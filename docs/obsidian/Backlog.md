---
tags:
  - project/overseerr-dm-bot
  - backlog
reviewed: 2026-08-21
source_commit: 937f379
github_snapshot: 16 open issues
---

# Backlog

[[Project Home]] | [[Project Graph]] | [[Project Review]] | [[Architecture]]

This is a snapshot of the live issue tracker on 2026-08-21. GitHub remains authoritative. The
open program contains umbrella issue [#175](https://github.com/DurantTL/overseerr-dm-bot/issues/175)
and 15 open child issues, #176, #178–#191 (#177 closed via PR #205 — session secret enforcement
landed). PR #226 (rclone preflight case-sensitivity, Premiumize dead-transfer detection,
season-pack/rTorrent dedupe) merged today; it closes out further iterations of already-closed
tickets (#211, #212, #198) and does not correspond to any open issue below.

## P0 — public HTTP security

- [#176](https://github.com/DurantTL/overseerr-dm-bot/issues/176) — authenticate and throttle
  public HTTP work before large body parsing. **Partial:** pre-auth ordering (PR #203) and the
  tier-agent rate limit (PR #204) landed; broader route/concurrency review still open.
- ~~#177 — require an explicit, high-entropy dashboard session signing secret.~~ **Closed**
  (PR #205).

## P1 — reliability and testability

- [#178](https://github.com/DurantTL/overseerr-dm-bot/issues/178) — extract and integration-test
  the remaining HTTP surface. **Partial:** the `createApp()` seam landed (PR #207); route-group
  extraction remains.
- [#179](https://github.com/DurantTL/overseerr-dm-bot/issues/179) — add versioned,
  transactional SQLite migrations and upgrade fixtures. **Partial:** transaction + version ledger
  landed (PR #208); ordered/historical fixtures remain.
- [#180](https://github.com/DurantTL/overseerr-dm-bot/issues/180) — align the Node runtime contract
  and bring the tier agent into CI. Not started.

## P1 — automation and dashboard

- [#186](https://github.com/DurantTL/overseerr-dm-bot/issues/186) — unify scheduler inventory,
  run telemetry, and dashboard controls.
- [#187](https://github.com/DurantTL/overseerr-dm-bot/issues/187) — correct dashboard refresh,
  keyboard access, and client-side regressions.
- [#188](https://github.com/DurantTL/overseerr-dm-bot/issues/188) — keep HTTP health and admin
  control available while Discord is degraded.
- [#190](https://github.com/DurantTL/overseerr-dm-bot/issues/190) — validate and expose the exact
  public dashboard origin for passkeys.
- [#191](https://github.com/DurantTL/overseerr-dm-bot/issues/191) — provision and verify the
  external HTTPS path required by the dashboard.

## P1 — edge playback completion

- [#181](https://github.com/DurantTL/overseerr-dm-bot/issues/181) — verify the PH and California
  merged remote-fallback rollout.
- [#182](https://github.com/DurantTL/overseerr-dm-bot/issues/182) — implement California
  play-triggered promotion.
- [#183](https://github.com/DurantTL/overseerr-dm-bot/issues/183) — add season-level TV cache
  planning and promotion granularity.

## P2 — delivery and project hygiene

- [#184](https://github.com/DurantTL/overseerr-dm-bot/issues/184) — add image security gates,
  SBOM/provenance, and versioned releases. Not started.
- [#185](https://github.com/DurantTL/overseerr-dm-bot/issues/185) — refresh documentation and
  establish the human-approved public-repository policy. **Nearly done:** PR #194 already did the
  doc refresh; only the automated drift-check (this doc vs. live GitHub state) remains open —
  this 2026-08-21 pass is exactly that kind of check, done manually.
- [#189](https://github.com/DurantTL/overseerr-dm-bot/issues/189) — cache and scope dashboard data
  with explicit freshness.

## Dependency order

Finish #176 (#177 is done). Establish the #178 HTTP seam before expanding route behavior, and
define #186's automation registry before migrating dashboard automation. For edge playback,
verify fallback under #181 before California promotion under #182; season-level planning under
#183 should precede unrestricted TV promotion. Coordinate #190 with #191 so strict WebAuthn
verification consumes a verified HTTPS origin.

The earlier #116–#170 roadmap is complete history. It must not be used as the current delivery
queue; the live #175 umbrella and its child issues control current priorities.
