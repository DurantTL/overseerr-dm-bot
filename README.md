# Durant Media Server Bot

## What this is

**A Discord-first concierge for private Plex communities: onboard members, approve Seerr requests,
keep requesters informed, and safely manage media access.**

The normal member journey is intentionally short: request access once, use `/request`, follow the
four-step `/request-status` timeline, and watch on the assigned Plex server. The larger operational
toolkit is layered around that core instead of being required to understand it:

1. **Core concierge** — onboarding, Plex invites, Seerr requests, DMs, `/me`, and request tracking.
2. **Media operations** — queue health, secure downloads, cleanup previews, retention, and backups.
3. **Advanced infrastructure** — seedbox/AvistaZ transfer, Philippines staging, and multi-node tiering.

The repository keeps its historical `overseerr-dm-bot` name, while new user-facing copy calls the
product **Durant Media Server** and the request service **Seerr**. API names and migration-oriented
operator screens retain `Overseerr` where that compatibility context is useful.

> **Guided setup (issue #221 / PR #222):** `/setup` is being added as a persistent setup and
> troubleshooting center for both new and existing users. Main users get Plex-only guidance.
> Users assigned to `home_server=ph` additionally get PH Server Connection (Tailscale) device
> guides for phone/tablet, Apple TV, Android/Google TV, and computers. `/me` also gains mobile
> Quick Actions for common member commands. Plex username confirmation is preferred over relying
> on Plex invitation email delivery, and a saved username can be used to resend the server share.

## Documentation
This README covers what the bot does and how to set it up. Deep implementation detail for the
advanced-infrastructure layer lives in `docs/`:
- [AvistaZ pipeline](docs/avistaz-pipeline.md) — private-tracker fallback, season-pack-first search, direct grab
- [Plex Home staging](docs/plex-home-staging.md) — remote cache box, server-aware webhook routing
- [Regional tiering](docs/regional-tiering.md) — multi-node edge cache, the sync agent's safety model
- [Edge playback architecture](docs/edge-playback-architecture.md) — mergerfs remote-fallback design
- [mergerfs + Plex operational notes](docs/mergerfs-plex-operational.md)
- [Episode recovery watchdog](docs/episode-recovery.md)
- [Tier caching roadmap](docs/tier-caching-roadmap.md)
- [Production readiness / rollout gate](docs/production-readiness.md)
- [Project map and current backlog](docs/obsidian/Project%20Home.md)

## Features
- Discord onboarding workflow with admin approval buttons.
- Plex invite + access removal automation.
- Seerr/Overseerr request approvals from Discord.
- Secure download links (hashed tokens, expiry, optional one-time-use, access logs, rate limits).
- Audit logging for admin/user/system actions.
- Admin dashboard (`/admin`) with health, pending items, and safe action endpoints.
- Production topology and rollout gate: [`docs/production-readiness.md`](docs/production-readiness.md).
- Safe sync (`/sync mode:preview|apply`) and cleanup preview/apply.
- Full-chain linking: `/link` (and the one-click `/sync-fix links` buttons) merges any matching `plex_` synthetic row, sends a Plex invite if the person doesn't already have access, and links or creates the Seerr user including its Discord notification ID. The `email` fields on `/link`, `/reinvite`, and `/invite` autocomplete against every linked user — searchable by Discord name, Plex username, or email (the native user picker only suggests members your client has cached).
- Admin-initiated onboarding: `/invite @member` DMs them for their Plex email and **auto-approves** when they reply (no Approve button — the admin already vouched); `/invite @member email:x@y.com` skips the DM and sets them up immediately. `/invite-post` drops a persistent public **Request Plex Access** button in the current channel (email collected via modal, normal Approve/Deny review) — pin it and forget it. When `PH_SERVER_NAMES` is configured, every self-service path (welcome DM, `/invite`'s DM, and the Request Plex Access button/modal) also offers a **Main (USA) / Philippines** server pick up front, so admins don't have to `/assign-server` someone after the fact just because they said in chat they're in the Philippines.
- Media requesting with correct attribution: `/request` searches Seerr as you type and places the
  request **as the linked user's Seerr account**, so Seerr, webhooks, DMs, and keep/delete prompts
  all credit the right person. (Requestrr does *not* do this by default — it submits everything
  under its own configured Seerr account, which makes every request look like the admin's unless
  each Discord user is manually associated with a Seerr user in Requestrr's settings.)
- Bot-side approval gate: Seerr **always auto-approves** requests created with an admin API key
  (its status check uses the authenticated caller's permissions, and admins pass every check), so
  a Seerr-side pending state can't exist for bot requests. Instead, a non-admin `/request` is
  held by the bot and posted to the requests channel with **Approve/Deny** buttons — the Seerr
  request is only created when an admin clicks Approve (still attributed to the member), and Deny
  never touches Seerr. Either way the member gets a DM. Admin `/request`s skip the gate. Pending
  gate entries survive bot restarts.
- Optional per-topic notification channels (`REQUESTS_`/`SYSTEM_ALERTS_`/`DOWNLOADS_`/`CLEANUP_`/
  `AUDIT_`/`DEPLOY_CHANNEL_ID`), each falling back to `ADMIN_CHANNEL_ID` when unset — see
  `.env.example` for the routing map.
- Pipeline visibility: `/request-status` presents a submitted → approved → downloaded → delivered
  timeline and explains why a request isn't ready (pending approval,
  downloading with progress/ETA, stalled with the *arr's reported reason, or waiting for a
  release — including the expected digital release / air date pulled from Radarr/Sonarr when the
  title simply isn't out yet; approval DMs and AvistaZ escalation alerts show the same release
  ETA), `/queue` shows live downloads with stall reasons, `/watching` shows current Plex
  sessions, `/indexers` shows Prowlarr/Byparr health, `/debrid` shows Premiumize status, and
  `/cleanup-suggestions` lists the biggest disk hogs and estimates how much time the top five on
  the fastest-filling root would buy (read-only; honors keep/never-delete lists).
- Heavy-transcode alerts via Tautulli, startup config sanity warnings, and a version-stamped
  "Bot Online" deploy ping (`GIT_SHA` is baked into the image by CI).
- Test suite (`npm test`) runs the shipped code against mock Seerr servers; CI runs it on every
  PR and gates the image build.
- User self-service commands (`/request`, `/request-status`, `/me`, `/myrequests`, `/downloads`, `/keep`, `/help`).
- Health endpoints (`/health` and authenticated `/admin/health`) plus `/doctor` and
  `npm run doctor:edge` for read-only Main → edge transfer checks.

## Architecture
Discord events + slash commands are handled in the bot process, which also runs an Express server for webhooks, download streaming, health, and dashboard routes. State is stored in SQLite at `/app/data/plex_invites.db`.

### Code layout
- `index.js` — composition root: the Discord client, notification routing, slash/button handlers, webhooks, dashboard/express routes, and the periodic sweeps.
- `src/` — service modules with **no Discord dependencies** (they never import discord.js or reach back into index.js): `config.js` (env + validation + warnings), `log.js`, `util.js` (pure helpers), `db.js` (SQLite schema + every row helper), `seerr.js`, `plex.js`, `arr.js` (Radarr/Sonarr), `tautulli.js`, `premiumize.js`.
- `src/routes/` — named Express handler factories with explicit dependencies; `index.js` supplies those dependencies and registers middleware and route paths.
- `scripts/tests/` — the `npm test` suite; service modules are imported directly, index.js-resident functions are exercised via source extraction.

## Discord Bot Permissions / Intents
Required intents:
- Guilds
- GuildMembers
- GuildMessages
- DirectMessages
- MessageContent

Bot should have permission to:
- Send Messages / Send Messages in Threads
- Use Slash Commands
- Read Message History
- Embed Links

## Environment Variables
See `.env.example` for full values.

### Required by code
- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- `ADMIN_CHANNEL_ID`
- `ADMIN_USER_ID`
- `OVERSEERR_URL`
- `OVERSEERR_API_KEY`
- `PLEX_TOKEN` **or** `PLEX_USERNAME` + `PLEX_PASSWORD`
- `TUNNEL_DOMAIN`
- `RAID_PATH`
- `WEBHOOK_SECRET`, `TAUTULLI_WEBHOOK_SECRET` — since `TUNNEL_DOMAIN` is itself required, the
  `/webhook/overseerr`, `/webhook/plex`, and `/webhook/tautulli` routes are always reachable from
  the internet, live deletion or not; startup fails closed if either secret is blank.

### Optional (code)
- `LOG_LEVEL` (default `info`; `debug`/`info`/`warn`/`error`) — anything below the configured level is dropped. `LOG_FORMAT` (default `text`; `text`/`json`) — `json` emits one `{ts, level, msg}` object per line for shipping to something like Loki/ELK/CloudWatch instead of the default human-readable console format.
- `RADARR_URL`, `RADARR_API_KEY`
- `RADARR_4K_URL`, `RADARR_4K_API_KEY`
- `SONARR_URL`, `SONARR_API_KEY`
- `PROWLARR_URL`, `PROWLARR_API_KEY` — adds Prowlarr to `/status` and dashboard health checks, and powers `/indexers` (per-indexer health with failure/backoff states)
- `BYPARR_URL` — adds Byparr to health checks and `/indexers`; general status uses the fast
  `/openapi.json` liveness route, while `/indexers` keeps the slower browser-backed `/health`
  deep check
- `TAUTULLI_URL`, `TAUTULLI_API_KEY` — enables `/watching` (live Plex sessions) and the heavy-transcode watchdog: every `PLAYBACK_CHECK_MINUTES` (default `5`, `0` disables) sessions that are **video**-transcoding trigger an alert to `PLAYBACK_CHANNEL_ID` (fallback admin channel), at most once per user+media per `TRANSCODE_ALERT_COOLDOWN_MINUTES` (default `60`)
- `PREMIUMIZE_API_KEY` — enables `/debrid` (fair-use %, cloud storage, active/failed transfers, plus **Clear Stuck/0%** and **Clear Finished** buttons) and the **stuck-transfer watchdog**: every `PREMIUMIZE_CHECK_MINUTES` (default `15`, `0` disables) transfers that are errored or whose progress hasn't moved for `PREMIUMIZE_STUCK_AFTER_MINUTES` (default `45` — catches "0% forever") are checked. A transfer still at (effectively) 0% with no cached source (`PREMIUMIZE_AUTO_CLEAR_MAX_PROGRESS`, default `1`%) is deleted automatically (`PREMIUMIZE_AUTO_CLEAR_DEAD`, default on) instead of sitting in the queue re-alerting forever; anything else stuck gets a batched alert (one embed for the whole sweep, not one per transfer) with **Retry / Clear Transfer / Ignore** — a single stuck transfer keeps its own buttons, a batch gets **Clear Stuck/0%** / **Clear Finished** — at most once per transfer per `PREMIUMIZE_ALERT_COOLDOWN_HOURS` (default `6`)
- `STUCK_CHECK_MINUTES` (default `10`), `STUCK_AFTER_MINUTES` (default `45`), `STUCK_ALERT_COOLDOWN_HOURS` (default `6`) — stuck-download watchdog: when a queue item makes no progress for `STUCK_AFTER_MINUTES` (e.g. no seeders), the admin channel gets an alert with **Remove & Try Another Release** (blocklist + auto re-search), **Remove Only**, and **Ignore** buttons. TV episodes are consolidated **per season** — a whole season stalling (from either download path, public indexers or the AvistaZ fallback) is one alert listing every stuck episode, and its buttons act on all of them at once, instead of one message per episode. Set `STUCK_CHECK_MINUTES=0` to disable.
- `ESCALATION_ENABLED` (default `false`), `AVISTAZ_TAG` (default `avistaz`), `ESCALATION_DELAY_MINUTES` (default `45`; the legacy `ESCALATION_DELAY_HOURS` still works when the minutes key is unset), `ESCALATION_CHECK_MINUTES` (default `15`), `ESCALATION_MAX_AGE_DAYS` (default `14`), `ESCALATION_ARR_GRACE_MINUTES` (default `10`; the "request never landed" check), plus optional `RADARR_ROOT_FOLDER`/`SONARR_ROOT_FOLDER`/`RADARR_QUALITY_PROFILE`/`SONARR_QUALITY_PROFILE` for the direct-add rescue button — the AvistaZ private-tracker fallback; see [docs/avistaz-pipeline.md](docs/avistaz-pipeline.md) for the one-time Radarr/Sonarr/Prowlarr setup and the full escalation rules.
- `RTORRENT_URL`, `RTORRENT_LABEL_MOVIE`/`RTORRENT_LABEL_TV` (defaults `radarr`/`sonarr`), `AVISTAZ_INDEXER_NAME` (default `avistaz`), `AVISTAZ_DAILY_GRAB_LIMIT` (default `100`, `0` = unlimited), `GRAB_MODE` (`approve` default / `auto`), `GRAB_AUTO_CONFIDENCE` (default `92`), `GRAB_TV_COMPLETE` (default on — one-click whole-series grabs), `GRAB_TV_MAX_RELEASES` (default `6`), `GRAB_TV_COMPLETE_MIN_CONFIDENCE` (default `70`), `GRAB_RCLONE_REMOTE`, `GRAB_RCLONE_FLAGS`, `GRAB_STAGING_PATH`, `GRAB_IMPORT_PATH`, `GRAB_CHECK_MINUTES` (default `5`), `GRAB_COPY_TIMEOUT_MINUTES` (default `240`), `GRAB_MISSING_AFTER_MINUTES` (default `10`), `GRAB_DOWNLOAD_TIMEOUT_HOURS` (default `72`), `SONARR_AUTO_MANUAL_IMPORT` (default `false` — see "Sonarr series identity" in [docs/avistaz-pipeline.md](docs/avistaz-pipeline.md)) — the AvistaZ **direct grab** pipeline (`/avistaz`, and the smarter escalation path); see that doc for the full setup and flow.
- `RTORRENT_ADOPT_ENABLED` (default `false`), `RTORRENT_ADOPT_CHECK_MINUTES` (default `5`), `RTORRENT_ADOPT_LABELS` (default `sonarr,radarr`), `RTORRENT_ADOPT_AUTO` (default `false`), `RTORRENT_REMOTE_ROOT` (unset) — **adoption** of torrents that already exist in the seedbox rTorrent (`/rtorrent`); see "Adopting existing torrents" in [docs/avistaz-pipeline.md](docs/avistaz-pipeline.md). Manual `/rtorrent adopt` works whenever the direct-grab transfer pieces are configured; `RTORRENT_ADOPT_ENABLED` gates only the discovery sweep.
- `JANITOR_CHECK_MINUTES` (default `60`) — janitor sweep interval; `0` disables. The janitor:
  1. **Grace deletes** — enforces the "Finished Watching" prompt's auto-delete promise for an
     exact movie edition. 4K prompts retain `radarr-4k` identity through execution; ambiguous legacy
     rows fail closed. Episode playback never creates a series-wide delete action. Requires
     `ENABLE_DELETION=true`; honors dry-run, keep list, and never-delete list.
  2. **Disk-space alerts and forecast** — samples each *arr-visible root during the existing poll,
     retaining at most 30 days and 720 samples per root. After at least six samples spanning 24
     hours, `/status` and the dashboard show an approximate fill date from a median interval trend;
     a single large import is treated as a step rather than a sustained rate. The admin channel is
     warned (24h cooldown) below `DISK_SPACE_WARN_GB` (default `100`) or within
     `DISK_FORECAST_WARN_DAYS` projected days (default `14`). Both thresholds are runtime-tunable
     in the Automation tab and `0` disables that warning. Forecasts remain advisory. Set
     `DISK_SPACE_PATHS` (comma-separated) to an allowlist of mounts/folders to report — this hides
     the container's own `/` and `/config` disks and relabels a mount with the more specific media
     folder (e.g. shows `/share/media` for the `/share` mount). Unset reports every *arr mount.
  3. **Retention rules** — with `RETENTION_ENFORCEMENT=true`, enforces the `media_retention_rules` table (`movie_4k`/`movie_1080p` → matching Radarr, `tv_episode` → Sonarr) every `RETENTION_CHECK_HOURS` (default `24`), deleting oldest-first, at most `RETENTION_MAX_DELETES_PER_RUN` (default `10`) per run. Dry-run posts a "would delete" digest instead.
- `TAILSCALE_ENABLED` (default `false`) — adds an **Approve + Tailscale (PH)** button next to
  Approve/Deny on new access requests, for viewers who need to reach the PH box (CGNAT + no
 ... (truncated)