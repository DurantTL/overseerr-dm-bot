# Agent API access

The bot exposes a read-only machine API (`GET /api/v1/*`) for the Plex Director agent
(now Edith's standing role). Endpoints: health, library search, requests, and queues —
never mutations, never raw errors, and downstream secrets stay in outbound headers.

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
