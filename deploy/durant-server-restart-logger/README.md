# durant-server container restart logger

A report-only script that logs every container restart on durant-server. Each line has enough
facts to answer later: was that you, Watchtower, or something else?

It **never restarts, stops, starts, removes, pulls or execs anything**. It runs as `media@`
from cron, without sudo.

```
media@ crontab, every 5 min
  restart_logger.py --> docker ps -aq --no-trunc                      (every container)
                    --> docker inspect --format '<whitelisted fields>'
                    --> /proc/uptime                                   (host uptime)
                    --> docker logs --since/--until watchtower         (only when an image changed)
                    --> ~/restart-logger/logs/restarts-YYYY-MM-DD.log      (one line per change)
                    --> ~/restart-logger/reports/restarts-YYYY-MM-DD.jsonl (one JSON per change)
                    --> ~/restart-logger/latest.json, state.json (+ state.json.bak)
```

**Why it exists:**
- On Oct 27 all plex-stack containers restarted at about 22:03 CDT, and the bot container again
  at about 22:16. Nothing recorded why.
- On Oct 26 at 23:03 CDT, Plex, Radarr, Sonarr, Syncthing, qBittorrent, media-cloudflared and
  speedtest-tracker restarted together.

The bot's service card already counts restarts for its own services (#400). This covers the
whole host, keeps an event log, and classifies each restart.

**Runtime:** Python 3 standard library and the docker CLI. Both are already on Ubuntu 24.04 with
Docker. There are no packages to install and no `jq`.

## What each poll does

1. Lists every container (`docker ps -aq --no-trunc`, including stopped ones).
2. Reads these fields per container, and only these, through
   `docker inspect --format '{"id":{{json .Id}},…}'`:
   - id;
   - name;
   - `State.StartedAt`;
   - `State.Status`;
   - `RestartCount`;
   - image id;
   - image reference (used only to recognise Watchtower; never logged);
   - `HostConfig.RestartPolicy.Name`.

   The Go template means Docker never hands this script the container's env, command line,
   labels or mounts. The parser also keeps only those keys, as a second guard.
3. Reads the host uptime from `/proc/uptime`.
4. Compares with `state.json` (the last poll). Any change becomes a log line and a JSON line:
   - restarted;
   - recreated;
   - appeared;
   - gone;
   - stopped.
5. Backs up the previous state to `state.json.bak`, then writes the new state atomically.

A poll with no change writes **nothing** to the log. Only `state.json` and `latest.json` change.

## What polling can and can't tell

