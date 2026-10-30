#!/usr/bin/env python3
"""durant-server container restart logger (report-only).

Runs from media@'s crontab every 5 minutes. Each poll reads, for every container on the host,
a whitelisted set of fields through `docker ps` and `docker inspect --format` (the Go template
asks Docker for those fields only, so container env, command lines and labels never reach this
script), plus the host uptime from /proc/uptime. It compares them with the last poll's state file
and writes one log line per detected change, with a classification that never claims more than
the evidence shows.

It never restarts, stops, starts, removes, pulls or execs anything. Read-only docker commands
only: ps, inspect, logs (Watchtower's log, searched in memory for this window; never copied out).

On a failure (docker unreachable, unreadable output, corrupt state file) it writes a FAIL line,
reports nothing about restarts, leaves the state file untouched and exits non-zero. A failed poll
is never reported as "no restarts".

Python 3 standard library and the docker CLI only. No sudo.
Usage: restart_logger.py [--dry-run] [--env-file PATH]
"""

import datetime
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

HOME = os.path.expanduser("~")
DEFAULTS = {
    "RESTART_LOGGER_DIR": os.path.join(HOME, "restart-logger"),
    "RESTART_LOGGER_KEEP_DAYS": "30",
    "DOCKER_BIN": "docker",
    "PROC_UPTIME": "/proc/uptime",
}
DEFAULT_ENV_FILE = os.path.join(HOME, ".config", "restart-logger", "env")

# Docker is asked for these fields and nothing else. The parser below also keeps only these keys,
# so even a template mistake that let more through could not reach a log line.
FIELDS = ("id", "name", "startedAt", "status", "restartCount", "image", "imageRef", "policy")
INSPECT_TEMPLATE = (
    '{"id":{{json .Id}},"name":{{json .Name}},"startedAt":{{json .State.StartedAt}},'
    '"status":{{json .State.Status}},"restartCount":{{json .RestartCount}},'
    '"image":{{json .Image}},"imageRef":{{json .Config.Image}},'
    '"policy":{{json .HostConfig.RestartPolicy.Name}}}'
)
DOCKER_TIMEOUT_S = 30
HEARTBEAT_TIMEOUT_S = 10
# Restarts of this many or more containers (image unchanged) in one poll window are read as a
# cluster: a host reboot, a Docker daemon restart or a stack redeploy, not one container's problem.
CLUSTER_MIN = 3
# A boot this close before the previous poll still counts as "rebooted inside the window"
# (clock rounding between the poll and /proc/uptime).
BOOT_SLACK_S = 60
STATE_VERSION = 1
HEX = re.compile(r"^[0-9a-f]+$")


class PollError(Exception):
    """A failure that must not produce a restart report."""

    def __init__(self, message, reason="error"):
        super().__init__(message)
        self.reason = reason


# ---------------------------------------------------------------------------------------------
# Config


def parse_env_file(text):
    out = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[7:].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key] = value
    return out


def read_env_file(path):
    """The optional env file (heartbeat token). Missing is fine; loose permissions are not."""
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return {}
    if st.st_mode & 0o077:
        raise PollError(f"env file {path} must be readable by its owner only (chmod 600)", "config")
    with open(path, encoding="utf-8") as fh:
        return parse_env_file(fh.read())


def is_loopback(host):
    h = (host or "").strip("[]").lower()
    return h in ("localhost", "::1") or re.match(r"^127\.\d+\.\d+\.\d+$", h) is not None


def heartbeat_config(values):
    """Off unless BOTH the URL and the token are set. Never the uptime ingest."""
    url = (values.get("BOT_HEARTBEAT_URL") or "").strip()
    token = (values.get("BOT_HEARTBEAT_TOKEN") or "").strip()
    if not url and not token:
        return {"enabled": False, "note": "off"}
    if not url:
        return {"enabled": False, "note": "off (BOT_HEARTBEAT_URL not set)"}
    if not token:
        return {"enabled": False, "note": "off (BOT_HEARTBEAT_TOKEN not set)"}
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and is_loopback(parsed.hostname)):
        raise PollError("BOT_HEARTBEAT_URL must be https (plain http only to this machine)", "config")
    if re.search(r"/api/uptime(/|$)", parsed.path or "", re.I):
        raise PollError("BOT_HEARTBEAT_URL must not be the uptime ingest; restarts are not up/down samples", "config")
    return {"enabled": True, "url": url, "token": token, "note": "on"}


