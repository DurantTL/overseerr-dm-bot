#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// src/db.js honors DB_PATH from the environment (defaulting to the production container's data
// volume, which a test runner won't have write access to). Point it at a scratch file per test so
// the scenarios below don't see each other's state. Historical upgrade coverage uses the reusable
// fixture harness in helpers/db-migration-fixture.js.
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

    // Re-running must not throw and must not change the recorded version — every migration step
    // is still individually idempotent, and is now also skipped outright once its version is
    // already recorded (see the dedicated skip test below).
    runMigrations();
    assert.strictEqual(schemaVersion(), version);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
    assert.ok(tables.includes('users'));
    assert.ok(tables.includes('tier_node_files'));
  } finally {
    cleanup(handle);
  }
});

test('an already-applied migration step is skipped, not just idempotent', () => {
  const handle = freshDb();
  const { runMigrations, schemaVersion, MIGRATIONS } = handle;
  try {
    runMigrations();
    const version = schemaVersion();
    assert.ok(MIGRATIONS.length >= 1);
    assert.ok(MIGRATIONS.every(step => step.version <= version), 'test assumes the fixture db is fully migrated');

    let calls = 0;
    const originalRun = MIGRATIONS[0].run;
    MIGRATIONS[0].run = (...args) => { calls += 1; return originalRun(...args); };
    try {
      runMigrations();
      assert.strictEqual(calls, 0, 'a step whose version is already recorded must not be re-invoked');
    } finally {
      MIGRATIONS[0].run = originalRun;
    }
  } finally {
    cleanup(handle);
  }
});

test('an upgrade of an existing database is backed up before the migration transaction opens', () => {
  const handle = freshDb();
  const { db, dir, runMigrations, schemaVersion } = handle;
  try {
    // Simulate a pre-ledger database: some schema already exists (as any real deployed database
    // would have), but user_version is still at its SQLite default of 0.
    db.exec('CREATE TABLE placeholder (id INTEGER PRIMARY KEY)');
    assert.strictEqual(schemaVersion(), 0);

    runMigrations();

    const backups = fs.readdirSync(dir).filter(name => name.includes('.pre-migration-v0-'));
    assert.strictEqual(backups.length, 1, 'exactly one pre-migration backup should be written');

    const backupDb = new (require('better-sqlite3'))(path.join(dir, backups[0]), { readonly: true });
    try {
      const tables = backupDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
      assert.ok(tables.includes('placeholder'), 'the backup is a snapshot of the pre-migration schema');
      assert.ok(!tables.includes('users'), 'the backup predates the migration, not a copy taken after it');
    } finally {
      backupDb.close();
    }
  } finally {
    cleanup(handle);
  }
});

test('a brand-new database is not backed up before its first migration', () => {
  const handle = freshDb();
  const { dir, runMigrations } = handle;
  try {
    runMigrations();
    const backups = fs.readdirSync(dir).filter(name => name.includes('.pre-migration-'));
    assert.deepStrictEqual(backups, [], 'nothing existed yet to back up');
  } finally {
    cleanup(handle);
  }
});

test('the .env tier-node seed still applies on a restart after the database is already fully migrated', () => {
  const CONFIG_MODULE = require.resolve('../../src/config');
  const handle = freshDb();
  try {
    handle.runMigrations();
    assert.strictEqual(handle.db.prepare('SELECT COUNT(*) AS n FROM tier_nodes').get().n, 0);
    handle.db.close();

    // An operator adding TIER_NODES_SEED long after first deploy must still see it take effect on
    // the next restart — this seed is not part of the versioned migration ledger, so it must keep
    // running even when every migration step above it is skipped as already-applied.
    process.env.TIER_NODES_SEED = JSON.stringify([{ name: 'ph', usable_bytes: 1024 }]);
    delete require.cache[CONFIG_MODULE];
    delete require.cache[DB_MODULE];
    const reloaded = require('../../src/db');
    try {
      reloaded.runMigrations();
      assert.strictEqual(reloaded.db.prepare('SELECT COUNT(*) AS n FROM tier_nodes').get().n, 1);
    } finally {
      reloaded.db.close();
      delete require.cache[CONFIG_MODULE];
    }
  } finally {
    delete process.env.TIER_NODES_SEED;
    delete process.env.DB_PATH;
    fs.rmSync(handle.dir, { recursive: true, force: true });
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

test('recordEscalationWatch returns the row so a per-title action can address it', () => {
  const fixture = freshDb();
  try {
    fixture.runMigrations();
    const { recordEscalationWatch, getEscalationById } = fixture;

    // Not pre-authorized: the request path still records the watch so the escalation asks when
    // public indexers come up empty — only the automatic tagging is withheld.
    const watching = recordEscalationWatch({
      mediaType: 'tv', tmdbId: 4242, tvdbId: 99, title: 'The Road to Splendor',
      discordId: '1', preAuthorized: false,
    });
    assert.ok(watching?.id, 'the row is returned so a button can carry its id');
    assert.strictEqual(watching.pre_authorized, 0);
    assert.strictEqual(watching.state, 'watching');

    // Opting in re-runs the same upsert; pre_authorized is MAX()'d, so it promotes in place.
    const promoted = recordEscalationWatch({
      mediaType: 'tv', tmdbId: 4242, tvdbId: 99, title: 'The Road to Splendor',
      discordId: '1', preAuthorized: true,
    });
    assert.strictEqual(promoted.id, watching.id, 'the same row, not a second one');
    assert.strictEqual(promoted.pre_authorized, 1);

    // And it never goes backwards: a later non-preauth write cannot silently un-authorize.
    const again = recordEscalationWatch({
      mediaType: 'tv', tmdbId: 4242, tvdbId: 99, title: 'The Road to Splendor',
      discordId: '1', preAuthorized: false,
    });
    assert.strictEqual(again.pre_authorized, 1);
    assert.strictEqual(getEscalationById(watching.id).pre_authorized, 1);
  } finally {
    cleanup(fixture);
  }
});

test('v6 repairs tier_play_pins on databases that migrated past v1 before the table existed', () => {
  const handle = freshDb();
  const { db, runMigrations, schemaVersion } = handle;
  try {
    runMigrations();
    assert.strictEqual(schemaVersion(), 6);

    // Simulate the production state seen live Sep 2026: v1 ran before PR #286 added
    // tier_play_pins to its body, so the table is missing even though the recorded
    // version covers v1..v5. The versioned ledger skips recorded steps, so only a new
    // step can create it.
    db.exec('DROP TABLE IF EXISTS tier_play_pins');
    db.pragma('user_version = 5');
    assert.strictEqual(schemaVersion(), 5);
    assert.throws(() => db.prepare('SELECT COUNT(*) FROM tier_play_pins').get(), /no such table/);

    runMigrations();
    assert.strictEqual(schemaVersion(), 6);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tier_play_pins'").get();
    assert.ok(row, 'the repair migration creates tier_play_pins');
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tier_play_pins'").all().map(r => r.name);
    assert.ok(indexes.includes('idx_tier_play_pins_node'));
    assert.ok(indexes.includes('idx_tier_play_pins_viewer'));

    // And the step is a no-op on a healthy database that already has the table.
    runMigrations();
    assert.strictEqual(schemaVersion(), 6);
  } finally {
    cleanup(handle);
  }
});
