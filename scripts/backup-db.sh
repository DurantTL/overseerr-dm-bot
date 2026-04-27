#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${1:-/app/data/plex_invites.db}"
OUT_DIR="${2:-./backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_FILE="$OUT_DIR/plex_invites-$STAMP.db"

if [[ ! -f "$DB_PATH" ]]; then
  echo "Database not found: $DB_PATH" >&2
  exit 1
fi

cp "$DB_PATH" "$OUT_FILE"

echo "Backup created: $OUT_FILE"
