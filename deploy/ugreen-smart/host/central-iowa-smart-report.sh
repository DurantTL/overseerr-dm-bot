#!/bin/sh
# central-iowa-smart-report — read-only SMART reader for the UGREEN (UGOS) host.
#
# Install on the UGOS host as /usr/local/sbin/central-iowa-smart-report (root:root, 0755).
# The reporter container's SSH key is forced to run this script and nothing else
# (authorized_keys command="sudo -n /usr/local/sbin/central-iowa-smart-report"), and sudoers
# allows exactly this path, so the key can do one thing: read SMART health and attributes.
#
# What it does, every run:
#   1. Discovery: the member disks of every md array in /proc/mdstat (UGOS RAID 1 data volume).
#      If that finds nothing, falls back to `smartctl --scan`.
#   2. One `smartctl -i -H -A -j` per disk (identity, health, attributes). It never starts a
#      self-test (-t) and never changes a setting.
#   3. Optional: total/free bytes of DATA_PATH (the Syncthing data volume). Empty = skipped.
#   4. Host temperatures, best effort: the raw readings from /sys/class/thermal zones and
#      /sys/class/hwmon temp*_input (with their zone type / hwmon name / label). The container
#      filters and classifies them exactly as the tier agent does. A failure here only means no
#      temperature; it never affects the disk readings or the exit status.
#   5. Prints one JSON object on stdout. smartctl's own JSON is embedded per disk.
#
# Exit status: 0 ok; 3 smartctl is not installed (JSON still printed with smartctlMissing and the
# mdstat disks, each without a reading);
# 4 no disks discovered. A disk that can't be opened is NOT an error here — it is printed
# with smartctl's exit status and output, and the container reports it as UNKNOWN.
#
# In the fallback design (no wrapper installed), the container pipes this same file over SSH
# (`ssh host sh -s`) with SMARTCTL="sudo -n smartctl"; nothing else differs.

set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH LC_ALL=C

# The Syncthing data volume on this host, for free/total space in the bot's fleet-disks view.
# Leave empty to report SMART only. Example (confirm the real path in the UGOS UI): /volume1
DATA_PATH="${DATA_PATH:-}"
SMARTCTL="${SMARTCTL:-smartctl}"
# SYSFS is only overridable for tests; over the forced-command SSH path the client can't set it.
SYSFS="${SYSFS:-/sys}"
WRAPPER_VERSION=1

json_str() {
  # Minimal JSON string escaping for device names, sensor labels and paths (control characters dropped).
  printf '"%s"' "$(printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

# Parent disk of an md member: sda3 -> sda, nvme0n1p3 -> nvme0n1, mmcblk0p2 -> mmcblk0.
parent_disk() {
  case "$1" in
    nvme*p[0-9]*|mmcblk*p[0-9]*) printf '%s\n' "$1" | sed 's/p[0-9][0-9]*$//' ;;
    sd*|hd*|vd*|xvd*) printf '%s\n' "$1" | sed 's/[0-9][0-9]*$//' ;;
    *) printf '%s\n' "$1" ;;
  esac
}

smartctl_bin() {
  # First word of SMARTCTL ("smartctl" or "sudo -n smartctl" -> the smartctl part is checked).
  set -- $SMARTCTL
  [ "$1" = "sudo" ] && { shift; [ "${1:-}" = "-n" ] && shift; }
  command -v "$1" >/dev/null 2>&1
}

disks=""
source=""
# MDSTAT is only overridable for tests; over the forced-command SSH path the client can't set it.
MDSTAT="${MDSTAT:-/proc/mdstat}"
if [ -r "$MDSTAT" ]; then
  # Member tokens look like sda3[0] or nvme0n1p2[1] on the "mdN : active raid1 ..." lines.
  members=$(awk '/^md[0-9]+[ \t]*:/ { for (i = 4; i <= NF; i++) if ($i ~ /\[[0-9]+\]/) { sub(/\[.*$/, "", $i); print $i } }' "$MDSTAT")
  for m in $members; do
    d="/dev/$(parent_disk "$m")"
    case " $disks " in *" $d "*) ;; *) disks="$disks $d" ;; esac
  done
  [ -n "$disks" ] && source="mdstat"
