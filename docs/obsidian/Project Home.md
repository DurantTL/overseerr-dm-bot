---
aliases:
  - Overseerr DM Bot
  - Durant Media Server Bot
tags:
  - project/overseerr-dm-bot
  - map-of-content
reviewed: 2026-08-11
source_commit: b656155
---

# Overseerr DM Bot project home

This vault maps the checked-out `DurantTL/overseerr-dm-bot` repository at commit `b656155` and the 19 open GitHub issues reviewed on 2026-08-11.

The product is a Discord-first concierge for private Plex communities. It links Discord members to Plex and Seerr, gates requests, reports request progress, and adds an operator layer for downloads, recovery, cleanup, staging, and regional media caches.

## Start here

- [[Project Graph]] gives the fastest visual orientation.
- [[Architecture]] explains the runtime and repository boundaries.
- [[Core Workflows]] follows the important member and media paths.
- [[Data and Operations]] covers SQLite state, automation, deployment, and safety controls.
- [[Backlog]] groups all open issues and records their dependencies.
- [[Project Review]] gives the main conclusions and recommended work order.

## Source entry points

- [README](../../README.md)
- [Deployment guide](../../DEPLOYMENT.md)
- [Composition root](../../index.js)
- [Bootstrap](../../bootstrap.js)
- [Service modules](../../src)
- [Edge agent](../../agent/README.md)
- [Tests](../../scripts/tests)
- [GitHub repository](https://github.com/DurantTL/overseerr-dm-bot)

## Current shape

The application is one Node.js 24 process with three major responsibilities:

1. Discord commands, buttons, modals, onboarding, and notifications.
2. Express routes for webhooks, downloads, health, the admin dashboard, and edge agents.
3. Periodic automation for request reconciliation, search/recovery, transfers, retention, backups, and tiering.

SQLite is the durable coordination layer. External systems remain authoritative for their own domains: Seerr for requests, Plex for access and playback, Sonarr/Radarr for library and queue state, Prowlarr for indexers, and Syncthing or rclone for edge movement.

## Graph conventions

Open this folder as an Obsidian vault. Obsidian's graph view uses the internal links between these notes, while the Mermaid diagrams in [[Project Graph]] show explicit runtime and backlog relationships.
