---
tags:
  - project/overseerr-dm-bot
  - architecture
reviewed: 2026-08-16
source_commit: 1a803ac
---

# Architecture

[[Project Home]] | [[Project Graph]] | [[Core Workflows]] | [[Data and Operations]]

## Process boundary

`bootstrap.js` validates configuration before loading `index.js`. An invalid deployment exposes a
diagnostic health server without opening the Discord client or normal workers. A valid deployment
loads `index.js`, then starts the isolated episode-recovery worker.

`index.js` remains the composition root for the Discord client, interaction handlers, Express
application, dashboard, and most scheduled sweeps. At the reviewed commit it is 9,417 lines. The
webhook handlers have moved to `src/routes/webhooks.js`, but most route registration and behavior
still share the `startExpressServer()` closure. Issue
[#178](https://github.com/DurantTL/overseerr-dm-bot/issues/178) owns the next route-extraction and
HTTP-integration boundary.

## Major components

| Component | Responsibility | Primary code |
| --- | --- | --- |
| Discord surface | Slash commands, buttons, modals, DMs, onboarding, approvals | [index.js](../../index.js) |
| HTTP composition | Middleware, route registration, dashboard and agent routes | [index.js](../../index.js) |
| Extracted HTTP handlers | Dependency-injected webhook behavior | [src/routes/webhooks.js](../../src/routes/webhooks.js) |
| Configuration and bootstrap | Environment parsing, validation, warnings, diagnostic startup | [src/config.js](../../src/config.js), [bootstrap.js](../../bootstrap.js) |
| Durable state | SQLite schema, migrations, row-level functions, audit | [src/db.js](../../src/db.js) |
| Request systems | Seerr API and local request reconciliation | [src/seerr.js](../../src/seerr.js), [src/request-tracking.js](../../src/request-tracking.js) |
| Media systems | Plex, Tautulli, Sonarr, Radarr, queue and disk state | [src/plex.js](../../src/plex.js), [src/tautulli.js](../../src/tautulli.js), [src/arr.js](../../src/arr.js) |
| Fallback pipeline | Escalation, release ranking, rTorrent, Premiumize | [src/escalation.js](../../src/escalation.js), [src/grab.js](../../src/grab.js), [src/rtorrent.js](../../src/rtorrent.js), [src/premiumize.js](../../src/premiumize.js) |
| Edge media | Staging, tier planning, diagnostics, standalone sync agent | [src/staging.js](../../src/staging.js), [src/tier.js](../../src/tier.js), [agent](../../agent/README.md) |
| Dashboard rendering | Escaped server-rendered HTML and settings forms | [src/dashboard-render.js](../../src/dashboard-render.js), [src/runtime-settings.js](../../src/runtime-settings.js) |

## HTTP boundaries and tests

The process exposes these route groups:

- Public liveness and health: `GET /live`, `GET /health`.
- Secret-authenticated Seerr, Plex, and Tautulli webhooks.
- Token-protected downloads: `GET /download/:token`.
- Per-node bearer-token agent install, source, manifest, and report routes.
- Password/session-protected dashboard, health, diagnostics, previews, settings, and actions.

The test suite has one real HTTP-boundary test for the config-error `/health` server, four direct
request/response tests for the extracted webhook handlers, and a real HTTP test for the shared
rate-limit middleware. Most normal application routes still lack app-level HTTP integration tests,
so it is inaccurate to say there are no route tests while equally inaccurate to call the HTTP
surface comprehensively covered.

## External ownership

The bot coordinates systems rather than replacing them:

- Seerr owns the request catalog and request IDs.
- Plex owns access, libraries, and availability.
- Tautulli and Plex provide playback events and histories.
- Sonarr and Radarr own monitored media, queues, searches, and imports.
- Prowlarr supplies indexer searches, including AvistaZ.
- rTorrent keeps private-tracker downloads seeding.
- Syncthing owns regional replication; the edge agent applies bot-generated keep/drop manifests.

SQLite stores identity links, request coordination, tokens, queues, audit history, runtime
overrides, cooldowns, and edge plan state. See [[Data and Operations]].

## Deployment path

GitHub Actions runs lint, tests, and a Docker build. Pushes to `main` publish `latest` and
commit-addressed images to GHCR. The runtime image is `node:24-slim`, runs as the unprivileged
`node` user, and persists `/app/data` in a Docker volume. Public TLS is owned by a trusted external
proxy or tunnel; issue [#191](https://github.com/DurantTL/overseerr-dm-bot/issues/191) tracks making
that requirement reproducible and observable.
