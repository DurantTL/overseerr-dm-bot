#!/usr/bin/env node
// Regression coverage for a round of review findings:
// - subscriberKeyFor: standard vs 4K editions must not share a subscriber list.
// - resolveTmdbId: a tvdb:-keyed (approved TV) row must resolve its real tmdbId via its
//   tmdb:-keyed sibling row, not misread the tvdb id as a tmdbId.
// - the quota-reservation query backing quotaBlockReason: a user's own still-outstanding
//   'pending' rows must count against their live Seerr quota.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { loadSandbox } = require('./extract');

test('subscriberKeyFor: standard and 4K get distinct keys', () => {
  const sb = loadSandbox(['subscriberKeyFor'], {});
  assert.strictEqual(sb.run('subscriberKeyFor(42, false)'), 'tmdb:42');
  assert.strictEqual(sb.run('subscriberKeyFor(42, true)'), 'tmdb:42:4k');
  assert.notStrictEqual(sb.run('subscriberKeyFor(42, false)'), sb.run('subscriberKeyFor(42, true)'));
});

function tempRequestsDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseerr-bot-review-fixes-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.exec(`CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    overseerr_request_id TEXT,
    media_id TEXT NOT NULL,
    media_type TEXT NOT NULL,
    is_4k INTEGER DEFAULT 0,
    title TEXT NOT NULL,
    requested_by_discord_id TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  return db;
}

test('resolveTmdbId: a tmdb:-keyed row resolves directly', () => {
  const db = tempRequestsDb();
  db.prepare("INSERT INTO requests (media_id, media_type, title, status) VALUES ('tmdb:42', 'movie', 'A Movie', 'approved')").run();
  const row = db.prepare("SELECT * FROM requests WHERE media_id = 'tmdb:42'").get();
  const sb = loadSandbox(['resolveTmdbId'], { db });
  assert.strictEqual(sb.run(`resolveTmdbId(${JSON.stringify(row)})`), 42);
  db.close();
});

test('resolveTmdbId: a tvdb:-keyed approved TV row resolves via its tmdb:-keyed sibling', () => {
  const db = tempRequestsDb();
  // Mirrors handleGateApprove: both rows share the same overseerr_request_id once Seerr assigns
  // a tvdbId for a TV show.
  db.prepare("INSERT INTO requests (overseerr_request_id, media_id, media_type, title, status) VALUES ('99', 'tvdb:555', 'tv', 'A Show', 'approved')").run();
  db.prepare("INSERT INTO requests (overseerr_request_id, media_id, media_type, title, status) VALUES ('99', 'tmdb:777', 'tv', 'A Show', 'approved')").run();
  const tvdbRow = db.prepare("SELECT * FROM requests WHERE media_id = 'tvdb:555'").get();
  const sb = loadSandbox(['resolveTmdbId'], { db });
  assert.strictEqual(sb.run(`resolveTmdbId(${JSON.stringify(tvdbRow)})`), 777, 'must return the real tmdbId (777), not misread the tvdb id (555) as one');
  db.close();
});

test('resolveTmdbId: a tvdb:-keyed row with no sibling and no request id resolves to null', () => {
  const db = tempRequestsDb();
  db.prepare("INSERT INTO requests (media_id, media_type, title, status) VALUES ('tvdb:555', 'tv', 'A Show', 'pending')").run();
  const row = db.prepare("SELECT * FROM requests WHERE media_id = 'tvdb:555'").get();
  const sb = loadSandbox(['resolveTmdbId'], { db });
  assert.strictEqual(sb.run(`resolveTmdbId(${JSON.stringify(row)})`), null, 'no sibling to resolve from means null, not a wrong guess');
  db.close();
});

test('quota reservation query: counts only this user\'s own pending rows for the same media type', () => {
  const db = tempRequestsDb();
  const insert = (discordId, mediaType, status) => db.prepare(
    'INSERT INTO requests (media_id, media_type, title, requested_by_discord_id, status) VALUES (?, ?, ?, ?, ?)',
  ).run(`tmdb:${Math.random()}`, mediaType, 'X', discordId, status);

  insert('u1', 'movie', 'pending');
  insert('u1', 'movie', 'pending');
  insert('u1', 'tv', 'pending'); // different media type — must not count
  insert('u1', 'movie', 'approved'); // not pending — must not count
  insert('u2', 'movie', 'pending'); // different user — must not count

  const reserved = db.prepare(
    "SELECT COUNT(*) AS c FROM requests WHERE requested_by_discord_id = ? AND media_type = ? AND status = 'pending'",
  ).get('u1', 'movie').c;
  assert.strictEqual(reserved, 2);
  db.close();
});
