---
tags:
  - project/overseerr-dm-bot
  - architecture
reviewed: 2026-08-11
source_commit: b656155
---

# Architecture

[[Project Home]] | [[Project Graph]] | [[Core Workflows]] | [[Data and Operations]]

## Process boundary

`bootstrap.js` loads `index.js`, then starts the isolated episode-recovery worker. `index.js` is still the effective composition root and contains the Discord client, interaction handlers, Express application, webhook handlers, dashboard, and most scheduled sweeps.

At the reviewed commit, `index.js` is 7,763 lines. The `src/` directory contains Discord-independent service modules, but orchestration remains concentrated in the root file. That concentration is the reason [[Backlog#Foundations|issue #133]] targets route-handler extraction.

## Major components

| Component | Responsibility | Primary code |
| --- | --- | --- |
| Discord surface | Slash commands, buttons, modals, DMs, onboarding, approvals | [index.js](../../index.js) |
| HTTP surface | Health, webhooks, secure downloads, dashboard, agent API | [index.js](../../index.js) |
| Configuration | Environment parsing, required values, validation, warnings | [src/config.js](../../src/config.js) |
| Durable state | SQLite schema, migrations, row-level functions, audit | [src/db.js](../../src/db.js) |
| Request systems | Seerr API and local request reconciliation | [src/seerr.js](../../src/seerr.js), [src/request-tracking.js](../../src/request-tracking.js) |
| Media systems | Plex, Tautulli, Sonarr, Radarr, queue and disk state | [src/plex.js](../../src/plex.js), [src/tautulli.js](../../src/tautulli.js), [src/arr.js](../../src/arr.js) |
| Fallback pipeline | Escalation, release ranking, rTorrent, Premiumize | [src/escalation.js](../../src/escalation.js), [src/grab.js](../../src/grab.js), [src/rtorrent.js](../../src/rtorrent.js), [src/premiumize.js](../../src/premiumize.js) |
| Edge media | Staging, tier planning, diagnostics, standalone sync agent | [src/staging.js](../../src/staging.js), [src/tier.js](../../src/tier.js), [agent](../../agent/README.md) |
| Dashboard rendering | Escaped server-rendered HTML and settings forms | [src/dashboard-render.js](../../src/dashboard-render.js), [src/runtime-settings.js](../../src/runtime-settings.js) |

## HTTP boundaries

The Express server exposes five route groups:

- Public health: `GET /health`.
- Authenticated webhooks: Seerr, Plex, and Tautulli POST endpoints.
- Token-protected downloads: `GET /download/:token`.
- Per-node bearer-token agent endpoints for install, source, manifest, and reports.
- Password/session-protected admin dashboard, health, diagnostics, previews, settings, and revocation actions.

These routes share a closure created by `startExpressServer()`. No internet-facing route currently has an HTTP-level test, although pure helpers such as webhook secret checks and dedupe logic are tested. That gap is the highest structural security concern in [[Project Review]].

## External ownership

The bot coordinates systems rather than replacing them:

- Seerr owns the request catalog and request IDs.
- Plex owns access, libraries, and availability.
- Tautulli and Plex provide playback events and histories.
- Sonarr and Radarr own monitored media, queues, searches, and imports.
- Prowlarr supplies indexer searches, including AvistaZ.
- rTorrent keeps private-tracker downloads seeding.
- Syncthing owns replication to regional nodes; the edge agent applies a bot-generated keep/drop manifest.

The local SQLite database stores identity links, coordination state, audit history, tokens, queues, and plan state. See [[Data and Operations]].

## Deployment path

GitHub Actions runs lint, tests, and a Docker build. Pushes to `main` publish `latest` and commit-addressed images to GHCR. Docker Compose uses `pull_policy: always`; Watchtower can update the opted-in container. The runtime image is `node:24-slim`, runs as the unprivileged `node` user, and persists `/app/data` in a Docker volume.
