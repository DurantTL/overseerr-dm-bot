#!/usr/bin/env node
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const {
  createMigratedFixture,
  schemaSnapshot,
  assertDatabaseHealthy,
} = require('./helpers/db-migration-fixture');

function withFixture(names, fn) {
  const fixture = createMigratedFixture(names);
  try {
    fixture.runMigrations();
    return fn(fixture);
  } finally {
    fixture.cleanup();
  }
}

function currentBaseline() {
  return withFixture([], fixture => ({
    version: fixture.schemaVersion(),
    schema: schemaSnapshot(fixture.db),
  }));
}

test('fresh and original-v3 databases converge to the same schema and version', () => {
  const expected = currentBaseline();
  withFixture(['v3-core.sql'], fixture => {
    assert.strictEqual(fixture.schemaVersion(), expected.version);
    assert.deepStrictEqual(schemaSnapshot(fixture.db), expected.schema);
    assertDatabaseHealthy(fixture.db);

    const user = fixture.db.prepare('SELECT * FROM users WHERE discord_id = ?').get('100000000000000001');
    assert.strictEqual(user.email, 'fixture@example.test');
    assert.strictEqual(user.home_server, 'primary');

    const request = fixture.db.prepare('SELECT * FROM requests WHERE title = ?').get('Fixture Movie');
    assert.strictEqual(request.overseerr_request_id, null, 'the bounded legacy empty-id repair ran');
    assert.strictEqual(request.status, 'available');
    const repairAudit = fixture.db.prepare("SELECT metadata_json FROM audit_log WHERE action = 'empty_request_ids_repaired'").get();
    assert.deepStrictEqual(JSON.parse(repairAudit.metadata_json), { count: 1 });
  });
});

test('the pre-multifolder tier fixture preserves files and backfills folder identity', () => {
  const expected = currentBaseline();
  withFixture(['v3-core.sql', 'tier-single-folder.sql'], fixture => {
    assert.strictEqual(fixture.schemaVersion(), expected.version);
    assert.deepStrictEqual(schemaSnapshot(fixture.db), expected.schema);
    assertDatabaseHealthy(fixture.db);

    const columns = fixture.db.prepare('PRAGMA table_info(tier_node_files)').all().map(row => row.name);
    assert.ok(columns.includes('folder_id'));
    const file = fixture.db.prepare('SELECT * FROM tier_node_files WHERE node = ?').get('fixture-edge');
    assert.deepStrictEqual(
      { folderId: file.folder_id, path: file.rel_path, size: file.size_bytes },
      { folderId: '', path: 'Movies/Fixture Movie (2025)', size: 123456789 },
    );
    const folder = fixture.db.prepare('SELECT * FROM tier_node_folders WHERE node = ?').get('fixture-edge');
    assert.deepStrictEqual(
      { folderId: folder.syncthing_folder_id, root: folder.folder_root },
      { folderId: '', root: '/fixture/media' },
    );

    const backupPath = fixture.migrationStatus().backupPath;
    assert.strictEqual(backupPath, `${fixture.dbPath}.pre-migration-v0-to-v1.bak`);
    assert.ok(fs.existsSync(backupPath));
    assert.strictEqual(fs.statSync(backupPath).mode & 0o777, 0o600);
    const backup = new Database(backupPath, { readonly: true });
    try {
      const oldColumns = backup.prepare('PRAGMA table_info(tier_node_files)').all().map(row => row.name);
      assert.strictEqual(oldColumns.includes('folder_id'), false, 'backup precedes the destructive rebuild');
      assert.strictEqual(backup.prepare('SELECT COUNT(*) AS count FROM tier_node_files').get().count, 1);
      assertDatabaseHealthy(backup);
    } finally {
      backup.close();
    }
  });
});

test('every supported fixture remains stable when migrations run again', () => {
  for (const names of [
    [],
    ['v3-core.sql'],
    ['v3-core.sql', 'tier-single-folder.sql'],
  ]) {
    withFixture(names, fixture => {
      const version = fixture.schemaVersion();
      const schema = schemaSnapshot(fixture.db);
      fixture.runMigrations();
      assert.strictEqual(fixture.schemaVersion(), version, names.join('+') || 'fresh');
      assert.deepStrictEqual(schemaSnapshot(fixture.db), schema, names.join('+') || 'fresh');
      assertDatabaseHealthy(fixture.db);
    });
  }
});
