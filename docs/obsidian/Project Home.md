---
aliases:
  - Overseerr DM Bot
  - Durant Media Server Bot
tags:
  - project/overseerr-dm-bot
  - map-of-content
reviewed: 2026-08-21
source_commit: 937f379
github_snapshot: 16 open issues
---

# Durant Media Server Bot project home

This vault maps `DurantTL/overseerr-dm-bot` at commit `937f379` and the 16 open GitHub issues
reviewed on 2026-08-21. GitHub remains authoritative after that dated snapshot.

The product is a Discord-first concierge for private Plex communities. It links Discord members
to Plex and Seerr, gates requests, reports request progress, and adds an operator layer for
downloads, recovery, cleanup, staging, and regional media caches.

## Start here

- [[Project Graph]] gives the fastest visual orientation.
- [[Architecture]] explains the runtime, repository, and test boundaries.
- [[Core Workflows]] follows the important member and media paths.
- [[Data and Operations]] covers SQLite state, automation, deployment, and safety controls.
- [[Backlog]] is the dated view of the live #175–#191 work program.
- [[Project Review]] summarizes the current risks and recommended order.

Historical investigations are retained for context, not priority setting. In particular,
[`season-search-review.md`](../season-search-review.md) is an archived review whose proposed work
has since shipped.

## Source entry points

- [README](../../README.md)
- [Deployment guide](../../DEPLOYMENT.md)
- [Composition root](../../index.js)
- [Bootstrap](../../bootstrap.js)
- [Service modules](../../src)
- [HTTP handler factories](../../src/routes)
- [Edge agent](../../agent/README.md)
- [Tests](../../scripts/tests)
- [Contributor workflow](../../AGENTS.md)
- [Shared engineering guide](../../CLAUDE.md)
- [Contribution policy](../../CONTRIBUTING.md)
- [Security reporting](../../SECURITY.md)
- [MIT License](../../LICENSE)
- [GitHub repository](https://github.com/DurantTL/overseerr-dm-bot)

## Current shape

The application targets Node.js 24 and currently combines three responsibilities:

1. Discord commands, buttons, modals, onboarding, and notifications.
2. Express routes for health, webhooks, downloads, the admin dashboard, and edge agents.
3. Periodic automation for request reconciliation, search/recovery, transfers, retention,
   backups, staging, and tiering.

At this working-tree audit, `index.js` is 9,417 lines. The test suite contains 53 `*.test.js`
files and `npm test` reports 336 passing tests. SQLite is the durable coordination layer; external
services remain authoritative for requests, libraries, queues, indexers, playback, and file
movement.

## Graph conventions

Open this folder as an Obsidian vault. Obsidian's graph view uses the internal links between these
notes, while the Mermaid diagrams in [[Project Graph]] show explicit runtime and backlog
relationships.
