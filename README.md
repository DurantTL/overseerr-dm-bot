# Durant Media Server Bot

## Overview
Durant Media Server Bot is a Discord + Plex + Seerr/Overseerr automation bot for private media communities. It handles onboarding, request review, media availability notifications, secure download links, retention prompts, sync/cleanup tooling, and admin observability.

## Features
- Discord onboarding workflow with admin approval buttons.
- Plex invite + access removal automation.
- Seerr/Overseerr request approvals from Discord.
- Secure download links (hashed tokens, expiry, optional one-time-use, access logs, rate limits).
- Audit logging for admin/user/system actions.
- Admin dashboard (`/admin`) with health, pending items, and safe action endpoints.
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
- Pipeline visibility: `/request-status` explains why a request isn't ready (pending approval,
  downloading with progress/ETA, stalled with the *arr's reported reason, or waiting for a
  release — including the expected digital release / air date pulled from Radarr/Sonarr when the
  title simply isn't out yet; approval DMs and AvistaZ escalation alerts show the same release
  ETA), `/queue` shows live downloads with stall reasons, `/watching` shows current Plex
  sessions, `/indexers` shows Prowlarr/Byparr health, `/debrid` shows Premiumize status, and
  `/cleanup-suggestions` lists the biggest disk hogs (read-only; honors keep/never-delete lists).
- Heavy-transcode alerts via Tautulli, startup config sanity warnings, and a version-stamped
  "Bot Online" deploy ping (`GIT_SHA` is baked into the image by CI).
- Test suite (`npm test`) runs the shipped code against mock Seerr servers; CI runs it on every
  PR and gates the image build.
- User self-service commands (`/request`, `/request-status`, `/me`, `/myrequests`, `/downloads`, `/keep`, `/help`).
- Health endpoints (`/health` and authenticated `/admin/health`).

## Architecture
Discord events + slash commands are handled in the bot process, which also runs an Express server for webhooks, download streaming, health, and dashboard routes. State is stored in SQLite at `/app/data/plex_invites.db`.

### Code layout
- `index.js` — composition root: the Discord client, notification routing, slash/button handlers, webhooks, dashboard/express routes, and the periodic sweeps.
- `src/` — service modules with **no Discord dependencies** (they never import discord.js or reach back into index.js): `config.js` (env + validation + warnings), `log.js`, `util.js` (pure helpers), `db.js` (SQLite schema + every row helper), `seerr.js`, `plex.js`, `arr.js` (Radarr/Sonarr), `tautulli.js`, `premiumize.js`.
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

