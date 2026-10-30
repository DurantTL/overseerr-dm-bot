# PH sync progress and stall reporter

A report-only script on PH that, every 15 minutes, records how much each Syncthing folder still
has to download, how much space the media drive has, and whether a folder has stopped moving.
It replaces the manual check (SSH in, read the Syncthing numbers, do the arithmetic by hand).

```
root cron, every 15 min
  ph-sync-report.js --GET--> Syncthing REST on 127.0.0.1:8384 (config/folders, db/status, db/need)
                    --statfs--> /mnt/media
                    --> /var/log/ph-sync-reporter/sync-YYYY-MM-DD.log         (one line per run)
                    --> /var/lib/ph-sync-reporter/reports/sync-YYYY-MM-DD.jsonl (one JSON per run)
                    --> /var/lib/ph-sync-reporter/latest.json                  (this run)
```

**What it never does:** no POST, pause, resume, rescan, override or restart in Syncthing; no
container restart; no prune or delete; no `.stignore` or tier-plan change; no temperatures or
SMART (the tier agent already reports those). The only network write is the optional heartbeat
below, which is off by default.

**Runtime:** Node.js stdlib only. PH already has Node.js 24 for the tier agent, so nothing is
installed. Check with `node --version` (expect `v24.x`) and `command -v node` (expect
`/usr/bin/node`, which the cron's default PATH finds).

## What each run records

Per folder (from `GET /rest/config/folders/<id>` and `GET /rest/db/status?folder=<id>`):

- `state`: Syncthing's state (`idle`, `scanning`, `sync-waiting`, `sync-preparing`, `syncing`,
  `error`, …), or `paused`.
- `needBytes`, `needItems` (`needTotalItems`), `needDeletes`.
- `inProgress`: for the files Syncthing is pulling right now (the `progress` list of
  `GET /rest/db/need`), the bytes already in their `.syncthing.*.tmp` files on disk and when
  one was last written. This is the "are the temp files still growing?" check.

Then the disk (`/mnt/media`: total, free, Use% as `df` shows them) and the totals: total need,
and **free after downloads complete** = free − total need (the bottom of the downloads-first
dip; negative means the downloads would not fit). There is no prune projection: pending prune
bytes belong to the tier agent's plan.

Two counters are deliberately **not** used:

- `/rest/db/completion`: a paused folder reads as complete there.
- the `files` key of `/rest/db/need`: it doesn't exist (`page`, `perpage`, `progress`,
  `queued`, `rest`); only `progress` is read.

### Paused folders

Syncthing has no "paused" state. A paused folder has no runner, so `db/status` answers with
`state: ""` and need numbers from the database that don't describe anything. The script reads
`paused` from the folder config and reports the need as **unknown** (`null`), never 0.

- The totals then become a lower bound: `totalNeedBytes` and `freeAfterDownloadsBytes` are
  `null`, `knownNeedBytes` holds the rest, and `unknownNeedFolders` names the paused ones.
- A folder that isn't paused but has no runner is reported the same way, as `not-running`.

## Stall rule

A folder is **stalled** when it has something to download (`needBytes` > 0, not paused) and
"still to download" moved **less than 100 MB in the last 2 hours** (8 runs at 15 minutes).
"Still to download" is `needBytes` minus the bytes already in its temp files.

| Case | Result |
|---|---|
| Need dropping by 100 MB or more in 2 h | `progressing` |
| Need flat (under 100 MB moved in 2 h) | `stalled`, flag set |
| Need **grew** since the last run (new content from the master, e.g. a new movie landing) | `new-content`, not a stall. The 2-hour window restarts from that run; if nothing moves for 2 hours after that, it is a stall. |
| Need 0 | `converged` (or `finishing` when only deletes or folders are left), never stalled |
| Paused or not running | stall `null` (unknown). A pause also restarts the window. |
| Less than 2 hours of history (first runs, or after a pause or growth) | `warming-up`, not stalled |

The overall `stalled` flag is set when any folder is stalled. The settings are
`PH_SYNC_STALL_WINDOW_MINUTES` (default 120) and `PH_SYNC_STALL_MIN_MB` (default 100).

**Why these numbers:**

- **100 MB in 2 hours is about 0.11 Mbps**, roughly 3% of the 3.60 Mbps live rate seen on
  Oct 28. A folder getting any real share of the link clears it easily. A folder that has
  stopped (Movies and Family on Oct 28, temps unwritten for about 15 hours while TV was active)
  does not.
- **2 hours** is the shortest window that a long `sync-waiting` or a slow `scanning` pass
  doesn't trip. It's also what the Oct 28 situation needed: about 15 hours went by unnoticed,
  and a 2-hour flag would have caught it on the first evening.
- **Temp bytes count as movement** because `needBytes` only drops when a whole file finishes.
  A 6 GB movie on a small share of a 3.6 Mbps link takes hours, and without its temp file the
  folder would look flat the whole time.
  - Temp bytes are the file's allocated blocks, not its length: blocks arrive out of order, so
    the length can jump early.
  - When a file completes, need drops by the file and temp drops by what was already counted,
    so nothing is counted twice.

