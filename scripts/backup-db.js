#!/usr/bin/env node
// Consistent online SQLite backup. Copying only the main .db file while WAL mode is active can
// silently omit committed rows that still live in the -wal sidecar; better-sqlite3's backup API
// uses SQLite's online-backup mechanism and captures one coherent snapshot.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

async function runBackup(source, outDir) {
  source = path.resolve(source);
  outDir = path.resolve(outDir);
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
  // The temp snapshot picks up its own -wal/-shm sidecars while it's opened above; they're
  // checkpointed into it on close, but the sidecar files themselves aren't renamed away with the
  // main file, so clean them up explicitly instead of leaving them to accumulate on every backup.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${temporary}${suffix}`;
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }
  return destination;
}

// Deletes the oldest plex_invites-*.db backups in outDir beyond keepCount. Returns the deleted
// file names.
function rotateBackups(outDir, keepCount) {
  outDir = path.resolve(outDir);
  if (!keepCount || keepCount <= 0) return [];
  const files = fs.readdirSync(outDir)
    .filter(f => /^plex_invites-.*\.db$/.test(f))
    .sort();
  const excess = files.length - keepCount;
  if (excess <= 0) return [];
  const toDelete = files.slice(0, excess);
  for (const f of toDelete) fs.unlinkSync(path.join(outDir, f));
  return toDelete;
}

async function main() {
  const source = process.argv[2] || '/app/data/plex_invites.db';
  const outDir = process.argv[3] || './backups';
  const destination = await runBackup(source, outDir);
  process.stdout.write(`Backup created: ${destination}\n`);
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { runBackup, rotateBackups };
