# Edge Playback Architecture — Remote Fallback + Play-Triggered Promotion

**Status:** design / not yet implemented
**Applies to:** the California edge node *and* the Philippines (PH) cache box
**Author's intent:** "Press Play in an edge Plex → the title plays immediately → the bot
promotes it to that edge's local storage → future plays are local → the tier system later evicts
cold local copies while everything stays visible."

This document explains why that behaviour does not exist today, what the missing pieces are, and
how to build them so **both** edge servers behave the same way. It is grounded in the code as it
stands (`src/tier.js`, `src/staging.js`, the webhook handlers in `index.js`, `agent/`).

---

## 1. Where we are today

The repo already ships **two different, independent edge models**. They were built for different
boxes and they do not share a playback story.

### California — regional tiering edge (`src/tier.js` + `agent/`)

* Transport: **Syncthing**, folder(s) **Receive Only**. California mirrors four folders
  (`Family Films`, `4k`, `Movies`, `TV Shows`) as one budget pool.
* Curation: the planner (`planTier` / `planNode`) scores every title and writes a per-folder
  `.stignore`; the `tier-agent` asserts Receive-Only, loads the ignores, then prunes the dropped
  files. Nothing is ever pushed back to the master.
* Demand signal: `demand_source = atime` — the agent reports file `atime`s and the planner treats
  "recently read by California's Plex" as demand (with a maintenance-window mask so Plex's nightly
  scans don't flatten the LRU).
* Plex on California therefore sees **only the files physically present on California**. The ~32
  `.stignore` entries stop Syncthing from auto-restoring hundreds of GB.

> This is a **curation system inside a fixed budget**, not an on-demand gateway. A title that was
> pruned is simply gone from California's Plex until the planner keeps it again.

### Philippines — Plex Home staging cache box (`src/staging.js`)

* Transport: **rclone copy** into a remote cache (`STAGE_RCLONE_REMOTE`, e.g. `phbox:/cache`).
* Triggers that copy a title *today* (`index.js`):
  * `/stage <title>` (a user), `/stage-bulk` (admin),
  * auto-stage when a **PH-assigned** requester's title reaches `MEDIA_AVAILABLE`
    (`handleOverseerrWebhook` → `enqueueStageJob(... origin:'auto')`).
* Playback webhooks (`handlePhWatchedEvent`) only handle **finished-watching / eviction** of a
  title that is *already staged* — the very first line is `if (!staged) return;`. A title that
  isn't in the cache produces no action.

### The gap (identical on both boxes)

Neither model implements *"play a title that isn't here yet."* On an edge Plex:

1. User presses Play on a title whose file is absent.
2. Plex tries to open the file, fails, playback errors out.
3. **No usable `media.play` / "playing" webhook is produced** — you cannot scrobble a file you
   could not open — so there is nothing for the bot to react to.

`src/staging.js` even documents PH as "a curation system, not an on-demand file gateway." Correct.
Getting the intended behaviour needs **two** new capabilities, one infra, one bot:

* **A remote fallback** so the edge Plex can *always* open the file (and thus emit a real play
  event), even before it is local.
* **Play-triggered promotion** so that play event copies the title local for next time.

---

## 2. Target architecture

Same shape on California and Philippines. Only the *promotion transport* differs.

### 2.1 Infra layer — the merged library (per edge node, outside this repo)

Give each edge Plex a single library path that is the union of local cache and a read-only view of
the full master:

```
/mnt/plex-library            <- mergerfs mount, Plex points here
├── (branch 1, RW)  local edge cache on the edge RAID
└── (branch 2, RO)  read-only view of the Durant master library over Tailscale
```

* **Remote view:** a read-only `rclone mount` (SFTP/WebDAV/rclone-serve) or `sshfs` of the master
  library, reached over the existing Tailscale mesh. Read-only is a hard requirement — the edge
  must never be able to mutate the master.
* **Merge:** `mergerfs` with the local branch first (`category.create=ff` / local-first policy) so
  reads prefer a local copy and fall back to the remote branch when the file is absent locally.
* **Plex** is pointed at `/mnt/plex-library`, not at the raw Syncthing/cache folder.

Resulting behaviour, with **no bot involvement yet**:

1. Plex always sees the **full master library** (remote branch supplies every title's file).
2. A locally-cached title plays straight from the edge RAID.
3. A title missing locally plays through the **remote fallback** (streamed over Tailscale).
4. Because step 3 succeeds, Plex/Tautulli now emit a **real play event** the bot can act on.

This single change is what turns "playback fails, no webhook" into "playback works, webhook fires."
It also makes the existing `.stignore` drops safe to keep: a dropped title stays **visible and
playable** through the remote branch while occupying zero edge RAID.

**Interaction with Syncthing on California:** the mergerfs *remote* branch is independent of
Syncthing. Syncthing keeps managing the local branch exactly as now (Receive-Only, `.stignore`
prunes). mergerfs must be configured so the remote branch is **never a create target** — new local
files (promotions) only ever land in the local branch, which is what Syncthing owns.

### 2.2 Bot layer — play-triggered promotion (this repo, not yet built)

Four pieces, all additive to existing code:

#### (a) Ingest a play-*start* event

Today `handlePlexWebhook` early-returns on anything but `media.scrobble`, and
`handleTautulliWebhook` only acts on `event === 'watched'`. Add handling for the **start** of
playback:

* Plex webhook: `media.play` and `media.resume`.
* Tautulli webhook: the `play` event (configure a Tautulli "Playback Start" notification with the
  same JSON payload that already carries `server_name` / `machine_id`).

Reuse `classifyServerIdentity({serverName, machineId})` unchanged — it already fails safe
(`'unknown'` events are dropped). The only new requirement is that the classifier can recognise a
**tier node** (California) as an edge origin, not just PH. Two options:

* extend `PH_SERVER_NAMES` semantics into a general `EDGE_SERVER_NAMES` map of
  `serverIdentity → nodeName`, or
* keep `PH_SERVER_NAMES` for PH and add each tier node's Plex `server_name`/`machine_id` to its
  `tier_nodes` row so the webhook can resolve identity → node.

#### (b) Decide "is this title already local on that node?"

Promotion should fire **only** when the play is being served by the remote fallback (i.e. the file
is not local yet). Per transport:

* **PH (staging):** `getStagedItem(mediaId)` — already exists. Absent ⇒ promote.
* **California (tier):** the title is "local" iff it is in the node's current keep-set. That is
  already tracked in `tier_node_files` / the last published manifest (`getTierPlan(node)` →
  `keep`). Not in keep ⇒ it is playing via fallback ⇒ promote.

#### (c) Promote — by transport

* **PH:** `enqueueStageJob({ mediaId, mediaType, title, discordId, origin: 'play' })`. The existing
  stage worker (`processStageQueue` → `stageCopy`) copies the folder into the cache. Playback is
  already happening through the fallback; the copy just makes the *next* play local. The
  disk-pressure guard (`planCacheSpace`) and per-user/day cap already apply.
* **California (tier):** do **not** rclone into a Syncthing-managed folder directly. Instead record
  a **play-promotion pin** for `(node, mediaId)` and let the planner keep it:
  * add a per-node promotion set that feeds `planTier` as an extra floor source (same shape as the
    restricted-node `memberRequests` grace pins in `planNode`), with its own TTL
    (`TIER_PLAY_PIN_DAYS`, default e.g. 21);
  * the next `/tier apply` (or scheduled plan) keeps the title, the agent's next converge removes
    it from `.stignore`, and **Syncthing pulls the real file** into the local branch.
  * Until Syncthing finishes pulling, playback continues via the remote fallback — so the user
    experience is identical to PH; only the copy mechanism differs.

  This keeps the invariant that California's local files are *only* ever written by Syncthing, and
  reuses the whole existing keep/evict machinery instead of bolting on a second writer.

> **Path layout must match the remote tree (PH).** mergerfs only prefers the local copy when it
> sits at the **same relative path** as the file Plex discovered on the remote branch. Today
> `resolveStageSource` copies to `movies/<basename>` and `tv/<basename>` (`src/staging.js`), but the
> master library exposes folders like `Movies` / `TV Shows`. Left as-is, the promoted file lands at
> a *different* path than the one Plex indexed via the fallback, so Plex keeps opening the remote
> item and the local copy is an orphaned duplicate. **Before relying on mergerfs local-first for PH,
> change the stage destination layout (or add a remap) so cached paths are identical to the master's
> relative paths** — e.g. stage into `Movies/<basename>` / `TV Shows/<basename>` so
> `/mnt/plex-library/Movies/<basename>` resolves to the local branch. The California tier path is
> unaffected: Syncthing already replicates the master's exact folder tree, so promoted files match by
> construction.

#### (d) Guardrails (shared)

* **Dedupe/debounce:** one promotion per `(node, mediaId)` per window — a binge shouldn't enqueue
  the same show repeatedly. Mirror the existing `evict_prompt_last:<mediaId>` cooldown pattern with
  a `promote_last:<node>:<mediaId>` setting.
* **Only promote titles that exist on a full master** — `planTier` already flags
  `noFullCopy`/`onFullNode:false`; never promote something the master can't serve.
* **WAN contention:** a fallback *stream* and a promotion *copy* share the Tailscale link. Keep
  `STAGE_RCLONE_FLAGS`/`GRAB_RCLONE_FLAGS` `--bwlimit` in place, and consider deferring the copy
  slightly so the live stream wins the pipe.
* **Respect existing budgets — but add the missing rate-limit accounting.** The cache guard
  (`planCacheSpace`) and California's node budget + eviction gate run inside the copy/plan paths, so
  promotion inherits them for free. **The per-user daily cap does *not* come for free:**
  `STAGE_MAX_PER_USER_PER_DAY` is enforced only in `handleStageCommand` via the in-memory
  `stageCommandLimits` map (`index.js`), *before* `enqueueStageJob` — `enqueueStageJob` and the stage
  worker only dedupe active jobs and check disk space. A `origin:'play'` path that calls
  `enqueueStageJob` directly would let one viewer queue unlimited distinct missing titles. So the
  play-promotion handler **must apply its own rate-limit/attribution** (attribute to the watcher's
  linked Discord id, then `takeRateLimit(stageCommandLimits, watcherId, STAGE_MAX_PER_USER_PER_DAY,
  …)` or an equivalent persistent per-day counter) before enqueuing. Promotion is an *admission
  request*, not an override of the budget.

### 2.3 Tiering + eviction (already built — steps 5 & 6)

Once a title is promoted and local:

* PH: `handlePhWatchedEvent` already bumps the LRU clock (`touchStagedItem`) and offers eviction on
  finish; `planCacheSpace` evicts coldest-first under pressure.
* California: the atime signal now shows the title as warm; `planNode`'s incremental watermark LRU
  keeps it while hot and evicts it when it goes cold — and because of the remote fallback, eviction
  no longer makes the title disappear, it just returns it to "visible, plays remotely."

So the tier system we already have **is** steps 5 and 6. The remote fallback (2.1) and the
play-triggered promotion (2.2) are the only missing links.

---

## 3. California vs Philippines — what each needs

| Concern | California (tier node) | Philippines (PH cache box) |
|---|---|---|
| Full library visible in Plex | mergerfs: local Syncthing branch + RO remote branch | mergerfs: local cache branch + RO remote branch |
| Remote fallback transport | RO rclone/sshfs mount of master over Tailscale | RO rclone/sshfs mount of master over Tailscale |
| Play event source | Plex/Tautulli on the CA box (add its identity to the node) | already have `PH_SERVER_NAMES` + webhook payload |
| "Is it local?" check | title in node keep-set (`getTierPlan`) | `getStagedItem(mediaId)` |
| Promotion mechanism | play-promotion pin → planner keeps → Syncthing pulls | `enqueueStageJob(origin:'play')` → `stageCopy` |
| Eviction / budget | existing `planNode` LRU + node budget | existing `planCacheSpace` + `STAGE_CACHE_MAX_GB` |
| Already-built? | tiering ✅ / fallback ✗ / play-promote ✗ | staging ✅ / fallback ✗ / play-promote ✗ |

The upshot: **the two boxes converge to one behaviour** and reuse the code each already has for
steps 5–6. Only the front half (fallback mount + play event → promotion) is new, and the promotion
call is a one-liner difference (`enqueueStageJob` vs. a play-pin) behind a shared handler.

---

## 4. Suggested config additions

```dotenv
# Edge play-triggered promotion (new)
EDGE_PROMOTE_ON_PLAY=false            # master switch; off = today's behaviour
EDGE_PROMOTE_COOLDOWN_HOURS=12        # per (node,title) debounce, mirrors evict_prompt cooldown
TIER_PLAY_PIN_DAYS=21                 # how long a play-promoted title is pinned on a tier node

# Recognise each edge Plex as a promotion origin. PH already uses PH_SERVER_NAMES; either
# generalise to EDGE_SERVER_NAMES=identity:node,... or store plex server_name/machine_id on the
# tier_nodes row so the webhook can resolve identity -> node.
```

No secrets here; all of the sensitive values (tokens, rclone remotes) already exist and stay in
`.env` (git-ignored).

---

## 5. Build order (incremental, each step independently useful)

1. **Infra first, no bot changes:** stand up the RO remote mount + mergerfs on one box (PH is the
   simpler pilot since it has no Syncthing to reconcile). Verify Plex shows the full library and a
   missing title plays via fallback. This alone restores "everything is visible and playable."
2. **Ingest play-start events** (`media.play`/`media.resume`, Tautulli `play`) behind
   `EDGE_PROMOTE_ON_PLAY`, audit-only (log "would promote X on node Y") — no copies yet.
3. **Wire PH promotion** (`enqueueStageJob(origin:'play')`) with the cooldown guard.
4. **Wire California promotion** (play-pin → planner floor → agent converge) and add the CA Plex
   identity to the node.
5. **Tune** bwlimits and cooldowns; confirm eviction returns titles to "visible via fallback" rather
   than "gone."

---

## Appendix — Repository security review (public repo)

`DurantTL/overseerr-dm-bot` is **public**. Findings from auditing tracked files:

* ✅ **No credentials committed.** `.gitignore` / `.dockerignore` exclude `.env`, `.env.*`,
  `stack.env`, `*.db`, `data/`, `backups/`. `.env.example` ships only blank keys and placeholder
  hosts (`files.example.com`, `bot.example.com`). Every secret in code is read from `process.env`.
* ✅ **No real IPs, Tailscale hostnames, or personal domains** in tracked files.
* ⚠️ **Real Syncthing folder IDs + library paths are committed** as doc examples
  (`agent/README.md`, `agent/agent.js`, `src/db.js`, `index.js`): `cfjvc-ykzis`, `ch3dl-xnzem`,
  `mafyh-4dn5b`, `wg9fc-ntkc4` alongside `/mnt/media/Media/{Family Films,4k,Movies,TV Shows}`.
  Folder IDs are **not** a Syncthing security boundary (device IDs + mutual sharing are), so risk is
  **low** — but they are real infrastructure identifiers and the paths leak the library layout.
  *Recommendation:* replace with obviously-fake sample IDs in the docs. (Scrubbing current files
  does not remove them from history; a history rewrite would, but that is disruptive — decide
  before doing it.)
* ⚠️ **Weak dashboard session-secret fallback.** `index.js` derives the cookie-signing secret from
  `'durant'` when both `DASHBOARD_ADMIN_PASSWORD` and `DASHBOARD_ADMIN_TOKEN` are unset. Dashboard
  auth still requires one of those to log in, so this is **low** severity, but set an explicit
  random `SESSION_SECRET` in production to avoid a predictable signing key.
* ℹ️ Operational naming (`durant-media-server-bot`, `california`, `philippines`, RapidSeedbox
  references, RAID paths) is present. It reveals topology but no credentials — acceptable for an
  open-source self-host bot; only worth changing if you'd rather not advertise the deployment.

**Bottom line:** nothing secret is exposed. The only cleanups worth doing are cosmetic
(placeholder folder IDs) and hardening (`SESSION_SECRET`).
