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

### File-backed secrets

Every bot configuration key supports the `KEY_FILE` convention. Set the file variant instead of
the direct value, and the bot reads it once during startup:

```env
DISCORD_BOT_TOKEN_FILE=/run/secrets/discord_bot_token
OVERSEERR_API_KEY_FILE=/run/secrets/overseerr_api_key
RTORRENT_URL_FILE=/run/secrets/rtorrent_url
```

This applies to all credential-bearing keys, including Plex credentials, arr/Tautulli/Prowlarr and
Premiumize API keys, webhook secrets, dashboard credentials, `SESSION_SECRET`, and seedbox URLs.
Remove the direct key entirely when using its file variant; even `KEY=` together with `KEY_FILE=...`
is refused. Missing or unreadable files stop startup with the key name in the error. One final LF or
CRLF is removed from the file value, while spaces and any other content are preserved.

Docker Compose secrets mount at `/run/secrets/<name>`. Add the secret to the bot service and point
the corresponding file variable at it:

```yaml
services:
  overseerr-dm-bot:
    environment:
      DISCORD_BOT_TOKEN_FILE: /run/secrets/discord_bot_token
      OVERSEERR_API_KEY_FILE: /run/secrets/overseerr_api_key
    secrets:
      - discord_bot_token
      - overseerr_api_key

secrets:
  discord_bot_token:
    file: /srv/overseerr-dm-bot/secrets/discord_bot_token
  overseerr_api_key:
    file: /srv/overseerr-dm-bot/secrets/overseerr_api_key
```

A plain read-only bind mount works when Compose secrets are unavailable:

```yaml
services:
  overseerr-dm-bot:
    environment:
      WEBHOOK_SECRET_FILE: /run/bot-secrets/webhook_secret
    volumes:
      - /srv/overseerr-dm-bot/secrets:/run/bot-secrets:ro
```

For a Portainer standalone Docker stack, create the files on the Docker host, add the read-only bind
mount to the stack Compose definition, and add only the `KEY_FILE` paths under the stack's
environment variables. For Portainer Swarm, create each value under **Secrets**, reference it from
the service with an external Compose secret, and use its `/run/secrets/<name>` path. Keep secret
files outside the Git checkout and restrict host permissions to the account running Docker.

To rotate a value, replace its file and restart or redeploy the bot container. Values are loaded
only at startup. `CLOUDFLARE_TUNNEL_TOKEN` belongs to the separate `cloudflared` service and is not
processed by the bot's `KEY_FILE` loader.

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

### Compose version requirement

`docker-compose.yml` uses the `env_file` **long syntax** (`path:` / `required:`),
which needs **Docker Compose v2.24.0 or newer** — check with
`docker compose version`, and in Portainer make sure it is not falling back to an
older bundled binary. On anything older the two optional env files are rejected
outright and the stack refuses to deploy.

## 3. One-time stack setup

1. Make sure the image exists and is pullable first: push to `main` so
   `build-image.yml` publishes the GHCR image, then make the package Public (or
   `docker login ghcr.io` on the host) — see section 5.
2. In Portainer go to **Stacks → Add stack**.
3. Name it (e.g. `plex-stack`). The stack name prefixes the volume, so keep it stable.
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

### The startup lines that actually prove it worked

A clean-looking startup is not proof that Discord notifications work — logging
in and *posting* are separate permissions. Every restart logs exactly one deploy
ping line, and it tells you which:

| Log line | Meaning |
| --- | --- |
| `Deploy ping posted to channel <id> (image sha-…)` | Working. The `sha-` is the CI build actually running — if it says `no GIT_SHA baked in`, this container is a locally built image, not the one from GHCR. |
| `Deploy ping skipped: DEPLOY_CHANNEL_ID is unset` | Opt-in feature is off. Set `DEPLOY_CHANNEL_ID` to a channel ID. |
| `Notification to 'deploy' channel <id> dropped: Unknown Channel (10003)` | Wrong/mistyped ID, or the bot isn't in that server. |
| `… Missing Access (50001)` | The bot's role can't see the channel — grant **View Channel**. |
| `… Missing Permissions (50013)` | It can see the channel but can't post — grant **Send Messages** and **Embed Links**. |

