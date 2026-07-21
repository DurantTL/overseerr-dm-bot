# Edge Playback Architecture — Remote Fallback + Play-Triggered Promotion

**Status (component-level):**

```
PH play-triggered promotion:        implemented, off by default
PH merged fallback mount:           infra runbook ready (mergerfs-plex-operational.md), stand-up pending
California tiering:                 implemented
California play promotion:          not implemented (needs §2.2 bot work)
California merged fallback mount:   infra runbook ready (mergerfs-plex-operational.md), stand-up pending
Season-level TV planning:           not implemented
```

The merged-library *mount* work (mergerfs, Plex test library) is infra outside this repo — the
step-by-step stand-up, with verification and rollback at each step, is now written up as a runbook:
[`mergerfs-plex-operational.md`](mergerfs-plex-operational.md). The bot-side promotion, planner
correctness (Phase 1), and PH staging fixes (path layout, DB reconciliation, durable promotion cap)
are in place, as are the operational agent-heartbeat and async-deletion items.

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
  scans don't flatten the LRU). **Recommended switch: `demand_source = plex`** — Plex's scheduled
  tasks read every file on a regular basis, which is exactly what pollutes atime; the node's own
  PMS watch history only records real playback and is immune to scans. The atime report stays on
  as the automatic fallback (`/tier-node add name:california demand_source:plex plex_url:… plex_token:…`).
* Plex on California therefore sees **only the files physically present on California**. The ~32
  `.stignore` entries stop Syncthing from auto-restoring hundreds of GB.
* **Persistent manual overlay:** on top of the planner's `.stignore`, California carries a hand-kept
  overlay (`/etc/tier-agent/extra-ignores/<folderId>.txt`, e.g. `aaaaa-bbbbb.txt`) that is appended
  after every planner run. The committed agent *overwrites* `.stignore` with planner output only, so
  this overlay is applied out-of-band and is **authoritative over the planner** for the titles it
  lists — a fact §2.2 must design around, because a keep/pin cannot un-ignore an overlaid title.

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
is not local yet). Crucially, three states must be distinguished — conflating them is a bug:

* **desired locally** — the plan says keep it (`getTierPlan(node).keep`).
* **actually present locally** — the file exists on the edge RAID *now*.
* **fully synchronized locally** — *all* of it is present (every episode of a series, not a
  half-pulled folder).

"In the keep-set" only proves **desired**, not present or synchronized. A title can be kept while
Syncthing is still downloading it, has errored, has pulled only some episodes, or the agent has
published the plan but not yet converged — in every one of those cases playback is *still* using the
remote fallback, so suppressing promotion because it's "kept" would strand it on the fallback
forever. Per transport:

* **PH (staging):** `getStagedItem(mediaId)` records a completed copy — absent ⇒ promote. (Partial
  copies are already retried by the stage worker, so "present" and "synchronized" coincide here.)
* **California (tier):** do **not** decide from `getTierPlan(node).keep` alone. Check *presence and
  completion* against the node's real state:
  * **presence:** the agent already reports its inventory (`listTierNodeFiles(node)` — every
    `relPath`/`sizeBytes`); the title's folder being absent or short on files ⇒ not present.
  * **completion:** for authoritative "fully synced," query Syncthing on the node —
    `GET /rest/db/completion?folder=<id>&device=<self>` (or per-file `need`) — via the agent (it
    already talks to the Syncthing REST API). `completion < 100%` for the title's folder ⇒ still
    pulling ⇒ keep it on the fallback and treat as promotable/needs-nudge, not "done."
  * Only when the title is **present and complete** should the play handler treat it as local and
    skip promotion. Otherwise: (re)assert the pin and nudge convergence (see (c)).

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
  * the plan keeps the title, the agent's converge removes it from `.stignore`, and **Syncthing
    pulls the real file** into the local branch.
  * Until Syncthing finishes pulling, playback continues via the remote fallback — so the user
    experience is identical to PH; only the copy mechanism differs.

  This keeps the invariant that California's local files are *only* ever written by Syncthing, and
  reuses the whole existing keep/evict machinery instead of bolting on a second writer.

