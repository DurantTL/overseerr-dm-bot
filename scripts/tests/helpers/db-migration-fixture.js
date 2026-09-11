'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const DB_MODULE = require.resolve('../../../src/db');
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'db');

function createMigratedFixture(names = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-fixture-'));
  const dbPath = path.join(dir, 'fixture.db');
  const seed = new Database(dbPath);
  try {
    for (const name of names) {
      const sql = fs.readFileSync(path.join(FIXTURE_ROOT, name), 'utf8');
      seed.exec(sql);
    }
  } finally {
    seed.close();
  }

  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  delete require.cache[DB_MODULE];
  const handle = require('../../../src/db');

  return {
    ...handle,
    dbPath,
    cleanup() {
      handle.db.close();
      delete require.cache[DB_MODULE];
      if (previousDbPath === undefined) delete process.env.DB_PATH;
      else process.env.DB_PATH = previousDbPath;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function schemaSnapshot(db) {
  const objects = db.prepare(`
    SELECT name, type
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
      AND type IN ('table', 'view', 'trigger')
    ORDER BY type, name
  `).all();

  const tables = objects.filter(row => row.type === 'table').map(row => {
    const columns = db.prepare(`PRAGMA table_info("${row.name.replaceAll('"', '""')}")`).all()
      .map(column => ({
        name: column.name,
        type: String(column.type || '').toUpperCase(),
        notnull: column.notnull,
        defaultValue: column.dflt_value,
        primaryKeyPosition: column.pk,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const indexes = db.prepare(`PRAGMA index_list("${row.name.replaceAll('"', '""')}")`).all()
      .map(index => ({
        name: index.name,
        unique: index.unique,
        origin: index.origin,
        partial: index.partial,
        columns: db.prepare(`PRAGMA index_info("${index.name.replaceAll('"', '""')}")`).all()
          .sort((a, b) => a.seqno - b.seqno)
          .map(column => column.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { name: row.name, columns, indexes };
  });

  return {
    tables,
    views: objects.filter(row => row.type === 'view').map(row => row.name),
    triggers: objects.filter(row => row.type === 'trigger').map(row => row.name),
  };
}

function assertDatabaseHealthy(db) {
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}`);
  const foreignKeyFailures = db.pragma('foreign_key_check');
  if (foreignKeyFailures.length) {
    throw new Error(`SQLite foreign key check failed: ${JSON.stringify(foreignKeyFailures)}`);
  }
}

module.exports = {
  createMigratedFixture,
  schemaSnapshot,
  assertDatabaseHealthy,
};

