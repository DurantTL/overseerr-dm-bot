#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const Database = require('better-sqlite3');
const { SqliteRollingWindowStore } = require('../../src/rate-limit');

function database() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE rate_limit_hits (
    scope TEXT NOT NULL, identity TEXT NOT NULL, hit_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  ); CREATE INDEX idx_rate_limit_bucket ON rate_limit_hits(scope, identity, expires_at);
  CREATE INDEX idx_rate_limit_expiry ON rate_limit_hits(expires_at);`);
  return db;
}

async function serverWith(db, now) {
  const app = express();
  app.get('/limited', rateLimit({
    windowMs: 60000,
    limit: 2,
    store: new SqliteRollingWindowStore({ db, scope: 'download-route', limit: 2, windowMs: 60000, now }),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).send('limited'),
  }), (_req, res) => res.send('ok'));
  const server = await new Promise(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}/limited`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('HTTP rate limit: SQLite rolling window survives middleware recreation and expires on the boundary', async () => {
  const db = database();
  let now = 1000;
  let http = await serverWith(db, () => now);
  assert.strictEqual((await fetch(http.url)).status, 200);
  assert.strictEqual((await fetch(http.url)).status, 200);
  const blocked = await fetch(http.url);
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual(await blocked.text(), 'limited');
  assert.match(blocked.headers.get('ratelimit') || '', /r=0/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM rate_limit_hits').get().n, 2,
    'blocked retries do not extend the rolling window');
  await http.close();

  now = 2000;
  http = await serverWith(db, () => now);
  assert.strictEqual((await fetch(http.url)).status, 429, 'a fresh middleware instance sees the exhausted SQLite bucket');

  now = 61000;
  assert.strictEqual((await fetch(http.url)).status, 200, 'the oldest hits expire at the exact boundary');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM rate_limit_hits WHERE expires_at <= ?').get(now).n, 0,
    'expired buckets are pruned by the next request');
  await http.close();
  db.close();
});

test('HTTP rate limit store: decrement and resetKey affect only the selected bucket', () => {
  const db = database();
  const store = new SqliteRollingWindowStore({ db, scope: 'download-route', limit: 3, windowMs: 60000, now: () => 1000 });
  store.init({ windowMs: 60000 });
  store.increment('one');
  store.increment('one');
  store.increment('two');
  store.decrement('one');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM rate_limit_hits WHERE identity = ?').get('one').n, 1);
  store.resetKey('one');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM rate_limit_hits WHERE identity = ?').get('one').n, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM rate_limit_hits WHERE identity = ?').get('two').n, 1);
  assert.throws(() => store.init({ windowMs: 5000 }), /window mismatch/);
  db.close();
});
