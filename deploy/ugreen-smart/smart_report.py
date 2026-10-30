#!/usr/bin/env python3
"""UGREEN Central Iowa SMART reporter.

Runs in a small Debian container on the UGOS box. The container can't see the host's disks,
so it SSHes into the host with a dedicated key, where a read-only wrapper
(host/central-iowa-smart-report.sh) discovers the disks and runs one `smartctl -i -H -A -j`
per disk. This script parses that, writes a dated JSON report to /reports, and posts the
health to the bot as a monitor-only tier-node heartbeat: the same request agent/agent.js
sends with TIER_MONITOR_ONLY=1 (POST /agent/report/<node>, Bearer node token, body
{heartbeat, monitorOnly, telemetry, agentVersion}). That lands in the bot's existing
fleet-disks view and SMART transition alerting with no bot change.

Strict: on an SSH, tool or parse failure, or any disk that couldn't be read (UNKNOWN), it
posts nothing and exits non-zero. It never reports health it didn't just measure; the bot's
telemetry age is what shows a silent reporter. It never starts a SMART self-test.

Usage: smart_report.py once [--dry-run] | smart_report.py loop
Never prints the SSH key, the node token, or drive serial numbers.
"""

import datetime
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
WRAPPER_FILE = os.path.join(HERE, "central-iowa-smart-report.sh")
if not os.path.exists(WRAPPER_FILE):  # repo layout (tests): host/ next to this file
    WRAPPER_FILE = os.path.join(HERE, "host", "central-iowa-smart-report.sh")

# The bot keeps at most 8 drives per node and only 'ok' / 'failing' (src/node-telemetry.js).
BOT_MAX_DRIVES = 8


class ReportError(Exception):
    """A failure that must not produce a health post."""


def log(message):
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"{stamp} smart-report: {message}", flush=True)


def env_config(environ=None):
    e = os.environ if environ is None else environ

    def read_secret(name):
        path = e.get(f"{name}_FILE")
        if path:
            with open(path, encoding="utf-8") as fh:
                return fh.read().strip()
        return (e.get(name) or "").strip()

    return {
        "ssh_host": e.get("SMART_SSH_HOST", ""),
        "ssh_user": e.get("SMART_SSH_USER", ""),
        "ssh_port": e.get("SMART_SSH_PORT", "22"),
        "ssh_key": e.get("SMART_SSH_KEY", "/run/secrets/smart_ssh_key"),
        "known_hosts": e.get("SMART_KNOWN_HOSTS", "/config/known_hosts"),
        # wrapper: the host forces the wrapper (recommended). remote: the fallback design, where
        # the wrapper is piped over SSH and smartctl runs through `sudo -n` (sudoers: smartctl only).
        "mode": e.get("SMART_MODE", "wrapper"),
        "data_path": e.get("SMART_DATA_PATH", ""),  # remote mode only; wrapper mode sets it on the host
        "bot_url": (e.get("BOT_URL") or "").rstrip("/"),
        "node": (e.get("TIER_NODE") or "central-iowa").lower(),
        "token": read_secret("TIER_NODE_TOKEN"),
        "report_dir": e.get("SMART_REPORT_DIR", "/reports"),
        "keep_days": int(e.get("SMART_REPORT_KEEP_DAYS", "60")),
        "schedule": e.get("SMART_SCHEDULE", "03:17"),  # local time in TZ (America/Chicago)
        "tz": e.get("TZ", "America/Chicago"),
        "ssh_timeout": int(e.get("SMART_SSH_TIMEOUT", "300")),
    }


