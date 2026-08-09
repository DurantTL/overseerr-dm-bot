# Durant Media Server Bot
# Uses node:20-slim (Debian/glibc) instead of node:20-alpine, because
# better-sqlite3 is a native module: glibc installs a prebuilt binary with no
# compiler; alpine/musl tries to compile it and fails (no toolchain).
FROM node:20-slim

# rclone drives the Plex Home staging copies/evictions (see README "Plex Home staging").
# ca-certificates lets it talk TLS to remotes like SFTP-over-VPS or cloud backends.
RUN apt-get update \
  && apt-get install -y --no-install-recommends rclone ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

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
# an HTTP endpoint, so it has no business running as uid 0. node:20-slim ships a `node` user at
# uid/gid 1000; /app/data is chowned here so a FRESH named volume inherits that ownership.
#
# Upgrading an existing deployment: a volume created while the bot ran as root is still owned by
# root and the bot cannot write its SQLite database, so it will fail to start. Fix it once on the
# host before pulling this image — read the real volume name off the container rather than assuming
# it, since Compose prefixes `durant_bot_data` with the project/stack name:
#   VOL=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' <container>)
#   docker run --rm -v "$VOL":/data alpine chown -R 1000:1000 /data
# The same applies to a GRAB_STAGING_PATH bind mount (chown -R 1000:1000 on the host folder).
# See DEPLOYMENT.md "Upgrading to the non-root image".
RUN chown -R node:node /app/data
USER node

CMD ["node", "bootstrap.js"]
