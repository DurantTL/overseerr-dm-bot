#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { upsertTrackedRequest, collapseStalePendingRequests, statusFromSeerrRequest, reconcileTrackedRequestStatuses } = require('../../src/request-tracking');

test('request-tracking: upsert/collapse/status-mapping/reconcile against an in-memory db', () => {
  let db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(':memory:');
  } catch (_nativeMismatch) {
    // Developer machines may run a newer Node than the checked-in native dependency was built
    // against. Node 22+ has a compatible synchronous in-memory SQLite fallback for this test.
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(':memory:');
  }
  db.exec(`CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    overseerr_request_id TEXT UNIQUE,
    media_id TEXT NOT NULL,
    media_type TEXT NOT NULL,
    is_4k INTEGER DEFAULT 0,
    title TEXT NOT NULL,
    requested_by_discord_id TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  upsertTrackedRequest(db, null, 'tmdb:603', 'movie', false, 'The Matrix', '111', 'pending');
  const adopted = upsertTrackedRequest(db, 42, 'tmdb:603', 'movie', false, 'The Matrix', '111', 'approved');
  assert.strictEqual(adopted.action, 'adopted-provisional');
  assert.deepStrictEqual(db.prepare('SELECT overseerr_request_id, status, requested_by_discord_id FROM requests').all().map(r => ({ ...r })), [
    { overseerr_request_id: '42', status: 'approved', requested_by_discord_id: '111' },
  ]);

  // Later payloads without requester information preserve attribution and update canonical fields.
  upsertTrackedRequest(db, 42, 'tmdb:603', 'movie', false, 'The Matrix (1999)', null, 'available');
  assert.deepStrictEqual({ ...db.prepare('SELECT title, status, requested_by_discord_id FROM requests').get() }, {
    title: 'The Matrix (1999)', status: 'available', requested_by_discord_id: '111',
  });

  // Historical duplicate repair merges attribution into the authoritative row, then deletes only
  // the stale pending row. A genuine pending-only row remains untouched.
  db.prepare(`INSERT INTO requests (overseerr_request_id, media_id, media_type, is_4k, title, requested_by_discord_id, status)
    VALUES (NULL, 'tmdb:7', 'movie', 0, 'Seven', '222', 'pending')`).run();
  db.prepare(`INSERT INTO requests (overseerr_request_id, media_id, media_type, is_4k, title, requested_by_discord_id, status)
    VALUES ('77', 'tmdb:7', 'movie', 0, 'Seven', NULL, 'available')`).run();
  db.prepare(`INSERT INTO requests (overseerr_request_id, media_id, media_type, is_4k, title, requested_by_discord_id, status)
    VALUES (NULL, 'tmdb:8', 'movie', 0, 'Eight', '333', 'pending')`).run();
  const repaired = collapseStalePendingRequests(db);
  assert.strictEqual(repaired.length, 1);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS c FROM requests WHERE media_id = 'tmdb:7'").get().c, 1);
  assert.strictEqual(db.prepare("SELECT requested_by_discord_id FROM requests WHERE media_id = 'tmdb:7'").get().requested_by_discord_id, '222');
  assert.strictEqual(db.prepare("SELECT status FROM requests WHERE media_id = 'tmdb:8'").get().status, 'pending');

  assert.strictEqual(statusFromSeerrRequest({ status: 1, is4k: false, media: { status: 2 } }), 'pending');
  assert.strictEqual(statusFromSeerrRequest({ status: 2, is4k: false, media: { status: 3 } }), 'approved');
  assert.strictEqual(statusFromSeerrRequest({ status: 2, is4k: false, media: { status: 5 } }), 'available');
  assert.strictEqual(statusFromSeerrRequest({ status: 2, is4k: true, media: { status: 5, status4k: 3 } }), 'approved');
  assert.strictEqual(statusFromSeerrRequest({ status: 3 }), 'declined');
  assert.strictEqual(statusFromSeerrRequest({ status: 4 }), 'failed');
  assert.strictEqual(statusFromSeerrRequest({ status: 5 }), 'available');

  db.prepare(`INSERT INTO requests (overseerr_request_id, media_id, media_type, is_4k, title, status)
    VALUES ('99', 'tmdb:99', 'movie', 0, 'Ninety Nine', 'pending')`).run();
  const synced = reconcileTrackedRequestStatuses(db, [{ id: 99, status: 2, is4k: false, media: { status: 5 } }]);
  assert.strictEqual(synced.changed.length, 1);
  assert.strictEqual(db.prepare("SELECT status FROM requests WHERE overseerr_request_id = '99'").get().status, 'available');

  db.close();
});
