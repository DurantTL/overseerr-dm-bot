# Token Security Design Decisions

## M1: Agent API bearer token scope

**Status:** Documented design decision (Sep 20, 2026)

The Agent API bearer token (`POST /api/v1/discord/exec`, `/api/v1/discord/interact`) intentionally
runs any slash command as an admin actor. This is by design — the Agent API exists so automation
(Caleb's own agents) can operate the bot with full capability.

**Risk accepted:** A leaked token = full bot control. Mitigations in place:
- 32-char minimum, sha256-hash-only storage, per-token labels + audit trail
- Dashboard-minted tokens are revocable per-client (prefer these over the legacy env token)
- The legacy `AGENT_API_TOKEN` env var is irrevocable without redeploy — migrate clients to
  dashboard-minted tokens, then unset it.

**Future:** Per-token command scopes (e.g. read-only tokens for monitors). Not implemented yet —
the current model is "one token per trusted client, revoke on suspicion."

## M4: Dashboard admin token rotation

**Status:** Documented design decision (Sep 20, 2026)

`DASHBOARD_ADMIN_TOKEN` / `DASHBOARD_ADMIN_PASSWORD` are static env-var credentials with no
expiry. Rotation today = change the env var + redeploy (Portainer: update the stack env, redeploy).

**Guidance:**
- Prefer the passkey login for interactive use (no shared secret to leak).
- Use `x-admin-token` header auth only from automation with the token in a `_FILE`-backed secret,
  never in shell history or chat.
- If a token is ever pasted into chat/logs, rotate immediately via redeploy.

**Future:** DB-backed token with a dashboard rotation endpoint (invalidate + reissue without
redeploy). Not implemented yet.