### Optional (code)
- `WEBHOOK_SECRET`
- `TAUTULLI_WEBHOOK_SECRET`
- `RADARR_URL`, `RADARR_API_KEY`
- `RADARR_4K_URL`, `RADARR_4K_API_KEY`
- `SONARR_URL`, `SONARR_API_KEY`
- `PROWLARR_URL`, `PROWLARR_API_KEY` — adds Prowlarr to `/status` and dashboard health checks, and powers `/indexers` (per-indexer health with failure/backoff states)
- `BYPARR_URL` — adds Byparr (`/health` endpoint) to health checks and `/indexers`
- `TAUTULLI_URL`, `TAUTULLI_API_KEY` — enables `/watching` (live Plex sessions) and the heavy-transcode watchdog: every `PLAYBACK_CHECK_MINUTES` (default `5`, `0` disables) sessions that are **video**-transcoding trigger an alert to `PLAYBACK_CHANNEL_ID` (fallback admin channel), at most once per user+media per `TRANSCODE_ALERT_COOLDOWN_MINUTES` (default `60`)
- `PREMIUMIZE_API_KEY` — enables `/debrid` (fair-use %, cloud storage, active/failed transfers, plus **Clear Stuck/0%** and **Clear Finished** buttons) and the **stuck-transfer watchdog**: every `PREMIUMIZE_CHECK_MINUTES` (default `15`, `0` disables) transfers that are errored or whose progress hasn't moved for `PREMIUMIZE_STUCK_AFTER_MINUTES` (default `45` — catches "0% forever") alert the downloads channel with **Retry / Clear Transfer / Ignore** buttons, at most once per transfer per `PREMIUMIZE_ALERT_COOLDOWN_HOURS` (default `6`)
- `STUCK_CHECK_MINUTES` (default `10`), `STUCK_AFTER_MINUTES` (default `45`), `STUCK_ALERT_COOLDOWN_HOURS` (default `6`) — stuck-download watchdog: when a queue item makes no progress for `STUCK_AFTER_MINUTES` (e.g. no seeders), the admin channel gets an alert with **Remove & Try Another Release** (blocklist + auto re-search), **Remove Only**, and **Ignore** buttons. TV episodes are consolidated **per season** — a whole season stalling (from either download path, public indexers or the AvistaZ fallback) is one alert listing every stuck episode, and its buttons act on all of them at once, instead of one message per episode. Set `STUCK_CHECK_MINUTES=0` to disable.
- `ESCALATION_ENABLED` (default `false`), `AVISTAZ_TAG` (default `avistaz`), `ESCALATION_DELAY_MINUTES` (default `45`; the legacy `ESCALATION_DELAY_HOURS` still works when the minutes key is unset), `ESCALATION_CHECK_MINUTES` (default `15`), `ESCALATION_MAX_AGE_DAYS` (default `14`), `ESCALATION_ARR_GRACE_MINUTES` (default `10`; the "request never landed" check), plus optional `RADARR_ROOT_FOLDER`/`SONARR_ROOT_FOLDER`/`RADARR_QUALITY_PROFILE`/`SONARR_QUALITY_PROFILE` for the direct-add rescue button — the AvistaZ private-tracker fallback; see the dedicated section below. Requires the one-time Radarr/Sonarr/Prowlarr setup described there.
- `RTORRENT_URL`, `RTORRENT_LABEL_MOVIE`/`RTORRENT_LABEL_TV` (defaults `radarr`/`sonarr`), `AVISTAZ_INDEXER_NAME` (default `avistaz`), `AVISTAZ_DAILY_GRAB_LIMIT` (default `4`, `0` = unlimited), `GRAB_MODE` (`approve` default / `auto`), `GRAB_AUTO_CONFIDENCE` (default `92`), `GRAB_RCLONE_REMOTE`, `GRAB_RCLONE_FLAGS`, `GRAB_STAGING_PATH`, `GRAB_IMPORT_PATH`, `GRAB_CHECK_MINUTES` (default `5`), `GRAB_COPY_TIMEOUT_MINUTES` (default `240`), `GRAB_MISSING_AFTER_MINUTES` (default `10`), `GRAB_DOWNLOAD_TIMEOUT_HOURS` (default `72`) — the AvistaZ **direct grab** pipeline (`/avistaz`, and the smarter escalation path); see the dedicated section below.
- `RTORRENT_ADOPT_ENABLED` (default `false`), `RTORRENT_ADOPT_CHECK_MINUTES` (default `5`), `RTORRENT_ADOPT_LABELS` (default `sonarr,radarr`), `RTORRENT_ADOPT_AUTO` (default `false`), `RTORRENT_REMOTE_ROOT` (unset) — **adoption** of torrents that already exist in the seedbox rTorrent (`/rtorrent`); see "Adopting existing torrents" below. Manual `/rtorrent adopt` works whenever the direct-grab transfer pieces are configured; `RTORRENT_ADOPT_ENABLED` gates only the discovery sweep.
- `JANITOR_CHECK_MINUTES` (default `60`) — janitor sweep interval; `0` disables. The janitor:
  1. **Grace deletes** — enforces the "Finished Watching" prompt's auto-delete promise: if nobody clicks Keep/Delete within `DELETION_GRACE_HOURS`, the media is deleted (requires `ENABLE_DELETION=true`; honors `DELETION_DRY_RUN`, keep list, and never-delete list). Requester gets a DM; admin channel gets a report. "Remind Me Later" restarts the grace window after the reminder.
  2. **Disk-space alerts** — warns the admin channel (24h cooldown) when any *arr-visible volume drops below `DISK_SPACE_WARN_GB` (default `100`, `0` disables). `/status` also shows a Storage section. Set `DISK_SPACE_PATHS` (comma-separated) to an allowlist of mounts/folders to report — this hides the container's own `/` and `/config` disks and relabels a mount with the more specific media folder (e.g. shows `/share/media` for the `/share` mount). Unset reports every *arr mount.
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
- Service name + container: `durant-media-server-bot`
- SQLite persisted in named volume `durant_bot_data`
- Media mounted read-only: `${MEDIA_HOST_PATH:-/mnt/raid}:/mnt/raid:ro`
- Healthcheck endpoint: `http://127.0.0.1:3000/health`

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
- Seerr: `POST /webhook/overseerr`
- Plex: `POST /webhook/plex` (uses `WEBHOOK_SECRET` when set)
- Tautulli (legacy): `POST /webhook/tautulli`

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
- [ ] Container `durant-media-server-bot` is running and healthy.
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

