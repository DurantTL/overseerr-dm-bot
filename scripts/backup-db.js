#!/usr/bin/env node
// Consistent online SQLite backup. Copying only the main .db file while WAL mode is active can
// silently omit committed rows that still live in the -wal sidecar; better-sqlite3's backup API
// uses SQLite's online-backup mechanism and captures one coherent snapshot.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

async function main() {
  const source = path.resolve(process.argv[2] || '/app/data/plex_invites.db');
  const outDir = path.resolve(process.argv[3] || './backups');
  if (!fs.existsSync(source)) throw new Error(`Database not found: ${source}`);
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-');
  const destination = path.join(outDir, `plex_invites-${stamp}.db`);
  const temporary = `${destination}.tmp-${process.pid}`;
  const sourceDb = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await sourceDb.backup(temporary);
  } finally {
    sourceDb.close();
  }

  const snapshot = new Database(temporary, { readonly: true, fileMustExist: true });
  try {
    const result = snapshot.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`Backup integrity check failed: ${result}`);
  } finally {
    snapshot.close();
  }
  fs.renameSync(temporary, destination);
  process.stdout.write(`Backup created: ${destination}\n`);
}

main().catch(err => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