def load_config(env_file, environ=None):
    environ = os.environ if environ is None else environ
    values = dict(DEFAULTS)
    values.update({k: v for k, v in read_env_file(env_file).items() if v != ""})
    # The environment can point the paths elsewhere (tests, a manual run); the token stays in the file.
    for key in ("RESTART_LOGGER_DIR", "RESTART_LOGGER_KEEP_DAYS", "DOCKER_BIN", "PROC_UPTIME"):
        if environ.get(key):
            values[key] = environ[key]
    try:
        keep = float(values["RESTART_LOGGER_KEEP_DAYS"])
    except ValueError:
        keep = -1
    if keep <= 0:
        raise PollError("RESTART_LOGGER_KEEP_DAYS must be a positive number", "config")
    base = os.path.abspath(os.path.expanduser(values["RESTART_LOGGER_DIR"]))
    return {
        "base": base,
        "logs": os.path.join(base, "logs"),
        "reports": os.path.join(base, "reports"),
        "state": os.path.join(base, "state.json"),
        "backup": os.path.join(base, "state.json.bak"),
        "latest": os.path.join(base, "latest.json"),
        "lock": os.path.join(base, "poll.lock"),
        "keep_days": keep,
        "docker": values["DOCKER_BIN"],
        "proc_uptime": values["PROC_UPTIME"],
        "heartbeat": heartbeat_config(values),
    }


# ---------------------------------------------------------------------------------------------
# Time


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc)


def iso(dt):
    return dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def local_stamp(dt):
    return dt.astimezone().isoformat(timespec="seconds")


def parse_docker_time(value):
    """Docker's StartedAt (nanoseconds, Z). None for the zero time of a never-started container."""
    if not isinstance(value, str) or not value or value.startswith("0001-01-01"):
        return None
    m = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$", value)
    if not m:
        return None
    frac = (m.group(2) or ".0")[:7]
    tz = "+00:00" if m.group(3) == "Z" else m.group(3)
    return datetime.datetime.fromisoformat(m.group(1) + frac + tz)


def duration_words(seconds):
    s = int(max(0, seconds))
    d, rem = divmod(s, 86400)
    h, rem = divmod(rem, 3600)
    m = rem // 60
    if d:
        return f"{d}d {h}h"
    if h:
        return f"{h}h {m}m"
    return f"{m}m"


# ---------------------------------------------------------------------------------------------
# Docker (read-only)


def run_docker(cfg, args):
    try:
        res = subprocess.run([cfg["docker"], *args], capture_output=True, text=True, timeout=DOCKER_TIMEOUT_S)
    except FileNotFoundError:
        raise PollError("docker CLI not found", "docker_missing")
    except subprocess.TimeoutExpired:
        raise PollError(f"docker {args[0]} did not answer within {DOCKER_TIMEOUT_S} s", "docker_timeout")
    if res.returncode != 0:
        # Docker's own error text is summarised, never copied into the log.
        msg = (res.stderr or "").lower()
        why = "permission denied (is media@ in the docker group?)" if "permission denied" in msg \
            else "daemon unreachable" if "cannot connect" in msg or "is the docker daemon running" in msg \
            else f"exit {res.returncode}"
        raise PollError(f"docker {args[0]} failed: {why}", "docker_unreachable")
    return res.stdout


def whitelist(raw):
    """Only the known fields, normalised. Anything else in the input is dropped here."""
    if not isinstance(raw, dict):
        raise PollError("docker inspect returned something that is not an object", "parse")
    rec = {k: raw.get(k) for k in FIELDS}
    cid = str(rec["id"] or "")
    image = str(rec["image"] or "")
    image = image.split(":", 1)[1] if image.startswith("sha256:") else image
    name = str(rec["name"] or "").lstrip("/")
    if not HEX.match(cid) or not name:
        raise PollError("docker inspect output is missing a container id or name", "parse")
    count = rec["restartCount"]
    return {
        "id": cid[:12],
        "name": name,
        "startedAt": rec["startedAt"] if isinstance(rec["startedAt"], str) else None,
        "status": str(rec["status"] or "unknown"),
        "restartCount": count if isinstance(count, int) and count >= 0 else None,
        "image": image[:12] if HEX.match(image or "x") else None,
        "imageRef": str(rec["imageRef"] or "")[:200],
        "policy": str(rec["policy"] or "no") or "no",
    }