> **BLOCKER — the persistent ignore overlay must subtract active pins.** The committed agent writes
> `.stignore` with `fs.writeFileSync(target, fp.stignore)` — it *overwrites* the file with pure
> planner output. But California runs a **persistent manual overlay**
> (`/etc/tier-agent/extra-ignores/<folderId>.txt`, e.g. `aaaaa-bbbbb.txt`) that is appended **after**
> the planner's `.stignore`. Those rules keep ignoring their titles **even when the planner moves the
> title into the keep-set** — so a play-promotion pin alone will *never* make an overlaid legacy
> title (Boku, Lizzie, …) download. This is fatal to promotion for exactly the titles most likely to
> need on-demand restoration. The design must make the overlay pin-aware. Concretely:
> * split the persistent rules into **`legacy-ignores`** and **`promotion-overrides`** files;
> * compute the **final** ignore set as `planner-drops ∪ legacy-ignores − active-promotion-pins`
>   (the agent, or whatever applies the overlay, must subtract the pins — the bot exposes the active
>   pin list in the manifest so the overlay step knows what to remove);
> * when a promotion pin **expires** and the title becomes eviction-eligible again, restore its
>   legacy ignore rule so the overlay's intent returns.
> Without this subtraction step, points (a)–(c) above are inert on any overlaid title.

> **Promotion must converge immediately, not on the next scheduled cycle.** A play-start pin whose
> effect waits for the next `/tier apply` and the agent's timer (up to ~6 h) is not "press Play and
> it promotes." On promotion the bot should, in order: (1) record the pin; (2) **recompute and
> publish** the California plan right away (`planTier` for that node → `setTierPlan` /
> `tier_manifest:<node>`); (3) **trigger the California agent immediately** rather than waiting for
> its timer — this needs a push/kick path the agent doesn't have today (e.g. a lightweight
> `systemctl start tier-agent.service` over the tunnel, or an agent long-poll/pull-now endpoint);
> (4) once the agent has rewritten ignores, **trigger a Syncthing rescan** of the affected folder
> (`POST /rest/db/scan?folder=<id>` — the agent already does this in `rescanAndConfirmIgnores`) so
> the pull starts now. The scheduled tier cycle remains the *fallback/backstop*, not the normal
> promotion path.

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

#### (c′) TV promotion granularity

The existing staging resolver (`resolveStageSource`) copies the **entire series folder** for TV.
That is fine for a small show but catastrophic on a large one: pressing Play on a single episode
could promote **hundreds of GB**. The design must choose a granularity explicitly rather than
inherit "whole series":

* **current episode only** — minimal, but a binge re-triggers per episode;
* **current season** — good balance; one pull covers the likely next few plays;
* **entire series** — only for small shows or an explicit opt-in.

**Recommended default: current season**, with a configurable whole-series option
(`TIER_TV_PROMOTE_GRANULARITY = episode|season|series`, default `season`). This has a real cost on
the tier side: the planner currently reasons in **whole titles** (one series = one keep/drop unit),
and season/episode promotion requires **sub-folder inventory and ignore rules** (`.stignore`
entries and keep/atime tracking below the series-folder level). PH's staging path can already target
a season subfolder with a narrower `resolveStageSource`; California's planner needs season-level
granularity added before season promotion is meaningful there. Until that exists, document the
interim behaviour honestly (whole-series) and gate large series behind an admin confirm.

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
| "Is it local?" check | inventory presence (`listTierNodeFiles`) **+ Syncthing completion**, not keep alone | `getStagedItem(mediaId)` |
| Promotion mechanism | play-pin → planner keeps → **overlay subtracts pin** → agent converges → Syncthing pulls | `enqueueStageJob(origin:'play')` → `stageCopy` |
| Persistent ignore overlay | **must subtract active pins** (`extra-ignores/<folderId>.txt`) — else pinned titles never pull | n/a (no Syncthing) |
| Immediate convergence | republish plan + kick agent + Syncthing scan **now**, not on the 6 h timer | stage worker picks it up on its short interval |
| TV granularity | needs season-level inventory/ignores (planner is whole-title today) | narrow `resolveStageSource` to season subfolder |
| Rate limit | own watcher-attributed cap | own watcher-attributed cap (not the command-layer one) |
| Eviction / budget | existing `planNode` LRU + node budget | existing `planCacheSpace` + `STAGE_CACHE_MAX_GB` |
| Already-built? | tiering ✅ / fallback ✗ / play-promote ✗ | staging ✅ / fallback ✗ / play-promote ✗ |

The upshot: **the two boxes converge to one behaviour** and reuse the code each already has for
steps 5–6. Only the front half (fallback mount + play event → promotion) is new. But note the
promotion mechanisms are **not** symmetric: PH's is close to a one-liner (`enqueueStageJob`), while
California's must go through the planner **and** make the persistent ignore overlay pin-aware, prove
presence/completion rather than trusting the keep-set, and converge on demand — those are the
substantive pieces of work, not the PH path.

---

## 4. Suggested config additions

