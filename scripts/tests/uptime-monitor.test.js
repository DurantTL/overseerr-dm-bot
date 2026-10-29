'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Database = require('better-sqlite3');
const { createApp, listen, close } = require('../../src/app');
const { sha256, safeEqual } = require('../../src/util');
const uptime = require('../../src/uptime-monitor');
const { registerUptimeRoutes } = require('../../src/routes/uptime');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

function memDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE uptime_samples (endpoint TEXT NOT NULL, checked_at INTEGER NOT NULL, up INTEGER NOT NULL, detail TEXT, PRIMARY KEY (endpoint, checked_at))');
  return db;
}

// One checker-style sample every 5 minutes over [from, to), with isDown(t) deciding the result.
function fill(db, key, from, to, isDown = () => false) {
  const rows = [];
  for (let t = from; t < to; t += 5 * MIN) rows.push({ endpoint: key, checkedAt: t, up: !isDown(t), detail: isDown(t) ? 'HTTP 502' : 'HTTP 200' });
  uptime.recordSamples(db, rows);
}

const report = (db, key) => uptime.uptimeReport(db, NOW).find(e => e.key === key);

test('full history: 30 days covered, percentages from stored samples only', () => {
  const db = memDb();
  // Down for exactly one hour, 2 days ago: 12 of 8640 samples.
  const outStart = NOW - 2 * DAY;
  fill(db, 'plex-funnel', NOW - 30 * DAY, NOW, t => t >= outStart && t < outStart + HOUR);
  const r = report(db, 'plex-funnel');
  assert.strictEqual(r.collecting, false);
  assert.deepStrictEqual(r.periods['24h'], { pct: 100, samples: 288, covered: true });
  assert.strictEqual(r.periods['7d'].samples, 2016);
  assert.strictEqual(r.periods['7d'].pct, Math.round(((2016 - 12) / 2016) * 10000) / 100);
  assert.strictEqual(r.periods['30d'].pct, Math.round(((8640 - 12) / 8640) * 10000) / 100);
  assert.deepStrictEqual(r.lastOutage, { start: outStart, end: outStart + HOUR, durationMs: HOUR });
  assert.strictEqual(r.ongoing, null);
  assert.deepStrictEqual(r.current, { up: true, at: NOW - 5 * MIN, detail: 'HTTP 200' });
  assert.ok(r.blocks.every(b => b === 'up'));
});

test('partial history: only covered periods count as covered, uncovered hours are no data', () => {
  const db = memDb();
  // Three hours of history; down for 10 minutes 90 minutes ago, and down again right now.
  fill(db, 'bot-cloudflare', NOW - 3 * HOUR, NOW, t => (t >= NOW - 90 * MIN && t < NOW - 80 * MIN) || t >= NOW - 10 * MIN);
  const r = report(db, 'bot-cloudflare');
  assert.strictEqual(r.collecting, true);
  assert.strictEqual(r.periods['24h'].covered, false);
  assert.strictEqual(r.periods['24h'].samples, 36);
  assert.strictEqual(r.periods['24h'].pct, Math.round((32 / 36) * 10000) / 100);
  assert.strictEqual(r.historySince, NOW - 3 * HOUR);
  // 21 grey hours, never green.
  assert.deepStrictEqual(r.blocks.slice(0, 21), Array(21).fill(null));
  assert.deepStrictEqual(r.blocks.slice(21), ['up', 'down', 'down']);
  assert.deepStrictEqual(r.lastOutage, { start: NOW - 90 * MIN, end: NOW - 80 * MIN, durationMs: 10 * MIN });
  assert.deepStrictEqual(r.ongoing, { start: NOW - 10 * MIN, durationMs: 10 * MIN });
  assert.strictEqual(r.current.up, false);
});

test('no data: no percentages, no blocks, no outage, nothing invented', () => {
  const r = report(memDb(), 'seedbox-rutorrent');
  assert.strictEqual(r.current, null);
  for (const p of ['24h', '7d', '30d']) assert.deepStrictEqual(r.periods[p], { pct: null, samples: 0, covered: false });
  assert.deepStrictEqual(r.blocks, Array(24).fill(null));
  assert.strictEqual(r.lastOutage, null);
  assert.strictEqual(r.collecting, true);
});

test('a gap where the checker did not run stays grey and does not change the percentage', () => {
  const db = memDb();
  fill(db, 'dashboard-funnel', NOW - 24 * HOUR, NOW - 10 * HOUR);
  fill(db, 'dashboard-funnel', NOW - 6 * HOUR, NOW);
  const r = report(db, 'dashboard-funnel');
  assert.strictEqual(r.periods['24h'].pct, 100);
  assert.deepStrictEqual(r.blocks.slice(14, 18), [null, null, null, null]);
});

