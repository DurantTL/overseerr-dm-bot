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

test('pack rejection sightings accumulate counts and converge on the floor that has to move', () => {
  const fixture = freshDb();
  try {
    fixture.runMigrations();
    const { recordPackRejections, listPackRejectionSightings, getPackRejectionSighting,
      markPackRejectionSuggested, dismissPackRejectionSuggestion, resetPackRejectionSightings } = fixture;

    recordPackRejections([{
      bucket: 'size_below_min', quality: 'WEBDL-1080p', count: 2,
      sample: '4.2 GB is smaller than minimum allowed 9 GB (for 20min)',
      size: { limitMb: 9216, actualMb: 4300, limitMbPerMinute: 460.8, actualMbPerMinute: 215 },
    }], { seriesTitle: 'Winter Sonata' });
    recordPackRejections([
      { bucket: 'size_below_min', quality: 'WEBDL-1080p', count: 3,
        sample: '2.1 GB is smaller than minimum allowed 9 GB (for 20min)',
        size: { limitMb: 9216, actualMb: 2100, limitMbPerMinute: 460.8, actualMbPerMinute: 107.5 } },
      { bucket: 'language', quality: '', count: 1, sample: 'Language Korean is not wanted in profile' },
    ], { seriesTitle: 'Autumn Tale' });

    const size = getPackRejectionSighting('size_below_min', 'WEBDL-1080p');
    assert.strictEqual(size.sighting_count, 5, 'every blocked pack counts — how loud the problem is');
    assert.strictEqual(size.season_count, 2, 'and how many sweeps saw it — how persistent it is');
    assert.strictEqual(size.limit_mb_per_minute, 460.8, 'the floor doing the blocking');
    // A new floor has to sit below the LEAST dense blocked pack, or the rest stay stuck.
    assert.strictEqual(size.observed_mb_per_minute, 107.5);
    assert.match(size.sample_reason, /2\.1 GB/);

    assert.deepStrictEqual(listPackRejectionSightings().map(r => r.bucket), ['size_below_min', 'language']);
    // A bucket with no size numbers at all must not be polluted with zeros from the CASE/MIN.
    assert.strictEqual(getPackRejectionSighting('language', '').limit_mb, null);

    markPackRejectionSuggested('size_below_min', 'WEBDL-1080p');
    assert.ok(getPackRejectionSighting('size_below_min', 'WEBDL-1080p').suggested_at);
    dismissPackRejectionSuggestion('size_below_min', 'WEBDL-1080p');
    assert.strictEqual(getPackRejectionSighting('size_below_min', 'WEBDL-1080p').dismissed, 1);

    // A pack of that quality getting through means the setting is no longer blocking anything.
    resetPackRejectionSightings('WEBDL-1080p');
    const reset = getPackRejectionSighting('size_below_min', 'WEBDL-1080p');
    assert.deepStrictEqual(
      { count: reset.sighting_count, seasons: reset.season_count, suggested: reset.suggested_at, dismissed: reset.dismissed },
      { count: 0, seasons: 0, suggested: null, dismissed: 0 });
    assert.strictEqual(getPackRejectionSighting('language', '').sighting_count, 1, 'other qualities are untouched');
  } finally {
    cleanup(fixture);
  }
});
