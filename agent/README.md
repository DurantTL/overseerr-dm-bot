# Tiering sync agent

The tiny per-node companion of the bot's regional tiering planner. It runs **on each edge
node** (California, Philippines, …), pulls that node's manifest from the bot, and converges the
local Syncthing replica onto it — ignore-first, then prune, never the other way around.

One run does, in order:

1. `GET <bot>/agent/manifest/<node>` with the node's bearer token. If the `planHash` is
   unchanged **and** the local inventory hasn't changed, it POSTs a lightweight
   `{heartbeat:true}` and exits — safe on any schedule. The heartbeat is proof of life so the bot
   can tell a healthy idle node from a stopped / unreachable / timer-broken one (last-check-in age
   shows in `/tier-node list`, `/tier preview`, and the dashboard).
2. **Asserts the Syncthing folder is Receive Only** via the Syncthing REST API. If someone
   flipped it to send-receive, the agent aborts and reports — that misconfiguration is the only
   way an edge node could ever push a delete back to the master.
3. Writes the manifest's `.stignore` into the folder root — atomically (temp file in the same
   directory, fsynced, then renamed into place), so a crash or a rescan racing the write can
   never observe a truncated or empty ignore file.
4. Checks the folder's Syncthing state (`GET /rest/db/status`) before forcing a rescan. If it's
   still `scanning`/`syncing` — expected on a brand-new node with a large freshly-populated
   library — the agent skips prune for that folder this run and retries on the next scheduled
   cycle instead of forcing its own rescan on top of one already running (which is what used to
   time out and fail the systemd unit). Otherwise it triggers a rescan and **confirms Syncthing
   loaded the ignore patterns**.
5. Prunes local files that are in `drop` *and* confirmed ignored (ignored files are never
   re-pulled). Every deletion is logged; paths are confined to the folder root. Deletion is
   asynchronous and one title at a time (`fs.promises.rm`, which yields to the event loop rather
   than blocking Node on a big TV folder), and freed bytes are estimated from the planner's
   inventory size instead of a synchronous recursive stat of the tree.
6. `POST <bot>/agent/report/<node>` — bytes freed, errors, and (by default) the local media
   inventory `{relPath, sizeBytes, atime}`, which is the planner's demand signal for
   `demand_source = atime` nodes. The inventory is walked before step 5 (reading metadata never
   bumps atime), but whatever step 5 actually pruned is subtracted before it's sent — the report
   reflects this run's real end state, not a stale pre-prune snapshot the bot would otherwise
   have to wait a whole extra cycle to correct.

Requires Node.js 24, matching the bot image, CI, and package runtime contract. The installer
provisions Node.js 24 through NodeSource when an older runtime is present on an apt-, dnf-, or
yum-based Linux host. A newer unsupported major fails with an actionable message instead of being
used silently. No other runtime dependencies are needed.

## Install (one command)

The dashboard and `/tier-node token name:<node>` generate a ready-to-paste installer for that node.
Run it **on the selected node**—edge or full master—not merely inside the bot container:

```sh
export TIER_AGENT_TOKEN=<the token it just showed you>
curl -fsSL -H "Authorization: Bearer $TIER_AGENT_TOKEN" https://<bot-domain>/agent/install/<node> \
  | sudo -E env SYNCTHING_API_KEY=... TIER_FOLDERS='[{"id":"movies","path":"/mnt/media/Movies"}]' sh
```

It installs `agent.js` to `/opt/tier-agent`, writes the token to root-only `/etc/tier-agent.env`,
installs `tier-agent.service` + a 15-minute `tier-agent.timer`, and runs once so a failure shows up
immediately rather than fifteen minutes later. Both endpoints require the node's own bearer token,
so nothing new is exposed publicly.

Config comes from the environment rather than prompts, because stdin is the script itself when
piped — an interactive `read` would eat the rest of the file. Required in that `env` list:
`SYNCTHING_API_KEY`, either `TIER_FOLDERS` or the legacy single-folder pair `TIER_FOLDER_ROOT` +
`SYNCTHING_FOLDER_ID`, and `TIER_AGENT_TOKEN` exported above. The dashboard generates
`TIER_FOLDERS` directly from every folder row for the selected node. Anything else from the table
below can be added the same way; `TIER_MOUNT_ROOT` +
`TIER_MOUNT_MARKER` in particular if the media sits on an external drive.