def run_ssh(cfg):
    """Run the wrapper on the host. Returns its stdout (JSON text) and exit status."""
    for key in ("ssh_host", "ssh_user"):
        if not cfg[key]:
            raise ReportError(f"{key.upper().replace('SSH_', 'SMART_SSH_')} is not set")
    if not os.path.isfile(cfg["known_hosts"]):
        raise ReportError("pinned host key file (SMART_KNOWN_HOSTS) is missing; refusing to connect")
    if not os.path.isfile(cfg["ssh_key"]):
        raise ReportError("SSH key file (SMART_SSH_KEY) is missing")
    # ssh refuses a key readable by others, and a mounted secret's owner/mode can't be relied on,
    # so use a private 0600 copy for the duration of the call.
    tmpdir = tempfile.mkdtemp(prefix="smart-ssh-")
    try:
        key = os.path.join(tmpdir, "id")
        fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as dst, open(cfg["ssh_key"], "rb") as src:
            shutil.copyfileobj(src, dst)
        cmd = [
            "ssh", "-F", "/dev/null", "-T",
            "-i", key, "-p", str(cfg["ssh_port"]),
            "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={cfg['known_hosts']}",
            "-o", "GlobalKnownHostsFile=/dev/null", "-o", "UpdateHostKeys=no",
            "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=15",
            f"{cfg['ssh_user']}@{cfg['ssh_host']}",
        ]
        stdin = None
        if cfg["mode"] == "remote":
            env = "SMARTCTL='sudo -n smartctl'"
            if cfg["data_path"]:
                env += " DATA_PATH=" + "'" + cfg["data_path"].replace("'", "'\\''") + "'"
            cmd.append(f"{env} sh -s")
            with open(WRAPPER_FILE, "rb") as fh:
                stdin = fh.read()
        elif cfg["mode"] != "wrapper":
            raise ReportError(f"SMART_MODE must be wrapper or remote, not {cfg['mode']!r}")
        try:
            proc = subprocess.run(cmd, input=stdin, capture_output=True, timeout=cfg["ssh_timeout"])
        except subprocess.TimeoutExpired:
            raise ReportError(f"SSH to the host timed out after {cfg['ssh_timeout']}s")
        if proc.returncode == 255:
            err = proc.stderr.decode("utf-8", "replace").strip().splitlines()
            raise ReportError("SSH failed: " + (err[-1][:200] if err else "no detail"))
        return proc.stdout.decode("utf-8", "replace"), proc.returncode
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _ata_raw(smart, attr_id):
    table = ((smart.get("ata_smart_attributes") or {}).get("table")) or []
    for row in table:
        if row.get("id") == attr_id:
            raw = row.get("raw") or {}
            value = raw.get("value")
            return value if isinstance(value, int) else None
    return None


def _smartctl_error(smart, exit_status):
    msgs = ((smart or {}).get("smartctl") or {}).get("messages") or []
    errors = [m.get("string", "") for m in msgs if m.get("severity") in ("error", "warning")]
    if errors:
        return "; ".join(e for e in errors if e)[:300]
    if exit_status and exit_status & 1:
        return "smartctl could not parse the command line"
    if exit_status and exit_status & 2:
        return "device could not be opened"
    if exit_status and exit_status & 4:
        return "a SMART command to the disk failed"
    return None


def parse_disk(entry):
    """One wrapper disk entry -> the report row (no serial number, ever)."""
    device = str(entry.get("device") or "")[:80]
    smart = entry.get("smart") if isinstance(entry.get("smart"), dict) else None
    exit_status = entry.get("exit") if isinstance(entry.get("exit"), int) else None
    row = {
        "device": device,
        "model": None,
        "health": "UNKNOWN",
        "temperatureC": None,
        "reallocatedSectors": None,
        "pendingSectors": None,
        "offlineUncorrectable": None,
        "powerOnHours": None,
        "error": None,
    }
    if smart is None:
        row["error"] = _smartctl_error(None, exit_status) or "no readable smartctl output"
        return row
    row["model"] = (smart.get("model_name") or smart.get("model_family") or None)
    if row["model"]:
        row["model"] = str(row["model"])[:60]
    passed = (smart.get("smart_status") or {}).get("passed")
    if passed is True:
        row["health"] = "PASSED"
    elif passed is False:
        row["health"] = "FAILED"
    temp = (smart.get("temperature") or {}).get("current")
    row["temperatureC"] = temp if isinstance(temp, (int, float)) else None
    hours = (smart.get("power_on_time") or {}).get("hours")
    row["powerOnHours"] = hours if isinstance(hours, int) else None
    row["reallocatedSectors"] = _ata_raw(smart, 5)
    row["pendingSectors"] = _ata_raw(smart, 197)
    row["offlineUncorrectable"] = _ata_raw(smart, 198)
    nvme = smart.get("nvme_smart_health_information_log")
    if isinstance(nvme, dict) and row["powerOnHours"] is None and isinstance(nvme.get("power_on_hours"), int):
        row["powerOnHours"] = nvme["power_on_hours"]
    error = _smartctl_error(smart, exit_status)
    if row["health"] == "UNKNOWN":
        row["error"] = error or "smartctl gave no overall health result"
    elif error:
        row["error"] = error
    return row