Recommended cron (host):
```cron
0 */6 * * * cd /opt/durant-media-server-bot && ./scripts/backup-db.sh /app/data/plex_invites.db ./backups
```

## Health Checks
- Public JSON: `GET /health`
- Authenticated JSON: `GET /admin/health`

Checks include Discord, SQLite, Plex, Seerr/Overseerr, Radarr, Radarr-4K, Sonarr, RAID path, and tunnel domain configuration.

## Admin Dashboard
- Route: `GET /admin` (themed, dark UI).
- Login: visit `/admin/login` and enter `DASHBOARD_ADMIN_PASSWORD` (or `DASHBOARD_ADMIN_TOKEN`). A signed, HttpOnly session cookie is set so the password never appears in the URL; sessions last `SESSION_TTL_HOURS` (default 12). A **Log out** button is in the top bar.
- Login is rate limited (5 attempts / 15 min per IP) to slow brute-force guessing.
- The old `?password=` / `?token=` query-string auth has been **removed** (it leaked credentials into history and logs). For scripts/automation, use the `x-admin-password` or `x-admin-token` request headers — these still work.
- Shows overall status, summary stat cards, color-coded integration health badges, and readable tables for pending users/requests, linked users, recent downloads, keep/delete decisions, and audit logs, plus safe action buttons (revoke-all asks for confirmation).
- Configure the cookie signing secret with `SESSION_SECRET` (optional; derived from your admin credentials if unset).

## Security Notes
- Raw download tokens are never stored in SQLite.
- Download requests are rate limited and logged.
- Download streaming validates path containment under `RAID_PATH`.
- Admin endpoints are authenticated.
- Secrets are not intentionally logged.

## Testing Webhooks / Helpers
- Seerr test webhook: send sample payload to `/webhook/overseerr`.
- Plex test webhook: POST multipart `payload` to `/webhook/plex`.
- Tautulli test webhook: POST JSON to `/webhook/tautulli`.
- Health test: `curl http://localhost:3000/health`.
- Smoke test: `./scripts/smoke-test.sh`.

## AvistaZ Private-Tracker Fallback
Public indexers (→ Premiumize) always get first crack at every request. AvistaZ is only used as a
per-title fallback, which conserves its download slots / ratio and keeps private grabs seeding on a
seedbox instead of Premiumize.

> When the **direct grab** pipeline (next section) is fully configured, escalation routes through
> it instead — the tag mechanism below stays as the fallback for when the direct search fails or
> finds nothing.

**Why not Prowlarr priority?** Priority is only a tie-breaker — Radarr/Sonarr grab the
best-scoring release regardless of which indexer returned it. The strict mechanism is **indexer
tags**: an indexer with a tag only applies to movies/series that carry the same tag. The AvistaZ
indexer is tagged, no title carries the tag by default, so nothing ever hits AvistaZ until the bot
"escalates" a title by adding the tag to it and re-searching.

### How the bot uses it
- The approval embed gets a third button, **Approve + AvistaZ Fallback**, which pre-authorizes the
  fallback: the `avistaz` tag goes onto the title in Radarr/Sonarr right at approval (it's
  definitely AvistaZ-bound), and if nothing public has been grabbed within
  `ESCALATION_DELAY_MINUTES` the bot escalates automatically.
- Plain **Approve** gets the watchdog flavor instead: after the delay, the downloads channel gets
  a **⏳ Nothing Found Yet** embed with **Escalate to AvistaZ / Ignore** buttons.
- Admin self-requests skip the gate entirely (no button to click), so they're pre-authorized
  automatically — tagged at request time and auto-escalated after the delay, same as
  **Approve + AvistaZ Fallback**.
