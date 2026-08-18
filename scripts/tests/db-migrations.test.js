#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// src/db.js opens a fixed on-disk path (matching the production container's data volume) rather
// than taking one as a parameter — no test currently requires it. Reset that file to a clean
// slate before each scenario here so the two tests below don't see each other's state; a later
// #179 packet is expected to make the path configurable for a proper fixture harness.
const DB_PATH = '/app/data/plex_invites.db';
const DB_MODULE = require.resolve('../../src/db');

function freshDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
  delete require.cache[DB_MODULE];
  return require('../../src/db');
}

test('runMigrations is idempotent and records the schema version', () => {
  const { db, runMigrations, schemaVersion } = freshDb();
  try {
    runMigrations();
    const version = schemaVersion();
    assert.ok(version > 0);

    // Re-running must not throw and must not change the recorded version — the migration body is
    // still re-evaluated today (all statements are individually idempotent), but the ledger this
    // packet introduces is what a later skip-if-current-version fast path will read.
    runMigrations();
    assert.strictEqual(schemaVersion(), version);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
    assert.ok(tables.includes('users'));
    assert.ok(tables.includes('tier_node_files'));
  } finally {
    db.close();
  }
});

test('a failed migration step rolls back the whole transaction, including the version stamp', () => {
  const { db, runMigrations, schemaVersion } = freshDb();
  try {
    // Force the very first statement inside runMigrations (CREATE TABLE IF NOT EXISTS users) to
    // fail: SQLite rejects creating a table over an existing object of any kind with that name,
    // even with IF NOT EXISTS, so a same-named view is enough to trigger a genuine mid-migration
    // failure without needing to modify runMigrations itself.
    db.exec('CREATE VIEW users AS SELECT 1 AS x');

    assert.throws(() => runMigrations());

    // Nothing committed: the version stamp never advanced past its default...
    assert.strictEqual(schemaVersion(), 0);
    // ...and no table from later in the migration (which never got far enough to run) exists —
    // proof the transaction rolled back everything, not just the statement that failed.
    const objects = db.prepare('SELECT name, type FROM sqlite_master').all();
    assert.deepStrictEqual(objects, [{ name: 'users', type: 'view' }]);
  } finally {
    db.close();
  }
});
