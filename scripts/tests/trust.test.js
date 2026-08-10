#!/usr/bin/env node
// #80: trust-score bookkeeping (getTrustScore/bumpTrustScore/resetTrustScore) backing
// AUTO_APPROVE_AFTER_N_APPROVED.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { loadSandbox } = require('./extract');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseerr-bot-trust-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.exec(`CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
  return db;
}

test('trust: starts at zero and accumulates with each approval', () => {
  const db = tempDb();
  const setSetting = (key, value) => db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value));
  const getSetting = key => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value || null;
  const sb = loadSandbox(['getTrustScore', 'bumpTrustScore', 'resetTrustScore'], { getSetting, setSetting });

  assert.strictEqual(sb.run("getTrustScore('u1')"), 0, 'starts at zero');
  assert.strictEqual(sb.run("bumpTrustScore('u1', 1)"), 1);
  assert.strictEqual(sb.run("bumpTrustScore('u1', 1)"), 2);
  assert.strictEqual(sb.run("getTrustScore('u1')"), 2);
  assert.strictEqual(sb.run("getTrustScore('u2')"), 0, 'a different user is unaffected');
});

test('trust: a denial resets standing back to zero', () => {
  const db = tempDb();
  const setSetting = (key, value) => db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value));
  const getSetting = key => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value || null;
  const sb = loadSandbox(['getTrustScore', 'bumpTrustScore', 'resetTrustScore'], { getSetting, setSetting });

  sb.run("bumpTrustScore('u1', 1)");
  sb.run("bumpTrustScore('u1', 1)");
  sb.run("bumpTrustScore('u1', 1)");
  assert.strictEqual(sb.run("getTrustScore('u1')"), 3);
  sb.run("resetTrustScore('u1')");
  assert.strictEqual(sb.run("getTrustScore('u1')"), 0);
});

test('trust: score never goes negative', () => {
  const db = tempDb();
  const setSetting = (key, value) => db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value));
  const getSetting = key => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value || null;
  const sb = loadSandbox(['getTrustScore', 'bumpTrustScore'], { getSetting, setSetting });

  assert.strictEqual(sb.run("bumpTrustScore('u1', -1)"), 0);
});