# Host CPU temperature, best effort. The wrapper sends raw sysfs readings; this applies the tier
# agent's rules exactly (agent/agent.js collectSystemTelemetry): values above 1000 are
# millidegrees; keep only finite readings from -20 to 150°C; a sensor is CPU-kind when its device
# or label names a CPU (same pattern); CPU sensors first, then hottest; the first is the headline.
CPU_SENSOR_RE = re.compile(r"(?:cpu|core|package|x86_pkg_temp|coretemp|k10temp|zenpower|soc)", re.I)


def parse_host_temperatures(raw):
    if not isinstance(raw, list):
        return None
    out = []
    for entry in raw[:64]:
        if not isinstance(entry, dict):
            continue
        value = entry.get("raw")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        temperature = value / 1000 if value > 1000 else value
        if temperature != temperature or temperature < -20 or temperature > 150:  # NaN or out of range
            continue
        source_path = str(entry.get("source") or "")[:120]
        device = str(entry.get("device") or "")[:60]
        label = str(entry.get("label") or "")[:60] or source_path
        identity = " ".join(x for x in (device, label) if x)
        if label == source_path:
            source = f"{device} ({source_path})" if device else source_path
        else:
            source = f"{label} ({device + '/' if device else ''}{source_path})"
        out.append({"label": source[:80], "kind": "cpu" if CPU_SENSOR_RE.search(identity) else "unclassified", "temperatureC": temperature})
    out.sort(key=lambda t: (t["kind"] != "cpu", -t["temperatureC"]))
    return out


def parse_wrapper_output(text, status):
    """Wrapper stdout -> {source, disks, filesystem, smartctlMissing}. Raises on bad output."""
    try:
        data = json.loads(text)
    except (ValueError, TypeError) as exc:
        raise ReportError(f"could not parse the host's output as JSON ({exc.__class__.__name__}); exit {status}")
    if not isinstance(data, dict) or not isinstance(data.get("disks"), list):
        raise ReportError("host output has no disk list")
    if data.get("smartctlMissing"):
        disks = [parse_disk(d) for d in data["disks"] if isinstance(d, dict)]
        for r in disks:
            r["health"], r["error"] = "UNKNOWN", "smartmontools missing on host"
        return {"smartctlMissing": True, "source": data.get("source"), "disks": disks, "filesystem": None}
    disks = [parse_disk(d) for d in data["disks"] if isinstance(d, dict)]
    if not disks:
        raise ReportError("no disks discovered on the host (/proc/mdstat and smartctl --scan both empty)")
    # Temperature is best effort and never blocks the SMART report: any problem here is just "no
    # temperature" (an older wrapper without "sensors" included).
    try:
        temperatures = parse_host_temperatures(data.get("sensors"))
    except Exception:  # noqa: BLE001 - deliberately broad: temperature must not fail the run
        temperatures = None
    fs = data.get("filesystem") if isinstance(data.get("filesystem"), dict) else None
    filesystem = None
    if fs:
        total, free = fs.get("totalBytes"), fs.get("freeBytes")
        if isinstance(total, int) and isinstance(free, int) and total > 0 and 0 <= free <= total:
            filesystem = {"path": str(fs.get("path") or "")[:200], "totalBytes": total, "freeBytes": free}
        else:
            filesystem = {"path": str(fs.get("path") or "")[:200], "error": str(fs.get("error") or "unusable df result")[:120]}
    return {"smartctlMissing": False, "source": data.get("source"), "disks": disks, "filesystem": filesystem, "temperatures": temperatures}


def device_label(row):
    # Device node + model: enough to match a drive in the UGOS UI, no serial. Stable run to run,
    # which the bot's SMART transition alerting relies on (it keys on this string).
    return (f"{row['device']} · {row['model']}" if row["model"] else row["device"])[:80]


