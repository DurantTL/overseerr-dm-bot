# Tiering sync agent

The tiny per-node companion of the bot's regional tiering planner. It runs **on each edge
node** (California, Philippines, …), pulls that node's manifest from the bot, and converges the
local Syncthing replica onto it — ignore-first, then prune, never the other way around.

One run does, in order:

1. `GET <bot>/agent/manifest/<node>` with the node's bearer token. If the `planHash` is
   unchanged **and** the local inventory hasn't changed, it exits — safe on any schedule.
2. **Asserts the Syncthing folder is Receive Only** via the Syncthing REST API. If someone
   flipped it to send-receive, the agent aborts and reports — that misconfiguration is the only
   way an edge node could ever push a delete back to the master.
3. Writes the manifest's `.stignore` into the folder root.
4. Triggers a rescan and **confirms Syncthing loaded the ignore patterns**.
5. Prunes local files that are in `drop` *and* confirmed ignored (ignored files are never
   re-pulled). Every deletion is logged; paths are confined to the folder root.
6. `POST <bot>/agent/report/<node>` — bytes freed, errors, and (by default) the local media
   inventory `{relPath, sizeBytes, atime}`, which is the planner's demand signal for
   `demand_source = atime` nodes.

Requires Node 18+ (uses global `fetch`). No other dependencies.

## Configuration (environment)

| var | required | meaning |
|---|---|---|
| `TIER_BOT_URL` | ✅ | Bot base URL, e.g. `https://bot.example.com` |
| `TIER_NODE` | ✅ | This node's name in the bot's registry, e.g. `california` |
| `TIER_AGENT_TOKEN` | ✅ | Bearer token from `/tier-node token name:<node>` |
| `TIER_FOLDER_ROOT` | ✅ (single-folder) | Local path of the Syncthing folder (media root) |
| `TIER_FOLDERS` | ✅ (multi-folder) | Folder list for nodes whose library spans several Syncthing folders — replaces `TIER_FOLDER_ROOT`/`SYNCTHING_FOLDER_ID`. JSON `[{"id":"mafyh-4dn5b","path":"/mnt/media/Media/Movies"}, …]` **or** the compact `id:path;id:path` form. The agent asserts Receive-Only, writes a `.stignore`, rescans, and prunes **each** folder every run. |
| `SYNCTHING_URL` | | Syncthing GUI/REST address (default `http://127.0.0.1:8384`) |
| `SYNCTHING_API_KEY` | ✅ in practice | Syncthing REST API key |
| `SYNCTHING_FOLDER_ID` | ✅ (single-folder) | The media folder's Syncthing folder ID (multi-folder nodes carry ids in `TIER_FOLDERS`) |
| `TIER_STATE_DIR` | | Where plan/inventory state lives (default `/var/lib/tier-agent`) |
| `TIER_REPORT_INVENTORY` | | `0` disables the inventory report (leave on for atime nodes) |
| `TIER_DRY_RUN` | | `1` = log what would happen, write and delete nothing |

Multi-folder example (California's four folders):

```sh
TIER_FOLDERS='cfjvc-ykzis:/mnt/media/Media/Family Films;ch3dl-xnzem:/mnt/media/Media/4k;mafyh-4dn5b:/mnt/media/Media/Movies;wg9fc-ntkc4:/mnt/media/Media/TV Shows'
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
  -v /mnt/media:/media -v tier-agent-state:/state \
  tier-agent
```

Run it on an interval with your scheduler of choice (the container executes one run and exits,
same as the systemd unit).

## atime nodes (California)

The inventory report is the whole demand signal, so the media filesystem must record atime:
`relatime` is what you want (`findmnt -no FSTYPE,OPTIONS <mount>`), `noatime` means no signal.
Reading file *metadata* never bumps atime, and the agent collects the inventory before any
pruning — the signal stays honest.
