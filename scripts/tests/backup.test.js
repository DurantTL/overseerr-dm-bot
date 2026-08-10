#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

test('backup/restore: WAL-safe online backup round-trips through restore-db.js', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overseerr-bot-backup-'));
  const source = path.join(tmp, 'live.db');
  const output = path.join(tmp, 'backups');
  const writer = new Database(source);
  writer.pragma('journal_mode = WAL');
  writer.exec('CREATE TABLE sample (value TEXT)');
  writer.prepare('INSERT INTO sample (value) VALUES (?)').run('committed-in-wal');

  const script = path.join(__dirname, '..', 'backup-db.js');
  const result = spawnSync(process.execPath, [script, source, output], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  const files = fs.readdirSync(output).filter(f => f.endsWith('.db'));
  assert.strictEqual(files.length, 1);
  const snapshot = new Database(path.join(output, files[0]), { readonly: true });
  assert.deepStrictEqual(snapshot.prepare('SELECT value FROM sample').pluck().all(), ['committed-in-wal']);
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
  assert.deepStrictEqual(restored.prepare('SELECT value FROM sample').pluck().all(), ['committed-in-wal']);
  restored.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