**Can:**
- **When:** that a restart happened between the previous poll and this one ("detected between …
  and … (poll window)"). Docker's `StartedAt` also gives the exact start of the **latest** run.
- **How many:** `RestartCount` only rises when Docker's restart policy restarts a container.
  If it rose by 2 between polls, the log says `restarts +2`. It never invents two event times.

**Can't:**
- **Earlier restarts:** the exact time of any restart before the latest one in a window.
- **Exit code:** the previous run's exit code. After a restart, `inspect` shows the new run only.
- **Actor:** who did it. A manual `docker restart`, a Portainer redeploy and a Docker daemon
  restart look alike from Docker's side.

## Classification (never more than the evidence shows)

| Class | When | Wording | Flagged unexplained |
|---|---|---|---|
| `watchtower-self` | Watchtower's own container (name `watchtower`, or an image reference containing `watchtower`) | "expected when Watchtower updates itself" | no |
| `image-changed` | the image id changed | "consistent with a Watchtower image update, not proof". It becomes "**Watchtower log matches this window**" when Watchtower's log for the window has `Found new` and `Stopping /<name>` or `Creating /<name>`. If the log can't be read: "… (Watchtower log not readable)". | no |
| `host-reboot` | 3 or more image-unchanged restarts in one window **and** the host booted inside the window (uptime reset) | "consistent with a host reboot", with the boot time | no |
| `stack-wide` | 3 or more image-unchanged restarts, host **not** rebooted | "consistent with a stack redeploy or Docker daemon restart; check Portainer redeploy history (not proof)" | **yes** |
| `policy-restart` | 1–2 containers whose `RestartCount` rose | "Docker's restart policy restarted it after it exited by itself; a crash or OOM is consistent" | **yes** |
| `recreated` | 1–2 containers with a new id and the same image | "consistent with a stack redeploy or manual recreate, not a Watchtower update" | **yes** |
| `unexplained` | anything else, for example one container restarted with the same image | "unexplained: needs a human check" | **yes** |

Containers that **appeared**, are **gone**, or **stopped** (running → not running, no new
start) are logged and never flagged.

**Not used:** "manual" is never claimed. Dashboard Restart-button presses are audited
(`dashboard_service_restart`), but in the bot's SQLite inside the `durant_bot_data` Docker volume.
That lives under `/var/lib/docker/volumes`, which is root-only, and media@ can't read it without
sudo or `docker exec`/`docker cp`. So that evidence isn't used, and no restart is ever labelled
a dashboard restart.

A cluster's long wording is logged once as a `CLUSTER` line. Each container's line then says
"part of the cluster above", and its JSON line carries the full wording.

## Output

**Log**, `~/restart-logger/logs/restarts-YYYY-MM-DD.log`. These are illustrative lines from the
tests, not real events:

```
2026-10-27T22:00:00-05:00 BASELINE 8 containers recorded; restarts before this poll are unknown (not 0) · host up 30d 0h
2026-10-27T22:05:00-05:00 RESTART radarr detected between 2026-10-28T03:00:00Z and 2026-10-28T03:05:00Z (poll window) · latest start 2026-10-28T03:03:12.5Z (was 2026-10-20T03:00:00.123456789Z) · restarts +0 · image unchanged · policy unless-stopped · host up 30d 0h · unexplained: needs a human check · UNEXPLAINED
2026-10-27T22:10:00-05:00 RESTART plex detected between … (poll window) · latest start 2026-10-28T03:07:40.1Z (was …) · count reset (new container) · image changed bbbbbbbbbbbb→6d6d6d6d6d6d · policy unless-stopped · host up 30d 0h · image changed: Watchtower log matches this window
2026-10-27T22:15:00-05:00 CLUSTER detected between 2026-10-28T03:10:00Z and 2026-10-28T03:15:00Z (poll window) · media-cloudflared, plex, qbittorrent, radarr, sonarr, speedtest-tracker, syncthing · 7 containers restarted in this window and the host did not reboot (up 30d 0h): consistent with a stack redeploy or Docker daemon restart; check Portainer redeploy history (not proof) · UNEXPLAINED
2026-10-27T22:15:00-05:00 RESTART plex detected between … · restarts +0 · image unchanged · policy unless-stopped · host up 30d 0h · part of the cluster above · UNEXPLAINED
2026-10-27T22:20:00-05:00 FAIL docker ps failed: daemon unreachable; no restart report this poll
```

**JSON**, `~/restart-logger/reports/restarts-YYYY-MM-DD.jsonl`. There is one object per event,
plus baseline and failure lines:

```json
{"at":"2026-10-28T03:05:00Z","ok":true,"window":{"from":"2026-10-28T03:00:00Z","to":"2026-10-28T03:05:00Z"},
 "hostUptimeSeconds":2592000,"type":"restart","name":"radarr",
 "old":{"id":"222222222222","startedAt":"2026-10-20T03:00:00.123456789Z","status":"running","restartCount":0,"image":"cccccccccccc","policy":"unless-stopped"},
 "new":{"id":"222222222222","startedAt":"2026-10-28T03:03:12.5Z","status":"running","restartCount":0,"image":"cccccccccccc","policy":"unless-stopped"},
 "recreated":false,"restartDelta":0,"imageChanged":false,
 "classification":"unexplained","unexplained":true,"explanation":"unexplained: needs a human check"}
```

**`latest.json`** holds the last poll:

```json
{ "ok": true, "at": "…", "containers": 8, "hostUptimeSeconds": 2592000, "baseline": false,
  "window": {"from": "…", "to": "…"}, "restarts": 1, "unexplained": 1, "events": [ … ], "heartbeat": "off" }
```

On a failed poll it holds `{ "ok": false, "at", "reason", "error" }` and no counts. A failure is
never reported as "no restarts".

**Retention:** dated logs and reports older than 30 days (`RESTART_LOGGER_KEEP_DAYS`) are deleted
by the script, matching the bot's uptime and heartbeat retention. Restarts are rare, so files stay
tiny: a quiet day writes nothing at all.

## Failures and recovery

On any of these, the poll exits **1**, writes one `FAIL` line, reports nothing about restarts and
leaves `state.json` untouched:

- **Docker daemon unreachable**, or **permission denied**. The second means media@ isn't in the
  `docker` group; that's a root step, not something the script works around.
- **docker timeout:** a Docker call didn't answer within 30 s.
- **Unreadable inspect output.**
- **Unreadable uptime:** `/proc/uptime` couldn't be read.
- **Corrupt state file.**
- **Lock held:** a previous poll still holds the lock. This prints to stderr only.

**Corrupt `state.json`:** the file is not overwritten, and `state.json.bak` still holds the
last good state. To recover:

```sh
mv ~/restart-logger/state.json ~/restart-logger/state.json.corrupt
```

The next poll then **baselines**. It logs "BASELINE n containers recorded; restarts before this
poll are unknown (not 0)", never "0 restarts". Alternatively, copy `state.json.bak` back over
`state.json`; the next poll's window then starts at that older poll.

## Heartbeat (off)

When **both** `BOT_HEARTBEAT_URL` and `BOT_HEARTBEAT_TOKEN` are set in `~/.config/restart-logger/env`
(mode 600), each poll posts the bot's common heartbeat fields to its
`POST /api/automation/heartbeat` (#438):

```json
{ "name": "restart-logger", "source": "durant-server", "status": "ok",
  "summary": "1 restart(s) in window, 1 unexplained", "counts": { "restarts": 1, "unexplained": 1, "containers": 8 } }
```

- A failed poll posts `status: "fail"`.
- The URL must be https (plain http only to this machine).
- Any `/api/uptime/...` path is refused.
- A failed post adds one `WARN heartbeat failed …; logging continues` line. The poll still
  succeeds.

Leave it unset until Caleb approves the wiring.

## Install (Caleb or Edith, after Caleb's go-ahead)

Nothing below has been run on durant-server. Everything runs as **media@, with no sudo**.

1. **Check that Docker reads work as media@**, the same calls the script makes:
   ```sh
   id -nG | tr ' ' '\n' | grep -x docker      # prints "docker"
   docker ps -aq --no-trunc | wc -l           # the container count
   docker inspect --format '{{.Name}} {{.RestartCount}}' $(docker ps -aq | head -n 1)
   docker logs --since 10m watchtower >/dev/null 2>&1 && echo watchtower-log-readable
   python3 --version
   ```
   If `docker` isn't in the groups or the reads fail with "permission denied", adding media@ to
   the `docker` group is a root step for Caleb. Don't work around it with sudo or the
   emergency-host-shell container. If the Watchtower check doesn't print, the logger still
   works and uses the weaker image-changed wording.
2. **Place the script** (same `~/bin` as the staging sweep):
   ```sh
   install -d -m 0750 ~/bin ~/restart-logger
   install -m 0750 deploy/durant-server-restart-logger/restart_logger.py ~/bin/restart_logger.py
   ```
3. **Dry run** (writes nothing):
   ```sh
   ~/bin/restart_logger.py --dry-run
   ```
   Expect a `BASELINE n containers` line, where n is the `docker ps -aq | wc -l` count, plus the
   JSON summary.
4. **Cron.** First read the current crontab with `crontab -l`. It should hold the two crons from
   the Oct 21 cleanup: the staging sweep, Sundays 09:17 UTC, and the latest-movies sync, daily
   05:00 UTC. Then add this one line verbatim with `crontab -e`. It calls the script file only,
   with no `&&` and no redirection; the script writes and rotates its own files:
   ```
   */5 * * * * /home/media/bin/restart_logger.py
   ```
5. **After 10 minutes:**
   ```sh
   cat ~/restart-logger/logs/restarts-$(date +%F).log   # one BASELINE line, then only changes
   cat ~/restart-logger/latest.json
   ```

**Why every 5 minutes:**
- The poll is cheap: one `ps` and one `inspect` for all containers. Watchtower's log is read only
  when an image changed.
- A 5-minute window pins a restart close enough to compare with a merge time or a Portainer
  action. It matches the RackNerd checker's cadence.
- On Oct 27, 22:03 versus 22:16 would have been separate windows.

**To remove it:** delete the crontab line, then delete `~/bin/restart_logger.py`,
`~/restart-logger` and `~/.config/restart-logger`.

## Tests

`python3 -m unittest discover -s deploy/durant-server-restart-logger -p 'test_*.py'`, which is
also part of `npm test` (`scripts/tests/restart-logger.test.js`). They run against a fake
`docker` CLI that refuses anything but `ps`, `inspect` and `logs`.
