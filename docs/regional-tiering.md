# Regional Tiering ("edge cache")

Multiple nodes each run their own Plex against a local Syncthing replica of the media tree
(home is the sole sender; every other node is Receive Only). The tiering planner keeps each
edge node's replica curated to its disk budget: a per-node keep/drop manifest, published by the
bot and converged by a tiny standalone sync agent on each node (`agent/`).

A node's library can span **several Syncthing folders** (e.g. California's `Movies`, `4k`,
`TV Shows`, `Family Films`) while remaining **one budget pool with one eviction plan** — the
manifest splits the drop set per folder (one `.stignore` per folder root) and the agent asserts
Receive Only, writes ignores, rescans and prunes each folder every run. Manage a node's folders
with `/tier-node folder add|remove|list`; the agent lists them in `TIER_FOLDERS`. Single-folder
nodes (one `folder_root`, one `SYNCTHING_FOLDER_ID`) are unchanged.

The dashboard installer shows four folder ID/path rows immediately (and can add more), preloads the
saved mappings when switching nodes, atomically replaces that node's complete folder registry, and
generates `TIER_FOLDERS` without hand-editing. Use the same setup for edge nodes and the `full`
master so inventory and folder-relative manifests agree everywhere.

For this deployment, California is an edge node even though its viewers belong to **Main**. Its
3 TB budget should be the tier node's usable media capacity. Philippines should count only the
5 TB external media drive as usable capacity; the 1 TB system SSD is not part of the media pool.
Both nodes must use the mount guard below so a missing external/real media mount cannot redirect
sync writes onto a system disk or an empty fallback directory.

How each node is curated:
- **Tier 0 (floor, never evicted):** keep list ∪ `NEVER_DELETE_MEDIA_IDS` ∪ the universal core
  (top-K titles by summed plays across every node's Tautulli). Any title with no copy on an
  enabled `full` master is force-kept everywhere — edge pruning can never lose data.
- **Tier 1 (node demand):** per `demand_source`:
  - `tautulli` — the node's own Tautulli history
    (`recencyDecay × log1p(plays) × log1p(distinctUsers)`).
  - `plex` — the node's own PMS watch history **directly**
    (`/status/sessions/history/all` with `plex_url`/`plex_token`), scored
    `recencyDecay(lastViewedAt) × log1p(viewCount)`. Real playback is a true watch (no atime
    pollution), and PMS history is per-server, so it's inherently node-local. Any title Plex has
    no view record for **falls back to that title's `atime`**; a title with neither is coldest
    (still protected by the fresh-added grace window). If the local PMS is unreachable the node
    simply falls back to atime for everything — the plan never fails.
  - `atime` — an LRU over file last-read times reported by the agent; atime only moves when
    *that node's* Plex reads a file. The media filesystem must be mounted `relatime` (not
    `noatime`), and Plex's nightly read-heavy tasks (extensive analysis, preview thumbnails,
    intro/credit detection) should be disabled on that server or they count as watches. As a
    backstop, set the node's `atime_mask` (`HH:MM-HH:MM`, UTC, may wrap midnight) to the
    maintenance window: reads landing in that window are laundered at report ingest — the
    previously stored atime (the last plausible human read) is carried forward instead.
- **Tier 2 (member pins, `restricted` nodes only):** requests by the node's member set
  (`/tier-member`) pin for `TIER_REQUEST_GRACE_DAYS` — cold-start before Tautulli has signal.
  `open` nodes never pin (a requester could stream from any node), and on `restricted` nodes
  the members' own history outranks the universal core when the budget is tight.

The fill is an incremental watermark LRU: eviction happens **only to admit** something warmer
(never a scheduled purge), recently-watched (`warm_days`) and recently-added (`fresh_days`)
titles are never evicted, and a new title is admitted only if it outranks the coldest victim.
`sticky` nodes (old drives — California) get a doubled warm window and a bigger headroom floor.
If a node's budget covers the whole library, nothing is ever dropped.

Safety model (§ the agent enforces this order every run):
0. **Mount guard** — if `TIER_MOUNT_ROOT` is set, verify the external media drive is actually
   mounted **before** anything else: a positive proof (matching `TIER_EXPECTED_UUID` or a present
   `TIER_MOUNT_MARKER` sentinel — a bare mount-point check is not trusted since a container bind
   mount fakes it) plus every folder root on that same filesystem. If the drive is absent — the
   classic "`/mnt/media` reverted to an empty dir on the system disk after a reboot" — the agent
   aborts, reports `driveMissing` **without** an inventory (so the bot keeps the node's last-known
   contents instead of wiping them and re-seeding onto the wrong disk), and the bot alerts once on
   the transition and once on recovery. See `../agent/README.md`.
1. Assert the Syncthing folder is still **Receive Only** — abort + report otherwise.
2. Write the manifest's `.stignore` (drops, folder-relative; no delete-on-ignore directive).
3. Rescan and **confirm the ignores loaded**.
4. Only then delete local files that are dropped *and* ignored (ignored ⇒ never re-pulled).

Commands: `/tier preview [node]` (dry-run, shows the delta vs the last applied plan),
`/tier apply [node]` (publish manifests), `/tier-node add|list|enable|disable|token|folder`,
`/tier-member add|remove|list`. Agents authenticate to `GET /agent/manifest/:node` /
`POST /agent/report/:node` with the per-node bearer token from `/tier-node token` (hash-stored,
shown once). Env knobs: `TIER_CORE_TOP_K`, `TIER_HALF_LIFE_DAYS`, `TIER_WARM_DAYS`,
`TIER_FRESH_DAYS`, `TIER_REQUEST_GRACE_DAYS`, `TIER_HISTORY_DAYS`, `TIER_SOURCE_ROOT`,
`TIER_NODES_SEED` (JSON seed applied only when the `tier_nodes` table is empty).

Multi-folder nodes may mount the same Syncthing folders under a different absolute prefix than
the bot's Arr inventory (`/mnt/raid/Media/Movies` on the bot versus
`/mnt/media/Media/Movies` on an edge). Exact absolute matches win; otherwise the planner matches
the longest shared source-relative suffix (`Media/Movies`) to the node folder ID. Any title that
still cannot be routed blocks apply instead of silently falling into the first folder.

**Apply is blocked on an incomplete inventory.** If any *arr fails to answer while the plan is
being built, the titles it serves appear in neither `keep` nor `drop` — so their folder's
`.stignore` renders **empty** and the node re-downloads everything the previous plan was holding
back (potentially the whole library, over the edge uplink). The apply-impact caps cannot catch
this, because those titles aren't in the keep set either, so no confirm code is demanded. `/tier
apply` therefore refuses outright when a source failed, naming the source; there is no confirm
code that overrides it. `/tier preview` still renders the plan with the same warning. Fix the
source and re-run.

A **per-file prune skip** on the agent (an entry that isn't in the loaded ignores, or whose path
escapes the folder root) is reported in the report's `skipped` array, separately from `errors`.
Skips do not block convergence: the file stays ignored either way, so the node is still on plan,
and the agent advances its local plan hash after a skip and won't retry — counting a skip as an
error would wedge the node at "published but not converged" with nothing able to clear it, and
would also cost it the hysteresis keep-set that only carries forward from a converged state.

See `../agent/README.md` for deploying the node agent (systemd timer or Docker).
