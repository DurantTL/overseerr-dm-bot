# Deployment Guide — Portainer from Git

This guide covers deploying the Durant Media Server Bot as a Portainer stack
built directly from this Git repository.

## 1. Keep secrets out of Git

Never commit a real `.env` (or `stack.env`) to this repository. The repo ships
`.env.example` as a template only — copy it and fill in real values outside of
version control:

```bash
cp .env.example .env   # on the Docker host, NOT committed
```

`.gitignore` excludes `.env` and `stack.env`, and `.dockerignore` keeps them
out of the image build context. If a secret ever lands in Git history, rotate
it (Discord token, Overseerr/Radarr/Sonarr API keys, Plex token, dashboard
password) — removing the file later does not un-leak it.

## 2. How Portainer handles environment variables

When you deploy a stack from Git, Portainer writes every environment variable
you enter in its UI into a file named `stack.env` next to the compose file.
This repo's `docker-compose.yml` loads both files, each optional:

```yaml
env_file:
  - path: .env        # manual / docker-compose CLI deployments
    required: false
  - path: stack.env   # written by Portainer from UI vars — listed last so it wins
    required: false
```

Compose keeps the **last** duplicate value across `env_file` entries, so
`stack.env` is listed last: if both files exist, the values entered in
Portainer take precedence over a stale local `.env`.

**Important:** if you set *any* variable in the Portainer UI, Portainer
generates `stack.env` and that becomes the effective source — a `.env` you
placed in the repo checkout is effectively ignored for those values. So pick
one strategy:

- **All in Portainer (recommended):** enter every variable from
  `.env.example` in the Portainer UI, or
- **None in Portainer:** leave the UI variables empty and manage a `.env`
  file yourself (e.g. when running `docker compose` by hand).

Do not split variables across both — you will get confusing partial config.

## 3. One-time stack setup

1. In Portainer go to **Stacks → Add stack**.
2. Name it (e.g. `durant-media-server-bot`).
3. Choose **Git Repository** as the build method.
4. Repository URL: this repo's HTTPS URL; reference: your deploy branch
   (e.g. `refs/heads/main`).
5. **Compose path:** `docker-compose.yml`.
6. Under *Environment variables*, click **Load variables from .env file** and
   upload your filled-in env file (or add the variables manually). Make sure
   every required variable from `.env.example` is present.
7. (Optional) To run the Cloudflare tunnel sidecar, set
   `CLOUDFLARE_TUNNEL_TOKEN` and enable the `tunnel` compose profile.
8. Click **Deploy the stack**.

## 4. Verify the deployment

From the Docker host:

```bash
# Health endpoint should return JSON with status info
curl -s http://localhost:3000/health

# Admin dashboard should require auth — expect HTTP 401
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/admin
```

`/health` returning JSON and `/admin` returning `401` means the bot is up and
the dashboard is correctly protected. Also check the container logs in
Portainer for `Express server listening` and a successful Discord login.

## 5. Redeploying after a code change

Push your change to the deploy branch, then in Portainer open the stack and
click **Pull and redeploy**. Portainer fetches the latest commit, rebuilds the
image, and recreates the container. The SQLite database lives in the
`durant_bot_data` named volume, so it survives redeploys.

## 6. Database backups

The image ships backup/restore scripts in `/app/scripts`. Run them inside the
container:

```bash
# Back up the live DB to /app/data/backups inside the data volume
docker exec durant-media-server-bot \
  bash scripts/backup-db.sh /app/data/plex_invites.db /app/data/backups

# Copy a backup off the host if desired
docker cp durant-media-server-bot:/app/data/backups ./backups

# Restore (stop the bot first so SQLite isn't mid-write)
docker stop durant-media-server-bot
docker run --rm -v durant_bot_data:/app/data -v "$PWD/backups:/restore" \
  node:20-slim bash -c "cp /restore/plex_invites-YYYYMMDD-HHMMSS.db /app/data/plex_invites.db"
docker start durant-media-server-bot
```

Schedule the backup command via cron on the host for regular snapshots.

## 7. Rollback

If a deploy goes bad:

1. **Code rollback:** revert or reset the deploy branch to the last good
   commit (`git revert <bad-commit>` and push), then use **Pull and
   redeploy** in Portainer. Pinning deploys to a tag/branch you control makes
   this deterministic.
2. **Database rollback:** if the bad deploy corrupted data, stop the
   container and restore the most recent backup using the restore steps in
   section 6 (`scripts/restore-db.sh <backup> /app/data/plex_invites.db
   --force` inside the container also works while the bot is stopped).
3. Verify with the section 4 checks (`/health` JSON, `/admin` → 401) before
   considering the rollback complete.