`sudo -E` matters — without it your environment does not survive into the script, and it will stop
and tell you what is missing rather than install something half-configured.

Re-running the command is safe: it overwrites the agent and the env file, and the units are
rewritten and reloaded. Rotating the token with `/tier-node token` again just means re-running it.

## Configuration (environment)

| var | required | meaning |
|---|---|---|
| `TIER_BOT_URL` | ✅ | Bot base URL, e.g. `https://bot.example.com` |
| `TIER_NODE` | ✅ | This node's name in the bot's registry, e.g. `california` |
| `TIER_AGENT_TOKEN` | ✅ | Bearer token from `/tier-node token name:<node>` |
| `TIER_FOLDER_ROOT` | ✅ (single-folder) | Local path of the Syncthing folder (media root) |
| `TIER_FOLDERS` | ✅ (multi-folder) | Folder list for nodes whose library spans several Syncthing folders — replaces `TIER_FOLDER_ROOT`/`SYNCTHING_FOLDER_ID`. JSON `[{"id":"aaaaa-bbbbb","path":"/mnt/media/Media/Movies"}, …]` **or** the compact `id:path;id:path` form. The agent asserts Receive-Only, writes a `.stignore`, rescans, and prunes **each** folder every run. |
| `SYNCTHING_URL` | | Syncthing GUI/REST address (default `http://127.0.0.1:8384`) |
| `SYNCTHING_API_KEY` | ✅ in practice | Syncthing REST API key |
| `SYNCTHING_FOLDER_ID` | ✅ (single-folder) | The media folder's Syncthing folder ID (multi-folder nodes carry ids in `TIER_FOLDERS`) |
| `TIER_STATE_DIR` | | Where plan/inventory state lives (default `/var/lib/tier-agent`) |
| `TIER_REPORT_INVENTORY` | | `0` disables the inventory report (leave on for atime nodes) |
| `TIER_MOUNT_ROOT` | | External media-drive mount point, e.g. `/mnt/media`. **Setting this enables the mount guard** (below) and **requires `TIER_EXPECTED_UUID` and/or `TIER_MOUNT_MARKER`**. All folder roots must live under it. |
| `TIER_EXPECTED_UUID` | | Filesystem UUID the drive at `TIER_MOUNT_ROOT` must have (`blkid`/`lsblk -o NAME,UUID`). Requires `TIER_MOUNT_ROOT`. Linux/host deploys. |
| `TIER_MOUNT_MARKER` | | Sentinel file that lives on the drive, relative to the mount root (e.g. `.tier-media-ok` — create once with `touch /mnt/media/.tier-media-ok`). Its absence means the real drive isn't there. Requires `TIER_MOUNT_ROOT`. **The right proof for Docker / bind-mount deploys.** |
| `EDGE_MERGED_ROOT` | | (#181) The mergerfs merged-library mount Plex points at, e.g. `/mnt/plex-library`. Setting this enables the read-only merged-mount diagnostic (below) and **requires `EDGE_REMOTE_ROOT`**. |
| `EDGE_REMOTE_ROOT` | | (#181) The read-only remote-fallback branch of the merged mount, e.g. `/mnt/master-ro`. Requires `EDGE_MERGED_ROOT`. |
| `EDGE_LOCAL_ROOT` | | (#181) The merged mount's local (RW) branch, if it differs from this node's own folder root — most nodes leave this unset and it defaults to `TIER_FOLDER_ROOT` / the first `TIER_FOLDERS` entry. |
| `EDGE_MOUNT_SAMPLE_RELPATHS` | | (#181) Comma-separated paths (relative to both branches) of one or more titles known to be cached locally, used to verify local-first precedence every cycle. Optional but recommended — without it the diagnostic can't prove precedence, only presence/read-only. |
| `TIER_DRY_RUN` | | `1` = log what would happen, write and delete nothing |
| `TIER_MONITOR_ONLY` | | `1` = **monitor-only mode** (backup boxes, non-Plex servers — see below). Only `TIER_AGENT_TOKEN` + `TIER_FOLDER_ROOT` are required; no Syncthing, no tier plan. |
| `TIER_SMART_DEVICES` | | Comma/space-separated drive devices for SMART health checks, e.g. `/dev/sda, /dev/nvme0n1`. Unset = best-effort derivation from the watched filesystem's block device. `smartctl` missing or a device unreadable just yields no reading — never a failed report. |
| `TIER_AGENT_LEGACY_IGNORE_DIR` | | §182. Directory holding the persistent manual ignore overlay (`<folderId>.txt`, one `/relPath` pattern per line). **Unset by default — reproduces prior behaviour exactly.** When set, the agent merges `planner-drops ∪ legacy-ignores − active-promotion-pins` (the manifest's `pinnedRelPaths`) instead of writing the planner's drops verbatim, so an active play-promotion pin can override a legacy-ignored title, and the override reverts on its own once the pin expires. |

## Mount guard (external media drive)

The single most dangerous failure on an edge node is the media drive **not remounting** after a
reboot or power loss: `/mnt/media` reverts to an ordinary empty directory on the internal system
disk, Syncthing starts re-pulling the whole library onto that disk, and the agent — walking an
empty tree — reports an empty inventory that tells the bot the node holds nothing.

When `TIER_MOUNT_ROOT` is set, the agent runs a preflight **before** any network call, `.stignore`
write, prune, or inventory walk, and aborts the run unless the real drive is proven present:

- **at least one positive proof** must pass — the filesystem mounted at the root is the expected
  `TIER_EXPECTED_UUID`, **or** the `TIER_MOUNT_MARKER` sentinel (a file that lives on the drive) is
  present. A bare "is it a mount point?" check is deliberately **not** trusted: a Docker bind mount
  looks like a distinct mount from inside the container even when the host drive failed to remount
  and the empty fallback dir is what's bound in. So `TIER_MOUNT_ROOT` **requires a UUID or a
  marker** — for containers, use the marker (or a UUID via a host-mounted `/dev`);
- a configured proof that *fails* (wrong/absent UUID, missing marker) is always a hard abort;
- every configured folder root lives **under** the mount and on the **same filesystem** (nothing
  fell back onto the system disk).

On failure the agent reports `driveMissing` to the bot **without** an inventory (so the bot keeps
the node's last-known contents instead of wiping them), exits non-zero, and touches nothing on
disk. The bot alerts once on the transition into the drive-missing state and once on recovery —
the agent forces a report on the recovery run even when nothing else changed, so a stable library
still clears the alert. Leave `TIER_MOUNT_ROOT` unset on single-machine / master deployments to
keep the guard off.

```sh
TIER_MOUNT_ROOT=/mnt/media
TIER_EXPECTED_UUID=1a2b3c4d-5e6f-7890-abcd-ef1234567890   # host/bare-metal
TIER_MOUNT_MARKER=.tier-media-ok                          # touch /mnt/media/.tier-media-ok (best for containers)
```

Multi-folder example (California's four folders):

```sh
TIER_FOLDERS='aaaaa-bbbbb:/mnt/media/Media/Family Films;ccccc-ddddd:/mnt/media/Media/4k;eeeee-fffff:/mnt/media/Media/Movies;ggggg-hhhhh:/mnt/media/Media/TV Shows'
```

The node is still one budget pool with one eviction plan; the manifest just splits `drop`
per folder and the agent converges each folder root independently.

## Merged-mount diagnostic (#181)

Once this node has stood up the merged-library view from
[`docs/mergerfs-plex-operational.md`](../docs/mergerfs-plex-operational.md) (mergerfs local branch
+ read-only remote fallback), set `EDGE_MERGED_ROOT`/`EDGE_REMOTE_ROOT` (and ideally
`EDGE_MOUNT_SAMPLE_RELPATHS`) so the agent verifies it every cycle instead of only at hand-check
time:

```sh
EDGE_MERGED_ROOT=/mnt/plex-library
EDGE_REMOTE_ROOT=/mnt/master-ro
EDGE_MOUNT_SAMPLE_RELPATHS=Movies/Some Cached Movie (2020)/movie.mkv
```

Every report then carries a `mergedMountDiagnostics` result (mount presence, remote read-only,
remote reachability, local-first precedence) — read-only checks, never a write or delete — which
`/doctor` on the bot surfaces per node. Leave both unset until the merged mount actually exists;
an unconfigured node contributes no checks (not a failure).

## systemd

```sh
sudo cp tier-agent.service tier-agent.timer /etc/systemd/system/
sudo mkdir -p /etc/tier-agent && sudo $EDITOR /etc/tier-agent/agent.env   # the vars above
sudo systemctl daemon-reload
sudo systemctl enable --now tier-agent.timer
```

First run: set `TIER_DRY_RUN=1` in the env file, `systemctl start tier-agent.service`, and read
`journalctl -u tier-agent` before letting it loose.

## Docker

```sh
docker build -t tier-agent .
docker run --rm \
  -e TIER_BOT_URL=... -e TIER_NODE=... -e TIER_AGENT_TOKEN=... \
  -e SYNCTHING_URL=http://syncthing:8384 -e SYNCTHING_API_KEY=... -e SYNCTHING_FOLDER_ID=media \
  -e TIER_FOLDER_ROOT=/media -e TIER_STATE_DIR=/state \
  -e TIER_MOUNT_ROOT=/media -e TIER_MOUNT_MARKER=.tier-media-ok \
  -v /mnt/media:/media -v tier-agent-state:/state \
  tier-agent
```

The mount guard is important here: a Docker bind mount always looks like a real mount point from
inside the container, so a host drive that fails to remount would bind in an empty fallback dir and
Syncthing would re-pull onto it. Use `TIER_MOUNT_MARKER` (a sentinel file created on the drive with
`touch /mnt/media/.tier-media-ok`) so the guard sees the drive is gone; a bare mount-point check
would not.

Run it on an interval with your scheduler of choice (the container executes one run and exits,
same as the systemd unit).

## atime nodes / the atime fallback

**Prefer `demand_source = plex` when the bot can reach the node's PMS** (e.g. over Tailscale):
it reads real watch history from the node's own Plex server, which is immune to Plex's scheduled
file scans — the exact reads that pollute atime and force the `atime_mask` laundering. In plex
mode the agent's inventory report is still the **fallback** (per-title for anything PMS has no
view record of, whole-node when PMS is unreachable), so keep `TIER_REPORT_INVENTORY` on either way.

For pure-atime nodes (PMS unreachable from the bot), the inventory report is the whole demand
signal, so the media filesystem must record atime: `relatime` is what you want
(`findmnt -no FSTYPE,OPTIONS <mount>`), `noatime` means no signal. Reading file *metadata* never
bumps atime, and the agent collects the inventory before any pruning — the signal stays honest.

## Monitor-only mode (backup boxes)

Servers that aren't Plex edge nodes — the two backup boxes, for example — still need
disk-space and drive-health visibility, but they run no tier plan, no Syncthing, and no
pruning. Register them with `/tier-node add name:<node> monitor_only:true
folder_root:/mnt/backup`, then mint the token with `/tier-node token name:<node>` —
the generated installer command carries `TIER_MONITOR_ONLY=1` and needs only the token
and the watched path (no `SYNCTHING_API_KEY`, no folder IDs).

What the agent does each cycle in monitor-only mode:

- Reports heartbeat + full system telemetry (load, temps, RAM, uptime).
- Reports free/total bytes of the watched filesystem (`TIER_FOLDER_ROOT`) — this is what
  feeds the fleet `/api/v1/disks` endpoint and the low-space alerts.
- Reports SMART health (`TIER_SMART_DEVICES`, or best-effort derivation from the watched
  filesystem's block device) — this feeds the drive-health alerts.
- Skips everything else: no manifest fetch, no mount guard, no inventory walk, no
  `.stignore` writes, no pruning.
- Runs hardened: the watched filesystem is mounted read-only into the unit
  (`ReadOnlyPaths`); the only writable path is the agent's state directory
  (`/var/lib/tier-agent`).

These nodes have no tier plan and never appear in `/tier preview`. For SMART readings,
install `smartmontools` on the box (`apt install smartmontools` / `dnf install
smartmontools`); if it's missing the agent just reports no SMART data and keeps going.
