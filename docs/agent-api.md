# Agent API access

The bot exposes a machine API (`/api/v1/*`) for the Plex Director agent
(now Edith's standing role). v1 was read-only; v1.1 adds a small allowlist of **fix
endpoints** so the agent can run checks and trigger repairs, not just observe.
Responses are small typed projections — never mutations beyond the allowlist, never raw
errors, and downstream secrets stay in outbound headers.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/health` | Bot + downstream service status. v1.1 adds `backupLastSuccessfulAt` and `backupAgeHours` (additive — the v1 shape is unchanged). |
| GET | `/api/v1/disks` | Per-node disk space: `[{ name, freeBytes, totalBytes, percentUsed }]` (v1.1). |
| GET | `/api/v1/library/search` | "Do I have this" across Plex servers (`?title=`, `&type=movie\|tv`). |
| GET | `/api/v1/queue` | Download queue, projected safe shape. |
| GET | `/api/v1/requests` | Seerr requests with resolved titles (`?status=pending\|approved\|available\|declined\|failed`). |
| POST | `/api/v1/automation/sweep` | Preview or run an automation sweep: `{ sweep, mode: "preview"\|"run" }`. Names validated against the registry. |
| POST | `/api/v1/requests/:id/retry` | Re-run the direct-add repair for a **failed** Seerr request (adds to the arr bypassing Seerr, starts a search). 404 unless the request is currently failed. |
| POST | `/api/v1/search/season` | Force a season search: `{ series, season, force? }`. `series` is a Sonarr id or an unambiguous title; same missing-episode/cooldown gates and AvistaZ-vs-Sonarr routing as the dashboard's Search Now button. |
| POST | `/api/v1/import-scan` | Trigger an arr import scan: `{ target: "sonarr"\|"radarr", source?: "premiumize"\|"seedbox", folder?, mode?: "move"\|"copy" }`. Same safety logic as the Discord `import` subcommands — path traversal guard, `.incoming` guard, existence check. In Move mode a partial-match preview **refuses** (409) instead of asking an interactive confirm button; nothing destructive is ever clicked through silently. |

## Safety model for the fix endpoints

The agent token is now **privileged, not read-only**. What keeps that sane:

- **Allowlist only.** The four POST endpoints above are the entire mutation surface. No
  deletes, no container/service restarts, no config changes, no user invite/link/unlink,
  no token management, no Plex shares, no direct database writes. Anything not listed
  does not exist.
- **No new repair logic.** Each fix endpoint calls an existing bot function — the same
  code the Discord commands and dashboard buttons already run. The API invents nothing.
- **Audit with actor.** Every mutation is audited as `agent:<token label>` (or
  `agent:legacy-env-token`), so the audit log shows exactly which agent client acted.
- **Tight write budget.** POST routes share a 10/min rate limiter
  (`AGENT_API_WRITE_MAX_PER_MINUTE`), separate from the read limiter (60/min).
- **Per-label revocable tokens.** Mint one token per client; revoke any one of them at
  any time from the dashboard without touching the others.
- **Upstream failures are 502s.** Like the read routes, fix endpoints never leak raw
  error text (which can carry sensitive detail).

## Mint tokens from the dashboard

Admin dashboard → Overview → **Agent API tokens**:

1. Give the client a label (e.g. `Edith`, `nightly-audit`).
2. Create — the raw token is shown **once**. Copy it immediately; it is never shown or
   logged again. Only a sha256 hash is stored in the database.
3. Revoke per client at any time from the same card. Revoked tokens stop working
   immediately; the dashboard records each token's label, creation time, and last use.

Tokens are bearer credentials: send `Authorization: Bearer <token>`. Rate-limited per IP.

## Legacy env token

`AGENT_API_TOKEN` (one shared secret, hashed into memory) still works as a legacy
fallback so existing clients keep working while you migrate them. To retire it:

1. Mint a labeled dashboard token for each client and switch the client over.
2. Clear `AGENT_API_TOKEN` from the container environment and redeploy.

With no `AGENT_API_TOKEN` and the dashboard disabled, the API routes are not mounted and
every request returns 401.

## Admin sign-in hardening

The dashboard supports passkeys (WebAuthn) alongside the admin password fallback:

- Password login sets a one-time setup nudge: the Overview page opens with a
  **Finish securing your admin account** banner until at least one passkey is enrolled.
- Enroll from the Passkeys card on Overview. Rename or revoke passkeys there too.
- Passkey login and logout clear the nudge; it grants no access, it only shows the prompt.

Enroll a passkey on every device you sign in from, then treat the password as a
break-glass fallback kept in your password manager.
