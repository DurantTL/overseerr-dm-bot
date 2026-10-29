'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { feedItems } = require('../../src/dashboard-feed');
const { diskTrend, uptimeByDay, requestsByDay, DAY_MS } = require('../../src/dashboard-trends');
const { renderFeed, renderTrends } = require('../../src/dashboard-render');

const row = (id, action, meta) => ({ id, action, created_at: '2026-10-29 05:00:00', metadata_json: JSON.stringify(meta) });

test('feedItems turns known audit actions into sentences and skips noise and reminders', () => {
  const items = feedItems([
    row(9, 'dashboard_search', { q: 'x' }),
    row(8, 'service_down_alerted', { service: 'radarr', attemptCount: 6 }),
    row(7, 'service_down_alerted', { service: 'radarr', attemptCount: 1 }),
    row(6, 'request_approved', { requestId: 42 }),
    row(5, 'media_available_notification_sent', { title: 'Dune', subscriber: true }),
    row(4, 'media_available_notification_sent', { title: 'Dune' }),
    row(3, 'service_down_recovered', { service: 'radarr', downForMs: 12 * 60000 }),
    { id: 2, action: 'media_requested', created_at: 'x', metadata_json: '{not json' },
  ], { serviceName: k => (k === 'radarr' ? 'Radarr' : k), requestTitle: id => (id === 42 ? 'Arrival' : null) });
  assert.deepStrictEqual(items.map(i => i.text), [
    'Radarr went down',
    'Arrival was approved',
    'Dune is ready to watch',
    'Radarr is back after 12 min',
  ]);
  assert.deepStrictEqual(items.map(i => i.tone), ['down', 'ok', 'ok', 'ok']);
});

test('renderFeed keys rows by audit id and escapes text', () => {
  const html = renderFeed([{ id: 7, at: Date.now() - 60000, tone: 'warn', text: '<b>x</b> could not be imported' }]);
  assert.match(html, /data-key="feed-7"/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(renderFeed([]), /Nothing new yet/);
});

function db() {
  const d = new Database(':memory:');
  d.exec(`CREATE TABLE disk_space_samples (root TEXT, free_bytes INTEGER, total_bytes INTEGER, sampled_at INTEGER, PRIMARY KEY (root, sampled_at));
    CREATE TABLE service_samples (service TEXT, state TEXT, sampled_at INTEGER, PRIMARY KEY (service, sampled_at));
    CREATE TABLE requests (id INTEGER PRIMARY KEY, title TEXT, created_at DATETIME);`);
  return d;
}

test('trends read stored history and say how much changed', () => {
  const d = db();
  const now = Date.UTC(2026, 9, 29, 12);
  for (let i = 0; i < 10; i++) d.prepare('INSERT INTO disk_space_samples VALUES (?,?,?,?)').run('/mnt/media', 1000e9 - i * 10e9, 4000e9, now - (9 - i) * DAY_MS);
  const disks = diskTrend(d, { now });
  assert.strictEqual(disks.length, 1);
  assert.strictEqual(disks[0].change, -90e9);
  assert.strictEqual(disks[0].series.length, 10);

  d.prepare('INSERT INTO service_samples VALUES (?,?,?)').run('plex', 'ok', now - 1000);
  d.prepare('INSERT INTO service_samples VALUES (?,?,?)').run('radarr', 'down', now - 2000);
  const up = uptimeByDay(d, { now });
  assert.strictEqual(up.length, 7);
  assert.strictEqual(up[6].pct, 50);
  assert.strictEqual(up[0].pct, null);

  d.prepare('INSERT INTO requests (title, created_at) VALUES (?, ?)').run('A', '2026-10-29 03:00:00');
  d.prepare('INSERT INTO requests (title, created_at) VALUES (?, ?)').run('B', '2026-10-28 03:00:00');
  const req = requestsByDay(d, { now });
  assert.strictEqual(req.length, 14);
  assert.deepStrictEqual(req.slice(-2).map(x => x.n), [1, 1]);

  const html = renderTrends({ disks, uptime: up, requests: req }, { fmtSpace: b => `${Math.round(b / 1e9)} GB` });
  assert.match(html, /910 GB free/);
  assert.match(html, /−90 GB in 9 d/);
  assert.match(html, /2 in 14 days/);
});

test('renderTrends says it is collecting when there is no history yet', () => {
  const html = renderTrends({ disks: [], uptime: Array.from({ length: 7 }, () => ({ day: 0, pct: null })), requests: [] });
  assert.match(html, /Collecting\. Disk samples/);
  assert.match(html, /Collecting\. Uptime/);
});
