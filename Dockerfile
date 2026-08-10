# Durant Media Server Bot
# Uses node:24-slim (Debian/glibc) instead of node:24-alpine, because
# better-sqlite3 is a native module: glibc installs a prebuilt binary with no
# compiler; alpine/musl tries to compile it and fails (no toolchain).
FROM node:24-slim

# rclone drives the Plex Home staging copies/evictions (see README "Plex Home staging").
# ca-certificates lets it talk TLS to remotes like SFTP-over-VPS or cloud backends.
RUN apt-get update \
  && apt-get install -y --no-install-recommends rclone ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Disables Express's default error handler (which echoes stack traces into HTTP 500 responses)
# and any other dev-mode behavior. Set before npm ci purely for clarity — npm ci --omit=dev
# already skips devDependencies regardless of NODE_ENV.
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY bootstrap.js ./
COPY src ./src
COPY scripts ./scripts

# Image version, shown in the DEPLOY_CHANNEL_ID "Bot Online" ping. Set by CI.
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA

RUN mkdir -p /app/data

# Drop root. The bot handles tracker-supplied filenames (rclone copies, arr imports) and serves
# an HTTP endpoint, so it has no business running as uid 0. node:24-slim ships a `node` user at
# uid/gid 1000; /app/data is chowned here so a FRESH named volume inherits that ownership.
#
# Upgrading an existing deployment: storage created while the bot ran as root is still root-owned
# and the bot cannot write its SQLite database, so it will fail to start. Fix it once on the host
# before pulling this image. Don't assume how /app/data is wired — a named volume and a bind mount
# need different commands, so ask the container first:
#   docker inspect -f '{{range .Mounts}}{{.Type}}  {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' <container>
# bind   → sudo chown -R 1000:1000 <the Source path>
# volume → docker run --rm -v <name>:/data alpine chown -R 1000:1000 /data
# Every other writable path needs it too (GRAB_STAGING_PATH; a bind-mounted rclone.conf), and the
# read-only media mount must be readable by uid 1000.
# See DEPLOYMENT.md "Upgrading to the non-root image".
RUN chown -R node:node /app/data
USER node

CMD ["node", "bootstrap.js"]
