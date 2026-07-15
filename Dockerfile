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
COPY src ./src
COPY scripts ./scripts

# Image version, shown in the DEPLOY_CHANNEL_ID "Bot Online" ping. Set by CI.
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA

RUN mkdir -p /app/data

CMD ["node", "index.js"]
