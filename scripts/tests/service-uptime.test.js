'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { recordServiceSamples, pruneServiceSamples, uptimeSummary, HISTORY_MS } = require('../../src/service-uptime');

function memDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE service_samples (service TEXT NOT NULL, state TEXT NOT NULL, sampled_at INTEGER NOT NULL, PRIMARY KEY (service, sampled_at))');
  return db;
}

const HOUR = 60 * 60 * 1000;

test('records only definite answers, so an unconfigured service never reads as down', () => {
  const db = memDb();
  recordServiceSamples(db, [{ key: 'radarr', state: 'ok' }, { key: 'sonarr', state: 'down' }, { key: 'plex', state: 'skip' }], 1000);
  const rows = db.prepare('SELECT service, state FROM service_samples ORDER BY service').all();
  assert.deepStrictEqual(rows, [{ service: 'radarr', state: 'ok' }, { service: 'sonarr', state: 'down' }]);
});

test('uptimeSummary reports share up, a 48-slot strip and down spells over the last 24 hours', () => {
  const db = memDb();
  const now = 100 * HOUR;
  // One check every 5 minutes for 24 hours; down for two separate half-hour stretches.
  for (let t = now - 24 * HOUR + 60000; t <= now; t += 5 * 60000) {
    const ago = now - t;
    const down = (ago > 10 * HOUR && ago <= 10.5 * HOUR) || (ago > 2 * HOUR && ago <= 2.5 * HOUR);
    recordServiceSamples(db, [{ key: 'radarr', state: down ? 'down' : 'ok' }], t);
  }
  const s = uptimeSummary(db, { now }).radarr;
  assert.strictEqual(s.slots.length, 48);
  assert.ok(s.pct > 95 && s.pct < 96, `pct was ${s.pct}`);
  assert.strictEqual(s.spells, 2);
  assert.ok(s.slots.includes('down') || s.slots.includes('mixed'));
  assert.strictEqual(s.slots[47], 'ok');
});

test('slots before sampling began stay empty instead of reading as up', () => {
  const db = memDb();
  const now = 50 * HOUR;
  recordServiceSamples(db, [{ key: 'plex', state: 'ok' }], now - HOUR);
  const s = uptimeSummary(db, { now }).plex;
  assert.strictEqual(s.slots.filter(x => x === null).length, 47);
  assert.strictEqual(s.pct, 100);
  assert.ok(s.coversMs <= HOUR);
});

test('pruneServiceSamples drops rows older than the history window', () => {
  const db = memDb();
  const now = 1000 * HOUR;
  recordServiceSamples(db, [{ key: 'plex', state: 'ok' }], now - HISTORY_MS - 1);
  recordServiceSamples(db, [{ key: 'plex', state: 'ok' }], now - HOUR);
  pruneServiceSamples(db, now);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM service_samples').get().n, 1);
});
