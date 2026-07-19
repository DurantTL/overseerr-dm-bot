# Tiering sync agent — one run per container invocation, schedule it externally.
FROM node:20-alpine
WORKDIR /opt/tier-agent
COPY agent.js .
ENV TIER_STATE_DIR=/state
VOLUME ["/state"]
ENTRYPOINT ["node", "/opt/tier-agent/agent.js"]
