# Regional tiering / edge cache — remaining work

A backlog of the review items **not** covered by PR #42
(`claude/plex-atime-fallback-bug-kuo15q`). Point a session at this file (or a
single section of it) to pick up the next piece. Every item has code pointers so
work can start without re-deriving context.

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

Not yet done — the rest of this file (Phase 1: 1.1, 1.2, 1.3, 1.6; Phases 2–4; operational items).

---

## Phase 1 (remainder) — finish the California planner before any mount work

These are the Phase-1 items PR #42 deliberately left out. Do these before
deploying merged Plex fallback anywhere.

### 1.1 Separate "published" from "converged" plan state

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

### 1.2 Previews from physical inventory, not last plan

`Δ vs applied` compares the new plan against the previous plan's `keepMediaIds`
(`tierManifestField`, `index.js:4108`), so manual deletions never show up and the
preview looks unchanged after freeing disk by hand. The agent already reports a
physical file inventory (stored via `replaceTierNodeFiles`, read by
`listTierNodeFiles`) — use it.

Distinguish four states in the preview: **planned to cache**, **published to
agent**, **actually present locally** (from `tier_node_files`), **fully
synchronized**.

### 1.3 Physical-action preview + `details:true`

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

### 1.6 Stable-ID title matching

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

- **Path mismatch:** PH staging writes `movies/<folder>`, `tv/<folder>` but the
  master tree uses `Movies/<folder>`, `TV Shows/<folder>`. For mergerfs to
  substitute the local copy the relative paths must match exactly, else the
  local copy is an unused duplicate. Reconcile in `src/staging.js`.
- **Stale staging DB:** PH treats a title as local when a `staged_items` row
  exists, without checking the file is present/complete. Add a reconciliation
  sweep: row+file+size → local; row+missing → drop row & restage; file+no row →
  reconcile/import; copy active → transferring.
- **In-memory daily promotion cap:** per-user daily cap resets on restart (the
  per-title cooldown is durable, the daily counter is not). Move the counter to
  SQLite.

Then: read-only remote mount → local-first mergerfs view → temporary Plex test
library on the merged view → verify local + remote playback → test remote-master
outage → enable promotion audit-only → reconcile DB vs disk → enable real
promotion.

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

- **Agent heartbeat:** the agent exits without reporting when neither plan nor
  inventory changed, so "healthy idle" is indistinguishable from "stopped / net
  down / timer broken". Post a lightweight heartbeat every run, including no-ops;
  surface last-heartbeat age in `/tier-node list` / status.
- **Async / bounded deletion:** the agent measures directory sizes and deletes
  folders with synchronous fs calls, which can block Node for a long time on a
  big TV folder. It already has inventory sizes — estimate removal size from
  inventory and delete asynchronously or in bounded batches (`agent/agent.js`).

## Documentation status to reflect

`docs/edge-playback-architecture.md` should read:

```
PH play-triggered promotion:        implemented, off by default
PH merged fallback mount:           not implemented
California tiering:                 implemented
California play promotion:          not implemented
California merged fallback mount:   not implemented
Season-level TV planning:           not implemented
```
