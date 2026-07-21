#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${1:-/app/data/plex_invites.db}"
OUT_DIR="${2:-./backups}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec node "$SCRIPT_DIR/backup-db.js" "$DB_PATH" "$OUT_DIR"
