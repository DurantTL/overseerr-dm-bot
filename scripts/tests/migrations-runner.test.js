#!/usr/bin/env node
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { validateMigrations, createMigrationRunner } = require('../../src/migrations');

test('migration runner applies ordered versions once and skips recorded work', () => {
  const db = new Database(':memory:');
  const calls = [];
  try {
    const runMigrations = createMigrationRunner({
      db,
      dbPath: ':memory:',
      migrations: [
        { version: 1, name: 'first', up: () => { calls.push('first'); db.exec('CREATE TABLE first (id INTEGER PRIMARY KEY)'); } },
        { version: 2, name: 'second', up: () => { calls.push('second'); db.exec('CREATE TABLE second (id INTEGER PRIMARY KEY)'); } },
      ],
    });

    assert.deepStrictEqual(runMigrations(), {
      status: 'ok',
      version: 2,
      targetVersion: 2,
      applied: [{ version: 1, name: 'first' }, { version: 2, name: 'second' }],
      backupPath: null,
    });
    assert.deepStrictEqual(runMigrations().applied, []);
    assert.deepStrictEqual(calls, ['first', 'second']);
  } finally {
    db.close();
  }
});

test('each version is atomic and a later failure leaves the prior valid version', () => {
  const db = new Database(':memory:');
  const states = [];
  try {
    const runMigrations = createMigrationRunner({
      db,
      dbPath: ':memory:',
      migrations: [
        { version: 1, name: 'stable', up: () => db.exec('CREATE TABLE stable (id INTEGER PRIMARY KEY)') },
        {
          version: 2,
          name: 'broken',
          up: () => {
            db.exec('CREATE TABLE partial (id INTEGER PRIMARY KEY)');
            throw new Error('injected failure');
          },
        },
      ],
      onState: state => states.push(state),
    });

    assert.throws(runMigrations, error => {
      assert.strictEqual(error.code, 'SQLITE_MIGRATION_FAILED');
      assert.deepStrictEqual(error.migration, { version: 2, name: 'broken' });
      assert.strictEqual(error.schemaVersion, 1);
      return true;
    });
    assert.strictEqual(db.pragma('user_version', { simple: true }), 1);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stable'").get());
    assert.strictEqual(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'partial'").get(), undefined);
    assert.strictEqual(states.at(-1).status, 'failed');
    assert.match(states.at(-1).error, /injected failure/);
  } finally {
    db.close();
  }
});

test('migration definitions reject gaps, reordering, and missing attribution', () => {
  assert.throws(
    () => validateMigrations([{ version: 2, name: 'late', up() {} }]),
    /expected version 1/,
  );
  assert.throws(
    () => validateMigrations([{ version: 1, name: '', up() {} }]),
    /name and up/,
  );
});

test('a database newer than this build is rejected without running migrations', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('user_version = 9');
    const runMigrations = createMigrationRunner({
      db,
      dbPath: ':memory:',
      migrations: [{ version: 1, name: 'old', up: () => assert.fail('must not run') }],
    });
    assert.throws(runMigrations, error => error.code === 'SQLITE_MIGRATION_UNSUPPORTED');
    assert.strictEqual(db.pragma('user_version', { simple: true }), 9);
  } finally {
    db.close();
  }
});

