#!/usr/bin/env node
// Consistent online SQLite backup. Copying only the main .db file while WAL mode is active can
// silently omit committed rows that still live in the -wal sidecar; better-sqlite3's backup API
// uses SQLite's online-backup mechanism and captures one coherent snapshot.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

function verifyDatabase(file) {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const result = database.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`Integrity check failed: ${result}`);
    return database.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  } finally {
    database.close();
  }
}

function backupFiles(outDir) {
  return fs.readdirSync(path.resolve(outDir))
    .filter(f => /^plex_invites-.*\.db$/.test(f))
    .sort();
}

async function runBackup(source, outDir, backupDatabase = (database, file) => database.backup(file)) {
  source = path.resolve(source);
  outDir = path.resolve(outDir);
  if (!fs.existsSync(source)) throw new Error(`Database not found: ${source}`);
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-');
  const destination = path.join(outDir, `plex_invites-${stamp}.db`);
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    const sourceDb = new Database(source, { readonly: true, fileMustExist: true });
    try {
      await backupDatabase(sourceDb, temporary);
    } finally {
      sourceDb.close();
    }
    verifyDatabase(temporary);
    fs.renameSync(temporary, destination);
    return destination;
  } finally {
    for (const file of [temporary, `${temporary}-wal`, `${temporary}-shm`]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
}

// Deletes the oldest plex_invites-*.db backups in outDir beyond keepCount. Returns the deleted
// file names.
function rotateBackups(outDir, keepCount) {
  outDir = path.resolve(outDir);
  if (!keepCount || keepCount <= 0) return [];
  const files = backupFiles(outDir);
  const excess = files.length - keepCount;
  if (excess <= 0) return [];
  const toDelete = files.slice(0, excess);
  for (const f of toDelete) fs.unlinkSync(path.join(outDir, f));
  return toDelete;
}

function backupState(lastSuccessfulAt, intervalHours, now = Date.now()) {
  if (intervalHours <= 0) return { status: 'disabled', lastSuccessfulAt: null, ageMs: null, overdue: false };
  const timestamp = Number(lastSuccessfulAt) || 0;
  if (!timestamp) return { status: 'missing', lastSuccessfulAt: null, ageMs: null, overdue: false };
  const ageMs = Math.max(0, now - timestamp);
  const overdue = ageMs > intervalHours * 2 * 3600000;
  return { status: overdue ? 'overdue' : 'ok', lastSuccessfulAt: timestamp, ageMs, overdue };
}

function rehearseLatestBackup(source, outDir) {
  source = path.resolve(source);
  outDir = path.resolve(outDir);
  if (!fs.existsSync(source)) throw new Error(`Database not found: ${source}`);
  if (!fs.existsSync(outDir)) throw new Error(`Backup directory not found: ${outDir}`);
  const newest = backupFiles(outDir).at(-1);
  if (!newest) throw new Error(`No backups found in: ${outDir}`);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overseerr-backup-rehearsal-'));
  const restored = path.join(directory, 'restored.db');
  try {
    fs.copyFileSync(path.join(outDir, newest), restored);
    const backupUsers = verifyDatabase(restored);
    const liveUsers = verifyDatabase(source);
    return { backup: path.join(outDir, newest), backupUsers, liveUsers, rowCountsMatch: backupUsers === liveUsers };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

module.exports = { verifyDatabase, runBackup, rotateBackups, backupState, rehearseLatestBackup };