**Known limit:** the rule can't tell why a folder isn't moving. Two cases look alike:

- TV saturating the shared link;
- a remote device offline.

The log line shows each folder's state, which helps tell them apart. Fixes such as the 2-hour TV
pause test or a Syncthing restart are not this script's job and still need Caleb's explicit
go-ahead.

## Output

**Log**, `/var/log/ph-sync-reporter/sync-YYYY-MM-DD.log`, dated by PH's local date. There's one
line per run and an extra line only when something changes. The example below uses
illustrative numbers, not PH's:

```
2026-10-29T22:00:00-05:00 OK need: Family 2.6 GiB syncing | 4K 0 idle | Movies 9.8 GiB syncing STALLED | TV 51.3 GiB syncing | total 63.7 GiB | free 293.0 GiB | after downloads 229.3 GiB | stall YES
2026-10-29T22:00:00-05:00 STALL START Movies (mafyh-4dn5b): still to download moved 0 since 2026-10-29T20:00:00-05:00 (threshold 100 MB per 120 min), need 9.8 GiB, state syncing
2026-10-29T22:15:00-05:00 STALL END Movies (mafyh-4dn5b): now progressing, stalled since 2026-10-29T22:00:00-05:00
2026-10-29T22:30:00-05:00 OK need: … | TV paused (need ?) | total >=10.8 GiB (some need unknown) | free 293.0 GiB | after downloads ? | stall no
2026-10-29T22:45:00-05:00 FAIL Syncthing API unreachable at http://127.0.0.1:8384 (ECONNREFUSED); no report this run
```

**JSON**:

- `/var/lib/ph-sync-reporter/reports/sync-YYYY-MM-DD.jsonl` has one report per line, per run;
- `/var/lib/ph-sync-reporter/latest.json` holds the current run, written atomically.

The shape, abridged to two folders, with illustrative numbers:

```json
{
  "ok": true,
  "at": "2026-10-30T03:00:00.000Z",
  "node": "ph",
  "folders": [
    { "id": "ch3dl-xnzem", "label": "4K", "state": "idle", "paused": false,
      "needBytes": 0, "needItems": 0, "needDeletes": 0, "inProgress": null,
      "stall": { "stalled": false, "status": "converged", "movedBytes": null, "since": null } },
    { "id": "mafyh-4dn5b", "label": "Movies", "state": "syncing", "paused": false,
      "needBytes": 10522669875, "needItems": 5, "needDeletes": 0,
      "inProgress": { "items": 1, "tempFiles": 1, "tempBytes": 0, "lastTempWriteAt": "2026-10-29T08:12:44.000Z" },
      "stall": { "stalled": true, "status": "stalled", "movedBytes": 0,
                 "windowStart": "2026-10-30T01:00:00.000Z", "since": "2026-10-30T03:00:00.000Z" } }
  ],
  "disk": { "path": "/mnt/media", "totalBytes": 5000981077504, "freeBytes": 314609664000, "usedPercent": 94 },
  "totals": { "totalNeedBytes": 74732167168, "knownNeedBytes": 74732167168,
              "unknownNeedFolders": [], "freeAfterDownloadsBytes": 239877496832 },
  "stalled": true,
  "stallRule": { "windowMinutes": 120, "minMovedBytes": 100000000 },
  "heartbeat": "off"
}
```

A failed run (`ok: false`) carries only the time, the error and the reason. No folder or disk
numbers are written, so `latest.json` never shows progress that wasn't just measured.

**State:** `/var/lib/ph-sync-reporter/state.json` holds about 4 hours of samples per folder for
the stall window.

**Retention:** dated logs and reports older than 60 days (`PH_SYNC_KEEP_DAYS`) are deleted by
the script itself. That works out to about 20 KB of log and 170 KB of JSON a day, roughly 11 MB
at most.

**Paths:** logs go under `/var/log`, where people look for them. Machine state and reports go
under `/var/lib`, next to the tier agent's `/var/lib/tier-agent`.

## Failure rules

The script exits non-zero, writes one `FAIL` line to the log and to stderr, and reports nothing
for that run when the following happen. A config error goes to stderr only, because the log's
location comes from the config.

- the env file is missing, or readable by anyone but root (mode must be 600);
- the Syncthing API doesn't answer within 10 s or refuses the connection;
- Syncthing rejects the key (HTTP 401/403);
- a configured folder isn't in Syncthing's config;
- an answer isn't JSON or has no `state` or `needBytes`;
- **`/mnt/media` is not a mount**. If the drive didn't mount, the directory sits on the system
  disk and its free space would be the wrong disk's;
- the previous run is still going (lock file younger than 10 minutes), or a run takes over
  120 s.

The key never appears in output. Errors name the endpoint and the HTTP status or error code
only.

## Heartbeat (off)

When **both** `BOT_HEARTBEAT_URL` and `BOT_HEARTBEAT_TOKEN` are set in the env file, each
successful run also POSTs the same JSON report to that URL with `Authorization: Bearer <token>`.
With either one unset, the script only logs (`"heartbeat": "off"`).

