#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { runBackup, rotateBackups, backupState, rehearseLatestBackup } = require('../backup-db');

test('backup/restore: WAL-safe online backup round-trips through restore-db.js', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overseerr-bot-backup-'));
  const source = path.join(tmp, 'live.db');
  const output = path.join(tmp, 'backups');
  const writer = new Database(source);
  writer.pragma('journal_mode = WAL');
  writer.exec('CREATE TABLE users (value TEXT)');
  writer.prepare('INSERT INTO users (value) VALUES (?)').run('committed-in-wal');

  const script = path.join(__dirname, '..', 'backup-db.js');
  const result = spawnSync(process.execPath, [script, source, output], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  const files = fs.readdirSync(output).filter(f => f.endsWith('.db'));
  assert.strictEqual(files.length, 1);
  const snapshot = new Database(path.join(output, files[0]), { readonly: true });
  assert.deepStrictEqual(snapshot.prepare('SELECT value FROM users').pluck().all(), ['committed-in-wal']);
  assert.strictEqual(snapshot.pragma('integrity_check', { simple: true }), 'ok');
  snapshot.close();
  writer.close();

  const destination = path.join(tmp, 'restored.db');
  const old = new Database(destination);
  old.exec('CREATE TABLE old_data (value TEXT)');
  old.close();
  fs.writeFileSync(`${destination}-wal`, 'stale wal');
  fs.writeFileSync(`${destination}-shm`, 'stale shm');
  const restoreScript = path.join(__dirname, '..', 'restore-db.js');
  const restore = spawnSync(process.execPath, [restoreScript, path.join(output, files[0]), destination, '--force'], { encoding: 'utf8' });
  assert.strictEqual(restore.status, 0, restore.stderr);
  assert.strictEqual(fs.existsSync(`${destination}-wal`), false);
  assert.strictEqual(fs.existsSync(`${destination}-shm`), false);
  const restored = new Database(destination, { readonly: true });
  assert.deepStrictEqual(restored.prepare('SELECT value FROM users').pluck().all(), ['committed-in-wal']);
  restored.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('backup: corrupt temporary snapshot is removed without replacing a good backup', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overseerr-bot-backup-corrupt-'));
  try {
    const source = path.join(tmp, 'live.db');
    const output = path.join(tmp, 'backups');
    const writer = new Database(source);
    writer.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    writer.prepare('INSERT INTO users DEFAULT VALUES').run();
    writer.close();

    const good = await runBackup(source, output);
    await assert.rejects(
      runBackup(source, output, async (_database, temporary) => fs.writeFileSync(temporary, 'truncated')),
      /not a database|malformed/,
    );
    assert.deepStrictEqual(fs.readdirSync(output), [path.basename(good)]);
    assert.deepStrictEqual(rotateBackups(output, 1), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('backup: user sanity query rejects a structurally valid snapshot without users', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overseerr-bot-backup-sanity-'));
  try {
    const source = path.join(tmp, 'live.db');
    const output = path.join(tmp, 'backups');
    const writer = new Database(source);
    writer.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
    writer.close();
    await assert.rejects(runBackup(source, output), /no such table: users/);
    assert.deepStrictEqual(fs.readdirSync(output), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('backup: rehearsal compares row counts and removes its temporary restore', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overseerr-bot-backup-rehearse-'));
  try {
    const source = path.join(tmp, 'live.db');
    const output = path.join(tmp, 'backups');
    const writer = new Database(source);
    writer.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    writer.prepare('INSERT INTO users DEFAULT VALUES').run();
    await runBackup(source, output);
    writer.prepare('INSERT INTO users DEFAULT VALUES').run();
    writer.close();

    const before = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('overseerr-backup-rehearsal-'));
    const result = rehearseLatestBackup(source, output);
    const after = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('overseerr-backup-rehearsal-'));
    assert.deepStrictEqual({ liveUsers: result.liveUsers, backupUsers: result.backupUsers, rowCountsMatch: result.rowCountsMatch }, { liveUsers: 2, backupUsers: 1, rowCountsMatch: false });
    assert.deepStrictEqual(after, before);
    const live = new Database(source, { readonly: true });
    assert.strictEqual(live.prepare('SELECT COUNT(*) AS count FROM users').get().count, 2);
    live.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('backup: persisted last-success timestamp reports age and overdue state', () => {
  const now = Date.UTC(2026, 7, 15, 12);
  assert.deepStrictEqual(backupState(null, 6, now), { status: 'missing', lastSuccessfulAt: null, ageMs: null, overdue: false });
  assert.deepStrictEqual(backupState(String(now - 13 * 3600000), 6, now), {
    status: 'overdue',
    lastSuccessfulAt: now - 13 * 3600000,
    ageMs: 13 * 3600000,
    overdue: true,
  });
});
