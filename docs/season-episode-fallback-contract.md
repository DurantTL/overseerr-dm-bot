# Sonarr Season-to-Episode Fallback Contract

Status: design contract for [issue #198](https://github.com/DurantTL/overseerr-dm-bot/issues/198),
packet 1. This document is normative for the implementation packets that follow. It intentionally
adds no command, scheduler, database, configuration, or Discord behavior by itself.

## Problem boundary

The season-pack worker first asks Sonarr for a season. On a fully missing season, Sonarr can limit
that automatic search to full-season releases. An episode-scoped interactive search may then show
an approved `SxxEyy` release even though the season command grabbed nothing. The fallback should
ask Sonarr to search individual missing episodes without turning one old 138-episode season into an
unbounded indexer burst.

The fallback is not a force-grab path. Sonarr's normal decision engine remains responsible for
quality, language, custom formats, blocklists, download permission, and the final grab. It is also
not AvistaZ escalation: no torrent is fetched directly and no private-tracker allowance is spent by
the bot.

## Decisions

### 1. Verification discovers work; the guarded sweep submits it

`verifySeasonSearchCommand()` may establish that a fallback is eligible, but it must not submit an
`EpisodeSearch` command from its asynchronous monitor callback. It records a pending season instead.
The existing guarded season-pack sweep drains pending fallback work before starting new season
searches. Dashboard run-now uses the same guard and drain path.

This split gives one place a global episode-search budget and prevents several season verification
callbacks from each believing they own the full budget. It also makes a restart safe: pending work
is durable, while the live Sonarr episode and queue reads remain the source of truth.

```text
SeasonSearch verification
        |
        | no/partial progress + safe episode evidence
        v
durable pending season
        |
        | next guarded season-pack sweep
        v
interactive + live-state recheck -- eligible pack --> existing pack path
        |
        | no eligible pack, no live blocker
        v
bounded EpisodeSearch command
        |
        v
terminal verification --> resolved | retry cooldown | normal season cooldown
```

### 2. The pure planner owns every eligibility and cap decision

Packet 2 adds one pure planner under `src/`. Both preview and execution must call it with the same
normalized inputs. I/O code may gather facts, submit a returned plan, and persist the result; it may
not repeat or override planner policy.

Conceptual input:

```js
{
  seriesId,
  seasonNumber,
  anchorEpisodeId,
  anchorEpisodeNumber,
  episodes,             // live Sonarr rows for the season
  releaseDecision,      // normalized pack/episode evidence from a fresh or cached observation
  queuedEpisodeIds,
  seasonQueued,
  claimedEpisodeIds,
  seasonClaimed,
  pendingState,
  now,
  budget: { perSeason, remainingGlobal },
}
```

Conceptual output:

```js
{
  action,               // submit | resolved | wait | blocked | no_evidence
  reason,               // stable value from the tables below
  episodeIds,           // ordered, capped submission list
  eligibleCount,
  submittedCount,
  deferredCount,
  nextEligibleAt,
  evidenceFingerprint,
}
```

The planner returns data only. It never reads time implicitly, calls Sonarr, writes SQLite, audits,
or creates Discord messages.

A second pure helper normalizes ranked releases, `chooseSeasonPack()`, and the anchor episode into:

```js
{
  status,               // eligible_pack | approved_episode | no_approved_episode | unavailable
  anchorEpisodeId,
  anchorEpisodeNumber,
  fingerprint,
  observedAt,
}
```

Execution supplies a freshly observed decision. Preview supplies the last persisted decision and
its observation time; both paths still use the same planner.

### 3. Episode evidence is positive and episode-scoped

The interactive query is anchored to the first live eligible missing episode because supported
Sonarr versions reliably scope `GET /release` by `episodeId`. A fallback is authorized only when at
least one returned release satisfies all of these conditions:

- Sonarr reports `approved === true`.
- `downloadAllowed !== false`.
- The release is not a full-season, multi-season, or complete-series pack.
- No blocking rejection is reported.
- When Sonarr reports `episodeNumbers`, they include the anchor episode. Otherwise the parsed title
  must identify exactly the requested season and anchor episode.

An unscoped result, unknown-series result, wrong-series alias, wrong season/episode, rejected
release, or missing download permission is not evidence. Interactive-search failure is
`interactive_unavailable`, never permission to fan out.

Evidence authorizes Sonarr to try its normal episode search; it does not authorize the bot to POST
that interactive release or assume that every other episode has a result.

### 4. Pack preference is absolute at planning time

The existing `chooseSeasonPack()` result is evaluated before episode evidence. When it returns an
eligible pack, the planner returns `blocked / eligible_pack` with no episode IDs. Existing manual
offer and default-off automatic pack behavior owns the next action.

Unsafe or ineligible packs do not block an otherwise safe episode fallback. This distinction keeps
the current pack seed/size/confidence limits meaningful without allowing a bad pack to strand
Sonarr-approved episodes.

Every retry performs a fresh interactive query and pack choice. If a good pack appears while a
fallback is pending, it wins before another episode batch is submitted.

### 5. Live state, not persisted episode IDs, determines the batch

Immediately before planning each batch, execution re-reads Sonarr episodes and queue state and
normalizes active content claims. An episode is eligible only when it is:

- in the requested non-special season;
- aired at or before the injected `now`;
- monitored while the series is monitored;
- missing its file;
- absent from Sonarr's queue; and
- not covered by an active episode, season, multi-season, or complete-series claim.

A season-wide queue item or active season-covering claim returns `blocked / season_covered`. Queued
or claimed individual episodes are removed from the eligible list. Episode IDs are sorted by
episode number and then Sonarr ID for deterministic batching.

Persisted state never stores the deferred episode-ID list. Deferred work is the difference between
the next live eligible set after the cycle's high-water cursor and the planner's cap. This prevents
imports, monitoring edits, episode refreshes, or renumbering during a restart from leaving stale
work behind.

The cursor is the `(episode_number, Sonarr episode ID)` pair of the last accepted batch member.
Within one fallback cycle, the planner considers only live eligible episodes ordered after that
pair; it never wraps to the beginning. The accepted command advances the cursor even when Sonarr
grabs nothing, so an unavailable E01 cannot starve E26 forever. When no live eligible episode
exists after the cursor, the cycle is complete: clear the pending row and return the season to its
normal cooldown. A later season cycle starts with no cursor and can retry still-missing earlier
episodes.

### 6. Fan-out has per-season and global limits

The implementation exposes these runtime-visible settings in the existing `season_pack` group:

| Setting | Default | Contract |
| --- | ---: | --- |
| `SEASON_PACK_EPISODE_FALLBACK` | `true` | Master switch; false submits no episode commands. |
| `SEASON_PACK_EPISODE_BATCH_SIZE` | `25` | Maximum episode IDs in one Sonarr command for one season. |
| `SEASON_PACK_EPISODE_MAX_PER_RUN` | `50` | Maximum total episode IDs submitted by one guarded sweep. |
| `SEASON_PACK_EPISODE_RETRY_MINUTES` | `180` | Earliest retry after a terminal or uncertain fallback attempt. |

The hard invariants are `1 <= batch size <= global maximum` and total submitted IDs never exceed
the run's remaining global budget. One season gets at most one batch per sweep. Eligible pending
seasons are ordered by `next_eligible_at`, then `last_attempt_at` (null first), series ID, and season
number. This gives old work priority without letting a 138-episode season consume every run.

Examples with defaults:

- Revenge S02 (22 missing): one command with at most 22 IDs.
- La Luna Sangre S01 (72 missing): up to 25, 25, and 22 across eligible runs; each batch is
  re-derived from live state after the cursor.
- Majika S01 (138 missing): never more than 25 in one command or 50 across the entire sweep; the
  cycle advances rather than retrying its first 25 indefinitely.

### 7. Fallback retry timing is separate from season-search cooldown

The existing `SEASON_PACK_COOLDOWN_HOURS` continues to govern new `SeasonSearch` attempts. It must
not delay a pending episode fallback. Pending rows use `next_eligible_at` and
`SEASON_PACK_EPISODE_RETRY_MINUTES` instead.

While a fallback row is `pending`, `submitted`, or in fallback cooldown, the normal season-target
planner suppresses another `SeasonSearch` for the same series/season. Each fallback retry still
re-runs interactive search, so a newly available eligible pack can take over without racing a new
season command.

The fallback returns to normal season cooldown only after `no_episode_evidence`,
`interactive_unavailable`, a terminal no-grab with no deferred eligible episodes, or an explicit
operator cancellation. A resolved season removes its pending row.

### 8. Durable state is a scheduler hint, not media truth

Packet 3 adds one additive, restart-safe SQLite table keyed by `(series_id, season_number)`:

| Column | Purpose |
| --- | --- |
| `series_id`, `season_number`, `series_title` | Stable work identity and operator label. |
| `state` | `pending`, `submitted`, or `cooldown`. |
| `evidence_status`, `evidence_fingerprint`, `evidence_observed_at` | Bounded normalized evidence for restart and preview. |
| `anchor_episode_id`, `anchor_episode_number` | Episode used for that evidence observation. |
| `last_command_id` | Correlate terminal polling; nullable before submission. |
| `cursor_episode_number`, `cursor_episode_id` | High-water pair for fair progress within one cycle. |
| `last_attempt_at`, `next_eligible_at` | Fair ordering and fallback-only retry timing. |
| `last_outcome`, `last_error` | Bounded operator/audit context. |
| `created_at`, `updated_at` | Restart and stale-state diagnostics. |

The migration is create-if-not-exists only. It does not rewrite season search times or existing
alert state. Recording the accepted command ID and its last submitted cursor pair is one SQLite
transaction.

On restart, `submitted` rows are reconciled before new work:

1. If the recorded command is still running, wait.
2. If it is terminal, verify live files/queue and enter the normal terminal transition.
3. If command state cannot be obtained, do not immediately resubmit. Move to cooldown, record
   `command_unknown`, and wait one fallback retry interval before a live replanning pass.

### 9. Submission has a final race check

The guarded sweep owns submissions, but an administrator or Sonarr can still act between planning
and POST. Execution therefore performs one final live queue/claim check after planning and directly
before `triggerEpisodeSearch(episodeIds)`. Any season-wide coverage blocks the command; newly
covered individual episodes are removed and the cap is reapplied. An empty result submits nothing.

The command ID is persisted immediately after Sonarr accepts the POST. A process crash before that
write is treated as an uncertain submission on restart: live queue/files are checked and the row
enters cooldown rather than issuing an immediate duplicate.

## Stable decisions and transitions

Planner reasons:

| Action | Reason | Meaning |
| --- | --- | --- |
| `resolved` | `season_complete` | No live eligible missing episodes remain. |
| `wait` | `retry_cooldown` | Fallback-specific next time has not arrived. |
| `blocked` | `fallback_disabled` | Runtime master switch is off. |
| `blocked` | `eligible_pack` | Existing pack path wins. |
| `blocked` | `season_covered` | Queue or active claim covers the season. |
| `blocked` | `global_budget_exhausted` | A later season waits for another guarded run. |
| `no_evidence` | `interactive_unavailable` | Query failed; no fallback is authorized. |
| `no_evidence` | `no_approved_episode` | No safe episode release supports fallback. |
| `no_evidence` | `evidence_not_observed` | Preview has no cached real-search evidence and does not search. |
| `resolved` | `cycle_complete` | No live eligible episode remains after the cursor; return to normal cooldown. |
| `submit` | `approved_episode` | Submit the returned capped IDs after the final check. |

Terminal command outcomes:

| Outcome | Next state |
| --- | --- |
| Every aired monitored episode now has a file | delete row as resolved |
| Queue/history shows grabs and live eligible episodes remain | `cooldown`; derive remainder later |
| No grab and deferred eligible episodes remain after the cursor | `cooldown`; continue after the cursor |
| Completed with no grab and no longer any episode evidence | return to normal season cooldown |
| Cursor reaches the end while earlier attempted episodes remain missing | finish this cycle; normal season cooldown before retrying them |
| Failed or aborted | `cooldown`, retain bounded error |
| Timed out or command unknown | `cooldown`; never immediate resubmit |

Result reporting uses distinct audit/outcome names (`episode_fallback_pending`,
`episode_fallback_submitted`, `episode_fallback_partial`, `episode_fallback_complete`,
`episode_fallback_no_grab`, `episode_fallback_failed`, `episode_fallback_timed_out`). A changed
evidence fingerprint, missing count, submitted/deferred count, command status, or queue/import
progress re-arms the existing per-season alert backoff. An identical result does not.

## Preview and observability contract

Preview calls the same pure planner with live episodes, queue/claim facts, the persisted normalized
evidence decision, and a simulated per-run budget. It must not call Sonarr's `/release` endpoint:
although that endpoint is a GET, it launches an indexer search. Preview performs no indexer
searches, commands, force-grabs, SQLite writes, alert-state writes, offer creation, or audit writes.
Each preview row reports action/reason, eligible, submitted, deferred, cap, next-eligible time, and
when its evidence was observed. With no cached observation it reports `evidence_not_observed`
instead of guessing.

Execution audits the same counts plus series/season, anchor episode, evidence fingerprint,
command ID, and final-check blocker. Discord copy must say "episode fallback" and must not call the
result a pack. A submitted batch reports both submitted and deferred counts so a long season is not
presented as fully handled.

## Required fixture matrix for implementation packets

| Fixture | Expected contract result |
| --- | --- |
| Revenge S02: 22/22 missing, approved E01 release, no eligible pack | submit 22, defer 0 |
| Revenge S04: 23/23 missing, approved E01 releases, no eligible pack | submit 23, defer 0 |
| La Luna Sangre: wrong/unknown series rejection only | no evidence, submit 0 |
| Majika: no interactive releases | no evidence, submit 0 |
| 72 missing with defaults | submit 25, then advance to the next live 25 and final 22 |
| 138 missing with defaults | submit 25 and advance cursor; global run remains at or below 50 |
| First 25 produce no grabs | next attempt starts after their cursor; no first-batch starvation |
| Eligible pack plus approved episode | pack blocks episode fallback |
| Season queue/claim appears at final check | submit 0 |
| Five individual episodes become queued before final check | remove those IDs and submit remainder within cap |
| Restart with pending row | live replan; no deferred-ID snapshot required |
| Restart with uncertain submitted row | cooldown first; no immediate duplicate command |
| Preview of any fixture | same plan and counts, zero writes/commands |
| Preview without cached evidence | `evidence_not_observed`; zero `/release` calls |

## Packet boundary

This packet freezes policy and failure behavior only. Packet 2 owns the pure planner and the thin
Arr `triggerEpisodeSearch(episodeIds)` helper with focused tests. Packet 3 owns SQLite migration,
guarded execution, preview, runtime settings, command monitoring, audit, and Discord wiring. Packet
4 updates environment and operator documentation after the verified defaults exist in code.
