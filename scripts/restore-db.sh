#!/usr/bin/env bash
set -euo pipefail

BACKUP_FILE="${1:-}"
DB_PATH="${2:-/app/data/plex_invites.db}"
FORCE="${3:-}"

if [[ -z "$BACKUP_FILE" ]]; then
  echo "Usage: $0 <backup_file> [db_path] [--force]" >&2
  exit 1
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

if [[ -f "$DB_PATH" && "$FORCE" != "--force" ]]; then
  echo "Refusing to overwrite existing DB without --force: $DB_PATH" >&2
  exit 1
fi

cp "$BACKUP_FILE" "$DB_PATH"
echo "Database restored to: $DB_PATH"
