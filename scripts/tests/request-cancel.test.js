#!/usr/bin/env node
// #79: the /request-cancel gate-stash lookup (findPendingRequestNonce) and the requestStatusBadge
// display for the new 'cancelled' status.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { loadSandbox } = require('./extract');
const { requestStatusBadge } = require('../../src/util');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseerr-bot-cancel-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.exec(`CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
  return db;
}

test('request-cancel: findPendingRequestNonce matches on requester + media + 4k', () => {
  const db = tempDb();
  const setSetting = (key, value) => db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value));
  const sb = loadSandbox(['findPendingRequestNonce'], { db });

  setSetting('pending_request:aaaa1111', JSON.stringify({ discordId: 'u1', mediaType: 'movie', tmdbId: 42, is4k: false }));
  setSetting('pending_request:bbbb2222', JSON.stringify({ discordId: 'u2', mediaType: 'movie', tmdbId: 42, is4k: false }));
  setSetting('pending_request:cccc3333', JSON.stringify({ discordId: 'u1', mediaType: 'movie', tmdbId: 42, is4k: true }));

  assert.strictEqual(sb.run("findPendingRequestNonce('u1', 'movie', 42, false)"), 'aaaa1111', 'matches the exact requester + media + quality');
  assert.strictEqual(sb.run("findPendingRequestNonce('u1', 'movie', 42, true)"), 'cccc3333', '4K is a distinct match, not conflated with SD');
  assert.strictEqual(sb.run("findPendingRequestNonce('u3', 'movie', 42, false)"), null, 'a different requester never matches');
  assert.strictEqual(sb.run("findPendingRequestNonce('u1', 'tv', 42, false)"), null, 'a different media type never matches');

  db.close();
});

test('request-cancel: requestStatusBadge renders the new cancelled status', () => {
  assert.strictEqual(requestStatusBadge('cancelled'), '↩️ Cancelled');
  assert.strictEqual(requestStatusBadge('pending'), '⏳ Pending');
});
