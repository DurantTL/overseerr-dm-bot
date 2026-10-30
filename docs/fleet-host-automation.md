# Automation → Fleet and host

A segment on the dashboard's Automation tab, after **Jobs**. It lists everything automation-related
that is **not** a bot registry job, without overstating liveness.

**Jobs is unchanged.** If Jobs and this list ever disagree, Jobs is the bot's own truth and this
list is the fleet and host view.

The section is **server-rendered** from the bot's own stores on every page render and live refresh
(the same `data-live` in-place refresh as Jobs). There's no client fetch of its own, so it can't
sit on a loading state. If a store can't be read, that group shows one error line and the rest of
the page renders.

| Group | Source | Rows |
|---|---|---|
| Tier agents | `tier_nodes` and each node's last check-in (`lastHeartbeatAt`, else its last report) | Every registered node, plus `central-iowa` even before it is registered |
| RackNerd | `uptime_samples`, the newest result per path or node | Reachability checker (4 paths) and tailscale monitor (nodes), as counts. The graphs stay on **Home → Uptime**. |
| Host crons, Edith watches, Fleet scripts | `automation_heartbeats`, posted to `POST /api/automation/heartbeat` | The allowlist in `src/fleet-host-inventory.js` |
| Listed only | `src/fleet-host-inventory.js` | Watchtower and the Syncthing conflict watcher. Status is always "unknown, see log". |

## Status

Each row is judged against **its own** expected period, never one threshold for every row.

| Status | Meaning | Dot |
|---|---|---|
| ok | last report within last + period + grace | green |
| stale | now is past last report + period + grace | amber |
| failed | the last heartbeat itself said `"status": "fail"` (even if it is also overdue) | red |
| no data | never reported: grey, never ok | grey |
| unknown | listed-only rows, and heartbeat rows with no schedule yet | grey |
| disabled | tier node disabled in the registry | grey |

**Grace is one period, at most 12 hours.** So:

| Row | Period | Stale after |
|---|---|---|
| Tier agent, director monitor, UPS watch, PH sync reporter | 15 min | 30 min without a report |
| RackNerd checker and monitor | 5 min | 10 min |
| Negros Power watch | 2 h | 4 h |
| Daily rows (Europe sync, central-iowa, Muse Charm, Tailworm) | 1 day | 36 h |
| Weekly rows (staging sweep, movie watch) | 7 days | 7 days 12 h |

A weekly job last run Sunday 09:17 is ok on Monday, and stale from the next Sunday at 21:17. A
daily job last seen 20 hours ago is ok.

Every row shows its expected schedule and when it was last seen. Tapping a row opens the existing
detail sheet with:
- the last summary and counts;
- the time it was last reported, and the time it is (or became) overdue;
- the script path and log location.

## Heartbeat endpoint

`POST /api/automation/heartbeat` with `Authorization: Bearer <AUTOMATION_HEARTBEAT_TOKEN>`.

```json
{
  "name": "staging-sweep",
  "status": "ok",
  "at": "2026-11-01T09:17:42Z",
  "source": "durant-server",
  "summary": "swept 3 folders",
  "counts": { "folders": 3, "moved": 12 }
}
```

| Field | Rule |
|---|---|
| `name` | Required. Must be on the allowlist; otherwise **404**, nothing stored. |
| `status` | Required. `"ok"` or `"fail"`. |
| `at` | Optional. ISO time or epoch; defaults to now. Must be within the last 24 hours and no more than 10 minutes in the future. |
| `source` | Optional. Up to 60 characters: where it ran. |
| `summary` | Optional. Up to 200 characters, plain words. |
| `counts` | Optional. Up to 10 numbers, with short lowercase keys (`a-z`, `0-9`, `_`). |

**Responses:**

- **No token configured:** **503**.
- **Missing or wrong token:** **401** with the same message either way. Nothing is stored and the
  attempt is audited (`automation_heartbeat_auth_failed`).
- **Dashboard sessions:** a dashboard cookie is never read here, and this token never opens the
  dashboard.
- **Any other field** in the body is dropped and never stored. Only the six fields above are read.
- **Missing or invalid fields:** **400**, nothing stored.
- **Rate limit:** 30 posts per 5 minutes per client.
- **Repeats:** a repeated post for the same name and `at` is ignored, not overwritten.

**No secrets are stored.** The schema is a whitelist of six fields, and the text fields are
checked before anything is written. A post is refused whole (**400**, nothing stored, the value
not echoed) when `summary` or `source` holds anything that looks like a credential:

- `token=`, `password:`, `api_key=` and the like;
- `Bearer …`;
- a private key block;
- `user:password@` in a URL;
- `?token=` or `?apikey=` in a query string;
- long hex or letter-and-digit runs;
- well-known token prefixes such as `ghp_`.

A `counts` key that names a credential (`token`, `key`, `secret`, `pass`, `auth`, …) is refused the
same way.

**Storage:** the `automation_heartbeats` table (migration v11), keyed by name and report time and
indexed by time. Rows are pruned after **30 days**, the same as uptime history. That covers four
runs of the weekly jobs, and at about 1,100 rows a day from today's senders the table stays small.

## Setting the token (Caleb)

The token value never goes in the repo, a PR or chat. It is **its own token**: not
`UPTIME_INGEST_TOKEN` (the bot refuses to start if the two are equal), and not a dashboard login.

1. **Generate it:** `openssl rand -hex 32`.
2. **Set it on the bot:** in Portainer's stack environment, add
   `AUTOMATION_HEARTBEAT_TOKEN=<the secret>`, then redeploy (recreate the container). Unset leaves
   the endpoint answering 503.
3. **Set it on each sender**, when that sender's own slice is built and approved: put the same
   value in the sender's root-only env file (mode 600), for example:
   - `BOT_HEARTBEAT_TOKEN` in `/etc/ph-sync-reporter.env` for the PH sync reporter, plus
     `BOT_HEARTBEAT_URL=https://media.durantlogic.com/api/automation/heartbeat`. Its JSON is a
     different shape, so that wiring is its own slice.
   - Restart or re-run the sender as needed.

## Adding a row

Edit `src/fleet-host-inventory.js` and redeploy the bot (Caleb). There's no admin UI for this in
v1. Names, paths and schedules only; never a token.

**A heartbeat row:** add an entry to `heartbeats`. The `name` is what the sender posts.

```js
Object.freeze({ name: 'backup-verify', label: 'Backup verify', group: 'Host crons', where: 'Host · media crontab', schedule: 'daily 06:30 UTC', period: DAY, path: '~/bin/backup-verify.sh', log: '~/logs/backup-verify.log' }),
```

`period` is minutes, using the file's `MIN`, `HOUR`, `DAY` and `WEEK`. It is what staleness is
judged against. Leave `schedule` and `period` as `null` only until the schedule is decided: such a
row can't be ok.

**A listed-only row:** add an entry to `inventory`.

```js
Object.freeze({ name: 'logrotate-media', label: 'Media logrotate', where: 'durant-server · /etc/cron.daily', schedule: 'daily', path: '/etc/logrotate.d/media', log: '/var/log/syslog', note: 'No heartbeat; check the log.' }),
```

**A tier node's details:** add an entry to `tierNodes` with its `node` name (as `/tier-node list`
shows it), `where`, `schedule` and `period`. Nodes without an entry show "Tier agent, every 15
min".

## Not in this slice

- Senders: host cron wrappers, Edith posters, PH reporter wiring.
- Alerting or Discord pings for missed heartbeats. This is display only.
- Changes to Jobs, the tier agent, the RackNerd scripts or uptime history.