- A watch row resolves automatically the moment the media turns available, starts downloading, or
  the request is declined; unresolved rows expire after `ESCALATION_MAX_AGE_DAYS`.
- If an approved request never lands in Radarr/Sonarr at all — Seerr can accept a request and
  lose it moments later (its log shows `Media data not found`, usually a broken TMDB↔TVDB
  mapping) — the bot repairs it after `ESCALATION_ARR_GRACE_MINUTES` (default 10). A
  **pre-authorized** request is fixed automatically: the title is added directly to the arr
  (bypassing Seerr; AvistaZ tag included) and the downloads channel just gets told. Anything
  else gets a **🕳️ Request Never Landed** alert with an **Add to Sonarr/Radarr & Search**
  button that does the same add on click. Direct adds use `SONARR_ROOT_FOLDER` /
  `SONARR_QUALITY_PROFILE` etc. when set, else the arr's first root folder / quality profile.
  The escalation clock restarts from the add, so public indexers get the full delay before
  any fallback.
- 4K requests are never escalated (the fallback is for hard-to-find content, not 4K upgrades).

### One-time arr/Prowlarr setup
1. **Prowlarr**: add the AvistaZ indexer (needs your AvistaZ account; mind its seeding rules).
2. **Get it into Radarr + Sonarr with a tag that sticks.** Caveat: Prowlarr *Full Sync* overwrites
   manual indexer edits on every sync. Either set the Prowlarr application sync level to
   *Add and Remove Only* and then tag the indexer inside Radarr/Sonarr, or add AvistaZ directly in
   Radarr/Sonarr as a Torznab indexer pointed at Prowlarr's AvistaZ feed URL.
3. **Tag the indexer** in Radarr → Settings → Indexers → AvistaZ → Tags → `avistaz` (must match
   `AVISTAZ_TAG`), and the same in Sonarr. This tag gate is the entire strictness mechanism.
4. **Do NOT tag it in the 4K Radarr instance** — 4K escalation is out of scope by design.
5. **Route AvistaZ downloads to the seedbox**: add Deluge (or your seedbox client) as a download
   client in Radarr/Sonarr, then on the AvistaZ indexer set *Download Client → Deluge*. Public
   indexers keep using the Premiumize client. Disable completed-download removal / seeding-goal
   teardown for the Deluge client so private grabs keep seeding.
6. Set `ESCALATION_ENABLED=true` (plus any of the other `ESCALATION_*` keys) and restart the bot.
7. Verify: the bot warns at startup (log + system channel) if the `avistaz` tag is missing in
   Radarr or Sonarr, and `/indexers` shows AvistaZ health via Prowlarr.

### Operational caveats
- The tag is **never auto-removed** after an escalation — it marks which titles came from AvistaZ
  (seeding traceability), and future upgrades of that title may search AvistaZ again. Remove the
  tag from the movie/series manually if you want it back on public-only.
- The stuck-download **Remove & Try Another Release** button blocklists the release; on an AvistaZ
  grab that blocklists a private-tracker release.

## AvistaZ Direct Grab (Prowlarr search → seedbox rTorrent → rclone → arr import)
The next stage of the fallback above. Instead of handing the search to Radarr/Sonarr via the
indexer tag (where the arrs grab whatever scores best and burn AvistaZ download slots on their
own judgement), the bot runs the whole chain itself:

```text
Escalation fires (or /avistaz search)
        ↓
Bot searches AvistaZ through Prowlarr (never scrapes the website)
        ↓
Bot scores each release: title/year match, season pack vs episode,
resolution/source, seeders, size sanity, freeleech, already-downloaded
        ↓
Auto-grab (GRAB_MODE=auto + high confidence) or Discord approval buttons
        ↓
.torrent pushed to seedbox rTorrent (raw bytes over XML-RPC) with the
radarr/sonarr label — the seedbox can't reach Prowlarr, so the bot fetches
the file and computes the info-hash locally for tracking
        ↓
Bot polls rTorrent until the download completes (seeding continues there —
private-tracker ratio lives on the seedbox)
        ↓
rclone copy into GRAB_STAGING_PATH/.incoming, then renamed into place so the
arr never sees a half-copied folder
        ↓
Radarr DownloadedMoviesScan / Sonarr DownloadedEpisodesScan (importMode Move)
→ normal import, renaming, notifications; Bazarr picks up subtitles; Plex updates
```

