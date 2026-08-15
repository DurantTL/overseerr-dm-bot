---
tags:
  - project/overseerr-dm-bot
  - backlog
reviewed: 2026-08-16
source_commit: 5866460
github_snapshot: 5 open issues
---

# Backlog

[[Project Home]] | [[Project Graph]] | [[Project Review]] | [[Architecture]]

This is a snapshot of the live issue tracker on 2026-08-16. GitHub remains authoritative.

## Active work

- [#124 Sonarr season search](https://github.com/DurantTL/overseerr-dm-bot/issues/124) is the oldest open issue and the current implementation track.
  - Shipped in [#162](https://github.com/DurantTL/overseerr-dm-bot/pull/162): record pack-vs-episode fill detail and correct the partial-season summary claim.
  - Shipped in [#163](https://github.com/DurantTL/overseerr-dm-bot/pull/163): add pure interactive-release classification/ranking and the thin Sonarr search/grab API calls.
  - Shipped in [#164](https://github.com/DurantTL/overseerr-dm-bot/pull/164): report interactive-search candidates and Sonarr rejection reasons in Discord after partial/no-grab outcomes.
  - This branch: add nonce-backed, admin-gated force-grab buttons with duplicate and queue checks.
  - Next: add opt-in automatic forcing, default off.

## Follow-up issues

- [#158 Season-search alert backoff](https://github.com/DurantTL/overseerr-dm-bot/issues/158): stand down repeated `no_grab` alerts per series/season while continuing searches and re-arm after a meaningful change.
- [#159 Regional tier history dedupe](https://github.com/DurantTL/overseerr-dm-bot/issues/159): decide whether `rollHistoryByTitle` should be wired into tier planning or removed, then eliminate the unused-code warning.
- [#160 Escalation preview coverage](https://github.com/DurantTL/overseerr-dm-bot/issues/160): prove previews remain side-effect free, use unsaved settings, cover every verdict, and avoid external calls when disabled.
- [#161 Rate-limiter pattern](https://github.com/DurantTL/overseerr-dm-bot/issues/161): standardize on a CodeQL-visible package or document the deliberate hand-rolled design and dismissal process.

## Delivery order

Work oldest-first unless a dependency or production incident changes priority:

`#124` -> `#158` -> `#159` -> `#160` -> `#161`

#158 benefits from #124's interactive-search release count as a re-arm signal, so completing the #124 reporting path first preserves that dependency.
