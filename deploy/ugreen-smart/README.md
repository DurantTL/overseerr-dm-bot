# UGREEN Central Iowa — SMART reporter

A small container on the UGOS box that reads the host's disk health once a day and reports it
to the bot as the monitor-only node **central-iowa**. It shows up in the bot's existing
fleet-disks view and SMART transition alerting; the bot needs no code change.

```
container (Debian slim, this folder)            UGOS host
  smart_report.py  --ssh, dedicated key-->  sudo -n /usr/local/sbin/central-iowa-smart-report
                   <--- one JSON object ----  (discovery + one `smartctl -i -H -A -j` per disk)
       |
       +--> POST https://media.durantlogic.com/agent/report/central-iowa  (Bearer node token)
       +--> /reports/smart-YYYY-MM-DD.json  and  docker logs
```

The container can't see the host's disks, so it SSHes in. The key can do exactly one thing:
run the read-only wrapper. It never starts a SMART self-test (`smartctl -t` is a manual action
only) and never changes a disk setting. Nothing is installed on the UGOS host apart from the
wrapper file, one sudoers line and one authorized_keys line.

## Why daily

A SMART read wakes a sleeping disk, so it runs **once a day** at 03:17 America/Chicago
(`SMART_SCHEDULE`), plus once when the container starts. Each run makes one `smartctl` call
per disk.

## What is reported

| Where | What |
|---|---|
| **Bot** (fleet-disks view, SMART alerts) | Per disk: `device · model` (for example `/dev/sda · WDC WD40EFPX-68C6CN0`) and `ok` / `failing`. Free/total bytes of the data volume **only if `DATA_PATH` is set** on the host (see below). No serial numbers. |
| **`/reports/smart-YYYY-MM-DD.json`** (kept 60 days) | Every disk found: device, model, health PASSED / FAILED / UNKNOWN, temperature, reallocated sectors, current pending sectors, offline uncorrectable, power-on hours, error text. No serial numbers. |
| **`docker logs`** | One line per disk with the same fields, the disk count and source, and the outcome. |

### Free/total space

The bot lists a node as a row in its fleet-disks view only when it reports the volume's total
size; without one, the SMART alerts still work but there is no row. The wrapper reports
free/total only for an explicit path: set `DATA_PATH` in the wrapper on the host to the
Syncthing data volume (for example `/volume1`; confirm it in the UGOS UI). Left empty, it
reports SMART only.

## Failure rules (strict)

It posts **nothing** and exits non-zero when:

- SSH fails, or the host key doesn't match the pinned one;
- the host's output can't be parsed;
- no disk is found (`/proc/mdstat` and `smartctl --scan` both empty);
- **any** disk reads UNKNOWN (couldn't be opened, no health result). The bot can only hold
  `ok` / `failing`, and a disk missing from a report would read as a recovery there, so a
  partial reading is never sent;
- smartmontools isn't installed on the host. Every disk from `/proc/mdstat` is reported
  UNKNOWN with "smartmontools missing on host" in the local report and logs. Installing it is a
  host decision; nothing installs it;
- the bot refuses the post (wrong token, unknown node).

The local report and logs still record what happened. When the reporter goes quiet, the bot
shows the node's telemetry age growing (fleet-disks `telemetryAgeMs`, `/tier-node list`).

**Note on staleness:** the bot marks telemetry older than 12 hours as stale, and its `/doctor`
"Tier agent" check expects a check-in every 15 minutes. With a once-a-day reporter, the
central-iowa row shows as stale for part of each day and `/doctor` shows a warning for it.
That is display only; SMART transition alerts still fire on each daily report. A per-node
staleness window would need a small bot change in a later slice.

## Setup

### 1. Dedicated key (on your own machine)

If the existing container uses a general admin key, replace it with this dedicated one.

```sh
ssh-keygen -t ed25519 -N '' -C central-iowa-smart -f smart_ssh_key
```

`smart_ssh_key` is the private key: it goes into the container as a mounted file only, never
into the image or git. `smart_ssh_key.pub` goes into the host's authorized_keys line below.

### 2. Host side (UGOS; three things)

Recommended design: a forced command plus sudoers for that one script.

1. Copy `host/central-iowa-smart-report.sh` to `/usr/local/sbin/central-iowa-smart-report`,
   owned by root, mode 0755. Optionally set `DATA_PATH` in it (see above).
2. Sudoers, `/etc/sudoers.d/central-iowa-smart`, mode 0440:
   ```
   <ssh-user> ALL=(root) NOPASSWD: /usr/local/sbin/central-iowa-smart-report
   ```
3. In `<ssh-user>`'s `~/.ssh/authorized_keys`, one line:
   ```
   restrict,command="sudo -n /usr/local/sbin/central-iowa-smart-report" ssh-ed25519 AAAA...your-public-key... central-iowa-smart
   ```
   `restrict` turns off port, agent and X11 forwarding and the PTY. Whatever command a client
   asks for, the host runs only the wrapper.

**Fallback** (if you'd rather not add a host script): the same key and authorized_keys line
without `command=` (keep `restrict`), sudoers limited to smartctl only
(`<ssh-user> ALL=(root) NOPASSWD: /usr/sbin/smartctl`; check the path with `command -v smartctl`),
and `SMART_MODE=remote` on the container, which pipes this same wrapper over SSH and runs smartctl
through `sudo -n`. Reads stay read-only, but the key can run any command as `<ssh-user>`, so the
forced-command design is preferred. Use `SMART_DATA_PATH` for free/total in this mode.

### 3. Pin the host key

```sh
ssh-keyscan -t ed25519 <ugos-host> > known_hosts
ssh-keygen -lf known_hosts                              # compare with, on the UGOS console:
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub       # the fingerprints must match
```

The container connects with `StrictHostKeyChecking=yes` against this file only. A changed host
key stops the reporter (no post) until you re-pin it on purpose.

### 4. Register the node in the bot (Discord, admin)

```
/tier-node add name:central-iowa monitor_only:True folder_root:<watched-path>
/tier-node token name:central-iowa
```

The token reply also shows an install command for the full tier agent: **don't run it on the
UGOS box**; only the token is needed. Pass the token over a secure channel into a file for the
container. It never goes into code, a PR or chat. This node stays monitor-only: no tier plan,
no .stignore, no pruning, no Syncthing changes.

### 5. Run the container

See `docker-compose.example.yml`. The container runs as uid 10001, so the mounted files must be
readable by it and the reports folder writable:

```sh
chown 10001 smart_ssh_key tier_node_token && chmod 400 smart_ssh_key tier_node_token
chown 10001 reports
docker build -t central-iowa-smart:latest deploy/ugreen-smart
docker compose -f docker-compose.example.yml up -d
```

First check, with nothing sent to the bot:

```sh
docker run --rm <same env and mounts> central-iowa-smart:latest once --dry-run
```

It logs each disk and prints the payload that would be posted. Compare the disk count with
the UGOS UI, then let the container run (`restart: unless-stopped`).

## Environment

| Variable | Default | |
|---|---|---|
| `SMART_SSH_HOST`, `SMART_SSH_USER` | — | The UGOS host and account. Required. |
| `SMART_SSH_PORT` | `22` | |
| `SMART_SSH_KEY` | `/run/secrets/smart_ssh_key` | Private key file (mounted). |
| `SMART_KNOWN_HOSTS` | `/config/known_hosts` | Pinned host key (mounted). |
| `SMART_MODE` | `wrapper` | `remote` for the fallback design. |
| `SMART_DATA_PATH` | — | Remote mode only: data volume path for free/total. |
| `BOT_URL` | — | For example `https://media.durantlogic.com`. |
| `TIER_NODE` | `central-iowa` | |
| `TIER_NODE_TOKEN_FILE` | — | File holding the node token (or `TIER_NODE_TOKEN`). |
| `SMART_SCHEDULE` | `03:17` | Daily run, local time. |
| `TZ` | `America/Chicago` | |
| `SMART_REPORT_DIR` | `/reports` | Dated JSON reports. |
| `SMART_REPORT_KEEP_DAYS` | `60` | |

## Tests

`python3 -m unittest discover -s deploy/ugreen-smart -p 'test_*.py'`, also run by `npm test`
(`scripts/tests/ugreen-smart-reporter.test.js`).