### Modes
- **Automatic** (`GRAB_MODE=auto`): escalations grab the top candidate themselves when its
  confidence ≥ `GRAB_AUTO_CONFIDENCE`; anything less confident falls back to approval buttons.
- **Approval** (`GRAB_MODE=approve`, default): escalations post the top 3 scored candidates to
  the downloads channel with **Download 1/2/3 / Cancel** buttons.
- **Manual**: `/avistaz search title:<...> type:movie|tv [season] [year]` any time;
  `/avistaz status` shows the allowance, mode, seedbox reachability, and active grabs.

### Allowance
Every grab (failed attempts included — the tracker may count the download the moment the
`.torrent` is fetched) consumes one slot of `AVISTAZ_DAILY_GRAB_LIMIT` per UTC day, so
automation can't drain a limited AvistaZ account. Scoring prefers season packs for exactly the
reason the limit exists: one grab can deliver a whole season. Multi-season / complete-series
releases (`S01-S05`, `Complete Series` — common for older shows that only exist as one big
torrent) are recognized too: they score as covering any requested season in their range, show up
labeled "complete series" in the candidate embeds, and Sonarr sorts the episodes into the right
seasons at import (per-file `SxxEyy` parsing — Sonarr's own automatic search can't grab
multi-season packs, which is why the direct pipeline handles them). Duplicate info-hashes are
refused outright ("already grabbed as job #N").

### Setup
1. Add the AvistaZ indexer in **Prowlarr** (the bot finds it by name via `AVISTAZ_INDEXER_NAME`).
2. Set `RTORRENT_URL` to the seedbox's XML-RPC endpoint incl. credentials — RapidSeedbox
   exposes it at `/plugins/rpc/rpc.php`, e.g.
   `https://user:pass@server.rapidseedbox.com/plugins/rpc/rpc.php`.
3. Configure an rclone remote that reaches the seedbox's rTorrent download folder (SFTP works
   well) and set `GRAB_RCLONE_REMOTE` (e.g. `rapidseedbox:files`) plus
   `GRAB_RCLONE_FLAGS=--config /app/data/rclone.conf` and any SFTP tuning.
4. Mount a **writable** staging folder into the container (the media mount is `:ro` — see the
   commented volume in `docker-compose.yml`) and set `GRAB_STAGING_PATH`; set
   `GRAB_IMPORT_PATH` to the same folder as Radarr/Sonarr see it.
5. Restart. When the pipeline is fully configured, escalations use it automatically and fall
   back to the tag-based flow only when the AvistaZ search fails or finds nothing.

Grab jobs are durable (`grab_jobs` in SQLite): a restart mid-download keeps watching, a restart
mid-transfer re-queues the copy, and rclone skips already-transferred files. Transfer failures
alert the downloads channel with a **Retry Transfer** button.

### Guided import ("Map to a Series…")
When Sonarr declines an import (`Unknown Series` — TVDB files the show under another title,
common for Asian dramas whose sequels are listed as a season of the original; or fansub names
with no `SxxEyy` to parse), the decline alert carries a **Map to a Series…** button that runs
Sonarr's Manual Import as a short conversation in the downloads channel: pick the series
(library fuzzy-matched, recently-added first, with a search-by-name modal), pick the season,
review the file→episode mapping (episode numbers read from filenames when possible, natural
order otherwise — mismatches are called out), confirm. The bot then pushes the exact mapping
through Sonarr's ManualImport API (move mode). `/rtorrent import` in move mode gets the same
post-scan verification, so silent declines there surface with the wizard too. Wizard state
lives in SQLite, so a bot restart mid-conversation doesn't strand the message.

### Adopting existing torrents (`/rtorrent adopt`)
The pipeline above tracks torrents by the info-hash the bot computes when **it** submits the
`.torrent` — anything added to rTorrent by hand, by another private tracker's automation, or
before the bot existed has no `grab_jobs` row and is invisible. Adoption closes that gap,
provider-independently:

```text
/rtorrent adopt search:"Blood Vs Duty" [target:sonarr|radarr]
        ↓
Bot queries every torrent in rTorrent (d.multicall2) and matches names
        ↓
Embed shows name, progress, size, and label, with Adopt buttons
(target from the rTorrent label; blank/unknown labels get an explicit
per-arr button — nothing is ever adopted on a guessed target)
        ↓
Admin clicks Adopt → a grab job is created for the EXISTING info-hash
at 'downloading' (watched to 100%) or 'complete' (transfers immediately)
        ↓
The normal chain finishes it: rclone → .incoming → rename → arr import
```

Safety properties, by construction:
- **Never** downloads a `.torrent` from AvistaZ (or anywhere) and **never** consumes an
  `AVISTAZ_DAILY_GRAB_LIMIT` slot — adopted jobs (`origin` `adopt`/`adopt-auto`) are excluded
  from the allowance count.
- **Never** removes the torrent or its data from rTorrent — transfers are `rclone copy`, and
  seeding continues on the seedbox.
- An info-hash already in `grab_jobs` is refused ("already tracked as job #N").
- The matching file/folder must exist under `GRAB_RCLONE_REMOTE` **before** the job is created.
  The probe self-corrects the path mapping: it tries the `RTORRENT_REMOTE_ROOT`-derived subpath
  (optional — the seedbox-side folder the remote points at), the bare torrent name, and every
  trailing suffix of the torrent's `d.base_path` — so an SFTP remote rooted at the login home
  dir (where files appear as `Downloads/…`) still resolves. If every probe misses, a one-off
  recursive listing searches the whole remote by exact torrent name (unique matches only —
  ambiguity is refused, never guessed), catching data that was sorted into folders behind
  rTorrent's back. Failures report exactly which paths were probed, and `/rtorrent status`
  previews what the remote root actually contains.
- Adopted jobs are durable `grab_jobs` rows — restarts keep watching/transferring them, and the
  `.incoming` rename guard applies unchanged.

**Import verification**: after every transfer's arr scan, the bot checks the video files
actually left staging. A scan that never completes raises a "command queue may be wedged"
alert; a scan that completes but silently skips cleanly-matched files gets them forced
through the arr's ManualImport API automatically; genuinely rejected files produce one
alert naming the rejection reasons. `/rtorrent staging` runs the same match/rejection
analysis on demand, summarized per staging folder.

Commands: `/rtorrent status` (connectivity + adoption settings), `/rtorrent list [search]`,
`/rtorrent adopt search:"..." [target:]`, `/rtorrent ignore search:"..."` (toggle — the sweep
skips ignored torrents), `/rtorrent adopted` (adopted jobs + ignore list), and
`/rtorrent import target: [folder:] [mode:move|copy]` — hand a staging folder straight to the
arr's DownloadedScan, for files that got into staging outside the pipeline (manual rclone
copies). `mode:copy` leaves the staging files in place; importing from `.incoming`, or the
staging root while a transfer is mid-copy, is refused.

**Bulk adoption**: when the search matches more than 3 untracked torrents (an
episode-per-torrent series can be 80+), the offer collapses to a single **Adopt all N**
button. One target applies to the whole batch (from `target:`, or from the labels when they
all agree — mixed/blank labels get one button per arr). Existence checks are batched (one
directory listing per unique seedbox folder instead of a stat per torrent), duplicates are
skipped quietly so a re-run after a partial failure only adopts what's still missing, and a
single summary reports adopted/skipped/failed counts. Completed torrents still transfer one
at a time — the WAN link is the bottleneck — and each import triggers its own arr scan.
Transfer progress for adopted batches is a single rolling embed in the downloads channel,
edited in place per import (one notification per batch, not one per episode), replaced by a
completion summary when the batch drains.

With `RTORRENT_ADOPT_ENABLED=true`, a **discovery sweep** (every `RTORRENT_ADOPT_CHECK_MINUTES`)
looks for torrents whose label is in `RTORRENT_ADOPT_LABELS` but which have no grab job, and
posts **one** message to the downloads channel covering the whole cohort — a bulk Adopt-all
offer when more than 3 are waiting, per-torrent buttons otherwise. Every posted candidate is
marked offered (durably, per info-hash), so nothing is re-posted unless new torrents appear.
`RTORRENT_ADOPT_AUTO=true` makes the sweep adopt label-resolved candidates outright; keep it
`false` initially so the bot only discovers candidates instead of transferring every completed
torrent on the seedbox.