def read_containers(cfg):
    ids = [line.strip() for line in run_docker(cfg, ["ps", "-aq", "--no-trunc"]).splitlines() if line.strip()]
    if not ids:
        return {}
    out = run_docker(cfg, ["inspect", "--format", INSPECT_TEMPLATE, *ids])
    containers = {}
    for line in out.splitlines():
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
        except ValueError:
            raise PollError("docker inspect output is not the expected JSON", "parse")
        rec = whitelist(raw)
        containers[rec["name"]] = rec
    if len(containers) != len(ids):
        raise PollError(f"docker inspect answered for {len(containers)} of {len(ids)} containers", "parse")
    return containers


def host_uptime(cfg):
    try:
        with open(cfg["proc_uptime"], encoding="ascii") as fh:
            return float(fh.read().split()[0])
    except (OSError, ValueError, IndexError):
        raise PollError("host uptime unreadable", "uptime")


def is_watchtower(rec, name=None):
    name = name or rec.get("name")
    return name == "watchtower" or "watchtower" in (rec.get("imageRef") or "").lower()


def watchtower_log_matches(cfg, watchtower_name, since, until, names):
    """Which of `names` Watchtower's own log shows it updating between since and until.

    Returns None when the log can't be read (that evidence is then unavailable). The log text is
    searched in memory only; no line of it is written anywhere."""
    if not watchtower_name:
        return None
    try:
        res = subprocess.run(
            [cfg["docker"], "logs", "--since", iso(since), "--until", iso(until), watchtower_name],
            capture_output=True, text=True, timeout=DOCKER_TIMEOUT_S,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if res.returncode != 0:
        return None
    text = (res.stdout or "") + "\n" + (res.stderr or "")
    found_new = "Found new" in text
    matched = set()
    for name in names:
        pat = re.compile(r"(Creating|Stopping)\s+/" + re.escape(name) + r"\b")
        if found_new and pat.search(text):
            matched.add(name)
    return matched


# ---------------------------------------------------------------------------------------------
# Diff and classification


def diff(prev, now):
    """Changes between two container maps (name → record). Pure."""
    events = []
    for name in sorted(set(prev) | set(now)):
        a, b = prev.get(name), now.get(name)
        if a and not b:
            events.append({"type": "gone", "name": name, "old": a, "new": None})
            continue
        if b and not a:
            events.append({"type": "appeared", "name": name, "old": None, "new": b})
            continue
        recreated = a["id"] != b["id"]
        started_changed = a.get("startedAt") != b.get("startedAt") and parse_docker_time(b.get("startedAt")) is not None
        delta = None
        if not recreated and isinstance(a.get("restartCount"), int) and isinstance(b.get("restartCount"), int):
            delta = b["restartCount"] - a["restartCount"]
        if recreated or started_changed or (delta or 0) > 0:
            events.append({
                "type": "restart",
                "name": name,
                "old": a,
                "new": b,
                "recreated": recreated,
                "restartDelta": delta,
                "imageChanged": (a.get("image") or None) != (b.get("image") or None),
            })
        elif a.get("status") == "running" and b.get("status") != "running":
            events.append({"type": "stopped", "name": name, "old": a, "new": b})
    return events


def classify(events, *, last_poll, now, uptime_s, watchtower_matches=None):
    """Adds classification, wording and the unexplained flag to each restart event. Pure.

    Rules (never more than the evidence shows):
      watchtower-self  Watchtower's own container: expected on its self-update, not flagged.
      image-changed    image id changed: consistent with a Watchtower update, not proof; upgraded
                       to "Watchtower log matches this window" when its log shows it.
      host-reboot      CLUSTER_MIN+ image-unchanged restarts and the host booted inside the window.
      stack-wide       CLUSTER_MIN+ image-unchanged restarts, host did not reboot: consistent with a
                       stack redeploy or Docker daemon restart; flagged for a human check.
      policy-restart   one or two containers whose RestartCount rose: Docker's restart policy
                       restarted it after it exited by itself (crash or OOM consistent); flagged.
      recreated        one or two containers with a new id and the same image: redeploy or manual
                       recreate consistent, not Watchtower; flagged.
      unexplained      anything else: needs a human check; flagged.
    """
    boot = now - datetime.timedelta(seconds=uptime_s)
    rebooted_in_window = boot >= last_poll - datetime.timedelta(seconds=BOOT_SLACK_S)
    restarts = [e for e in events if e["type"] == "restart"]
    plain = [e for e in restarts if not is_watchtower(e["new"], e["name"]) and not e["imageChanged"]]
    cluster = len(plain) >= CLUSTER_MIN
    for e in events:
        if e["type"] != "restart":
            e.update({"classification": e["type"], "unexplained": False,
                      "explanation": "new container (first seen this poll)" if e["type"] == "appeared"
                      else "container no longer present" if e["type"] == "gone"
                      else "stopped and not running at poll time"})
            continue
        if is_watchtower(e["new"], e["name"]):
            e.update({"classification": "watchtower-self", "unexplained": False,
                      "explanation": "Watchtower's own container restarted; expected when Watchtower updates itself"})
        elif e["imageChanged"]:
            match = watchtower_matches is not None and e["name"] in watchtower_matches
            e.update({"classification": "image-changed", "unexplained": False,
                      "explanation": "image changed: Watchtower log matches this window" if match
                      else "image changed: consistent with a Watchtower image update, not proof"
                      + ("" if watchtower_matches is not None else " (Watchtower log not readable)")})
        elif cluster and rebooted_in_window:
            e.update({"classification": "host-reboot", "unexplained": False,
                      "explanation": f"{len(plain)} containers restarted in this window and the host booted at {iso(boot)} (uptime {duration_words(uptime_s)}): consistent with a host reboot"})
        elif cluster:
            e.update({"classification": "stack-wide", "unexplained": True,
                      "explanation": f"{len(plain)} containers restarted in this window and the host did not reboot (up {duration_words(uptime_s)}): consistent with a stack redeploy or Docker daemon restart; check Portainer redeploy history (not proof)"})
        elif (e.get("restartDelta") or 0) > 0:
            e.update({"classification": "policy-restart", "unexplained": True,
                      "explanation": f"restart count +{e['restartDelta']}: Docker's restart policy ({e['new']['policy']}) restarted it after it exited by itself; a crash or OOM is consistent; needs a human check"})
        elif e.get("recreated"):
            e.update({"classification": "recreated", "unexplained": True,
                      "explanation": "recreated (new container id) with the same image: consistent with a stack redeploy or manual recreate, not a Watchtower update; needs a human check"})
        else:
            e.update({"classification": "unexplained", "unexplained": True,
                      "explanation": "unexplained: needs a human check"})
    return events


# ---------------------------------------------------------------------------------------------
# Output


def event_line(e, *, last_poll, now, uptime_s):
    o, n = e.get("old") or {}, e.get("new") or {}
    head = f"{local_stamp(now)} {e['type'].upper()} {e['name']}"
    window = f"detected between {iso(last_poll)} and {iso(now)} (poll window)"
    if e["type"] != "restart":
        return f"{head} {window} · {e['explanation']} · host up {duration_words(uptime_s)}"
    delta = "count reset (new container)" if e.get("recreated") else (
        f"restarts +{e['restartDelta']}" if e.get("restartDelta") is not None else "restart count unknown")
    parts = [
        f"latest start {n.get('startedAt') or '?'} (was {o.get('startedAt') or '?'})",
        delta,
        f"image {'changed ' + str(o.get('image')) + '→' + str(n.get('image')) if e['imageChanged'] else 'unchanged'}",
        f"policy {n.get('policy') or '?'}",
        f"host up {duration_words(uptime_s)}",
        # A cluster's long wording is on its CLUSTER line, logged once above these lines.
        "part of the cluster above" if e["classification"] in ("host-reboot", "stack-wide") else e["explanation"],
    ]
    line = f"{head} {window} · " + " · ".join(parts)
    return line + (" · UNEXPLAINED" if e["unexplained"] else "")


def event_json(e):
    o, n = e.get("old") or {}, e.get("new") or {}
    keep = lambda r: {k: r.get(k) for k in ("id", "startedAt", "status", "restartCount", "image", "policy")} if r else None
    return {
        "type": e["type"],
        "name": e["name"],
        "old": keep(o),
        "new": keep(n),
        "recreated": e.get("recreated", False),
        "restartDelta": e.get("restartDelta"),
        "imageChanged": e.get("imageChanged", False),
        "classification": e["classification"],
        "unexplained": e["unexplained"],
        "explanation": e["explanation"],
    }


def write_atomic(path, text):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=d)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.chmod(tmp, 0o640)
    os.replace(tmp, path)


