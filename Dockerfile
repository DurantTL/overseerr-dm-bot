# Durant Media Server Bot
# Uses node:24-slim (Debian/glibc) instead of node:24-alpine, because
# better-sqlite3 is a native module: it ships prebuilt .node binaries for
# linux-x64/arm64 (glibc) and loads one at require() time, so this image needs
# no compiler. Musl has prebuilds too, but the rest of the toolchain here is
# Debian-shaped, so stay on slim.
FROM node:25-slim

# rclone drives the Plex Home staging copies/evictions (see README "Plex Home staging").
# ca-certificates lets it talk TLS to remotes like SFTP-over-VPS or cloud backends.
# smartmontools lets the bot read its own box's drive health (MASTER_SMART_DEVICES) —
# the tier agent does this on edge nodes; nothing else on the master runs smartctl.
# The upgrade picks up Debian security point-releases (e.g. libpcre2-8-0) between node:24-slim
# base image refreshes, without waiting on a new upstream base image tag.
RUN apt-get update \
  && apt-get install -y --no-install-recommends rclone ca-certificates smartmontools \
  && apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Disables Express's default error handler (which echoes stack traces into HTTP 500 responses)
# and any other dev-mode behavior. Set before npm ci purely for clarity — npm ci --omit=dev
# already skips devDependencies regardless of NODE_ENV.
ENV NODE_ENV=production

COPY package*.json ./

# --ignore-scripts is load-bearing, not hardening. better-sqlite3 ships a binding.gyp but no
# install script, so npm synthesizes one and runs `node-gyp rebuild` for it. That rebuild does
# nothing useful here — without --force_build=1 the gyp target only touches a stamp file, and the
# addon we actually load is the prebuilt prebuilds/linux-x64.node from the tarball — but node-gyp
# still needs Python and make just to reach that no-op, and this image ships neither. Without the
# flag the install dies at "gyp ERR! find Python". better-sqlite3 is the only dependency in the
# production tree with any install script or binding.gyp, so nothing else loses out; recheck that
# if a native dependency is ever added.
RUN npm ci --omit=dev --ignore-scripts

# Fail the build here, loudly, rather than at container start, if the prebuilt addon ever stops
# resolving — a better-sqlite3 upgrade that drops prebuilds would otherwise sail through the
# --ignore-scripts install above and only surface when the bot opens its database.
RUN node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()"

# npm/npx/corepack are unused at runtime (CMD invokes node directly) and node:24-slim's bundled
# npm vendors its own copies of packages like tar/brace-expansion/ip-address, which is where
# Trivy's CRITICAL/HIGH findings against this image have come from historically — removing them
# drops that vendored tree instead of chasing npm's internal dependency versions.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  /usr/local/lib/node_modules/corepack /usr/local/bin/corepack

COPY index.js ./
COPY bootstrap.js ./
COPY src ./src
COPY scripts ./scripts
# Served to edge nodes by /agent/install/:node and /agent/source/:node.
COPY agent ./agent

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
