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
    seasons TEXT,
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

// #255: a season selection must not collapse into (or be adopted by) a request for a different
// season selection of the same show+edition, and a caller that doesn't know the selection (the
// Seerr webhook) must not clobber one that was already recorded.
test('request-tracking: seasons keep concurrent per-season requests for the same show separate', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    overseerr_request_id TEXT UNIQUE,
    media_id TEXT NOT NULL,
    media_type TEXT NOT NULL,
    is_4k INTEGER DEFAULT 0,
    title TEXT NOT NULL,
    requested_by_discord_id TEXT,
    status TEXT DEFAULT 'pending',
    seasons TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Two members gate-request different seasons of the same show — each gets its own pending row.
  upsertTrackedRequest(db, null, 'tmdb:1396', 'tv', false, 'Breaking Bad', 'u1', 'pending', JSON.stringify([1]));
  upsertTrackedRequest(db, null, 'tmdb:1396', 'tv', false, 'Breaking Bad', 'u2', 'pending', JSON.stringify([2]));
  const rows = db.prepare("SELECT requested_by_discord_id, seasons FROM requests WHERE media_id = 'tmdb:1396' ORDER BY id").all();
  assert.strictEqual(rows.length, 2, 'each season selection gets its own row instead of colliding');
  assert.deepStrictEqual(rows, [
    { requested_by_discord_id: 'u1', seasons: '[1]' },
    { requested_by_discord_id: 'u2', seasons: '[2]' },
  ]);

  // Approving u1's season-1 request (same selection it was gated under) must adopt ONLY that
  // provisional row, not u2's season-2 one.
  const adopted = upsertTrackedRequest(db, 501, 'tmdb:1396', 'tv', false, 'Breaking Bad', 'u1', 'approved', JSON.stringify([1]));
  assert.strictEqual(adopted.action, 'adopted-provisional');
  const afterApprove = db.prepare('SELECT overseerr_request_id, requested_by_discord_id, seasons, status FROM requests ORDER BY id').all();
  assert.deepStrictEqual(afterApprove, [
    { overseerr_request_id: '501', requested_by_discord_id: 'u1', seasons: '[1]', status: 'approved' },
    { overseerr_request_id: null, requested_by_discord_id: 'u2', seasons: '[2]', status: 'pending' },
  ]);

  // A caller that doesn't know the season selection (the Seerr webhook) must not wipe it out.
  upsertTrackedRequest(db, 501, 'tmdb:1396', 'tv', false, 'Breaking Bad', null, 'available');
  assert.strictEqual(db.prepare("SELECT seasons FROM requests WHERE overseerr_request_id = '501'").get().seasons, '[1]', 'seasons preserved when the caller passes none');

  // collapseStalePendingRequests must only merge a stale pending row into a completed row with
  // the SAME season selection.
  db.prepare(`INSERT INTO requests (overseerr_request_id, media_id, media_type, is_4k, title, requested_by_discord_id, status, seasons)
    VALUES (NULL, 'tmdb:55', 'tv', 0, 'Show', '333', 'pending', '[1]')`).run();
  db.prepare(`INSERT INTO requests (overseerr_request_id, media_id, media_type, is_4k, title, requested_by_discord_id, status, seasons)
    VALUES ('900', 'tmdb:55', 'tv', 0, 'Show', NULL, 'available', '[2]')`).run();
  const repaired = collapseStalePendingRequests(db);
  assert.strictEqual(repaired.length, 0, 'different season selections are not merged');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS c FROM requests WHERE media_id = 'tmdb:55'").get().c, 2);

  db.close();
});