def append(path, line):
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    os.chmod(path, 0o640)


def prune(directory, prefix, ext, keep_days, now):
    cutoff = now - datetime.timedelta(days=keep_days)
    try:
        names = os.listdir(directory)
    except OSError:
        return
    for name in names:
        m = re.match(r"^" + re.escape(prefix) + r"-(\d{4}-\d{2}-\d{2})" + re.escape(ext) + r"$", name)
        if not m:
            continue
        day = datetime.datetime.strptime(m.group(1), "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc)
        if day < cutoff:
            try:
                os.unlink(os.path.join(directory, name))
            except OSError:
                pass


def load_state(path):
    """The last poll's state, None when there is none yet; PollError when it is corrupt."""
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except FileNotFoundError:
        return None
    try:
        state = json.loads(text)
    except ValueError:
        state = None
    ok = isinstance(state, dict) and state.get("version") == STATE_VERSION and isinstance(state.get("containers"), dict) \
        and isinstance(state.get("lastPollAt"), str)
    if ok:
        try:
            datetime.datetime.fromisoformat(state["lastPollAt"].replace("Z", "+00:00"))
            for name, rec in state["containers"].items():
                if not isinstance(rec, dict) or not isinstance(rec.get("id"), str):
                    ok = False
        except ValueError:
            ok = False
    if not ok:
        raise PollError(f"state file {path} is corrupt; it was not overwritten. The last good state is in state.json.bak. "
                        f"To recover, move the corrupt file aside: the next poll baselines (restarts before it unknown)", "state_corrupt")
    return state


def send_heartbeat(hb, payload):
    req = urllib.request.Request(hb["url"], data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {hb['token']}"})

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=HEARTBEAT_TIMEOUT_S) as res:
            return "sent" if 200 <= res.status < 300 else f"failed (HTTP {res.status})"
    except urllib.error.HTTPError as err:
        return f"failed (HTTP {err.code})"
    except (urllib.error.URLError, OSError) as err:
        reason = getattr(err, "reason", err)
        return f"failed ({type(reason).__name__})"


# ---------------------------------------------------------------------------------------------
# One poll


def poll(cfg, *, now=None, dry_run=False, out=sys.stdout, err=sys.stderr):
    now = now or utc_now()
    day = now.astimezone().strftime("%Y-%m-%d")
    log_path = os.path.join(cfg["logs"], f"restarts-{day}.log")
    jsonl_path = os.path.join(cfg["reports"], f"restarts-{day}.jsonl")

    def emit(line, record=None):
        if dry_run:
            out.write(line + "\n")
            return
        append(log_path, line)
        if record is not None:
            append(jsonl_path, json.dumps(record, separators=(",", ":")))

    def heartbeat(status, summary, counts):
        if dry_run or not cfg["heartbeat"]["enabled"]:
            return cfg["heartbeat"]["note"]
        result = send_heartbeat(cfg["heartbeat"], {"name": "restart-logger", "source": "durant-server", "status": status,
                                                   "summary": summary, "counts": counts})
        if result != "sent":
            emit(f"{local_stamp(now)} WARN heartbeat {result}; logging continues")
        return result

    if not dry_run:
        for d in (cfg["base"], cfg["logs"], cfg["reports"]):
            os.makedirs(d, mode=0o750, exist_ok=True)
    try:
        state = load_state(cfg["state"])
        containers = read_containers(cfg)
        uptime_s = host_uptime(cfg)
    except PollError as e:
        line = f"{local_stamp(now)} FAIL {e}; no restart report this poll"
        emit(line, {"at": iso(now), "ok": False, "reason": e.reason, "error": str(e)})
        if not dry_run:
            write_atomic(cfg["latest"], json.dumps({"ok": False, "at": iso(now), "reason": e.reason, "error": str(e)}, indent=2) + "\n")
        err.write(f"restart-logger: FAIL {e}\n")
        heartbeat("fail", f"poll failed: {e.reason}", None)
        return 1

    new_state = {"version": STATE_VERSION, "lastPollAt": iso(now),
                 "hostBootAt": iso(now - datetime.timedelta(seconds=uptime_s)),
                 "containers": {n: {k: r[k] for k in ("id", "startedAt", "status", "restartCount", "image", "policy", "imageRef")}
                                for n, r in containers.items()}}
    summary = {"ok": True, "at": iso(now), "containers": len(containers), "hostUptimeSeconds": round(uptime_s),
               "heartbeat": cfg["heartbeat"]["note"]}

    if state is None:
        emit(f"{local_stamp(now)} BASELINE {len(containers)} containers recorded; restarts before this poll are unknown (not 0) · host up {duration_words(uptime_s)}",
             {"at": iso(now), "ok": True, "type": "baseline", "containers": len(containers), "hostUptimeSeconds": round(uptime_s)})
        summary.update({"baseline": True, "window": None, "restarts": None, "unexplained": None, "events": []})
    else:
        last_poll = datetime.datetime.fromisoformat(state["lastPollAt"].replace("Z", "+00:00"))
        events = diff(state["containers"], containers)
        image_changed = [e["name"] for e in events if e["type"] == "restart" and e["imageChanged"] and not is_watchtower(e["new"], e["name"])]
        wt_name = next((n for n, r in containers.items() if is_watchtower(r)), None)
        matches = watchtower_log_matches(cfg, wt_name, last_poll, now, image_changed) if image_changed else set()
        classify(events, last_poll=last_poll, now=now, uptime_s=uptime_s, watchtower_matches=matches)
        clustered = [e for e in events if e.get("classification") in ("host-reboot", "stack-wide")]
        if clustered:
            emit(f"{local_stamp(now)} CLUSTER detected between {iso(last_poll)} and {iso(now)} (poll window) · "
                 f"{', '.join(e['name'] for e in clustered)} · {clustered[0]['explanation']}"
                 + (" · UNEXPLAINED" if clustered[0]["unexplained"] else ""))
        for e in events:
            emit(event_line(e, last_poll=last_poll, now=now, uptime_s=uptime_s),
                 {"at": iso(now), "ok": True, "window": {"from": iso(last_poll), "to": iso(now)},
                  "hostUptimeSeconds": round(uptime_s), **event_json(e)})
        restarts = [e for e in events if e["type"] == "restart"]
        summary.update({"baseline": False, "window": {"from": iso(last_poll), "to": iso(now)},
                        "restarts": len(restarts), "unexplained": sum(1 for e in restarts if e["unexplained"]),
                        "events": [event_json(e) for e in events]})

    restarts_n = summary["restarts"] if summary["restarts"] is not None else 0
    hb_summary = "baselined; restarts before this poll unknown" if summary["baseline"] \
        else f"{restarts_n} restart(s) in window, {summary['unexplained']} unexplained"
    counts = {"containers": len(containers)} if summary["baseline"] \
        else {"restarts": restarts_n, "unexplained": summary["unexplained"], "containers": len(containers)}
    summary["heartbeat"] = heartbeat("ok", hb_summary, counts)

    if dry_run:
        out.write(json.dumps(summary, indent=2) + "\n")
        return 0
    # Keep the last good state before replacing it, so a bad write never erases history.
    if os.path.exists(cfg["state"]):
        shutil.copy2(cfg["state"], cfg["backup"])
        os.chmod(cfg["backup"], 0o640)
    write_atomic(cfg["state"], json.dumps(new_state, indent=1) + "\n")
    write_atomic(cfg["latest"], json.dumps(summary, indent=2) + "\n")
    prune(cfg["logs"], "restarts", ".log", cfg["keep_days"], now)
    prune(cfg["reports"], "restarts", ".jsonl", cfg["keep_days"], now)
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    dry_run = "--dry-run" in argv
    env_file = DEFAULT_ENV_FILE
    if "--env-file" in argv:
        i = argv.index("--env-file")
        if i + 1 >= len(argv):
            sys.stderr.write("restart-logger: --env-file needs a path\n")
            return 2
        env_file = argv[i + 1]
    unknown = [a for a in argv if a not in ("--dry-run", "--env-file", env_file)]
    if unknown:
        sys.stderr.write(f"restart-logger: unknown argument {unknown[0]}\nusage: restart_logger.py [--dry-run] [--env-file PATH]\n")
        return 2
    try:
        cfg = load_config(env_file)
    except PollError as e:
        sys.stderr.write(f"restart-logger: FAIL config: {e}\n")
        return 1
    if dry_run:
        return poll(cfg, dry_run=True)
    os.makedirs(cfg["base"], mode=0o750, exist_ok=True)
    with open(cfg["lock"], "w", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            sys.stderr.write("restart-logger: previous poll still running; skipped\n")
            return 1
        return poll(cfg)


if __name__ == "__main__":
    sys.exit(main())