test('parseIngest keeps the checker judgment and rejects anything malformed', () => {
  const rows = uptime.parseIngest({ checked_at: '2026-10-29T11:55:00Z', results: [{ key: 'plex-funnel', up: false, detail: 'HTTP 503\nbad gateway' }] }, NOW);
  assert.deepStrictEqual(rows, [{ endpoint: 'plex-funnel', checkedAt: NOW - 5 * MIN, up: false, detail: 'HTTP 503 bad gateway' }]);
  assert.strictEqual(uptime.parseIngest({ results: [{ key: 'plex-funnel', up: true, checked_at: (NOW - MIN) / 1000 }] }, NOW)[0].checkedAt, NOW - MIN);
  const bad = [
    [null, /results array/],
    [{ results: [] }, /between 1 and 4/],
    [{ results: [{ key: 'grafana', up: true }] }, /Unknown endpoint key: grafana/],
    [{ results: [{ key: 'plex-funnel', up: 'yes' }] }, /up: true or false/],
    [{ results: [{ key: 'plex-funnel', up: true }, { key: 'plex-funnel', up: true }] }, /twice/],
    [{ checked_at: 'soon', results: [{ key: 'plex-funnel', up: true }] }, /not a valid time/],
    [{ results: [{ key: 'plex-funnel', up: true, checked_at: NOW - 2 * DAY }] }, /outside the accepted window/],
  ];
  for (const [body, re] of bad) assert.throws(() => uptime.parseIngest(body, NOW), re);
});

test('storage is append-only and prunes after 30 days', () => {
  const db = memDb();
  const row = { endpoint: 'plex-funnel', checkedAt: NOW, up: true, detail: 'HTTP 200' };
  assert.strictEqual(uptime.recordSamples(db, [row]), 1);
  assert.strictEqual(uptime.recordSamples(db, [{ ...row, up: false }]), 0, 'a retried post never overwrites');
  assert.strictEqual(db.prepare('SELECT up FROM uptime_samples').get().up, 1);
  uptime.recordSamples(db, [{ ...row, checkedAt: NOW - 31 * DAY }]);
  assert.strictEqual(uptime.pruneSamples(db, NOW), 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM uptime_samples').get().n, 1);
});

function request(port, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function fixture({ token = 'test-ingest-token-0123456789abcdef0123' } = {}) {
  const app = createApp();
  const db = memDb();
  const audits = [];
  registerUptimeRoutes(app, {
    config: { UPTIME_INGEST_TOKEN_HASH: token ? sha256(token) : '' },
    db,
    dashboardAuth: (req, res, next) => (req.headers['x-admin'] === '1' ? next() : res.status(401).json({ ok: false })),
    httpRateLimitKey: () => 'test-client',
    sha256,
    safeEqual,
    audit: (action, meta) => audits.push({ action, meta }),
    now: () => NOW,
  });
  return { app, db, audits, token };
}

test('ingest endpoint: checker-style post stored; unauthenticated, unknown keys and unconfigured refused', async () => {
  const { app, db, audits, token } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const run = {
      checked_at: new Date(NOW - MIN).toISOString(),
      results: [
        { key: 'plex-funnel', up: true, detail: 'HTTP 200' },
        { key: 'dashboard-funnel', up: true, detail: 'HTTP 302' },
        { key: 'bot-cloudflare', up: false, detail: 'timeout after 10s' },
        { key: 'seedbox-rutorrent', up: true, detail: 'HTTP 401' },
      ],
    };
    assert.strictEqual((await request(port, 'POST', '/api/uptime/ingest', { body: run })).status, 401);
    assert.strictEqual((await request(port, 'POST', '/api/uptime/ingest', { body: run, headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.strictEqual(audits.filter(a => a.action === 'uptime_ingest_auth_failed').length, 2);
    const auth = { Authorization: `Bearer ${token}` };
    const unknown = await request(port, 'POST', '/api/uptime/ingest', { body: { results: [{ key: 'grafana', up: true }] }, headers: auth });
    assert.strictEqual(unknown.status, 400);
    const ok = await request(port, 'POST', '/api/uptime/ingest', { body: run, headers: auth });
    assert.deepStrictEqual(ok.body, { ok: true, stored: 4, duplicates: 0 });
    const again = await request(port, 'POST', '/api/uptime/ingest', { body: run, headers: auth });
    assert.deepStrictEqual(again.body, { ok: true, stored: 0, duplicates: 4 });
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM uptime_samples').get().n, 4);

    assert.strictEqual((await request(port, 'GET', '/admin/api/uptime')).status, 401);
    const read = await request(port, 'GET', '/admin/api/uptime', { headers: { 'x-admin': '1' } });
    assert.strictEqual(read.body.ok, true);
    assert.deepStrictEqual(read.body.endpoints.map(e => [e.key, e.current.up]), [['plex-funnel', true], ['dashboard-funnel', true], ['bot-cloudflare', false], ['seedbox-rutorrent', true]]);
    assert.ok(!JSON.stringify(read.body).includes(token));
  } finally {
    await close(server);
  }
  const off = fixture({ token: '' });
  const s2 = await listen(off.app, 0);
  try {
    const res = await request(s2.address().port, 'POST', '/api/uptime/ingest', { body: { results: [] }, headers: { Authorization: 'Bearer anything' } });
    assert.strictEqual(res.status, 503);
  } finally {
    await close(s2);
  }
});

test('ingest endpoint is rate limited', async () => {
  const { app, token } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await request(port, 'POST', '/api/uptime/ingest', { body: { results: [{ key: 'plex-funnel', up: true, checked_at: NOW - i * MIN }] }, headers: { Authorization: `Bearer ${token}` } })).status);
    }
    assert.deepStrictEqual(statuses.slice(0, 10), Array(10).fill(200));
    assert.deepStrictEqual(statuses.slice(10), [429, 429]);
  } finally {
    await close(server);
  }
});
