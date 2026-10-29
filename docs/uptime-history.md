# Uptime history (Services → Uptime)

The RackNerd reachability checker (`/opt/reachability-check/check.py`) probes four public paths
every 5 minutes and posts to Discord only when one flips. It decides up or down itself. With this
change it also sends each run's results to the bot, which stores them and shows 24-hour, 7-day and
30-day uptime on the dashboard. The bot never judges a result and never alerts from this data.

| Key | Endpoint |
|---|---|
| `plex-funnel` | Plex via Tailscale Funnel: `durant-server.end-cobra.ts.net/identity` |
| `dashboard-funnel` | Bot dashboard via Funnel: `durant-server.end-cobra.ts.net/dashboard` |
| `bot-cloudflare` | Bot via Cloudflare Tunnel: `media.durantlogic.com/live` |
| `seedbox-rutorrent` | EvoSeedbox ruTorrent: `pace.myseedbox.site/rutorrent/` |

## Bot side

- `POST /api/uptime/ingest` with `Authorization: Bearer <UPTIME_INGEST_TOKEN>`:
  - **Body:** `{ "checked_at": "<ISO time>", "results": [{ "key": "plex-funnel", "up": true, "detail": "HTTP 200" }, …] }`.
  - **Contents:** one result per endpoint per run. `detail` is free text, kept to 200 characters.
  - **Rejected:**
    - unknown keys;
    - duplicate keys;
    - non-boolean `up`;
    - results stamped more than a day old or more than 10 minutes in the future.
  - **No token configured:** the endpoint answers 503.
  - **Rate limit:** 10 posts per 5 minutes per client.
  - **Repeats:** a repeated post for the same endpoint and time is ignored, not overwritten.
- **Storage:** the `uptime_samples` table (migration v9), one row per endpoint per run, pruned
  after 30 days. That's about 35,000 rows at most.
- **Read API:** `GET /admin/api/uptime`, behind the dashboard login.
- **Grey hours:** an hour with no stored check is grey, never green.
- **Collecting history:** a period the stored samples don't cover yet is shown as collecting
  history.

## Setting the token (Caleb)

The token value never goes in the repo, a PR or chat. Generate one 32+ character secret and set it
in two places:

1. **The bot (Portainer, stack environment):** `UPTIME_INGEST_TOKEN=<the secret>`, then redeploy.
2. **The checker VM:** add these two lines to the checker's environment, using whatever the service
   or cron already loads (for example an `EnvironmentFile=` or the cron line):
   - `UPTIME_INGEST_TOKEN=<the same secret>`
   - `UPTIME_INGEST_URL=https://media.durantlogic.com/api/uptime/ingest`

```sh
openssl rand -hex 32
```

## Checker side

Nothing about the checker's probing changes:
- probe URLs;
- the 5-minute interval;
- expected-status lists;
- up/down judgment;
- Discord down and recovery alerts.

The change adds one helper file next to `check.py` and one call after each run. The call can't
fail the run: every error is caught and printed to stderr, and the post has a 10-second timeout.

### 1. New file `/opt/reachability-check/uptime_post.py`

```diff
--- /dev/null
+++ /opt/reachability-check/uptime_post.py
@@ -0,0 +1,50 @@
+"""Send one run's results to the bot's uptime history (POST /api/uptime/ingest).
+
+Display only: the bot stores what this checker decided and never alerts from it. Any failure
+is printed to stderr and swallowed, so it can never change the checker's run or its alerts.
+"""
+import datetime
+import json
+import os
+import sys
+import urllib.request
+
+# The checker's four probe URLs mapped to the bot's endpoint keys. Matched on host and path,
+# so scheme or a trailing query in the checker's own list doesn't matter.
+KEYS = {
+    "durant-server.end-cobra.ts.net/identity": "plex-funnel",
+    "durant-server.end-cobra.ts.net/dashboard": "dashboard-funnel",
+    "media.durantlogic.com/live": "bot-cloudflare",
+    "pace.myseedbox.site/rutorrent/": "seedbox-rutorrent",
+}
+
+
+def _key_for(url):
+    bare = url.split("://", 1)[-1].split("?", 1)[0]
+    return KEYS.get(bare) or KEYS.get(bare.rstrip("/")) or KEYS.get(bare.rstrip("/") + "/")
+
+
+def post_results(results, checked_at=None):
+    """results: iterable of (url, up, detail) exactly as this run judged them."""
+    url = os.environ.get("UPTIME_INGEST_URL")
+    token = os.environ.get("UPTIME_INGEST_TOKEN")
+    if not url or not token:
+        return
+    try:
+        payload = []
+        for probe_url, up, detail in results:
+            key = _key_for(probe_url)
+            if key:
+                payload.append({"key": key, "up": bool(up), "detail": str(detail or "")[:200]})
+        if not payload:
+            return
+        when = checked_at or datetime.datetime.now(datetime.timezone.utc)
+        body = json.dumps({"checked_at": when.isoformat(), "results": payload}).encode()
+        req = urllib.request.Request(url, data=body, method="POST", headers={
+            "Content-Type": "application/json",
+            "Authorization": "Bearer " + token,
+        })
+        with urllib.request.urlopen(req, timeout=10) as resp:
+            resp.read()
+    except Exception as exc:  # never let history reporting affect the checker
+        print(f"uptime history post failed: {exc}", file=sys.stderr)
```

### 2. Hook in `check.py`

I haven't been given a copy of `check.py`, so this is the exact change to make rather than a
line-numbered diff. Paste `check.py` into the session and I'll return a line-exact diff instead.

- Near the other imports:

  ```python
  from uptime_post import post_results
  ```

- Once per run, after every probe has been judged and after the Discord down/recovery logic
  (so a slow bot can never delay an alert). Use the same up/down value and the same short
  detail the checker already computes (status code or error) for each URL:

  ```python
  post_results([(url, is_up, detail) for url, is_up, detail in this_runs_results])
  ```

  `this_runs_results` stands for whatever list or dict the run already builds. The only
  requirement is one `(url, up, detail)` per probed URL.

### Verify after applying

```sh
# One manual run; expect no new Discord message unless something really flipped.
python3 /opt/reachability-check/check.py
```

Then open the dashboard: Services → Uptime should show "checked 1 min ago" on all four rows.
