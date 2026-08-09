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

1. Make sure the image exists and is pullable first: push to `main` so
   `build-image.yml` publishes the GHCR image, then make the package Public (or
   `docker login ghcr.io` on the host) — see section 5.
2. In Portainer go to **Stacks → Add stack**.
3. Name it (e.g. `durant-media-server-bot`).
4. Choose **Git Repository** as the build method (this only fetches the compose
   file; the bot itself runs the prebuilt GHCR image rather than being built by
   Portainer).
5. Repository URL: this repo's HTTPS URL; reference: your deploy branch
   (e.g. `refs/heads/main`).
6. **Compose path:** `docker-compose.yml`.
7. Under *Environment variables*, click **Load variables from .env file** and
   upload your filled-in env file (or add the variables manually). Make sure
   every required variable from `.env.example` is present.
8. (Optional) To run the Cloudflare tunnel sidecar, set
   `CLOUDFLARE_TUNNEL_TOKEN` and enable the `tunnel` compose profile.
9. Click **Deploy the stack**.

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

The stack runs a **prebuilt image** pulled from the GitHub Container Registry
(GHCR), just like the `cloudflared` sidecar pulls its image. Updates flow
registry-first: GitHub builds the image, your host pulls it. Nothing needs
inbound access to the host or to Portainer.

### Automatic (recommended)

On every push to the deploy branch, the GitHub Actions workflow
(`.github/workflows/build-image.yml`) builds the image and pushes it to:

```
ghcr.io/duranttl/overseerr-dm-bot:latest      # always the newest build
ghcr.io/duranttl/overseerr-dm-bot:sha-<commit> # immutable, for rollbacks
```

Your host's **Watchtower** then notices the new `:latest` digest and recreates
the bot container automatically — no manual step, no Portainer exposure. The
container carries the `com.centurylinklabs.watchtower.enable=true` label so it
works whether or not your Watchtower runs in label-enable mode.

**One-time setup:**

1. Push to `main` once so the workflow runs and creates the package.
2. The GHCR package starts **private**. Make the host able to pull it by either:
   - **Public (simplest):** GitHub → your profile → **Packages** →
     `overseerr-dm-bot` → **Package settings** → set visibility to **Public**, or
   - **Private:** `docker login ghcr.io` on the host with a PAT that has
     `read:packages`, and give Watchtower the same credentials (a mounted
     `~/.docker/config.json` or `REPO_USER`/`REPO_PASS`).

No GitHub secrets are required — the workflow authenticates to GHCR with the
built-in `GITHUB_TOKEN`. To rebuild on demand, use the workflow's **Run
workflow** button on the repo's **Actions** tab. If you deploy from a branch
other than `main`, edit the `branches:` list in the workflow file to match.

### Manual

Pin a specific build by setting `BOT_IMAGE_TAG` (e.g. `sha-abc1234`) in your env
and pulling, or just pull the latest:

```bash
docker compose pull durant-media-server-bot && docker compose up -d
```

In Portainer, **Pull and redeploy** on the stack does the same. The SQLite
database lives in the `durant_bot_data` named volume, so it survives every
update.

### Upgrading to the non-root image (one-time)

The container now runs as the unprivileged `node` user (uid/gid 1000) instead
of root. The data volume created by an older, root-running image is still owned
by root, so the bot cannot write its SQLite database and **will fail to start**
until you hand the volume over.

Note that `durant_bot_data` is the name *inside* `docker-compose.yml` — Docker
prefixes it with the project/stack name, so the real volume is something like
`overseerr-dm-bot_durant_bot_data`. Don't guess it; read it off the container
so this works whatever your stack is called (substitute your own container name,
from `docker ps --format '{{.Names}}'`):

```bash
VOL=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' durant-media-server-bot)
echo "$VOL"    # sanity-check it's non-empty before continuing

docker compose down
docker run --rm -v "$VOL":/data alpine chown -R 1000:1000 /data
docker compose pull && docker compose up -d
```

If `$VOL` comes back empty the container name is wrong — `docker volume ls |
grep durant_bot_data` will find the volume directly. Passing a name that doesn't
exist to `docker run -v` silently creates a new empty volume and chowns *that*,
which looks like it worked and changes nothing, so check `$VOL` first.

If you use the AvistaZ direct-grab pipeline, the writable staging bind mount
needs the same treatment (the read-only `/mnt/raid` media mount does not):

```bash
sudo chown -R 1000:1000 /mnt/raid/media/seedbox-staging   # your SEEDBOX_STAGING_HOST_PATH
```

Symptom if you skip this: the container restart-loops and the logs show a
SQLite `SQLITE_CANTOPEN` / `attempt to write a readonly database` error on
`/app/data/plex_invites.db`. Fresh installs need none of this — a new volume
inherits the right ownership from the image.

### Rolling back

Set `BOT_IMAGE_TAG=sha-<good-commit>` (the immutable per-commit tag) and
redeploy. Because Watchtower only tracks the tag you reference, pinning to a
`sha-` tag also freezes auto-updates until you move back to `latest`.

## 6. Database backups

The image ships backup/restore scripts in `/app/scripts`. Run them inside the
container:

```bash
# Back up the live DB to /app/data/backups inside the data volume
docker exec durant-media-server-bot \
  bash scripts/backup-db.sh /app/data/plex_invites.db /app/data/backups

# Copy a backup off the host if desired
docker cp durant-media-server-bot:/app/data/backups ./backups

# Restore (stop the bot first; the verified restore removes stale WAL/SHM sidecars)
docker stop durant-media-server-bot
docker run --rm -v durant_bot_data:/app/data -v "$PWD/backups:/restore:ro" \
  ghcr.io/duranttl/overseerr-dm-bot:${BOT_IMAGE_TAG:-latest} \
  node scripts/restore-db.js /restore/plex_invites-YYYYMMDD-HHMMSS.db /app/data/plex_invites.db --force
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
