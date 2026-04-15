# Durant Media Server Bot

A custom Discord bot for managing a private Plex media server. Handles user onboarding, Overseerr/Seerr request approvals, automated deletion prompts, secure file downloads, and admin tools.

---

## Features

| Command | Description |
|---|---|
| `/download` | Generate a private 24hr download link for any movie or episode |
| `/link` | Link a Discord user to their Plex email (admin) |
| `/unlink` | Remove a user from the database (admin) |
| `/users` | List all linked Plex users (admin) |
| `/status` | System status — linked users vs Overseerr accounts (admin) |
| `/sync` | 3-phase sync: Plex friends → DB → Overseerr → Discord links (admin) |
| `/cleanup` | Remove deleted/orphaned Overseerr accounts (admin) |

**Automatic flows:**
- Member joins Discord → welcome DM with Plex signup link → email collection → admin approval
- Member leaves Discord → auto-removes Plex access → admin notified
- Overseerr/Seerr request → rich approval card with poster + description in admin channel
- Tautulli/Plex scrobble at 90% → deletion prompt for 4K movies and TV shows
- Media available → DM notifies requester

---

## Stack

- Node.js 20 + Discord.js v14
- Express.js (webhooks + file streaming)
- SQLite via better-sqlite3
- Cloudflare Tunnel (IPv4 access on IPv6-only host)
- Radarr + Radarr-4K + Sonarr APIs
- Seerr (Overseerr fork) API
- Plex TV API (direct, no @ctrl/plex)
- Multer (multipart webhook handling)

---

## Setup

### 1. Clone and configure

```bash
git clone <your-repo>
cd overseerr-dm-bot
cp .env.example .env
# Fill in all values in .env
```

### 2. Set up Cloudflare Tunnel

1. Cloudflare Zero Trust → Networks → Tunnels → Create tunnel
2. Copy token → paste into compose as `YOUR_TUNNEL_TOKEN_HERE`
3. Add public hostname: subdomain `files`, service `http://overseerr-dm-bot:3000`
4. Set `TUNNEL_DOMAIN=files.yourdomain.com` in compose env

### 3. Build and deploy

```bash
docker build -t local-overseerr-bot .
# Deploy via Portainer stack
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Application ID from Discord Developer Portal |
| `DISCORD_GUILD_ID` | Your Discord server ID |
| `ADMIN_CHANNEL_ID` | Channel for approval/deletion prompts |
| `ADMIN_USER_ID` | Your Discord user ID |
| `OVERSEERR_URL` | e.g. `http://seerr:5055` |
| `OVERSEERR_API_KEY` | Seerr → Settings → General → API Key |
| `WEBHOOK_SECRET` | Optional shared secret for Seerr webhooks |
| `PLEX_TOKEN` | Plex auth token (preferred over username/password) |
| `PLEX_USERNAME` | Plex account email (fallback) |
| `PLEX_PASSWORD` | Plex account password (fallback) |
| `PLEX_EXCLUDE_SERVERS` | Comma-separated server names to never share (e.g. `Durant-Server`) |
| `RADARR_URL` | e.g. `http://radarr:7878` |
| `RADARR_API_KEY` | Radarr → Settings → General |
| `RADARR_4K_URL` | e.g. `http://radarr-4k:7878` |
| `RADARR_4K_API_KEY` | Radarr-4K → Settings → General |
| `SONARR_URL` | e.g. `http://sonarr:8989` |
| `SONARR_API_KEY` | Sonarr → Settings → General |
| `TUNNEL_DOMAIN` | Public domain e.g. `files.yourdomain.com` |
| `RAID_PATH` | RAID mount path inside container e.g. `/mnt/raid` |
| `PATH_REMAP_FROM` | Host path Radarr/Sonarr store e.g. `/share` |
| `PATH_REMAP_TO` | Container path e.g. `/mnt/raid` |
| `TAUTULLI_WEBHOOK_SECRET` | Optional Tautulli webhook secret |
| `PORT` | Express port (default `3000`) |

---

## Webhook Configuration

### Seerr
Settings → Notifications → Webhook → URL: `http://overseerr-dm-bot:3000/webhook/overseerr`

Enable: Request Pending Approval, Request Approved, Request Available

JSON body:
```json
{
  "notification_type": "{{notification_type}}",
  "subject": "{{subject}}",
  "message": "{{message}}",
  "media": {
    "media_type": "{{media_type}}",
    "tmdbId": "{{media_tmdbid}}",
    "tvdbId": "{{media_tvdbid}}",
    "status": "{{media_status}}",
    "status4k": "{{media_status4k}}",
    "is4k": false
  },
  "request": {
    "request_id": "{{request_id}}",
    "requestedBy_email": "{{requestedBy_email}}",
    "requestedBy_username": "{{requestedBy_username}}",
    "requestedBy_settings_discordId": "{{requestedBy_settings_discordId}}"
  }
}
```

### Plex
plex.tv → Account → Webhooks → Add: `https://files.yourdomain.com/webhook/plex`
(One webhook covers all servers under your account)

### Tautulli (optional, legacy)
Notification Agents → Webhook → URL: `http://overseerr-dm-bot:3000/webhook/tautulli`
Trigger: Watched

---

## Database

SQLite at `/app/data/plex_invites.db`

| Table | Purpose |
|---|---|
| `users` | Discord ID ↔ Plex email |
| `requests` | Overseerr request history with requester Discord ID |
| `keep_list` | Files requester chose to keep |
| `download_tokens` | Active 24hr download tokens |

---

## Updating

```bash
# On your server
cd /opt/docker/plex-stack/overseerr-dm-bot
# Replace index.js with new version
docker build -t local-overseerr-bot .
# Redeploy in Portainer (no re-pull)
```
