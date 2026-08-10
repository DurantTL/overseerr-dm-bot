#!/usr/bin/env node
// #75: request_subscribers bookkeeping — add/list/count/clear/prune.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { loadSandbox } = require('./extract');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseerr-bot-subscribers-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.exec(`CREATE TABLE request_subscribers (
    media_id TEXT NOT NULL,
    discord_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(media_id, discord_id)
  );`);
  return db;
}

test('request-subscribers: add is idempotent and reports whether it was new', () => {
  const db = tempDb();
  const sb = loadSandbox(['addRequestSubscriber', 'listRequestSubscribers', 'countRequestSubscribers'], { db });

  assert.strictEqual(sb.run("addRequestSubscriber('tmdb:1', 'u1')"), true, 'first add is new');
  assert.strictEqual(sb.run("addRequestSubscriber('tmdb:1', 'u1')"), false, 'duplicate add is not new');
  assert.strictEqual(sb.run("addRequestSubscriber('tmdb:1', 'u2')"), true, 'a different subscriber is new');

  assert.deepStrictEqual(sb.run("listRequestSubscribers('tmdb:1')"), ['u1', 'u2']);
  assert.strictEqual(sb.run("countRequestSubscribers('tmdb:1')"), 2);
  assert.strictEqual(sb.run("countRequestSubscribers('tmdb:999')"), 0, 'unrelated media has no subscribers');

  db.close();
});

test('request-subscribers: clear removes only that media\'s rows', () => {
  const db = tempDb();
  const sb = loadSandbox(['addRequestSubscriber', 'listRequestSubscribers', 'clearRequestSubscribers'], { db });

  sb.run("addRequestSubscriber('tmdb:1', 'u1')");
  sb.run("addRequestSubscriber('tmdb:2', 'u1')");
  sb.run("clearRequestSubscribers('tmdb:1')");

  assert.deepStrictEqual(sb.run("listRequestSubscribers('tmdb:1')"), []);
  assert.deepStrictEqual(sb.run("listRequestSubscribers('tmdb:2')"), ['u1'], 'other media untouched');

  db.close();
});

test('request-subscribers: prune drops only rows older than the retention window', () => {
  const db = tempDb();
  const sb = loadSandbox(['addRequestSubscriber', 'pruneRequestSubscribers'], { db });

  sb.run("addRequestSubscriber('tmdb:1', 'u1')");
  sb.run("addRequestSubscriber('tmdb:2', 'u2')");
  db.prepare("UPDATE request_subscribers SET created_at = datetime('now', '-200 days') WHERE media_id = 'tmdb:1'").run();

  const pruned = sb.run('pruneRequestSubscribers(180)');
  assert.strictEqual(pruned, 1);
  assert.deepStrictEqual(db.prepare('SELECT media_id FROM request_subscribers').all().map(r => r.media_id), ['tmdb:2']);

  db.close();
});
