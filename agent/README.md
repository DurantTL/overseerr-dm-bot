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
4. Triggers a rescan and **confirms Syncthing loaded the ignore patterns**.
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

Requires Node 18+ (uses global `fetch`). No other dependencies.

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
| `TIER_DRY_RUN` | | `1` = log what would happen, write and delete nothing |

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