The same warnings now cover *every* channel notification (requests, audit,
cleanup, …), so a misrouted channel ID can no longer fail invisibly. Malformed
IDs are also reported as config warnings at startup — a Discord ID is 17-20
digits, copied via right-click → **Copy ID** with Developer Mode enabled.

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
docker compose pull overseerr-dm-bot && docker compose up -d
```

In Portainer, **Pull and redeploy** on the stack does the same. The SQLite
database lives in the `durant_bot_data` named volume, so it survives every
update.

> **Switching an existing stack over to this compose file?** Check which volume
> your running container actually uses *before* redeploying — Compose prefixes
> volume names with the stack name, and attaching a differently-named volume
> gives the bot an empty database rather than an error:
>
> ```bash
> docker inspect overseerr-dm-bot \
>   --format '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{"\n"}}{{end}}'
> ```
>
> If the volume mounted at `/app/data` is not `<stack>_durant_bot_data`, rename
> the `durant_bot_data` key in this file to match what you already have (in both
> the service's `volumes:` list and the top-level `volumes:` block) instead of
> letting Compose create a fresh one.

### Why a redeploy could silently run old code

The compose service declares both `image:` (GHCR) and `build: .` (the local dev
fallback). With that combination Compose's default pull policy (`missing`) never
contacts the registry when a local image already carries the tag — and when it
doesn't, it *builds* from the checkout rather than pulling. Either way the
container comes up healthy while running code that isn't what CI published; an
image built locally also has no `GIT_SHA`, so the "Bot Online" ping can't tell
you what it is.

`pull_policy: always` is set on the service to close that off: every
`docker compose up -d` reconciles against GHCR. The trade-off is that a failed
pull (private GHCR package with no `docker login ghcr.io` on the host) now fails
the deploy loudly instead of quietly starting the old image — which is the point.
Local development is unaffected: `docker compose build` and
`docker compose up --build` still build from source.

### Upgrading to the non-root image (one-time)

The container now runs as the unprivileged `node` user (uid/gid 1000) instead of
root. Storage created while it ran as root is still root-owned, so the bot cannot
write its SQLite database and **will fail to start** until you hand it over.
Fresh installs need none of this.

**Do not assume how your storage is wired.** This repo's `docker-compose.yml`
declares a named volume, but a Portainer stack or a hand-rolled deployment often
uses bind mounts instead, and Compose prefixes named volumes with the project
name (so `durant_bot_data` is really `<stack>_durant_bot_data`). Ask the
container, then act on what it says:

```bash
docker ps -a --format '{{.Names}}\t{{.Image}}' | grep overseerr-dm-bot   # your container name
docker inspect -f '{{range .Mounts}}{{.Type}}  {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' <container>
```

**If `/app/data` is a `bind`** (its `Source` is a host path), chown that path —
no `docker run` involved:

```bash
sudo chown -R 1000:1000 /opt/docker/.../overseerr-dm-bot/data   # the Source from above
```

**If `/app/data` is a `volume`** (it has a name), chown it through a throwaway
container:

```bash
docker run --rm -v <volume-name>:/data alpine chown -R 1000:1000 /data
```

> ⚠️ Never pass a guessed volume name here. `docker run -v` does **not** error on
> a name that doesn't exist — it creates an empty volume and chowns *that*. The
> command looks like it succeeded, and nothing has actually changed.

**Check before you chown — most paths are usually already correct.** If the host
user that owns your media is already uid 1000 (common: `id <user>` returns
`uid=1000`), then everything it owns is already accessible to the container's
`node` user, and typically only the Docker-created data directory is root-owned:

```bash
id <your-media-user>
ls -ld <each Source path from the mount list>
```

Anything already showing `1000` (or your uid-1000 user's name) as owner needs
nothing. Only fix what actually shows `root`:

```bash
sudo chown -R 1000:1000 /mnt/raid/media/seedbox-staging      # GRAB_STAGING_PATH, if you use AvistaZ grabs
sudo chown 1000:1000 /home/media/.config/rclone/rclone.conf  # if rclone.conf is bind-mounted in
```

Two easy misses:

* A file bind-mounted *inside* `/app/data` (commonly `rclone.conf`) lives in a
  different host tree, so the recursive chown of the data directory does not
  reach it. Chown it separately.
* The read-only media mount needs to be **readable by uid 1000**. Root could read
  it whatever its mode; the `node` user cannot. Check with
  `ls -ld /mnt/raid/media` — if it isn't readable by that user or by other,
  staging and imports fail in ways that look like application bugs.

Then redeploy: **Pull and redeploy** on the stack in Portainer, or
`docker compose pull && docker compose up -d` from the directory holding your
compose file. (`docker compose` anywhere else fails with `no configuration file
provided: not found` — a Portainer-managed stack has no compose file on the host.)

Symptom if you skip all this: the container restart-loops and the logs show a
SQLite `SQLITE_CANTOPEN` / `attempt to write a readonly database` error on
`/app/data/plex_invites.db`.

**If Watchtower manages this stack** it will pull the non-root image on its own
schedule, so do the ownership changes *before* that happens rather than after the
restart loop starts.

### Rolling back

Set `BOT_IMAGE_TAG=sha-<good-commit>` (the immutable per-commit tag) and
redeploy. Because Watchtower only tracks the tag you reference, pinning to a
`sha-` tag also freezes auto-updates until you move back to `latest`.

## 6. Database backups

The image ships backup/restore scripts in `/app/scripts`. Run them inside the
container:

```bash
# Back up the live DB to /app/data/backups inside the data volume
docker exec overseerr-dm-bot \
  bash scripts/backup-db.sh /app/data/plex_invites.db /app/data/backups

# Copy a backup off the host if desired
docker cp overseerr-dm-bot:/app/data/backups ./backups

# Restore (stop the bot first; the verified restore removes stale WAL/SHM sidecars)
docker stop overseerr-dm-bot
docker run --rm -v durant_bot_data:/app/data -v "$PWD/backups:/restore:ro" \
  ghcr.io/duranttl/overseerr-dm-bot:${BOT_IMAGE_TAG:-latest} \
  node scripts/restore-db.js /restore/plex_invites-YYYYMMDD-HHMMSS.db /app/data/plex_invites.db --force
docker start overseerr-dm-bot
```

Schedule the backup command via cron on the host for regular snapshots, or set
`BACKUP_INTERVAL_HOURS` (see `.env.example`) to have the bot run this in-process on its own
schedule — it uses the same `runBackup()`/rotation logic and reports failures to the
`system_alerts` channel instead of failing silently on a host cron.

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
