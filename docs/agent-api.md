# Agent API access

The bot exposes a machine API (`/api/v1/*`) for the Plex Director agent
(now Edith's standing role). v1 was read-only; v1.1 adds a small allowlist of **fix
endpoints** so the agent can run checks and trigger repairs, not just observe.
v1.2 adds a headless **Discord command bridge** (`POST /api/v1/discord/exec`) that
invokes slash commands through the same dispatch the Discord handler uses, plus a
**button bridge** (`POST /api/v1/discord/interact`) that presses buttons through the
same dispatch — so interactive follow-ups like the `/rtorrent adopt` Adopt buttons are
pushable headlessly.
Responses are small typed projections — never mutations beyond the allowlist, never raw
errors, and downstream secrets stay in outbound headers.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/health` | Bot + downstream service status. v1.1 adds `backupLastSuccessfulAt` and `backupAgeHours` (additive — the v1 shape is unchanged). |
| GET | `/api/v1/disks` | Fleet disk space (v1.1): `[{ name, freeBytes, totalBytes, percentUsed, source, node, telemetryAgeMs, smartHealth }]`. `source` is `arr` (<master-host>'s *arr-reported volumes, `node: "<master-host>"`) or `tier-agent` (a tier node's watched filesystem from its latest telemetry). `telemetryAgeMs` is null for *arr entries and the sample age in ms for tier-agent entries — stale telemetry is still listed, flagged by its age. `smartHealth` is null unless SMART data exists: tier-agent entries carry what the agent reported (`[{ device, health }]` where health is `ok`/`failing`), and `<master-host>` entries carry the bot's own `smartctl` readings when `MASTER_SMART_DEVICES` is set. |
| GET | `/api/v1/library/search` | "Do I have this" across Plex servers (`?title=`, `&type=movie\|tv`). |
| GET | `/api/v1/queue` | Download queue, projected safe shape. |
| GET | `/api/v1/requests` | Seerr requests with resolved titles (`?status=pending\|approved\|available\|declined\|failed`). |
| POST | `/api/v1/automation/sweep` | Preview or run an automation sweep: `{ sweep, mode: "preview"\|"run" }`. Names validated against the registry. |
| POST | `/api/v1/requests/:id/retry` | Re-run the direct-add repair for a **failed** Seerr request (adds to the arr bypassing Seerr, starts a search). 404 unless the request is currently failed. |
| POST | `/api/v1/search/season` | Force a season search: `{ series, season, force? }`. `series` is a Sonarr id or an unambiguous title; same missing-episode/cooldown gates and AvistaZ-vs-Sonarr routing as the dashboard's Search Now button. |
| POST | `/api/v1/import-scan` | Trigger an arr import scan: `{ target: "sonarr"\|"radarr", source?: "premiumize"\|"seedbox", folder?, mode?: "move"\|"copy" }`. Same safety logic as the Discord `import` subcommands — path traversal guard, `.incoming` guard, existence check. In Move mode a partial-match preview **refuses** (409) instead of asking an interactive confirm button; nothing destructive is ever clicked through silently. |
| POST | `/api/v1/seedbox/sync` | rclone-copy a completed folder from the seedbox (`GRAB_RCLONE_REMOTE`) into local staging (`GRAB_STAGING_PATH`): `{ folder }`. Same folder validation as `/import-scan` (no traversal, no `.incoming`). Returns 202 immediately and copies in the background; the copy is resumable, so re-running after a failure is safe. **One sync per folder**: while one is in flight the same folder is a 409 naming the running job, so a retrying client can't start a second rclone onto the same destination. |
| GET | `/api/v1/seedbox/sync-status` | Progress for one synced folder (`?folder=`): `{ status, fileCount, totalBytes, dest?, started?, finished?, exitCode?, error?, errorCode? }`. `in-progress` / `done` / `failed` come from a sync job this process started; **`unknown`** means the folder is staged but no job explains it (the bot restarted mid-copy, or it was staged another way) — it may be incomplete, and re-running the sync is safe and resumable; `not-started` means nothing is there. A failed sync reports `exitCode` and a fixed message, never rclone's output — that can echo the remote and its credentials, so it goes to the audit log instead. |
| POST | `/api/v1/seedbox/import-force` | Copy a staged folder's files to a library path and trigger a Sonarr rescan: `{ folder, destination, target }`. `destination` must be an absolute path **inside an allowed media root** — see "Import destinations are contained" below. Returns **202** with `{ jobId, status: "running" }` and copies in the background (a multi-GB season would otherwise block the event loop for minutes); poll `/seedbox/import-status`. The Sonarr rescan targets the series whose own path contains the destination; no match means the files are copied and the rescan is left to the operator. |
| GET | `/api/v1/seedbox/import-status` | Progress of a background import: `?jobId=` returns that job, or omit it for the recent list (newest first). A job is `{ jobId, folder, destination, target, status: "running"\|"done"\|"failed", started, finished?, copied, chowned, chownFailed, message, error, errorCode }`. `error`/`errorCode` are a fixed message plus the errno (`ENOSPC`, `EACCES`, …) to branch on — never raw error text; the full error goes to the audit log. Jobs are in-memory, the most recent 20, and reset when the bot restarts, so an unknown `jobId` is a 404. |
| GET | `/api/v1/discord/commands` | v1.2 — the live slash-command surface, so a client doesn't hardcode it: `{ count, invocable, commands: [{ name, description, options?, subcommands?, invocable, reason? }] }`. Options carry `{ name, description, type, required, supported, choices?, min?, max?, autocomplete? }` with readable type names. Built from the same definitions `/discord/exec` validates against, and `invocable` mirrors that validator's rules — anything listed as invocable is a call `/discord/exec` accepts. See "Discovering the command surface" below. |
| POST | `/api/v1/discord/exec` | v1.2 — headless slash-command invocation. `{ command, subcommand?, options? }`; validated against the live slash-command definitions (unknown command/subcommand/option, wrong type, missing required option → 400). Routes through the same `handleSlashCommand` dispatch as Discord and returns `{ ok, replies }`. Replies that carried buttons list them as `buttons: [{ custom_id, label, style }]` for discovery. See "Discord command bridge" below. |
| POST | `/api/v1/discord/interact` | v1.2 — headless button press. `{ custom_id }` (max 100 chars, Discord's limit); validated non-empty → 400 otherwise. Routes through the same `handleButton` dispatch as Discord and returns `{ ok, replies }`. The admin gate inside `handleButton` still applies (the synthetic actor is admin-privileged, same as `/discord/exec`); every press is audited as `agent:<token-label>`. |

## Discovering the command surface (v1.2)

`GET /api/v1/discord/commands` returns the commands the bridge will accept, read straight from
the live `SlashCommandBuilder` definitions. Without it a client has to hardcode every command and
its options, and drifts silently the moment one changes — the only symptom being a 400 from
`/discord/exec` that looks like a client bug.

Two fields do the useful work:

- **`invocable`** (per command, and per subcommand) mirrors `validateExecInput`'s own rules, so a
  command listed as invocable is one `/discord/exec` will accept. When it is false, `reason` says
  why — a required option of a type the headless shim cannot supply (attachment, channel, role,
  mentionable), or a command built from subcommand groups, which the bridge doesn't support. An
  *optional* unsupported option doesn't block the command; it is simply marked
  `supported: false` and has to be left out.
- **`autocomplete: true`** on an option means Discord would normally resolve it from a live
  lookup. That never runs headless, so the value is free-form: the caller has to supply something
  the command's own resolution accepts (a title it can find, an email it can match) rather than
  one of a fixed set. It is not a `choices` list, and an unresolvable value fails inside the
  handler rather than in validation.

```json
// GET /api/v1/discord/commands
{ "ok": true, "count": 58, "invocable": 58, "commands": [
  { "name": "queue", "description": "Show the download queue", "options": [], "invocable": true },
  { "name": "rtorrent", "description": "Seedbox controls", "invocable": true, "subcommands": [
    { "name": "adopt", "description": "Adopt a finished torrent", "invocable": true, "options": [
      { "name": "search", "description": "Torrent name", "type": "string", "required": true, "supported": true }
    ] }
  ] }
] }
```

## Discord command bridge (v1.2)

`POST /api/v1/discord/exec` lets an authenticated agent client run any slash command
without Discord. The request names the command the way Discord does:

```json
{ "command": "rtorrent", "subcommand": "adopt", "options": { "search": "...", "target": "radarr" } }
```

Commands without subcommands omit `subcommand` (e.g. `{ "command": "queue" }`). Options
are validated against the command's live `SlashCommandBuilder` definition — the same
metadata that defines the command in Discord — so typos, wrong types, invalid choices,
and missing required options fail with a 400 before any handler runs.

The executor builds a headless interaction and calls the real `handleSlashCommand`,
so the handler code is identical to what a Discord user triggers — nothing is
duplicated. The synthetic actor is admin-privileged (agent tokens already are; see
"Allowlist only" below), identified as `agent:<token-label>` in the user object, and
every invocation is audited as `agent:<token-label>` with the command and args.

The response carries the handler's captured replies:

```json
{ "ok": true, "command": "rtorrent", "subcommand": "adopt", "replies": [ { "kind": "editReply", "content": "..." } ] }
```

When a reply carried buttons, they're listed for discovery — press one with
`POST /api/v1/discord/interact`:

```json
{ "kind": "reply", "content": "1 match for ...", "buttons": [
  { "custom_id": "adopt_do:offer42:0:radarr", "label": "Adopt 1 → radarr", "style": "success" },
  { "custom_id": "adopt_cancel:offer42", "label": "Dismiss", "style": "secondary" }
] }
```

```json
// POST /api/v1/discord/interact
{ "custom_id": "adopt_do:offer42:0:radarr" }
// -> { "ok": true, "custom_id": "adopt_do:offer42:0:radarr", "replies": [ { "kind": "update", ... } ] }
```

The interact endpoint routes the press through the real `handleButton` — the same
admin gate a Discord click goes through still runs, and every press is audited as
`agent:<token-label>` (including validation failures). The pushable surface is exactly
the buttons an admin could already press in Discord; the API adds no new destructive
capability, only headless access to existing ones.

Headless limitations (by design):

- **Buttons work; select menus and modals don't.** `POST /api/v1/discord/interact`
  covers buttons only. Select-menu pickers (e.g. the series picker when an adoption
  matches multiple Sonarr series) and modals still need a Discord client — the reply
  notes them (`selects: "N select menu(s) — not pressable via the API"`).
- **No DMs.** Handlers that DM a Discord user fail the same way they would for an
  unreachable user; the error surfaces in the captured replies (`ok: false`).
- **Channel/DM context is synthetic.** The interaction has no real guild or channel;
  handlers that depend on them behave as they would in an unreachable channel.
  Channel posts the bot itself makes (e.g. adoption progress updates to #downloads)
  still go to the real channels, same as a Discord click would produce.

### /downsize via the bridge

`/downsize` swaps a movie's existing file for a smaller staged replacement — the
downsize workflow (same quality, less space). Radarr only imports "upgrades," so a
smaller replacement is rejected no matter how the scan is triggered; the swap deletes
the old file via the Radarr API first, then imports the staged file.

Drive it headlessly in two calls. First the preview (admin-only, always shows before
anything destructive):

```json
// POST /api/v1/discord/exec
{ "command": "downsize", "options": { "movie": "Dune Part Two" } }
// -> reply embed: old file (size, quality, path) vs staged replacement (size, path),
//    bytes saved, plus buttons:
//    { "custom_id": "downsize_do:<nonce>", "label": "Swap (12.1 GB saved)", "style": "danger" },
//    { "custom_id": "downsize_cancel:<nonce>", "label": "Cancel", "style": "secondary" }
```

The preview requires a staged replacement: the command looks in the seedbox staging
share (`GRAB_STAGING_PATH`) for a file matching the movie — via adopted grab jobs
first, then filename similarity — and only offers the swap when the replacement is
smaller than the existing file. No replacement, or no existing file, is a clean error
(no swap offered).

Then press Swap:

```json
// POST /api/v1/discord/interact
{ "custom_id": "downsize_do:<nonce>" }
// -> deletes the old file via the Radarr API, triggers DownloadedMoviesScan on the
//    staged file, polls up to 60s for the new file, replies with the result.
```

Safety: the preview is mandatory (no direct-to-delete). The button re-verifies the
staged file still exists before deleting anything — if it vanished, the swap aborts
and the old file is untouched. Every step is audited (`downsize_preview`,
`downsize_old_deleted`, `downsize_swapped`, plus `downsize_aborted` /
`downsize_delete_failed` / `downsize_scan_failed` / `downsize_unverified` on the
failure paths).

## Safety model for the fix endpoints

The agent token is now **privileged, not read-only**. What keeps that sane:

- **Allowlist only.** The four v1.1 POST fix endpoints plus the v1.2 Discord bridge
  (`/api/v1/discord/exec` + `/api/v1/discord/interact`) are the entire mutation surface. The bridge can only invoke
  commands that exist in the bot's slash-command definitions — unknown commands,
  subcommands, and options are rejected with a 400 — and it runs the same dispatch
  code a Discord user triggers, so it can't do anything Discord itself can't. No
  deletes outside what commands already do, no container/service restarts, no config
  changes, no token management, no Plex shares, no direct database writes. Anything
  not listed does not exist.
- **No new repair logic.** Each fix endpoint calls an existing bot function — the same
  code the Discord commands and dashboard buttons already run. The API invents nothing.
- **Audit with actor.** Every mutation is audited as `agent:<token label>` (or
  `agent:legacy-env-token`), so the audit log shows exactly which agent client acted.
- **Tight write budget.** POST routes share a 10/min rate limiter
  (`AGENT_API_WRITE_MAX_PER_MINUTE`), separate from the read limiter (60/min). Both are charged
  per token, so one client can't spend another's budget.
- **Per-label revocable tokens.** Mint one token per client; revoke any one of them at
  any time from the dashboard without touching the others.
- **Background work never reports a state it can't prove.** Sync and import progress lives in
  memory for the life of the process, not in marker files beside the media. A marker written
  before a crash is orphaned (its cleanup ran in the child's close handler, which dies with the
  parent), so the old model reported a folder as syncing forever, and reported any folder that
  merely existed as `done` — which is how a half-copied season got imported as complete. A staged
  folder with no job behind it is now `unknown`, and the remedy is to sync again: rclone copies are
  resumable. The trade is that a restart forgets in-flight jobs, which is why `unknown` exists at
  all rather than a confident answer.
- **One writer per destination.** `/seedbox/sync` is one rclone per folder and
  `/seedbox/import-force` one job per destination; a second call while the first runs is a 409
  naming the job in flight. Both copies went background to keep the event loop free, so they no
  longer serialise by blocking it, and an agent that retries a slow call would otherwise have two
  writers interleaving into the same files.
- **Import destinations are contained.** `/api/v1/seedbox/import-force` takes a
  caller-supplied absolute `destination`, creates it, and overwrites files inside it, so the
  path is contained the same way `resolveSafeMediaPath()` contains the download routes. Allowed
  roots are the ones the deployment already configures — `RAID_PATH`, `PATH_REMAP_TO`,
  `TIER_SOURCE_ROOT`, and the *arr import/staging paths — plus `IMPORT_FORCE_DEST_ROOTS` for a
  library root none of those name. The deepest existing ancestor is resolved with `realpath`, so
  a symlinked parent cannot be used to escape a root, and a destination outside every root is a
  400 that lists the roots. Without this the endpoint is an arbitrary write for anyone holding an
  agent token, `/app/data` (the SQLite database and its backups) included.
- **Upstream failures are 502s.** Like the read routes, fix endpoints never leak raw
  error text (which can carry sensitive detail).

## Mint tokens from the dashboard

Admin dashboard → Overview → **Agent API tokens**:

1. Give the client a label (e.g. `Edith`, `nightly-audit`).
2. Create — the raw token is shown **once**. Copy it immediately; it is never shown or
   logged again. Only a sha256 hash is stored in the database.
3. Revoke per client at any time from the same card. Revoked tokens stop working
   immediately; the dashboard records each token's label, creation time, and last use.

Tokens are bearer credentials: send `Authorization: Bearer <token>`. **Rate-limited per token**, not per IP: both limiters run after authentication, so the budget is charged to the token that would be spending it. Clients sharing an egress address — a Director and a dashboard poller through the same tunnel — get independent budgets, and a token can't multiply its own by rotating addresses. Two tokens sharing a label still get separate budgets; the identity is the token, not its label.

## Legacy env token

`AGENT_API_TOKEN` (one shared secret, hashed into memory) still works as a legacy
fallback so existing clients keep working while you migrate them. To retire it:

1. Mint a labeled dashboard token for each client and switch the client over.
2. Clear `AGENT_API_TOKEN` from the container environment and redeploy.

With no `AGENT_API_TOKEN` and the dashboard disabled, the API routes are not mounted and
every request returns 401.

## Fleet disk & drive-health monitoring

The `disk-space` automation sweep runs on a cadence (`DISK_CHECK_MINUTES`, default 30)
over the same fleet `/api/v1/disks` reports, and pages the system channel only on
**transitions** — ok → warn → urgent and recoveries — so a disk riding a threshold
alerts once, not every sweep.

- **Thresholds** (env-overridable): `DISK_WARN_FREE_PCT` (default 15), `DISK_URGENT_FREE_PCT`
  (default 8), `DISK_CLEAR_MARGIN_PCT` (default 3, hysteresis — a warn clears only when
  free space climbs past warn + margin). Config validation rejects `urgent >= warn`.
- **Stale telemetry is never paged as disk-full.** A tier node whose telemetry is older
  than 12 hours is assessed as `unknown` (its liveness is covered by the existing
  node-heartbeat alerts); its disk still appears in `/api/v1/disks` with its age.
- **SMART health.** Tier agents report per-drive health (`ok`/`failing`) when
  `smartctl` is available. The sweep pages on newly failing drives and on recovery,
  and persists the failing-device set per node. Every transition is audited
  (`disk_space_transition`, `smart_health_transition`).
- **Master SMART.** <master-host> itself runs no tier agent, so the bot reads its own
  drives: set `MASTER_SMART_DEVICES` (e.g. `/dev/sda, /dev/sdb`) and the disk sweep
  runs `smartctl -H -j` per device, evaluates transitions as node `<master-host>`,
  and attaches the readings to the *arr entries in `/api/v1/disks`. The image ships
  `smartmontools`; the drives must also be mapped into the container (Portainer stack):
  ```yaml
  devices:
    - /dev/sda:/dev/sda   # repeat for each drive in MASTER_SMART_DEVICES
  group_add:
    - disk                # lets the non-root bot user read SMART data
  ```
  Unset, or unreadable devices, simply yield no readings — never an error or an alert.

## Admin sign-in hardening

The dashboard supports passkeys (WebAuthn) alongside the admin password fallback:

- Password login sets a one-time setup nudge: the Overview page opens with a
  **Finish securing your admin account** banner until at least one passkey is enrolled.
- Enroll from the Passkeys card on Overview. Rename or revoke passkeys there too.
- Passkey login and logout clear the nudge; it grants no access, it only shows the prompt.

Enroll a passkey on every device you sign in from, then treat the password as a
break-glass fallback kept in your password manager.
