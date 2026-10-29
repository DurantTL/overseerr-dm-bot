#!/usr/bin/env python3
"""Post the tailscale monitor's node states to the bot's uptime history.

Runs on the RackNerd VM after each tailscale-monitor run. Reads the monitor's own state file
(/opt/tailscale-monitor/device_states.json) and sends one result per fleet node to the bot's
POST /api/uptime/ingest, the same endpoint the reachability checker uses. It never changes the
monitor, its state file or its Discord alerts, and it judges nothing: "up" is exactly the
monitor's reported_status == "online".

Only the four fleet nodes the dashboard shows are sent. The watcher itself, retired registrations
(for example media-imac-pro) and anything else in the file are skipped. If the file holds two
records for one node (a re-registration, which Tailscale names like "durant-server-1"), one result
is sent for that node: the live record (online) wins; if none is online, the record that went
offline most recently.

Stays quiet when it should: no token or URL configured, or a state file older than
MAX_STATE_AGE_S (the monitor has stopped, so hours stay grey instead of repeating an old state).
Any error is printed to stderr and the script exits 0, so it can never fail the monitor's run.

Environment: UPTIME_INGEST_URL, UPTIME_INGEST_TOKEN (same values as the checker),
optionally TAILSCALE_STATE_FILE.
"""
import datetime
import json
import os
import re
import sys
import urllib.request

STATE_FILE = os.environ.get("TAILSCALE_STATE_FILE", "/opt/tailscale-monitor/device_states.json")
MAX_STATE_AGE_S = 20 * 60
NODES = {
    "durant-server": "node-durant-server",
    "ph-server": "node-ph-server",
    "southcentral-server": "node-southcentral-server",
    "cali-plex-server": "node-cali-plex-server",
}


def node_name(label):
    """Map a device label to a fleet node name, folding Tailscale's "-1" style duplicates."""
    name = str(label or "").strip().lower().split(".")[0]
    if name in NODES:
        return name
    base = re.sub(r"-\d+$", "", name)
    return base if base in NODES else None


def records(state):
    """The monitor's records, whether the file is a dict keyed by device or a list."""
    if isinstance(state, dict):
        items = state.get("devices", state)
        if isinstance(items, dict):
            return [dict(v, _id=k) for k, v in items.items() if isinstance(v, dict)]
        state = items
    return [r for r in state if isinstance(r, dict)] if isinstance(state, list) else []


def _offline_since(rec):
    value = rec.get("offline_since")
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return float("-inf")


def pick_live(recs):
    """One record per node: online wins, else the most recent offline_since."""
    best = {}
    for rec in recs:
        name = node_name(rec.get("label") or rec.get("hostname") or rec.get("name"))
        if not name:
            continue
        rank = (str(rec.get("reported_status", "")).lower() == "online", _offline_since(rec))
        if name not in best or rank > best[name][0]:
            best[name] = (rank, rec)
    return {name: rec for name, (_rank, rec) in best.items()}


def results_from(state):
    out = []
    for name, rec in sorted(pick_live(records(state)).items()):
        up = str(rec.get("reported_status", "")).lower() == "online"
        detail = "online" if up else ("offline since %s" % rec["offline_since"] if rec.get("offline_since") else "offline")
        out.append({"key": NODES[name], "up": up, "detail": detail[:200]})
    return out


def main():
    url = os.environ.get("UPTIME_INGEST_URL")
    token = os.environ.get("UPTIME_INGEST_TOKEN")
    if not url or not token:
        return
    try:
        mtime = os.path.getmtime(STATE_FILE)
        age = datetime.datetime.now().timestamp() - mtime
        if age > MAX_STATE_AGE_S:
            print("tailscale uptime post: state file is %d min old, not posting" % (age // 60), file=sys.stderr)
            return
        with open(STATE_FILE, encoding="utf-8") as fh:
            results = results_from(json.load(fh))
        if not results:
            return
        checked_at = datetime.datetime.fromtimestamp(mtime, datetime.timezone.utc).isoformat()
        body = json.dumps({"checked_at": checked_at, "results": results}).encode()
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token,
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except Exception as exc:  # never let history reporting affect the monitor
        print("tailscale uptime post failed: %s" % exc, file=sys.stderr)


if __name__ == "__main__":
    main()