fi
if ! smartctl_bin; then
  # No smartctl: still list the disks /proc/mdstat names, each with no reading, so every one is
  # reported UNKNOWN ("smartmontools missing on host") rather than silently absent.
  printf '{"wrapperVersion":%s,"smartctlMissing":true,"source":%s,"disks":[' "$WRAPPER_VERSION" "$( [ -n "$source" ] && json_str "$source" || printf null)"
  first=1
  for d in $disks; do
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '{"device":%s,"exit":null,"smart":null}' "$(json_str "$d")"
  done
  printf ']}\n'
  exit 3
fi
if [ -z "$disks" ]; then
  for d in $($SMARTCTL --scan 2>/dev/null | awk '$1 ~ /^\/dev\// { print $1 }'); do
    case " $disks " in *" $d "*) ;; *) disks="$disks $d" ;; esac
  done
  [ -n "$disks" ] && source="scan"
fi
if [ -z "$disks" ]; then
  printf '{"wrapperVersion":%s,"smartctlMissing":false,"source":null,"disks":[]}\n' "$WRAPPER_VERSION"
  exit 4
fi

printf '{"wrapperVersion":%s,"smartctlMissing":false,"source":"%s","disks":[' "$WRAPPER_VERSION" "$source"
first=1
for d in $disks; do
  out=$($SMARTCTL -i -H -A -j "$d" 2>/dev/null)
  status=$?
  [ "$first" -eq 1 ] || printf ','
  first=0
  # smartctl -j prints one JSON document; an empty or non-JSON reply is passed as null and the
  # container reports that disk UNKNOWN.
  case "$out" in
    \{*) printf '{"device":%s,"exit":%s,"smart":%s}' "$(json_str "$d")" "$status" "$out" ;;
    *) printf '{"device":%s,"exit":%s,"smart":null}' "$(json_str "$d")" "$status" ;;
  esac
done
printf ']'

# Host temperatures (raw). Integer millidegree values only; anything else is skipped. At most 64.
printf ',"sensors":['
first=1
count=0
emit_sensor() {
  # $1 source path, $2 device (zone type / hwmon name), $3 label, $4 raw value
  printf '%s' "$4" | grep -Eq '^-?[0-9]+$' || return 0
  [ "$count" -lt 64 ] || return 0
  [ "$first" -eq 1 ] || printf ','
  first=0
  count=$((count + 1))
  printf '{"source":%s,"device":%s,"label":%s,"raw":%s}' "$(json_str "$1")" "$(json_str "$2")" "$(json_str "$3")" "$4"
}
for zone in "$SYSFS"/class/thermal/thermal_zone*; do
  [ -r "$zone/temp" ] || continue
  emit_sensor "thermal/${zone##*/}/temp" "$(cat "$zone/type" 2>/dev/null | head -n 1)" "" "$(cat "$zone/temp" 2>/dev/null | head -n 1)"
done
for hw in "$SYSFS"/class/hwmon/hwmon*; do
  [ -d "$hw" ] || continue
  name=$(cat "$hw/name" 2>/dev/null | head -n 1)
  for input in "$hw"/temp*_input; do
    [ -r "$input" ] || continue
    labelfile="${input%_input}_label"
    label=""
    [ -r "$labelfile" ] && label=$(cat "$labelfile" 2>/dev/null | head -n 1)
    emit_sensor "hwmon/${hw##*/}/${input##*/}" "$name" "$label" "$(cat "$input" 2>/dev/null | head -n 1)"
  done
done
printf ']'

if [ -n "$DATA_PATH" ]; then
  fs=$(df -P -B1 "$DATA_PATH" 2>/dev/null | awk 'NR == 2 { print $2, $4 }')
  if [ -n "$fs" ]; then
    set -- $fs
    printf ',"filesystem":{"path":%s,"totalBytes":%s,"freeBytes":%s}' "$(json_str "$DATA_PATH")" "$1" "$2"
  else
    printf ',"filesystem":{"path":%s,"error":"df failed"}' "$(json_str "$DATA_PATH")"
  fi
fi
printf '}\n'
exit 0