def agent_version():
    h = hashlib.sha256()
    for path in (os.path.abspath(__file__), WRAPPER_FILE):
        try:
            with open(path, "rb") as fh:
                h.update(fh.read())
        except OSError:
            pass
    return "ugreen-smart-" + h.hexdigest()[:8]


def build_payload(parsed, collected_at_ms):
    """The monitor-only heartbeat agent/agent.js sends, with only what was measured."""
    telemetry = {
        "collectedAt": collected_at_ms,
        "smartHealth": [
            {"device": device_label(r), "health": "ok" if r["health"] == "PASSED" else "failing"}
            for r in parsed["disks"][:BOT_MAX_DRIVES]
        ],
    }
    # Host temperature, same field names as the tier agent. None when unavailable (best effort).
    temps = parsed.get("temperatures") or []
    if temps:
        telemetry["temperatureC"] = temps[0]["temperatureC"]
        telemetry["temperatureSource"] = temps[0]["label"]
        telemetry["temperatureKind"] = temps[0]["kind"]
        telemetry["temperatures"] = temps[:32]
    else:
        telemetry["temperatureC"] = None
    fs = parsed.get("filesystem")
    if fs and "totalBytes" in fs:
        telemetry["filesystemTotalBytes"] = fs["totalBytes"]
        telemetry["filesystemFreeBytes"] = fs["freeBytes"]
    return {"heartbeat": True, "monitorOnly": True, "telemetry": telemetry, "agentVersion": agent_version()}


def post_report(cfg, payload):
    if not cfg["bot_url"]:
        raise ReportError("BOT_URL is not set")
    if not cfg["token"]:
        raise ReportError("TIER_NODE_TOKEN (or TIER_NODE_TOKEN_FILE) is not set")
    url = f"{cfg['bot_url']}/agent/report/{urllib.request.quote(cfg['node'], safe='')}"
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg["token"],
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read(2000).decode("utf-8", "replace")
            return resp.status, body
    except urllib.error.HTTPError as exc:
        raise ReportError(f"bot answered HTTP {exc.code} for /agent/report/{cfg['node']}")
    except (urllib.error.URLError, OSError) as exc:
        raise ReportError(f"could not reach the bot: {getattr(exc, 'reason', exc)}")


