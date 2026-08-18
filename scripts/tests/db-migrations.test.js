#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// src/db.js honors DB_PATH from the environment (defaulting to the production container's data
// volume, which a test runner won't have write access to). Point it at a scratch file per test so
// the two scenarios below don't see each other's state; a later #179 packet is expected to build
// a proper fixture harness on top of this.
const DB_MODULE = require.resolve('../../src/db');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-migrations-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  delete require.cache[DB_MODULE];
  return { ...require('../../src/db'), dir };
}

function cleanup({ db, dir }) {
  db.close();
  delete process.env.DB_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('runMigrations is idempotent and records the schema version', () => {
  const handle = freshDb();
  const { db, runMigrations, schemaVersion } = handle;
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
    cleanup(handle);
  }
});

test('a failed migration step rolls back the whole transaction, including the version stamp', () => {
  const handle = freshDb();
  const { db, runMigrations, schemaVersion } = handle;
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
    cleanup(handle);
  }
});
