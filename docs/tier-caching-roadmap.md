---
reviewed: 2026-08-16
source_commit: 1a803ac
---

# Regional tiering / edge cache — implementation record and remaining work

This document retains the detailed implementation record that began after PR #42. Current
delivery is tracked by GitHub issues
[#181](https://github.com/DurantTL/overseerr-dm-bot/issues/181) through
[#183](https://github.com/DurantTL/overseerr-dm-bot/issues/183); completed phase notes below are
historical evidence, not an active queue.

## Status snapshot

Already done (in the codebase / PR #42):

- Safe deletion mechanism: agent asserts Receive Only, writes ignores before
  deleting, confirms Syncthing loaded them, confines paths to the folder root,
  aborts on missing media drive (`agent/agent.js`, mount-guard in
  `index.js` `/agent/report/:node` at ~L5170).
- **PR #42 — planner correctness:** Plex-mode atime fallback wired for every
  non-full edge node (`buildTierPlans`, `index.js:4072`); eviction tie-break
  split so displacement evicts larger-first while the over-budget trim sheds
  smaller-first (`planNode`, `src/tier.js:337`); missing Radarr/Sonarr added
  dates load as `null` not `now` (`fetchTierInventory`, `src/tier.js:79`).
- PH play-triggered promotion: implemented, off by default (`src/staging.js`).
- **Phase 1.4 — anti-churn admission threshold:** displacement now requires a meaningful net gain
  (absolute margin + relative margin + size-scaled transfer penalty), not any improvement
  (`planNode`, `src/tier.js`; knobs `TIER_CHURN_*` in `src/config.js`).
- **Phase 1.5 — apply limits + confirmation:** large rebalances (real removal bytes / removed
  titles / new-download bytes, measured against the node's last physical inventory) are held behind
  a plan-hash-bound confirm code (`assessApplyImpact` / `tierApplyConfirmCode` in `src/tier.js`;
  gate in `handleTierCommand`, `index.js`; caps `TIER_APPLY_MAX_*` in `src/config.js`).

- **Phase 1.1 — published vs converged plan state:** `tier_plan:<node>` now stores a lifecycle
  record (`published` / `converged` / `lastAgentReportAt` / `lastInventoryAt` / `lastErrors`).
  `/tier apply` writes `published` only; the report endpoint advances `converged` **only** when
  `body.converged && no errors && body.planHash === publishedHash`. Hysteresis keys off the last
  **converged** keep set (`buildTierPlans`, `index.js`). Legacy records migrate as assumed-converged.
- **Phase 1.2/1.3 — previews from physical inventory + physical-action preview + `details:true`:**
  the preview now reads the agent's file report (`tier_node_files`) instead of the previous plan, so
  manual deletions show up. `computeTierActionPreview` (`src/tier.js`) buckets titles into
  download / remove / still-syncing / already-gone; `tierManifestField` renders them plus the
  effective settings (demand source, warm/fresh, sticky, headroom). `/tier preview node:<n>
  details:true` attaches a per-title change list.
- **Phase 1.6 — stable-ID title matching:** `fetchPlexHistory` resolves each rating key to a
  tmdb:/tvdb: GUID (`fetchPlexGuid`, one bounded-concurrency metadata lookup per distinct key);
  `computeNodeValues` joins history to inventory by GUID first (`indexHistory` / `lookupHistory`)
  and only falls back to normalized title, warning when a Plex node leaned on the fallback.

- **Operational — agent heartbeat:** the sync agent now POSTs a lightweight `{heartbeat:true}` on
  every no-op run (plan + inventory unchanged), and the bot bumps a `lastHeartbeatAt` on any inbound
  agent contact (`recordTierAgentHeartbeat`, `src/db.js`; fast-path in `/agent/report/:node`,
  `index.js`). Last-check-in age is surfaced in `/tier preview`, `/tier-node list`, and the dashboard
  tier card, so "healthy idle" is distinguishable from "stopped / net down / timer broken".
- **Operational — async / bounded deletion:** `pruneDrops` (`agent/agent.js`) now deletes with
  `fs.promises.rm` one title at a time (yields to the event loop instead of a blocking `rmSync`), and
  estimates freed bytes from the planner's inventory `sizeBytes` instead of a synchronous recursive
  stat — only falling back to an async walk when a drop entry carries no size.

The mergerfs mount / Plex-test-library steps are documented in
[`mergerfs-plex-operational.md`](mergerfs-plex-operational.md), but live PH and California
stand-up remains unverified external work under #181. California play-triggered promotion remains
bot work under #182. Season-level TV planning remains under #183.

---

## Phase 1 (remainder) — finish the California planner before any mount work

These are the Phase-1 items PR #42 deliberately left out. Do these before
deploying merged Plex fallback anywhere.

### 1.1 Separate "published" from "converged" plan state — ✅ DONE

Today `/tier apply` calls `setTierPlan(...)` immediately after publishing the
manifest (`index.js:4161`), so a plan is marked "applied" before the agent has
run — it may be offline, drive-missing, or hours from its next cycle. The report
endpoint stores inventory but never consults `body.converged` to update applied
state, and the Discord notice says ``Plan `<hash>` converged.`` unconditionally,
even when the same report carries errors (`index.js:5223`).

Do:

- Track three plan records per node instead of one: `proposed`, `published`
  (hash + `publishedAt`), `converged` (hash + `convergedAt`), plus
  `lastAgentReportAt`, `lastInventoryAt`, `lastErrors`. Extend `setTierPlan` /
  `getTierPlan` and the `tier_plans` schema in `src/db.js`.
- On `/tier apply`: write `published`, do **not** write `converged`.
- In `/agent/report/:node`: mark `converged` only when
  `body.converged === true && (body.errors||[]).length === 0 && body.planHash === publishedHash`.
  Fix the notification to say "converged" only in that case; otherwise
  "published, agent pending" or "errors".
- Hysteresis (`prevKeepIds` in `planNode`) should key off the last **converged**
  keep set, not the most recently published one — otherwise the planner assumes
  a state the node never reached.

### 1.2 Previews from physical inventory, not last plan — ✅ DONE

`Δ vs applied` compares the new plan against the previous plan's `keepMediaIds`
(`tierManifestField`, `index.js:4108`), so manual deletions never show up and the
preview looks unchanged after freeing disk by hand. The agent already reports a
physical file inventory (stored via `replaceTierNodeFiles`, read by
`listTierNodeFiles`) — use it.

Distinguish four states in the preview: **planned to cache**, **published to
agent**, **actually present locally** (from `tier_node_files`), **fully
synchronized**.

### 1.3 Physical-action preview + `details:true` — ✅ DONE

Replace the Keep/Drop summary with real next actions computed from
{proposed keep/drop} × {published plan} × {physical inventory} × {Radarr/Sonarr
sizes}:

```
Download locally: N titles · X GB
Remove local copies: N · X GB
Already absent: N · X GB          (in drop set, already not on disk)
Kept but still downloading: N · X GB
```

`/tier preview node:<n> details:true` should attach a per-title change list
(folder, size, score, plays, last watched / last local access, current state,
reason) and the effective settings (demand source, history days, warm/fresh
days, sticky, headroom). The node-update response stores warm/fresh but does not
display them — surface them too.

### 1.4 Meaningful-improvement threshold (anti-churn) — ✅ DONE

Admission previously displaced any victim with `victim.value < candidate.value`
(`planNode`, `src/tier.js` step 2), so a `0.001` title could evict `0.000` ones.
The displacement gate now requires all three of: the candidate's demand beats the
**sum** of the demand it evicts by `TIER_CHURN_MIN_ABSOLUTE` (default 0.05); it
beats the **warmest** victim by `TIER_CHURN_MIN_RELATIVE` (default 20%); and it
overcomes a transfer penalty scaled by candidate size
(`TIER_CHURN_PENALTY_PER_TB`, default 0.05/TB) so larger downloads demand a
stronger signal. Free-budget admits are unaffected — only displacement is gated.

### 1.5 Apply limits + confirmation for large rebalances — ✅ DONE

Large applies are gated behind a confirmation code tied to the exact plan hash.
Caps (`TIER_APPLY_MAX_REMOVAL_GB` 100, `TIER_APPLY_MAX_REMOVED_TITLES` 10,
`TIER_APPLY_MAX_DOWNLOAD_GB` 150; 0 disables a cap) are measured against the
node's **last physical inventory** — real removal bytes / removed titles / new
download bytes (`assessApplyImpact`, `src/tier.js`). Anything over a cap prints a
plan-bound code (`tierApplyConfirmCode`) the admin must echo
(`/tier apply node:california confirm:XXXX`); the code stops matching once the
plan moves. Enforced in `handleTierCommand` (`index.js`); previews show the same
impact numbers and code. Full masters skip the guardrail (they never prune).

### 1.6 Stable-ID title matching — ✅ DONE

Watch history joins to inventory by normalized title text (`titleKey`,
`rollHistoryByTitle` in `src/tier.js`), which drops years/punctuation — remakes
collide, editions collide, Radarr `(4K)` vs plain title mismatch. Resolve Plex
rating keys to TMDB/TVDB GUIDs and join on `tmdb:<id>` / `tvdb:<id>` (the
inventory `mediaId` is already in that form); keep title matching only as a
fallback with a visible warning.

---

## Phase 2 — full-library visibility pilot on the PH box

Do **not** pilot merged-library on California first. PH is simpler and already
has play-triggered promotion behind flags. No RAID rebuild — the existing disk
becomes the local branch.

Fix first:

- **Path mismatch — ✅ DONE:** staged copies now land under `Movies/<folder>` /
  `TV Shows/<folder>` (config `STAGE_MOVIES_SUBDIR` / `STAGE_TV_SUBDIR`, defaults matching the
  master tree) so a mergerfs local-first view substitutes them instead of duplicating
  (`resolveStageSource`, `src/staging.js`). Existing lowercase `movies/`/`tv/` copies from before
  this change are orphaned and will be re-cached under the new paths.
- **Stale staging DB — ✅ DONE:** `reconcileStagedItems` (`src/staging.js`) verifies each
  `staged_items` row against the cache drive (`rclone lsjson`, summed per dest) — present+complete →
  local; present-but-partial or actively copying → transferring; missing → drop row & restage. Runs
  at startup and every `STAGE_RECONCILE_MINUTES` (`sweepStagedReconciliation`, `index.js`). A failed
  listing is treated as "unknown" and reconciles nothing (no mass re-copy on a transient error).
  Orphan-file import (file on disk, no row) is deliberately left manual — safe import needs media
  resolution the sweep doesn't attempt.
- **In-memory daily promotion cap — ✅ DONE:** the per-watcher daily counter is now durable in
  SQLite (`edge_promote_log`; `countRecentPromotions` / `recordPromotion`, `src/db.js`), so a
  restart no longer re-arms everyone's budget mid-day. A token is consumed only on an actual enqueue.

Then (operational, not code): read-only remote mount → local-first mergerfs view → temporary Plex test
library on the merged view → verify local + remote playback → test remote-master
outage → enable promotion audit-only → reconcile DB vs disk → enable real
promotion. **Step-by-step runbook, with verification + rollback at each step:
[`mergerfs-plex-operational.md`](mergerfs-plex-operational.md).**

---

## Phase 3 — California full-library fallback (after PH is stable)

- Add the same read-only remote branch + local-first merged Plex view.
- Keep Syncthing pointed only at the existing California RAID folders; keep the
  tier agent away from the merged path.
- Add play-promotion pins: a pin recomputes the plan, runs the agent, triggers a
  Syncthing rescan, checks physical presence + completion.
- Make manual exclusions pin-aware. Replace the out-of-band ignore overlay with
  first-class DB policies — `manual_exclusion`, `permanent_pin`,
  `temporary_play_pin`, `planner_drop`, `safety_force_keep` — and generate the
  final ignore list from those states (show it in the preview). Today an overlay
  rule can keep a title ignored even after the planner moves it into the keep
  set, so a promotion pin would look successful but never restore content.
- Add an authenticated "run now" path for the agent.

---

## Phase 4 — season-level TV caching (last, biggest win)

Inventory represents a whole Sonarr series as one title with the total series
size (`fetchTierInventory` tv branch, `src/tier.js:100`), so one watched episode
makes a 300 GB series compete as a single unit. Model
`Series → Season → episode files`; cache the watched season + next episode(s),
optionally the previous season briefly, whole series only when small or pinned.

Interim guard until then: cap automatic TV-series admission (e.g. 100 GB); larger
series require admin confirmation.

---

## Operational improvements (do alongside any phase)

- **Agent heartbeat — ✅ DONE:** the agent POSTs a lightweight `{heartbeat:true}`
  even on no-op runs (`agent/agent.js`); the bot bumps `lastHeartbeatAt` on any
  inbound agent contact (`recordTierAgentHeartbeat`, `src/db.js`; fast-path in
  `/agent/report/:node`) and surfaces last-check-in age in `/tier preview`,
  `/tier-node list`, and the dashboard tier card, so "healthy idle" is
  distinguishable from "stopped / net down / timer broken".
- **Async / bounded deletion — ✅ DONE:** `pruneDrops` (`agent/agent.js`) deletes
  with `fs.promises.rm` one title at a time (yields to the event loop instead of
  a blocking `rmSync`) and estimates freed bytes from the planner's inventory
  `sizeBytes` rather than a synchronous recursive stat — falling back to an async
  walk only when a drop entry carries no size.

## Current component status

Use this wording consistently across the edge documents:

```
PH play-triggered promotion:        implemented, off by default
PH merged fallback mount:           runbook ready; stand-up unverified/pending (#181)
California tiering:                 implemented
California play promotion:          not implemented (#182)
California merged fallback mount:   runbook ready; stand-up unverified/pending (#181)
Season-level TV planning:           not implemented (#183)
```
