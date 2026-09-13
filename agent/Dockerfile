# Tiering sync agent — one run per container invocation, schedule it externally.
FROM node:24-alpine

# Picks up Alpine security package updates between node:24-alpine base image refreshes.
RUN apk upgrade --no-cache

WORKDIR /opt/tier-agent
COPY agent.js .
ENV TIER_STATE_DIR=/state
VOLUME ["/state"]

# npm/npx/corepack are unused at runtime (ENTRYPOINT invokes node directly) and node:24-alpine's
# bundled npm vendors its own copies of packages like tar/brace-expansion/ip-address — the source
# of Trivy CRITICAL/HIGH findings against Node base images. Removing them drops that vendored tree
# instead of chasing npm's internal dependency versions.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  /usr/local/lib/node_modules/corepack /usr/local/bin/corepack

ENTRYPOINT ["node", "/opt/tier-agent/agent.js"]
