#!/usr/bin/env bash
set -euo pipefail

BACKUP_FILE="${1:-}"
DB_PATH="${2:-/app/data/plex_invites.db}"
FORCE="${3:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec node "$SCRIPT_DIR/restore-db.js" "$BACKUP_FILE" "$DB_PATH" "$FORCE"
