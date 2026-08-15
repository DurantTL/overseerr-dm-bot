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
- Admin-initiated onboarding: `/invite @member` DMs them for their Plex email and **auto-approves** when they reply (no Approve button — the admin already vouched); `/invite @member email:x@y.com` skips the DM and sets them up immediately. `/invite-post` drops a persistent public **Request Plex Access** button in the current channel (email collected via modal, normal Approve/Deny review) — pin it and forget it.
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
- `BYPARR_URL` — adds Byparr (`/health` endpoint) to health checks and `/indexers`
- `TAUTULLI_URL`, `TAUTULLI_API_KEY` — enables `/watching` (live Plex sessions) and the heavy-transcode watchdog: every `PLAYBACK_CHECK_MINUTES` (default `5`, `0` disables) sessions that are **video**-transcoding trigger an alert to `PLAYBACK_CHANNEL_ID` (fallback admin channel), at most once per user+media per `TRANSCODE_ALERT_COOLDOWN_MINUTES` (default `60`)
- `PREMIUMIZE_API_KEY` — enables `/debrid` (fair-use %, cloud storage, active/failed transfers, plus **Clear Stuck/0%** and **Clear Finished** buttons) and the **stuck-transfer watchdog**: every `PREMIUMIZE_CHECK_MINUTES` (default `15`, `0` disables) transfers that are errored or whose progress hasn't moved for `PREMIUMIZE_STUCK_AFTER_MINUTES` (default `45` — catches "0% forever") alert the downloads channel with **Retry / Clear Transfer / Ignore** buttons, at most once per transfer per `PREMIUMIZE_ALERT_COOLDOWN_HOURS` (default `6`)
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
- `PATH_REMAP_FROM`, `PATH_REMAP_TO`
- `DOWNLOAD_*`, `ENABLE_DELETION`, `KEEP_LIST_DEFAULT_DAYS`, `NEVER_DELETE_MEDIA_IDS`
- `DELETION_DRY_RUN` (default `true`) — when deletion is confirmed, logs the exact file paths and API call that would fire and skips the real delete API. Flip to `false` only after reviewing real prompts.
- `AUTO_REMOVE_PLEX_ON_LEAVE` (default `false`) — when `false`, a member leaving Discord only notifies the admin channel with a one-click **Revoke Plex** button instead of silently revoking. Multi-email merges in `/sync-fix mergeemails` are resolved per-row from the admin embed (no env key).
- `DELETION_GRACE_HOURS`, `DELETION_REMINDER_COOLDOWN_HOURS`
- `DASHBOARD_ENABLED`, `DASHBOARD_ADMIN_PASSWORD`, `DASHBOARD_ADMIN_TOKEN`, `STRICT_DASHBOARD_POST_AUTH`
- Notification channels (all optional; unset = `ADMIN_CHANNEL_ID`): `REQUESTS_CHANNEL_ID` (new
  Seerr requests, approve/deny, failed requests), `SYSTEM_ALERTS_CHANNEL_ID` (low disk space),
  `DOWNLOADS_CHANNEL_ID` (stuck downloads, large download started), `CLEANUP_CHANNEL_ID`
  (finished-watching prompts, janitor/retention reports), `AUDIT_CHANNEL_ID` (linked/unlinked,
  member left, Plex revoked), `DEPLOY_CHANNEL_ID` (post-restart "Bot online" ping — **no
  fallback**, sends only when set), `PLAYBACK_CHANNEL_ID` (reserved for future Tautulli
  playback alerts). Onboarding access-request embeds always go to `ADMIN_CHANNEL_ID`.

### Optional (compose-only)
- `MEDIA_HOST_PATH` (host path mounted to `/mnt/raid` in container)
- `CLOUDFLARE_TUNNEL_TOKEN` (optional cloudflared sidecar)

---

## Docker Compose Setup
```bash
git clone <your-repo>
cd overseerr-dm-bot
cp .env.example .env
# edit .env values
docker compose up -d --build
```

