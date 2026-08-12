---
tags:
  - project/overseerr-dm-bot
  - data
  - operations
reviewed: 2026-08-11
source_commit: b656155
---

# Data and operations

[[Project Home]] | [[Architecture]] | [[Core Workflows]] | [[Backlog]]

## SQLite domains

The schema in [src/db.js](../../src/db.js) is the durable control plane.

| Domain | Tables |
| --- | --- |
| Identity and requests | `users`, `requests`, `request_subscribers`, `media_priority` |
| Access and evidence | `download_tokens`, `download_access_log`, `audit_log` |
| Settings and dedupe | `app_settings`, `webhook_events` |
| Cleanup and retention | `keep_list`, `pending_deletions`, `media_retention_rules` |
| Search and transfer | `escalations`, `grab_jobs`, `season_searches` |
| Regional staging | `stage_jobs`, `staged_items`, `edge_promote_log` |
| Tiering | `tier_nodes`, `tier_node_members`, `tier_node_folders`, `tier_agent_tokens`, `tier_node_files` |

The episode-recovery worker adds its own recovery state schema. The database is operationally important because identity links, request history, download tokens, trust, pending actions, and tier convergence cannot all be reconstructed from external services.

## Automation loops

The main process schedules request reconciliation, stuck-download detection, escalation, season-pack search, grab transfer, torrent adoption, janitorial cleanup, backups, monthly recap, transcode alerts, Premiumize monitoring, staging, and tunnel health. Episode recovery runs from `bootstrap.js` as a separately structured worker.

Several automation settings can be changed from the dashboard without a redeploy. Overrides live in `app_settings`; the compose/environment value remains the base value, and clearing an override returns control to that base.

## Safety controls

- Request approval is nonce-based and restart-persistent.
- Download tokens are hash-stored, expire, can be one-time-use, and can be revoked.
- Webhooks use configured secrets and durable replay keys.
- Media deletion defaults to disabled or dry-run and respects keep/never-delete controls.
- AvistaZ uses eligibility rules, confidence thresholds, and a daily grab allowance.
- Tier plans fail closed on incomplete inventory; agents require mount proof and Receive Only folders before pruning.
- The container runs without root privileges and the media mount is read-only by default.

## Operational weaknesses

Current rate limits and some alert cooldowns are memory-backed, so restarts reset them ([[Backlog#Silent failure and reliability|#129]]). Backup files are rotated without an integrity test or surfaced last-success timestamp ([[Backlog#Silent failure and reliability|#131]]). Credentials are environment variables rather than file-backed Docker secrets ([[Backlog#Foundations|#130]]).

Startup validation can also fail before the HTTP server binds, leaving Portainer restart state and container logs as the only evidence. [[Backlog#Silent failure and reliability|#122]] reduces bad-placeholder failures and [[Backlog#Silent failure and reliability|#125]] makes fatal configuration errors visible through health and persistent state.

## Verification and delivery

`npm test` runs syntax checks and the built-in Node test runner. `npm run lint` uses ESLint with the security plugin. Pull requests run lint, tests, and a Docker build; pushes to `main` repeat the gate before publishing the image to GHCR.

Deep operational sources:

- [Deployment](../../DEPLOYMENT.md)
- [Production readiness](../production-readiness.md)
- [Regional tiering](../regional-tiering.md)
- [AvistaZ pipeline](../avistaz-pipeline.md)
- [Edge agent](../../agent/README.md)