```dotenv
# Edge play-triggered promotion (new)
EDGE_PROMOTE_ON_PLAY=false            # master switch; off = today's behaviour
EDGE_PROMOTE_COOLDOWN_HOURS=12        # per (node,title) debounce, mirrors evict_prompt cooldown
TIER_PLAY_PIN_DAYS=21                 # how long a play-promoted title is pinned on a tier node
TIER_TV_PROMOTE_GRANULARITY=season    # episode | season | series — cap the TV promotion size
EDGE_PROMOTE_MAX_PER_USER_PER_DAY=6   # own cap for origin:'play' (command-layer cap doesn't apply)

# Recognise each edge Plex as a promotion origin. PH already uses PH_SERVER_NAMES; either
# generalise to EDGE_SERVER_NAMES=identity:node,... or store plex server_name/machine_id on the
# tier_nodes row so the webhook can resolve identity -> node.
```

The tier node also needs, on the node side: the persistent ignore overlay split into
`legacy-ignores`/`promotion-overrides` (so pins can be subtracted), and a way for the bot to **kick
the agent on demand** (a pull-now endpoint or a `systemctl start tier-agent.service` over the
tunnel) instead of waiting for `tier-agent.timer`.

No secrets here; all of the sensitive values (tokens, rclone remotes) already exist and stay in
`.env` (git-ignored).

---

## 5. Build order (incremental, each step independently useful)

1. **Infra first, no bot changes:** stand up the RO remote mount + mergerfs on one box (PH is the
   simpler pilot since it has no Syncthing to reconcile). Verify Plex shows the full library and a
   missing title plays via fallback. This alone restores "everything is visible and playable."
2. **Ingest play-start events** (`media.play`/`media.resume`, Tautulli `play`) behind
   `EDGE_PROMOTE_ON_PLAY`, audit-only (log "would promote X on node Y") — no copies yet.
3. **Wire PH promotion** (`enqueueStageJob(origin:'play')`) with the cooldown guard, the
   watcher-attributed daily cap, and the path-layout fix so mergerfs prefers the local copy.
4. **Make the California overlay pin-aware first** (split `legacy-ignores`/`promotion-overrides`,
   subtract active pins) — nothing below works on an overlaid title until this lands.
5. **Wire California promotion:** play-pin → recompute/publish plan → **kick the agent now** →
   Syncthing scan; decide "local" from inventory presence **+ Syncthing completion**, not the
   keep-set; add the CA Plex identity to the node; pick a TV granularity.
6. **Tune** bwlimits, cooldowns, and TV granularity; confirm eviction returns titles to "visible via
   fallback" rather than "gone."

---

## Appendix — Repository security review (public repo)

`DurantTL/overseerr-dm-bot` is **public**. Findings from auditing tracked files:

* ✅ **No credentials committed.** `.gitignore` / `.dockerignore` exclude `.env`, `.env.*`,
  `stack.env`, `*.db`, `data/`, `backups/`. `.env.example` ships only blank keys and placeholder
  hosts (`files.example.com`, `bot.example.com`). Every secret in code is read from `process.env`.
* ✅ **No real IPs, Tailscale hostnames, or personal domains** in tracked files.
* ✅ **Real Syncthing folder IDs scrubbed (fixed).** The node's actual folder IDs were committed as
  doc examples in `agent/README.md`, `agent/agent.js`, `src/db.js`, and `index.js`; they have been
  replaced with obvious placeholders (`aaaaa-bbbbb`, …). Folder IDs are **not** a Syncthing security
  boundary (device IDs + mutual sharing are), so risk was **low**. Note: this only cleans the current
  tree — the old IDs remain in git **history**; a history rewrite would remove them but is disruptive,
  so that is left as an explicit call for the maintainer. The example library paths
  (`/mnt/media/Media/…`) are generic and were kept.
* ✅ **Dashboard session-secret hardened (fixed).** `sessionSecret()` previously fell back to the
  predictable constant `sha256('session:durant')` when no `SESSION_SECRET`/password/token was set.
  Because `dashboardAuth` accepts any validly-signed `dm_session` cookie, that constant let an
  attacker **forge an admin session and bypass login** whenever the dashboard was enabled (the
  default) without credentials. It now falls back to a per-process random secret, so a cookie can
  never be minted from a known constant. Setting an explicit `SESSION_SECRET` in production is still
  recommended (keeps sessions valid across restarts).
* ℹ️ Operational naming (`durant-media-server-bot`, `california`, `philippines`, RapidSeedbox
  references, RAID paths) is present. It reveals topology but no credentials — acceptable for an
  open-source self-host bot; only worth changing if you'd rather not advertise the deployment.

**Bottom line:** nothing secret is exposed. The two concrete cleanups (placeholder folder IDs,
session-secret hardening) are applied; a history rewrite for the old folder IDs is the only
remaining optional step.