## Plex Home Staging (remote cache box)
A second, small Plex server (e.g. a NUC abroad, behind CGNAT and a VPS tunnel) serves a local
**cache** of the master library. The bot manages that cache from Discord:

- `/stage <title>` — the verb the rest of the stack doesn't have. Overseerr can't request a
  title that's already Available, and Plex won't copy between servers. The bot resolves the
  folder from Radarr/Sonarr and runs `rclone copy` into the cache; the requester gets a DM when
  it's warm. Cold titles stop being mysterious buffering and become an announced wait.
- **Durable queue** — stage jobs live in SQLite (`stage_jobs`). A restart mid-copy re-queues the
  job; `rclone copy` skips files that already transferred, so resuming is cheap.
- **Disk-pressure guard** — before each copy the bot checks free space (`rclone about`, falling
  back to a `STAGE_CACHE_MAX_GB` budget). If space is short it evicts least-recently-streamed
  unpinned titles (announced in the cleanup channel), or refuses with a clear message when even
  that wouldn't be enough.
- `/pin` / `/unpin` — exempt weekly-rewatch titles from eviction. `/staged` shows the cache;
  `/stage-bulk` (admin) seeds it from a pasted list — do this on LAN at gigabit before flying.
- **Auto-stage** — when a PH user's request finishes importing on the master
  (`MEDIA_AVAILABLE`), the bot stages it automatically and DMs when it's ready to play.
- **Tunnel watchdog** — `PH_TUNNEL_HEALTH_URL` is polled; state transitions alert the system
  channel, and `/status` + `/staged` show tunnel state, cache free space, and active jobs.

### Server-aware webhook routing (the footgun guard)
Plex/Tautulli events now carry a server identity and every handler is gated on it:

- Events matching `PH_SERVER_NAMES` route to the **eviction** flow: the familiar finished-watching
  prompt, but "Free Up Space" only purges the *cache* copy — the master file is untouched.
- Events matching the primary route to the existing keep/delete flow.
- Once `PH_SERVER_NAMES` is set, events with **no** recognizable identity are skipped (fail-safe):
  a PH viewer finishing a movie must never reach a `delete_yes` that deletes the master.

