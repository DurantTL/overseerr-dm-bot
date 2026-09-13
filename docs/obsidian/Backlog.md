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
  keyboard access, and client-side regressions. **Mostly landed:** the refresh guard, full ARIA
  tabs pattern, progress-bar semantics, `:focus-visible`, and the mojibake fix are done. Remaining:
  a live browser keyboard/visual walkthrough (this repo's test suite has no browser automation).
- [#188](https://github.com/DurantTL/overseerr-dm-bot/issues/188) — keep HTTP health and admin
  control available while Discord is degraded.
- ~~#190 — validate and expose the exact public dashboard origin for passkeys.~~ **Closed:**
  added `DASHBOARD_PUBLIC_URL` (defaults to `https://TUNNEL_DOMAIN`), strict validation, and a
  client-side origin preflight that catches a mismatch before the browser call.
- [#191](https://github.com/DurantTL/overseerr-dm-bot/issues/191) — provision and verify the
  external HTTPS path required by the dashboard. **Mostly landed:** `/doctor` (Discord command and
  `GET /admin/doctor`) now reports **Local process liveness**, **Public HTTPS origin**, **Public
  TLS certificate**, and **Proxy trust configuration** as distinct checks, and `DEPLOYMENT.md`
  spells out that port 3000 is plain HTTP and must sit behind the Cloudflare Tunnel/reverse proxy.
  Remaining: an operator needs to actually run the diagnostic against the live public hostname and
  confirm it reports healthy — that live verification can't be done from this repository.

## P1 — edge playback completion

- [#181](https://github.com/DurantTL/overseerr-dm-bot/issues/181) — verify the PH and California
  merged remote-fallback rollout.
- [#182](https://github.com/DurantTL/overseerr-dm-bot/issues/182) — implement California
  play-triggered promotion.
- [#183](https://github.com/DurantTL/overseerr-dm-bot/issues/183) — add season-level TV cache
  planning and promotion granularity.

## P2 — delivery and project hygiene

- [#184](https://github.com/DurantTL/overseerr-dm-bot/issues/184) — add image security gates,
  SBOM/provenance, and versioned releases. **Landed:** Trivy scans the bot and tier-agent images
  in the PR gate and the bot image again before publish (fails on a fixable CRITICAL/HIGH
  finding); published images carry SBOM/provenance attestations; GitHub Actions are pinned to
  immutable commit SHAs with Dependabot keeping them current; pushing a `vX.Y.Z` tag publishes
  that version alongside `latest`/`sha-*` and creates a GitHub Release. See "Versioned releases
  and image security" in `DEPLOYMENT.md`.
- [#185](https://github.com/DurantTL/overseerr-dm-bot/issues/185) — refresh documentation and
  establish the human-approved public-repository policy. **Nearly done:** PR #194 already did the
  doc refresh; only the automated drift-check (this doc vs. live GitHub state) remains open —
  this 2026-08-21 pass is exactly that kind of check, done manually.
- [#189](https://github.com/DurantTL/overseerr-dm-bot/issues/189) — cache and scope dashboard data
  with explicit freshness. **Partial:** a single-flight + TTL cache now coalesces and bounds the
  `GET /admin` integration fan-out (health/Tautulli/Arr queues/disk space/edge diagnostics/guild
  members), with a stale-on-failure fallback and a page-level freshness/staleness note, and
  dashboard mutations invalidate it. Remaining: per-panel freshness display and loading only the
  active panel instead of the whole page on every render.

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
