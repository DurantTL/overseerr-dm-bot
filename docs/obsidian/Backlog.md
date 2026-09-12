---
tags:
  - project/overseerr-dm-bot
  - backlog
reviewed: 2026-09-09
source_commit: 7d2e045
github_snapshot: 20 open issues
---

# Backlog

[[Project Home]] | [[Project Graph]] | [[Project Review]] | [[Architecture]]

This is a snapshot of the live issue tracker on 2026-09-09. GitHub remains authoritative. The
open program contains umbrella issue [#175](https://github.com/DurantTL/overseerr-dm-bot/issues/175),
14 open children from #178–#191, and five review follow-ups (#252 and #254–#257). Issues #176 and
#177 are closed.

## P0 — public HTTP security

- ~~#176 — authenticate and throttle public HTTP work before large body parsing.~~ **Closed**
  after the pre-auth ordering and tier-agent admission-control work landed.
- ~~#177 — require an explicit, high-entropy dashboard session signing secret.~~ **Closed**
  (PR #205).

## P1 — reliability and testability

- ~~#178 — extract and integration-test the remaining HTTP surface.~~ **Closed** (PR #274): every
  route group (health/download, tier-agent, webhook, auth/passkeys, dashboard reads, dashboard
  mutations) now lives in a dependency-injected module under `src/routes/`.
- [#179](https://github.com/DurantTL/overseerr-dm-bot/issues/179) — add versioned,
  transactional SQLite migrations and upgrade fixtures. **Mostly landed:** the transaction +
  version ledger (PR #208), historical upgrade fixtures (PR #268), and now ordered/skippable
  migration steps plus a pre-migration backup snapshot for existing databases. Remaining: surface
  the migration version/failure state in startup health output.
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

## 2026-09-09 feature-review follow-ups

- [#252](https://github.com/DurantTL/overseerr-dm-bot/issues/252) — add proactive stale tier-plan
  alerts while preserving the manual large-rebalance confirmation gate.
- [#254](https://github.com/DurantTL/overseerr-dm-bot/issues/254) — preserve unavailable telemetry
  and identify temperature sensor sources correctly.
- [#255](https://github.com/DurantTL/overseerr-dm-bot/issues/255) — select TV seasons consistently
  across mobile and slash-command requests.
- [#256](https://github.com/DurantTL/overseerr-dm-bot/issues/256) — persist support cases through
  assignment and resolution.
- [#257](https://github.com/DurantTL/overseerr-dm-bot/issues/257) — replace Discord prototype
  interception incrementally. The Media Center slice landed in PR #258.

## Dependency order

Continue #178 before deeper dashboard route work, and complete #188 before moving scheduler
ownership into #186's automation registry. For edge playback,
verify fallback under #181 before California promotion under #182; season-level planning under
#183 should precede unrestricted TV promotion. Coordinate #190 with #191 so strict WebAuthn
verification consumes a verified HTTPS origin.

The earlier #116–#170 roadmap is complete history. It must not be used as the current delivery
queue; the live #175 umbrella and its child issues control current priorities.
