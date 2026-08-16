---
tags:
  - project/overseerr-dm-bot
  - data
  - operations
reviewed: 2026-08-16
source_commit: 1a803ac
---

# Data and operations

[[Project Home]] | [[Architecture]] | [[Core Workflows]] | [[Backlog]]

## SQLite domains

The schema in [src/db.js](../../src/db.js) is the durable control plane.

| Domain | Tables |
| --- | --- |
| Identity and requests | `users`, `requests`, `request_subscribers`, `media_priority` |
| Access and evidence | `download_tokens`, `download_access_log`, `audit_log` |
| Settings, limits, and dedupe | `app_settings`, `rate_limit_hits`, `alert_cooldowns`, `webhook_events` |
| Cleanup and retention | `keep_list`, `pending_deletions`, `media_retention_rules` |
| Search and transfer | `escalations`, `grab_jobs`, `season_searches` |
| Regional staging | `stage_jobs`, `staged_items`, `edge_promote_log` |
| Tiering | `tier_nodes`, `tier_node_members`, `tier_node_folders`, `tier_agent_tokens`, `tier_node_files` |

The episode-recovery worker owns additional recovery state. Identity links, request history,
download tokens, approval state, cooldowns, runtime overrides, and tier convergence cannot all be
reconstructed from external services.

## Automation loops

The main process schedules request reconciliation, stuck-download detection, escalation,
season-pack search, transfers, torrent adoption, janitorial cleanup, backups, monthly recap,
transcode alerts, Premiumize monitoring, staging, and tunnel health. Episode recovery is started by
`bootstrap.js` as an isolated optional worker.

Runtime-editable overrides live in `app_settings`; clearing an override restores the environment
base. Scheduler startup, `/status`, dashboard settings, and run telemetry still use manually
synchronized inventories, which issue #186 will replace with one declarative registry.

## Safety controls

- Request approval is nonce-based and restart-persistent.
- Download tokens are hash-stored, expiring, optionally one-time, rate-limited, and revocable.
- Webhooks use configured secrets and durable replay keys.
- Media deletion defaults to disabled or dry-run and respects keep/never-delete controls.
- AvistaZ uses eligibility rules, confidence thresholds, duplicate checks, and a daily allowance.
- Tier plans fail closed on incomplete inventory; agents require mount proof and Receive Only
  folders before pruning.
- Credentials support `*_FILE` values, and the container runs without root privileges.
- Backups use SQLite's online API, verify integrity and critical tables, and expose rehearsal state.

## Current operational risks

- Public parser/authentication order and large pre-auth bodies require the #176 admission-control
  design.
- Schema evolution remains an unversioned migration path without a historical upgrade-fixture
  matrix (#179).
- The normal HTTP/admin server is coupled to Discord readiness (#188).
- Dashboard passkeys require an exact public HTTPS origin that is not yet fully provisioned and
  diagnosed by the repository (#190 and #191).
- Agent/runtime/tooling versions and lint coverage are not yet one enforced contract (#180).

Older claims that rate limits reset on restart, backups lack verification, file-backed secrets are
missing, or configuration failures are invisible are no longer current.

## Verification and delivery

`npm test` runs syntax checks and the Node test runner; the audited working tree reports 336
passing tests. `npm run lint` uses ESLint with the security plugin. Pull requests run lint, tests,
and a Docker build; pushes to `main` repeat the gate before publishing the image to GHCR.

Deep operational sources:

- [Deployment](../../DEPLOYMENT.md)
- [Production readiness](../production-readiness.md)
- [Regional tiering](../regional-tiering.md)
- [AvistaZ pipeline](../avistaz-pipeline.md)
- [Edge agent](../../agent/README.md)