Compose defaults:
- Service name + container: `overseerr-dm-bot`
- SQLite persisted in named volume `durant_bot_data`
- Media mounted read-only: `${MEDIA_HOST_PATH:-/mnt/raid}:/mnt/raid:ro`
- Liveness endpoint: `http://127.0.0.1:3000/live`; readiness and integration status: `http://127.0.0.1:3000/health`

## Portainer Setup (first deployment)
1. In Portainer, create a new stack and paste `docker-compose.yml`.
2. Add environment variables from `.env.example` (or upload `.env`).
3. Ensure `RAID_PATH=/mnt/raid` matches the container mount target.
4. Ensure `MEDIA_HOST_PATH` points to your host media root.
5. Deploy the stack.
6. Confirm container health is `healthy`.

## Cloudflare Tunnel Setup (optional)
1. Create/manage tunnel in Cloudflare Zero Trust.
2. Set `CLOUDFLARE_TUNNEL_TOKEN`.
3. Enable tunnel sidecar profile:
   ```bash
   docker compose --profile tunnel up -d
   ```
4. Point hostname (for downloads/webhooks) to bot service URL.

## Webhook Setup
- Seerr: `POST /webhook/overseerr` — header `x-webhook-secret: $WEBHOOK_SECRET`
- Plex: `POST /webhook/plex` — header `x-webhook-secret`, **or** `?secret=$WEBHOOK_SECRET`
- Tautulli: `POST /webhook/tautulli` — header `x-tautulli-secret: $TAUTULLI_WEBHOOK_SECRET`