Setup:
1. On the **PH box's Tautulli**, point the webhook at the same `POST /webhook/tautulli` endpoint
   and include the server identity in the JSON payload:
   `"server_name": "{server_name}", "machine_id": "{machine_id}"` (add the same two fields to the
   master's Tautulli payload too, or set `PRIMARY_SERVER_NAMES` and keep them matching).
2. Set `PH_SERVER_NAMES` to the PH box's server name and/or machine id (lowercase).
3. Configure an rclone remote that reaches the PH cache (e.g. SFTP through the VPS tunnel), mount
   the config into the container, and set `STAGE_RCLONE_REMOTE` (e.g. `phbox:/cache`) plus
   `STAGE_RCLONE_FLAGS=--config /app/data/rclone.conf`.
4. `STAGING_ENABLED=true`, and set `STAGE_CACHE_MAX_GB` if the remote can't answer `rclone about`.

### One server per person
Plex does **not** sync watch state between servers — separate Continue Watching, separate watched
marks, separate Tautulli history. So each person belongs to exactly one server:

- `/assign-server user:@X server:ph` marks a PH user. Invites (`/link`, `/invite`, `/reinvite`,
  access-request approvals) then go **only** to servers matching `PH_SERVER_NAMES`; everyone else
  is invited to everything *except* the PH box. With `PH_SERVER_NAMES` unset, invites behave as
  before (all servers).
- Revocation (leave-server button, `/unlink`, sync-fix orphan cleanup) always sweeps **every**
  server in the account — including ones in `PLEX_EXCLUDE_SERVERS` — so nobody keeps quiet access
  to an "excluded" box after losing access.

## Regional Tiering ("edge cache")

Multiple nodes each run their own Plex against a local Syncthing replica of the media tree
(home is the sole sender; every other node is Receive Only). The tiering planner keeps each
edge node's replica curated to its disk budget: a per-node keep/drop manifest, published by the
bot and converged by a tiny standalone sync agent on each node (`agent/`).

How each node is curated:
- **Tier 0 (floor, never evicted):** keep list ∪ `NEVER_DELETE_MEDIA_IDS` ∪ the universal core
  (top-K titles by summed plays across every node's Tautulli). Any title with no copy on an
  enabled `full` master is force-kept everywhere — edge pruning can never lose data.
- **Tier 1 (node demand):** the node's own Tautulli history
  (`recencyDecay × log1p(plays) × log1p(distinctUsers)`), or for `demand_source = atime` nodes
  (California) an LRU over file last-read times reported by the agent — atime only moves when
  *that node's* Plex reads a file, so it is inherently node-local demand. The media filesystem
  must be mounted `relatime` (not `noatime`) for the signal to exist.
- **Tier 2 (member pins, `restricted` nodes only):** requests by the node's member set
  (`/tier-member`) pin for `TIER_REQUEST_GRACE_DAYS` — cold-start before Tautulli has signal.
  `open` nodes never pin (a requester could stream from any node), and on `restricted` nodes
  the members' own history outranks the universal core when the budget is tight.

The fill is an incremental watermark LRU: eviction happens **only to admit** something warmer
(never a scheduled purge), recently-watched (`warm_days`) and recently-added (`fresh_days`)
titles are never evicted, and a new title is admitted only if it outranks the coldest victim.
`sticky` nodes (old drives — California) get a doubled warm window and a bigger headroom floor.
If a node's budget covers the whole library, nothing is ever dropped.

Safety model (§ the agent enforces this order every run):
1. Assert the Syncthing folder is still **Receive Only** — abort + report otherwise.
2. Write the manifest's `.stignore` (drops, folder-relative; no delete-on-ignore directive).
3. Rescan and **confirm the ignores loaded**.
4. Only then delete local files that are dropped *and* ignored (ignored ⇒ never re-pulled).

Commands: `/tier preview [node]` (dry-run, shows the delta vs the last applied plan),
`/tier apply [node]` (publish manifests), `/tier-node add|list|enable|disable|token`,
`/tier-member add|remove|list`. Agents authenticate to `GET /agent/manifest/:node` /
`POST /agent/report/:node` with the per-node bearer token from `/tier-node token` (hash-stored,
shown once). Env knobs: `TIER_CORE_TOP_K`, `TIER_HALF_LIFE_DAYS`, `TIER_WARM_DAYS`,
`TIER_FRESH_DAYS`, `TIER_REQUEST_GRACE_DAYS`, `TIER_HISTORY_DAYS`, `TIER_SOURCE_ROOT`,
`TIER_NODES_SEED` (JSON seed applied only when the `tier_nodes` table is empty).

See `agent/README.md` for deploying the node agent (systemd timer or Docker).

## Slash Command List
Admin:
- `/invite`, `/invite-post`, `/link`, `/unlink`, `/users`, `/status`, `/seerr-test`, `/sync`, `/sync-fix`, `/reinvite`, `/requests`, `/cleanup`, `/cleanup-suggestions`, `/audit`, `/revoke-downloads`, `/watching`, `/indexers`, `/debrid`, `/avistaz`, `/rtorrent`, `/stage-bulk`, `/assign-server`, `/tier`, `/tier-node`, `/tier-member`

User:
- `/request`, `/request-status`, `/download`, `/queue`, `/me`, `/myrequests`, `/downloads`, `/keep`, `/help`, `/stage`, `/staged`, `/pin`, `/unpin`

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
- `grab_jobs` (AvistaZ direct-grab pipeline: sent → downloading → complete → transferring → done; adopted torrents enter at downloading/complete with origin `adopt`/`adopt-auto`)
- `stage_jobs` (durable Plex Home staging queue)
- `staged_items` (PH cache inventory + LRU/pin state)
- `tier_nodes` (regional tiering node registry)
- `tier_node_members` (restricted nodes' closed access sets)
- `tier_agent_tokens` (per-node sync-agent bearer token hashes)
- `tier_node_files` (agent-reported local inventory — the atime demand signal)

## Migration Notes
On startup the bot creates missing tables and adds missing columns with non-destructive migrations. Existing data is preserved.
