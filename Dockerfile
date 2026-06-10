# Durant Media Server Bot
# Uses node:20-slim (Debian/glibc) instead of node:20-alpine, because
# better-sqlite3 is a native module: glibc installs a prebuilt binary with no
# compiler; alpine/musl tries to compile it and fails (no toolchain).
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY scripts ./scripts

RUN mkdir -p /app/data

CMD ["node", "index.js"]
