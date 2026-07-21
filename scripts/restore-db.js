#!/usr/bin/env node
// Verified, atomic restore. The bot must be stopped first: stale WAL/SHM files from the replaced
// database are removed so SQLite cannot replay pages from the old database into the snapshot.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function verify(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`Integrity check failed for ${file}: ${result}`);
  } finally {
    db.close();
  }
}

const backup = path.resolve(process.argv[2] || '');
const destination = path.resolve(process.argv[3] || '/app/data/plex_invites.db');
const force = process.argv.includes('--force');
if (!process.argv[2]) throw new Error('Usage: restore-db.js <backup_file> [db_path] [--force]');
if (!fs.existsSync(backup)) throw new Error(`Backup file not found: ${backup}`);
if (fs.existsSync(destination) && !force) throw new Error(`Refusing to overwrite existing DB without --force: ${destination}`);

verify(backup);
fs.mkdirSync(path.dirname(destination), { recursive: true });
const temporary = `${destination}.restore-${process.pid}`;
fs.copyFileSync(backup, temporary);
verify(temporary);
for (const sidecar of [`${destination}-wal`, `${destination}-shm`]) {
  if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
}
fs.renameSync(temporary, destination);
process.stdout.write(`Database restored to: ${destination}\n`);
