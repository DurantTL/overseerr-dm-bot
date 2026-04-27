#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
RAID_PATH_CHECK="${RAID_PATH_CHECK:-/mnt/raid}"
DB_PATH_CHECK="${DB_PATH_CHECK:-/app/data/plex_invites.db}"

fail() { echo "[FAIL] $*" >&2; exit 1; }
warn() { echo "[WARN] $*" >&2; }
pass() { echo "[PASS] $*"; }

http_code() {
  local method="$1" url="$2"; shift 2
  curl -sS -o /tmp/smoke.out -w "%{http_code}" -X "$method" "$url" "$@"
}

code=$(http_code GET "$BASE_URL/health") || fail "Could not reach $BASE_URL/health"
[[ "$code" == "200" ]] || fail "/health returned HTTP $code"
pass "/health returns 200"

code=$(http_code GET "$BASE_URL/admin") || fail "Could not reach /admin"
[[ "$code" == "401" ]] || fail "/admin unauthorized expected 401, got $code"
pass "/admin unauthorized returns 401"

if [[ -n "$ADMIN_TOKEN" ]]; then
  code=$(http_code GET "$BASE_URL/admin" -H "x-admin-token: $ADMIN_TOKEN") || fail "Could not auth to /admin with token"
  [[ "$code" == "200" ]] || fail "/admin with token expected 200, got $code"
  pass "/admin with token returns 200"
elif [[ -n "$ADMIN_PASSWORD" ]]; then
  code=$(http_code GET "$BASE_URL/admin" -H "x-admin-password: $ADMIN_PASSWORD") || fail "Could not auth to /admin with password"
  [[ "$code" == "200" ]] || fail "/admin with password expected 200, got $code"
  pass "/admin with password returns 200"
else
  warn "ADMIN_TOKEN or ADMIN_PASSWORD not provided; skipping authenticated /admin check"
fi

code=$(http_code POST "$BASE_URL/webhook/plex" -H "x-webhook-secret: definitely-bad" -F 'payload={"event":"media.scrobble"}') || fail "Could not call /webhook/plex"
if [[ "$code" == "401" ]]; then
  pass "/webhook/plex rejects bad secret"
else
  warn "/webhook/plex returned HTTP $code for bad secret (expected 401 only if WEBHOOK_SECRET is configured)"
fi

if [[ -d "$RAID_PATH_CHECK" ]]; then
  pass "RAID path exists: $RAID_PATH_CHECK"
else
  warn "RAID path missing: $RAID_PATH_CHECK"
fi

if [[ -f "$DB_PATH_CHECK" ]]; then
  pass "Database file exists: $DB_PATH_CHECK"
else
  warn "Database file missing: $DB_PATH_CHECK (may be normal before first boot)"
fi

echo "Smoke test complete."
