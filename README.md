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
- User self-service commands (`/me`, `/myrequests`, `/downloads`, `/keep`, `/help`).
- Health endpoints (`/health` and authenticated `/admin/health`).

## Architecture
Discord events + slash commands are handled in the bot process, which also runs an Express server for webhooks, download streaming, health, and dashboard routes. State is stored in SQLite at `/app/data/plex_invites.db`.

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
- `PATH_REMAP_FROM`, `PATH_REMAP_TO`
- `DOWNLOAD_*`, `ENABLE_DELETION`, `KEEP_LIST_DEFAULT_DAYS`, `NEVER_DELETE_MEDIA_IDS`
- `DELETION_GRACE_HOURS`, `DELETION_REMINDER_COOLDOWN_HOURS`
- `DASHBOARD_ENABLED`, `DASHBOARD_ADMIN_PASSWORD`, `DASHBOARD_ADMIN_TOKEN`, `STRICT_DASHBOARD_POST_AUTH`

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

## Discord Command Registration
Slash commands are registered automatically on bot startup using `DISCORD_CLIENT_ID` + `DISCORD_GUILD_ID`.

---

## First-Deploy Checklist
- [ ] Container `durant-media-server-bot` is running and healthy.
- [ ] Discord bot appears online in your server.
- [ ] Slash commands appear in the configured guild.
- [ ] `GET /health` returns `overall: ok` or `degraded` only for expected unavailable services; optional integrations may show `skipped`.
- [ ] `GET /admin` without auth returns HTTP `401`.
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
- Route: `GET /admin`
- Auth: `x-admin-password` or `x-admin-token` headers (or query params for GET requests).
- Shows pending users/requests, linked users, recent downloads, keep/delete decisions, audit logs, health, and safe action links.

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

## Slash Command List
Admin:
- `/link`, `/unlink`, `/users`, `/status`, `/sync`, `/cleanup`, `/audit`, `/revoke-downloads`

User:
- `/download`, `/me`, `/myrequests`, `/downloads`, `/keep`, `/help`

## Database Tables
- `users`
- `requests`
- `keep_list`
- `download_tokens`
- `download_access_log`
- `audit_log`
- `app_settings`
- `media_retention_rules`

## Migration Notes
On startup the bot creates missing tables and adds missing columns with non-destructive migrations. Existing data is preserved.