Agent endpoints (each requires that node's bearer token from `/tier-node token`):
`GET /agent/install/:node` (one-command installer), `GET /agent/source/:node` (agent.js),
`GET /agent/manifest/:node`, `POST /agent/report/:node`.

### Plex webhooks (Plex Pass required)

Plex's webhook feature accepts a URL and nothing else — it cannot attach a custom header — so
the Plex route is the one place the shared secret may travel in the query string instead:

```
https://<your-domain>/webhook/plex?secret=<WEBHOOK_SECRET>
```

Add it under **Plex → Settings → Webhooks → Add Webhook**. Query strings are recorded in
proxy/CDN access logs where headers are not, so prefer the header for any client that can send
one; Overseerr and Tautulli therefore do not accept `?secret=`.

Plex sends one webhook per *account*, from every server that account owns, so a single entry
covers a multi-server setup. Which server an event came from is read from `Server.title` /
`Server.uuid` and routed through `PH_SERVER_NAMES` / `CA_EDGE_SERVER_NAMES` /
`PRIMARY_SERVER_NAMES` — see [Plex Home staging](docs/plex-home-staging.md). Only
`media.scrobble`, `media.play`, and `media.resume` are acted on; everything else is ignored.

### Seerr webhook JSON payload (important for correct requester attribution)
The bot resolves who made a request from its own DB first (matching `requestedBy_email`
against linked users on canonical email), and only falls back to the Discord ID in the
payload. Make sure the Seerr webhook JSON template includes the `{{request}}` block and
`{{image}}` — and uses the **`requestedBy_*`** variables, *not* `notifyuser_*` (those
resolve to whoever receives the notification, typically the admin, which makes every
request look like it came from the server owner):

```json
{
  "notification_type": "{{notification_type}}",
  "event": "{{event}}",
  "subject": "{{subject}}",
  "message": "{{message}}",
  "image": "{{image}}",
  "{{media}}": {
    "media_type": "{{media_type}}",
    "tmdbId": "{{media_tmdbid}}",
    "tvdbId": "{{media_tvdbid}}",
    "status": "{{media_status}}",
    "status4k": "{{media_status4k}}"
  },
  "{{request}}": {
    "request_id": "{{request_id}}",
    "requestedBy_email": "{{requestedBy_email}}",
    "requestedBy_username": "{{requestedBy_username}}",
    "requestedBy_avatar": "{{requestedBy_avatar}}",
    "requestedBy_settings_discordId": "{{requestedBy_settings_discordId}}",
    "requestedBy_settings_discordIds": "{{requestedBy_settings_discordIds}}"
  }
}
```

The template lists **both** Discord variables so it works on every version: Seerr 3.3+
fills `requestedBy_settings_discordIds` (renamed in
[seerr-team/seerr#2712](https://github.com/seerr-team/seerr/pull/2712), may contain
multiple IDs), while Overseerr / Jellyseerr 2.x fills the singular
`requestedBy_settings_discordId`. Whichever variable the server doesn't know is left as a
literal `{{...}}` placeholder, which the bot safely ignores.

Enable at least: Request Pending Approval, Request Approved, Request Automatically
Approved, Request Declined, Request Available, Request Processing Failed.

### Seerr 3.3+ per-user Discord IDs
Seerr 3.3 replaced the old single per-user "Discord ID" field with a multi-entry
**Discord IDs** list, found under **Users → (edit user) → Notifications → Discord**. The
field only appears once the Discord agent is enabled under **Settings → Notifications →
Discord**. The bot fills it automatically on `/link`, `/invite`, and `/sync-fix links`
(merging with any IDs already set, not overwriting). If the bot ran an older version
against Seerr 3.3, the old API payload stored an *empty* ID list — re-run
`/sync-fix links` once after updating to repopulate every user.

Not sure any of this is working? Run **`/seerr-test`**: it checks the Seerr version and
whether the Discord agent is enabled, then creates a throwaway Seerr user, pushes a
Discord ID through the same call `/link` uses, reads it back to prove it stored, and
deletes the test user. Pass `keep:true` to leave the test user in Seerr so you can open
*Users → bot-selftest → Settings → Notifications → Discord* and see the field yourself
(delete the user afterwards).

## Discord Command Registration
Slash commands are registered automatically on bot startup using `DISCORD_CLIENT_ID` + `DISCORD_GUILD_ID`.

---

## First-Deploy Checklist
- [ ] Container `overseerr-dm-bot` is running and healthy.
- [ ] Discord bot appears online in your server.
- [ ] Slash commands appear in the configured guild.
- [ ] `GET /health` returns `overall: ok` or `degraded` only for expected unavailable services; optional integrations may show `skipped`.
- [ ] `GET /admin` without auth: API/curl callers get HTTP `401`; a browser is redirected to `/admin/login`.
- [ ] `POST /webhook/plex` with invalid secret returns HTTP `401` (when `WEBHOOK_SECRET` is set).
- [ ] `/download` creates links that work and only hashed tokens are stored in `download_tokens`.
- [ ] `./scripts/backup-db.sh` creates a backup file.
- [ ] `./scripts/restore-db.sh` refuses overwrite without `--force`.
- [ ] Media mount is read-only (`:ro`) and `RAID_PATH=/mnt/raid` inside container.
- [ ] Admin channel receives request/approval/download notifications.

## Rollback Plan
1. Stop current container/stack.
2. Redeploy previous known-good image/tag or previous git commit.
3. Restore SQLite backup **if needed**:
   ```bash
   ./scripts/restore-db.sh ./backups/plex_invites-YYYYMMDD-HHMMSS.db /app/data/plex_invites.db --force
   ```
4. Start stack again.
5. Verify `GET /health` and `GET /admin/health`.
6. Confirm bot reconnects in Discord and slash commands respond.

---

## Smoke Test Script
Use `scripts/smoke-test.sh` after deploy:

```bash
# token auth example
ADMIN_TOKEN='your_dashboard_token' BASE_URL='http://127.0.0.1:3000' ./scripts/smoke-test.sh

# password auth example
ADMIN_PASSWORD='your_dashboard_password' ./scripts/smoke-test.sh
```

It checks:
- `/health` is reachable
- `/admin` unauthorized is `401`
- `/admin` authorized is `200` (if credentials supplied)
- `/webhook/plex` bad secret behavior
- RAID path existence
- database file existence

## Backup and Restore
Scripts:
- `scripts/backup-db.sh`
- `scripts/restore-db.sh`

Examples:
```bash
# Manual backup
./scripts/backup-db.sh /app/data/plex_invites.db ./backups

# Restore (requires --force if destination exists)
./scripts/restore-db.sh ./backups/plex_invites-YYYYMMDD-HHMMSS.db /app/data/plex_invites.db --force
```

Backups use SQLite's online backup API, so committed WAL data is included even while the bot is
running. Stop the bot before restoring. Restore verifies integrity, replaces the database
atomically, and removes stale `-wal`/`-shm` sidecars from the old database.

Recommended cron (host):
```cron
0 */6 * * * cd /opt/overseerr-dm-bot && ./scripts/backup-db.sh /app/data/plex_invites.db ./backups
```

## Health Checks
- Public JSON: `GET /health`
- Authenticated JSON: `GET /admin/health`

Checks include Discord, SQLite, Plex, Seerr/Overseerr, Radarr, Radarr-4K, Sonarr, RAID path, and tunnel domain configuration. `/doctor` additionally performs read-only source, rclone remote, cache listing/free-space, tunnel, transfer queue, and tier-agent checks.

## Admin Dashboard
- Route: `GET /admin` (themed, dark UI).
- Login: visit `/admin/login` and use an enrolled passkey, or enter `DASHBOARD_ADMIN_PASSWORD` (or `DASHBOARD_ADMIN_TOKEN`) as the rate-limited fallback. A signed, HttpOnly session cookie is set for either method; sessions last `SESSION_TTL_HOURS` (default 12). A **Log out** button is in the top bar.
- Enrol, rename, and revoke passkeys from the authenticated dashboard. The first passkey must be enrolled after a password login. Passkeys are discoverable platform credentials for Touch ID, Face ID, Windows Hello, and Android; multiple devices can be enrolled with separate labels.
- Passkeys use `TUNNEL_DOMAIN` as their exact relying-party ID and `https://TUNNEL_DOMAIN` as their only accepted origin. Enrol them through the public Cloudflare tunnel URL. Credentials enrolled on `localhost`, another hostname, or an HTTP origin will not work through the tunnel.
- Login is rate limited (5 attempts / 15 min per IP) to slow brute-force guessing.
- The old `?password=` / `?token=` query-string auth has been **removed** (it leaked credentials into history and logs). For scripts/automation, use the `x-admin-password` or `x-admin-token` request headers — these still work.
- Shows overall status, summary stat cards, color-coded integration health badges, and readable tables for pending users/requests, linked users, recent downloads, keep/delete decisions, and audit logs, plus safe action buttons (revoke-all asks for confirmation).
- Configure the cookie signing secret with `SESSION_SECRET` (optional; derived from your admin credentials if unset). Changing `TUNNEL_DOMAIN` requires enrolling new passkeys for the new hostname.

## Security Notes
- Raw download tokens are never stored in SQLite.
- Download requests are rate limited and logged.
- Download streaming validates path containment under `RAID_PATH`.
- Admin endpoints are authenticated.
- Secrets are not intentionally logged.
- Client-IP rate limits trust `X-Forwarded-For` only when `TRUST_PROXY=true` (one known proxy hop).
- Audit and download-access logs are pruned after `LOG_RETENTION_DAYS` (default 90; `0` disables).

### Rate limiting
The `/download` command and public `/download/:token` route use SQLite-backed rolling-window
counters, so a deploy, crash, or Watchtower restart does not reset an exhausted allowance. Expired
hits are deleted on the next check. The lower-risk `/request`, `/stage`, and dashboard-login limits
remain in-process because this app runs as one instance with one SQLite file and one Discord login.

IP-based limiting depends on `TRUST_PROXY` being set correctly. The download route and dashboard
login key their buckets on `req.ip`, which only reflects the real client address when
`TRUST_PROXY=true` and the bot sits behind exactly one trusted proxy hop (the Cloudflare Tunnel
setup above). Left at the default `false` behind a tunnel, every request can appear to come from
the same upstream address, making the limiter too strict because one real user can consume the
shared allowance.

## Testing Webhooks / Helpers
- Seerr test webhook: send sample payload to `/webhook/overseerr`.
- Plex test webhook: POST multipart `payload` to `/webhook/plex`.
- Tautulli test webhook: POST JSON to `/webhook/tautulli`.
- Health test: `curl http://localhost:3000/health`.
- Smoke test: `./scripts/smoke-test.sh`.

## AvistaZ Private-Tracker Fallback & Direct Grab
For content public indexers can't find, the bot can escalate a title to the AvistaZ private
tracker: automatic detection of Asian-content titles (AvistaZ's specialty), season-pack-first
searching so an old show pulls one pack instead of 30 per-episode grabs, and a full direct-grab
pipeline (Prowlarr search → score → seedbox rTorrent → rclone → arr import) instead of leaving
Radarr/Sonarr to grab on their own judgement. Admin approval is required by default
(`GRAB_MODE=approve`) with a daily grab limit, since this is real automated searching/downloading
against a named private tracker.

See **[docs/avistaz-pipeline.md](docs/avistaz-pipeline.md)** for the full escalation rules,
one-time Radarr/Sonarr/Prowlarr setup, whole-series grabs, adoption of existing torrents, and the
Sonarr series-identity resolver.

## Plex Home Staging (remote cache box)
A second, small Plex server (e.g. behind CGNAT and a VPS tunnel) can serve a local **cache** of
the master library — `/stage <title>` copies a title in on demand, play-triggered promotion warms
a title the moment a viewer starts it, and a disk-pressure guard evicts least-recently-streamed
titles when the cache runs low.

See **[docs/plex-home-staging.md](docs/plex-home-staging.md)** for the full command set, the
server-aware webhook routing that keeps a cache-server "Free Up Space" click from ever reaching
the master's delete flow, and the one-server-per-person invite/revocation model.

## Regional Tiering ("edge cache")
Multiple nodes can each run their own Plex against a local Syncthing replica of the media tree,
curated to each node's disk budget by a keep/drop manifest the bot publishes and a small sync
agent (`agent/`) converges. Demand is scored per node (Tautulli history, direct Plex playback, or
file atime), with a mount guard that refuses to prune anything if the node's real media drive
isn't actually mounted.

See **[docs/regional-tiering.md](docs/regional-tiering.md)** for the full tier model (floor /
node-demand / member-pin scoring), the agent's safety ordering, and the `/tier`/`/tier-node`
command set.

## Slash Command List
Admin (hidden from non-admin roles by default; grant per-role via Server Settings → Integrations if e.g. PH users should `/pin`):
- `/invite`, `/invite-post`, `/link`, `/unlink`, `/users`, `/status`, `/backup-rehearse`, `/doctor`, `/seerr-test`, `/sync`, `/sync-fix`, `/reinvite`, `/requests`, `/cleanup`, `/cleanup-suggestions`, `/audit`, `/revoke-downloads`, `/watching`, `/indexers`, `/debrid`, `/avistaz`, `/rtorrent`, `/staged`, `/pin`, `/unpin`, `/stage-bulk`, `/assign-server`, `/tier`, `/tier-node`, `/tier-member`

User:
- `/request`, `/request-status`, `/download`, `/queue`, `/me`, `/myrequests`, `/downloads`, `/keep`, `/help`, `/stage`

## Database Tables
- `users`
- `requests`
- `keep_list`
- `download_tokens`
- `download_access_log`
- `audit_log`
- `app_settings`
- `media_retention_rules`
- `escalations` (AvistaZ fallback watch list)
- `grab_jobs` (AvistaZ direct-grab pipeline: sent → downloading → complete → transferring → scanning → (importing) → verified, or needs_mapping/import_rejected/failed; adopted torrents enter at downloading/complete with origin `adopt`/`adopt-auto`; `target_arr_id`/`tvdb_id`/`match_type` pin the resolved Sonarr/Radarr identity)
- `stage_jobs` (durable Plex Home staging queue)
- `staged_items` (PH cache inventory + LRU/pin state)
- `tier_nodes` (regional tiering node registry)
- `tier_node_members` (restricted nodes' closed access sets)
- `tier_agent_tokens` (per-node sync-agent bearer token hashes)
- `tier_node_files` (agent-reported local inventory — the atime demand signal)

## Migration Notes
On startup the bot creates missing tables and adds missing columns with non-destructive migrations. Existing data is preserved.