def write_report(cfg, report, now_local):
    try:
        os.makedirs(cfg["report_dir"], exist_ok=True)
        path = os.path.join(cfg["report_dir"], f"smart-{now_local:%Y-%m-%d}.json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
        cutoff = now_local.date() - datetime.timedelta(days=cfg["keep_days"])
        for name in os.listdir(cfg["report_dir"]):
            if name.startswith("smart-") and name.endswith(".json"):
                try:
                    if datetime.date.fromisoformat(name[6:16]) < cutoff:
                        os.remove(os.path.join(cfg["report_dir"], name))
                except ValueError:
                    pass
        return path
    except OSError as exc:
        log(f"could not write the report file: {exc}")
        return None


def run_once(cfg, dry_run=False, ssh=run_ssh, post=post_report, clock=time.time):
    """One measurement. Returns the process exit code (0 = measured and posted)."""
    tz = ZoneInfo(cfg["tz"])
    now = clock()
    now_local = datetime.datetime.fromtimestamp(now, tz)
    report = {
        "node": cfg["node"], "ranAt": now_local.isoformat(timespec="seconds"),
        "status": None, "source": None, "diskCount": 0, "disks": [],
        "filesystem": None, "posted": False, "error": None,
    }
    code = 0
    try:
        text, status = ssh(cfg)
        parsed = parse_wrapper_output(text, status)
        if parsed["smartctlMissing"]:
            report.update(status="smartctl-missing", source=parsed["source"], diskCount=len(parsed["disks"]), disks=parsed["disks"])
            for r in parsed["disks"]:
                log(f"{r['device']}: UNKNOWN (smartmontools missing on host)")
            listed = f"{len(parsed['disks'])} disk(s) UNKNOWN" if parsed["disks"] else "no disks listed in /proc/mdstat to mark UNKNOWN"
            raise ReportError(f"smartmontools missing on host; {listed}. Not posting; installing it is a host decision")
        report.update(source=parsed["source"], diskCount=len(parsed["disks"]), disks=parsed["disks"], filesystem=parsed["filesystem"])
        for r in parsed["disks"]:
            extra = "" if r["health"] != "UNKNOWN" else f" ({r['error']})"
            log(f"{r['device']} {r['model'] or 'unknown model'}: {r['health']}{extra}"
                f" temp={r['temperatureC']} realloc={r['reallocatedSectors']} pending={r['pendingSectors']}"
                f" offline_unc={r['offlineUncorrectable']} hours={r['powerOnHours']}")
        log(f"{len(parsed['disks'])} disk(s) found via {parsed['source']}")
        temps = parsed.get("temperatures") or []
        report["temperatures"] = temps
        if temps:
            log(f"host temperature {temps[0]['temperatureC']:.1f}°C {temps[0]['kind']} ({temps[0]['label']}); {len(temps)} sensor(s)")
        else:
            log("host temperature unavailable (no readable sensor); reporting SMART without it")
        unknown = [r["device"] for r in parsed["disks"] if r["health"] == "UNKNOWN"]
        if unknown:
            # The bot can only hold ok/failing; a missing drive would read as a recovery. Fail closed.
            raise ReportError(f"{len(unknown)} disk(s) UNKNOWN ({', '.join(unknown)}); not posting a partial reading")
        if len(parsed["disks"]) > BOT_MAX_DRIVES:
            log(f"warning: {len(parsed['disks'])} disks found; the bot keeps the first {BOT_MAX_DRIVES}. All are in the local report.")
        payload = build_payload(parsed, int(now * 1000))
        report["payload"] = payload
        if dry_run:
            report["status"] = "dry-run"
            print(json.dumps(payload, indent=2), flush=True)
            log("dry run: payload printed, nothing posted")
        else:
            status_code, _body = post(cfg, payload)
            report["status"] = "posted"
            report["posted"] = True
            log(f"posted to the bot as node {cfg['node']} (HTTP {status_code})")
    except ReportError as exc:
        report["status"] = report["status"] or "error"
        report["error"] = str(exc)
        log(f"ERROR: {exc}")
        code = 2
    except Exception as exc:  # anything unexpected is a failure too: never post a guess
        report["status"] = "error"
        report["error"] = f"unexpected {exc.__class__.__name__}: {exc}"[:300]
        log(f"ERROR: {report['error']}")
        code = 2
    path = write_report(cfg, report, now_local)
    if path:
        log(f"report written: {path}")
    return code


def seconds_until_next(schedule, tz_name, now=None):
    tz = ZoneInfo(tz_name)
    hour, minute = (int(x) for x in schedule.split(":", 1))
    now = now or datetime.datetime.now(tz)
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now:
        target = (target + datetime.timedelta(days=1)).replace(hour=hour, minute=minute)
    # Re-anchor to the zone, then measure real elapsed time. Subtracting two datetimes that share a
    # tzinfo gives wall-clock difference, which is an hour off across a DST change.
    target = datetime.datetime(target.year, target.month, target.day, hour, minute, tzinfo=tz)
    return max(60, math.ceil(target.timestamp() - now.timestamp())), target


def loop(cfg):
    log(f"starting: node {cfg['node']}, daily at {cfg['schedule']} {cfg['tz']}, plus this start-up run")
    run_once(cfg)
    while True:
        wait, target = seconds_until_next(cfg["schedule"], cfg["tz"])
        log(f"next run {target.isoformat(timespec='minutes')}")
        sleep_until(target, wait)
        run_once(cfg)


def sleep_until(target, first_wait, sleep=time.sleep, now=time.time):
    # sleep() can wake a little early; never run before the target, or the next target would be
    # computed as the same time again and the run would repeat.
    sleep(first_wait)
    while now() < target.timestamp():
        sleep(max(1, math.ceil(target.timestamp() - now())))


def main(argv):
    cfg = env_config()
    cmd = argv[1] if len(argv) > 1 else "loop"
    if cmd == "once":
        return run_once(cfg, dry_run="--dry-run" in argv)
    if cmd == "loop":
        loop(cfg)
        return 0
    print("usage: smart_report.py once [--dry-run] | loop", file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv))
