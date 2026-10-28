# Dozzle alerts: FATAL log lines and OOM kills only

Service queue item 17. Your Dozzle stack already runs in Portainer; this is the alert setup to add
to it. Two alerts, both to Discord, and nothing else: Dozzle stays a log viewer, not a second alert
pipeline. Container-down and service health are already covered by the bot's own alerts.

These steps follow Dozzle's alerts guide (https://dozzle.dev/guide/alerts-and-webhooks), which
covers Dozzle v11 and later. Alerts are set up in Dozzle's UI, not in the compose file.

## 1. Two changes to the existing stack

```yaml
services:
  dozzle:
    # ...your existing settings...
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./dozzle-data:/data              # alerts and destinations are saved here
    environment:
      DISCORD_LOG_ALERTS_WEBHOOK: ${DISCORD_LOG_ALERTS_WEBHOOK}
```

- Without the `/data` volume, alerts are lost on every restart or Watchtower update.
- The Discord webhook URL carries Discord's token, so keep it in the stack environment and refer to
  it as `${DISCORD_LOG_ALERTS_WEBHOOK}` in Dozzle. Dozzle refuses to expand variables whose names
  start with `DOZZLE_`, `DOCKER_` and a few others, which is why this one doesn't.

Redeploy the stack.

## 2. Destination

In Dozzle, open **Notifications → Add Destination**:

- Type: **Webhook**, template **Discord**
- URL: `${DISCORD_LOG_ALERTS_WEBHOOK}`

## 3. The two alerts

**Notifications → Add Alert**, twice.

**FATAL log lines**

| Field | Value |
| --- | --- |
| Container | `true` |
| Log | `level == "fatal" \|\| message matches "\\bFATAL\\b"` |

This matches lines a logger marks as fatal, and plain-text lines with the word `FATAL` in capitals.
Capitals only on purpose: `non-fatal`, `fatal=false` and the like stay quiet.

**OOM kills**

| Field | Value |
| --- | --- |
| Container | `true` |
| Event | `name == "oom"` |

This fires on Docker's own out-of-memory event, so it doesn't depend on what the container logs.
It is deliberately not "exit code 137": that code also comes from every `docker stop` and
Watchtower update, which would make it noisy.

## 4. Check it

Send a test from the destination, then watch for the first real alert. If FATAL is too noisy for
one container, narrow the alert's Container expression, e.g.
`name != "noisy-app"`, rather than widening the pattern.