- The URL must be `https` (plain `http` is allowed only to this machine).
- Any `/api/uptime/...` path is refused: that ingest is for up/down samples only.
- A failed post leaves the local report in place and adds one `WARN heartbeat failed` line.

Leave it unset until the bot has a sync heartbeat endpoint (a later slice).

## Install (Caleb or Edith, on PH, after Caleb's go-ahead)

Nothing below has been run on PH. Run each step on the box and check what it shows.

1. **Node:**
   ```sh
   node --version          # v24.x (the tier agent's runtime)
   command -v node         # /usr/bin/node
   ```
2. **Script:**
   ```sh
   sudo install -d -o root -g root -m 0755 /opt/ph-sync-reporter
   sudo install -o root -g root -m 0755 deploy/ph-sync-reporter/ph-sync-report.js /opt/ph-sync-reporter/ph-sync-report.js
   ```
3. **Key file**, root only, without printing the key. First confirm where Syncthing's config
   lives (recorded on Oct 26 as `/home/media/docker/syncthing/config/config.xml`):
   ```sh
   sudo ls -l /home/media/docker/syncthing/config/config.xml
   sudo sh -c 'umask 077; k=$(sed -n "s:.*<apikey>\(.*\)</apikey>.*:\1:p" /home/media/docker/syncthing/config/config.xml | head -n 1); [ -n "$k" ] || { echo "no apikey found" >&2; exit 1; }; printf "SYNCTHING_API_KEY=%s\n" "$k" > /etc/ph-sync-reporter.env'
   ```
4. **Folders.** The tier agent's `TIER_FOLDERS` already lists PH's folder ids and host paths;
   copy that line (it holds no secret):
   ```sh
   sudo sh -c 'grep "^TIER_FOLDERS=" /etc/tier-agent.env | sed "s/^TIER_FOLDERS=/PH_SYNC_FOLDERS=/" >> /etc/ph-sync-reporter.env'
   sudo chown root:root /etc/ph-sync-reporter.env && sudo chmod 600 /etc/ph-sync-reporter.env
   sudo grep -c . /etc/ph-sync-reporter.env    # 2 lines; don't cat it (the key is in it)
   ```
   If that line is missing, write `PH_SYNC_FOLDERS=` by hand with the ids from the Syncthing GUI:
   `id:/mnt/media/Media/Family Films;id:/mnt/media/Media/4k;id:/mnt/media/Media/Movies;id:/mnt/media/Media/TV Shows`.
5. **Dry run** (writes nothing):
   ```sh
   sudo /opt/ph-sync-reporter/ph-sync-report.js --dry-run
   ```
   Check:
   - it lists four folders, each need agreeing with the Syncthing GUI (Out of Sync);
   - free space agrees with `df -h /mnt/media`.
6. **Cron.** Add this line verbatim with `sudo crontab -e`. It calls the script file only, with
   no inline `&&` and no redirection, since the script writes and rotates its own files:
   ```
   */15 * * * * /opt/ph-sync-reporter/ph-sync-report.js
   ```
7. **After the first run:**
   ```sh
   tail -n 3 /var/log/ph-sync-reporter/sync-$(date +%F).log
   sudo cat /var/lib/ph-sync-reporter/latest.json
   ```
   Stall flags appear after 2 hours of runs.

**To remove it:**
- delete the crontab line;
- delete `/opt/ph-sync-reporter`, `/etc/ph-sync-reporter.env`, `/var/lib/ph-sync-reporter` and
  `/var/log/ph-sync-reporter`.

## Settings

| Variable | Default | |
|---|---|---|
| `SYNCTHING_API_KEY` | — | Required. Only in `/etc/ph-sync-reporter.env`. |
| `PH_SYNC_FOLDERS` | — | Required. `id:path;…` or JSON, same as `TIER_FOLDERS`. |
| `SYNCTHING_URL` | `http://127.0.0.1:8384` | Must be on this machine (or https). |
| `PH_SYNC_MEDIA_PATH` | `/mnt/media` | Must be a mount point. |
| `PH_SYNC_LOG_DIR` | `/var/log/ph-sync-reporter` | |
| `PH_SYNC_STATE_DIR` | `/var/lib/ph-sync-reporter` | `state.json`, `latest.json`, `reports/` |
| `PH_SYNC_KEEP_DAYS` | `60` | |
| `PH_SYNC_STALL_WINDOW_MINUTES` | `120` | |
| `PH_SYNC_STALL_MIN_MB` | `100` | Decimal MB. |
| `BOT_HEARTBEAT_URL`, `BOT_HEARTBEAT_TOKEN` | unset | Heartbeat is off unless both are set. |

Options: `--dry-run` (print the line and JSON, write nothing) and `--env-file <path>`.

## Tests

`node --test scripts/tests/ph-sync-reporter.test.js`, which is also part of `npm test`. It runs
against a fake Syncthing REST API that follows v2.1.7's answers, including `state: ""` with
stale numbers for a paused folder and `db/need` without a `files` key.
