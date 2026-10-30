'use strict';

// Automation → Fleet and host (src/fleet-host.js, src/routes/automation-heartbeat.js): per-row
// status against each row's own schedule, the heartbeat endpoint's auth and validation, the
// RackNerd roll-up, tier rows, and the server-rendered section's empty and error states.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('node:http');
const { createApp, listen, close } = require('../../src/app');
const { sha256, safeEqual } = require('../../src/util');
const uptime = require('../../src/uptime-monitor');
const fleetHost = require('../../src/fleet-host');
const inventory = require('../../src/fleet-host-inventory');
const { registerAutomationHeartbeatRoutes } = require('../../src/routes/automation-heartbeat');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// A Monday, 12:00 UTC.
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const TOKEN = 'test-heartbeat-token-0123456789abcdef0123';
const DB_MODULE = require.resolve('../../src/db');

// The real migrations, so the table under test is the one production gets.
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-host-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  delete require.cache[DB_MODULE];
  const handle = require('../../src/db');
  handle.runMigrations();
  return { db: handle.db, dir, done: () => { handle.db.close(); delete process.env.DB_PATH; fs.rmSync(dir, { recursive: true, force: true }); } };
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtAgo = t => `${Math.round((NOW - t) / MIN)} min ago`;

// ---------------------------------------------------------------------------------------------
// Status logic

test('status: a 15-minute job last seen 2 hours ago is stale; 20 minutes ago is ok', () => {
  assert.strictEqual(fleetHost.rowStatus({ periodMs: 15 * MIN, lastAt: NOW - 2 * HOUR, now: NOW }).status, 'stale');
  assert.strictEqual(fleetHost.rowStatus({ periodMs: 15 * MIN, lastAt: NOW - 20 * MIN, now: NOW }).status, 'ok');
  // Grace is one period: stale only after 30 minutes.
  assert.strictEqual(fleetHost.rowStatus({ periodMs: 15 * MIN, lastAt: NOW - 30 * MIN, now: NOW }).status, 'ok');
  assert.strictEqual(fleetHost.rowStatus({ periodMs: 15 * MIN, lastAt: NOW - 31 * MIN, now: NOW }).status, 'stale');
});

test('status: a daily job 20 hours old is NOT stale; 37 hours old is', () => {
  assert.strictEqual(fleetHost.rowStatus({ periodMs: DAY, lastAt: NOW - 20 * HOUR, now: NOW }).status, 'ok');
  assert.strictEqual(fleetHost.rowStatus({ periodMs: DAY, lastAt: NOW - 37 * HOUR, now: NOW }).status, 'stale');
});

test('status: a weekly job last run Sunday is ok on Monday, and stale the Monday after (past grace)', () => {
  const sunday = Date.UTC(2026, 10, 1, 9, 17); // Sunday 09:17 UTC
  const monday = Date.UTC(2026, 10, 2, 12, 0);
  const nextMonday = Date.UTC(2026, 10, 9, 12, 0);
  assert.strictEqual(fleetHost.rowStatus({ periodMs: 7 * DAY, lastAt: sunday, now: monday }).status, 'ok');
  assert.strictEqual(fleetHost.rowStatus({ periodMs: 7 * DAY, lastAt: sunday, now: nextMonday }).status, 'stale');
  // Grace for a weekly job is capped at 12 hours: the next Sunday evening is still ok.
  assert.strictEqual(fleetHost.rowStatus({ periodMs: 7 * DAY, lastAt: sunday, now: Date.UTC(2026, 10, 8, 21, 0) }).status, 'ok');
  assert.strictEqual(fleetHost.rowStatus({ periodMs: 7 * DAY, lastAt: sunday, now: Date.UTC(2026, 10, 8, 21, 18) }).status, 'stale');
});

test('status: a heartbeat that reported failure is failed, not stale; never reported is no data; no schedule is unknown', () => {
  assert.strictEqual(fleetHost.rowStatus({ periodMs: DAY, lastAt: NOW - HOUR, lastFailed: true, now: NOW }).status, 'failed');
  const oldFail = fleetHost.rowStatus({ periodMs: 15 * MIN, lastAt: NOW - 5 * HOUR, lastFailed: true, now: NOW });
  assert.strictEqual(oldFail.status, 'failed');
  assert.strictEqual(oldFail.overdue, true);
  assert.strictEqual(fleetHost.rowStatus({ periodMs: DAY, lastAt: null, now: NOW }).status, 'no-data');
  assert.strictEqual(fleetHost.rowStatus({ periodMs: null, lastAt: NOW - MIN, now: NOW }).status, 'unknown');
});

test('heartbeat rows: an empty table gives every allowlisted row "awaiting first heartbeat", never ok', () => {
  const rows = fleetHost.heartbeatRows(new Map(), NOW);
  assert.strictEqual(rows.length, inventory.heartbeats.length);
  assert.ok(rows.every(r => r.status === 'no-data' && r.summary === 'Awaiting first heartbeat.'));
  const html = fleetHost.renderSection({ now: NOW, tier: { rows: [] }, racknerd: { rows: [] }, heartbeats: { rows }, inventory: { rows: [] } }, { escapeHtml, fmtAgo });
  assert.strictEqual((html.match(/awaiting first heartbeat/g) || []).length, inventory.heartbeats.length);
  assert.ok(!/data-fh-status="ok"/.test(html));
});

test('inventory rows: always unknown, see log; never ok', () => {
  const rows = fleetHost.inventoryRows();
  assert.deepStrictEqual(rows.map(r => r.key), ['watchtower', 'syncthing-conflict-watcher']);
  assert.ok(rows.every(r => r.status === 'unknown' && r.lastAt === null));
  const html = fleetHost.renderSection({ now: NOW, tier: { rows: [] }, racknerd: { rows: [] }, heartbeats: { rows: [] }, inventory: { rows } }, { escapeHtml, fmtAgo });
  assert.strictEqual((html.match(/unknown, see log/g) || []).length, 2);
  assert.match(html, /docker logs watchtower/);
});

test('the allowlist and inventory hold no secret-looking values, and every scheduled row has a period', () => {
  const text = JSON.stringify(inventory);
  assert.ok(!/token|password|secret|apikey|api_key/i.test(text.replace(/"(name|label|note)":"[^"]*"/g, '')));
  for (const h of inventory.heartbeats) {
    assert.match(h.name, /^[a-z][a-z0-9-]+$/);
    assert.ok((h.period == null) === (h.schedule == null), `${h.name}: schedule and period go together`);
  }
  // Latest-movies IS the Europe sync: one row, not two.
  assert.strictEqual(inventory.heartbeats.filter(h => /europe|latest-movies/i.test(`${h.name} ${h.label}`)).length, 1);
});

// ---------------------------------------------------------------------------------------------
// Endpoint

function request(port, method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = out ? JSON.parse(out) : null; } catch (_e) { parsed = { raw: out }; } // express's own 400 for unparseable JSON
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function withServer({ token = TOKEN } = {}, fn) {
  const h = freshDb();
  const app = createApp();
  const audits = [];
  registerAutomationHeartbeatRoutes(app, {
    config: { AUTOMATION_HEARTBEAT_TOKEN_HASH: token ? sha256(token) : '' },
    db: h.db,
    httpRateLimitKey: () => 'test-client',
    sha256,
    safeEqual,
    audit: (action, meta) => audits.push({ action, meta }),
    now: () => NOW,
  });
  const server = await listen(app, 0);
  try {
    await fn({ port: server.address().port, db: h.db, audits });
  } finally {
    await close(server);
    h.done();
  }
}

const count = db => db.prepare('SELECT COUNT(*) AS n FROM automation_heartbeats').get().n;
const auth = { Authorization: `Bearer ${TOKEN}` };
const valid = { name: 'staging-sweep', status: 'ok', at: new Date(NOW - 5 * MIN).toISOString(), source: 'durant-server', summary: 'swept 3 folders', counts: { folders: 3, moved: 12 } };

test('endpoint: unconfigured answers 503 and stores nothing', async () => {
  await withServer({ token: '' }, async ({ port, db }) => {
    const r = await request(port, 'POST', '/api/automation/heartbeat', { body: valid, headers: auth });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(count(db), 0);
  });
});

test('endpoint: missing or wrong token -> 401, the same message either way, nothing stored; a dashboard cookie is not a token', async () => {
  await withServer({}, async ({ port, db, audits }) => {
    const missing = await request(port, 'POST', '/api/automation/heartbeat', { body: valid });
    const wrong = await request(port, 'POST', '/api/automation/heartbeat', { body: valid, headers: { Authorization: 'Bearer not-the-token' } });
    const cookie = await request(port, 'POST', '/api/automation/heartbeat', { body: valid, headers: { Cookie: 'dm_session=anything' } });
    const uptimeLike = await request(port, 'POST', '/api/automation/heartbeat', { body: valid, headers: { Authorization: `Bearer ${'0'.repeat(64)}` } });
    for (const r of [missing, wrong, cookie, uptimeLike]) {
      assert.strictEqual(r.status, 401);
      assert.deepStrictEqual(r.body, { ok: false, error: 'Unauthorized' });
    }
    assert.strictEqual(count(db), 0);
    assert.strictEqual(audits.filter(a => a.action === 'automation_heartbeat_auth_failed').length, 4);
    assert.ok(!JSON.stringify(audits).includes(TOKEN));
  });
});

test('endpoint: unknown name -> 404 and nothing stored; missing or invalid fields -> 400 and nothing stored', async () => {
  await withServer({}, async ({ port, db }) => {
    const post = body => request(port, 'POST', '/api/automation/heartbeat', { body, headers: auth });
    assert.strictEqual((await post({ ...valid, name: 'grafana-backup' })).status, 404);
    for (const bad of [
      {},
      [valid],
      { ...valid, name: '' },
      { ...valid, status: 'success' },
      { ...valid, status: undefined },
      { ...valid, at: 'yesterday-ish' },
      { ...valid, at: new Date(NOW - 2 * DAY).toISOString() },
      { ...valid, at: new Date(NOW + HOUR).toISOString() },
      { ...valid, counts: [1, 2] },
      { ...valid, counts: { folders: 'three' } },
      { ...valid, counts: { 'Bad Key': 1 } },
      { ...valid, summary: 'x'.repeat(201) },
      { ...valid, summary: { nested: true } },
    ]) {
      const r = await post(bad);
      assert.strictEqual(r.status, 400, JSON.stringify(bad).slice(0, 80));
    }
    assert.strictEqual((await request(port, 'POST', '/api/automation/heartbeat', { body: '{not json', headers: auth })).status, 400);
    assert.strictEqual(count(db), 0);
  });
});

test('endpoint: secret-looking text or count names are refused whole; nothing stored and the value is not echoed', async () => {
  await withServer({}, async ({ port, db }) => {
    const post = body => request(port, 'POST', '/api/automation/heartbeat', { body, headers: auth });
    const secrets = [
      { summary: 'done; token=abc123' },
      { summary: 'used Authorization: Bearer abcdefghijklmnop' },
      { summary: `key ${'a1b2'.repeat(16)}` },
      { summary: 'pushed to https://media:hunter22@example.net/x' },
      { summary: 'GET /api?apikey=zzz ok' },
      { summary: '-----BEGIN OPENSSH PRIVATE KEY----- …' },
      { summary: 'password: hunter22' },
      { source: 'ghp_abcdefghijklmnopqrstuvwxyz0123' },
      { counts: { api_key: 1 } },
      { counts: { tokens: 2 } },
    ];
    for (const extra of secrets) {
      const r = await post({ ...valid, ...extra });
      assert.strictEqual(r.status, 400, JSON.stringify(extra));
      assert.ok(!JSON.stringify(r.body).includes('hunter22') && !JSON.stringify(r.body).includes('abc123'));
    }
    assert.strictEqual(count(db), 0);
    // Ordinary words, paths and file names pass.
    assert.strictEqual((await post({ ...valid, summary: 'moved 2 files to /mnt/media/Media/TV Shows/Some.Show.S01E02.1080p.mkv' })).status, 200);
  });
});

test('endpoint: valid post stored once; extra fields (including secret-like ones) dropped, never stored', async () => {
  await withServer({}, async ({ port, db }) => {
    const body = { ...valid, apiKey: 'sk_live_should_never_be_stored', password: 'hunter22', host: 'internal-host-detail', nested: { token: 'x' } };
    const r = await request(port, 'POST', '/api/automation/heartbeat', { body, headers: auth });
    assert.deepStrictEqual(r.body, { ok: true, stored: 1, duplicate: false });
    const again = await request(port, 'POST', '/api/automation/heartbeat', { body, headers: auth });
    assert.deepStrictEqual(again.body, { ok: true, stored: 0, duplicate: true });
    const rows = db.prepare('SELECT * FROM automation_heartbeats').all();
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(Object.keys(rows[0]).sort(), ['counts', 'name', 'ok', 'received_at', 'reported_at', 'source', 'summary']);
    const dump = JSON.stringify(rows);
    for (const leaked of ['sk_live', 'hunter22', 'internal-host-detail', TOKEN]) assert.ok(!dump.includes(leaked), leaked);
    assert.strictEqual(rows[0].counts, '{"folders":3,"moved":12}');

    // Shown on the section: ok, with summary and counts.
    const model = fleetHost.buildModel({ db, tierNodes: [], getTierPlan: () => null, now: NOW });
    const row = model.heartbeats.rows.find(x => x.key === 'staging-sweep');
    assert.strictEqual(row.status, 'ok');
    const html = fleetHost.renderSection(model, { escapeHtml, fmtAgo });
    assert.match(html, /data-key="fh-heartbeat-staging-sweep" data-fh-status="ok"/);
    assert.match(html, /swept 3 folders/);
    assert.match(html, /folders 3 · moved 12/);

    // A later run that reports failure: failed, with when it last succeeded.
    await request(port, 'POST', '/api/automation/heartbeat', { body: { name: 'staging-sweep', status: 'fail', summary: 'rsync exited 23' }, headers: auth });
    const after = fleetHost.buildModel({ db, tierNodes: [], getTierPlan: () => null, now: NOW }).heartbeats.rows.find(x => x.key === 'staging-sweep');
    assert.strictEqual(after.status, 'failed');
    assert.ok(after.notes.some(n => n.startsWith('last success ')));
  });
});

test('storage: append-only and pruned after 30 days', () => {
  const h = freshDb();
  try {
    const row = { name: 'ph-sync-reporter', at: NOW - 31 * DAY, ok: true, source: null, summary: null, counts: null };
    fleetHost.recordHeartbeat(h.db, row, NOW);
    fleetHost.recordHeartbeat(h.db, { ...row, at: NOW }, NOW);
    assert.strictEqual(fleetHost.recordHeartbeat(h.db, { ...row, at: NOW, ok: false }, NOW), 0, 'a retry never overwrites');
    assert.strictEqual(fleetHost.pruneHeartbeats(h.db, NOW), 1);
    assert.deepStrictEqual(h.db.prepare('SELECT ok FROM automation_heartbeats').all(), [{ ok: 1 }]);
    const idx = h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'automation_heartbeats'").all().map(r => r.name);
    assert.ok(idx.includes('idx_automation_heartbeats_time'));
  } finally { h.done(); }
});

// ---------------------------------------------------------------------------------------------
// RackNerd roll-up

test('RackNerd roll-up matches uptime_samples: up/down/stale/no data per feed, from each endpoint\'s newest sample', () => {
  const h = freshDb();
  try {
    const rows = [];
    for (let t = NOW - 2 * HOUR; t <= NOW - 2 * MIN; t += 5 * MIN) {
      rows.push({ endpoint: 'plex-funnel', checkedAt: t, up: true, detail: '' });
      rows.push({ endpoint: 'dashboard-funnel', checkedAt: t, up: true, detail: '' });
      rows.push({ endpoint: 'bot-cloudflare', checkedAt: t, up: t < NOW - 30 * MIN, detail: '' }); // down now
      rows.push({ endpoint: 'node-durant-server', checkedAt: t, up: true, detail: '' });
      rows.push({ endpoint: 'node-ph-server', checkedAt: t, up: true, detail: '' });
      rows.push({ endpoint: 'node-southcentral-server', checkedAt: t, up: true, detail: '' });
    }
    // cali-plex-server stopped reporting 40 minutes ago (stale); seedbox never reported.
    rows.push({ endpoint: 'node-cali-plex-server', checkedAt: NOW - 40 * MIN, up: true, detail: '' });
    uptime.recordSamples(h.db, rows);
    const [paths, nodes] = fleetHost.racknerdRollup(h.db, NOW);
    assert.deepStrictEqual(paths.counts, { total: 4, up: 2, down: 1, stale: 0, noData: 1 });
    assert.deepStrictEqual(nodes.counts, { total: 4, up: 4, down: 0, stale: 1, noData: 0 });
    assert.strictEqual(paths.status, 'ok', 'the checker itself is reporting on time');
    assert.match(paths.summary, /2 of 4 paths up · 1 down · 1 never reported/);
    assert.match(nodes.summary, /4 of 4 nodes up · 1 stale/);
    // Same answer as Services → Uptime's own report (current up/down per endpoint).
    const report = uptime.uptimeReport(h.db, NOW);
    for (const [feed, kind] of [[paths, 'path'], [nodes, 'node']]) {
      const eps = report.filter(e => e.kind === kind);
      assert.strictEqual(feed.counts.up, eps.filter(e => e.current && e.current.up).length);
      assert.strictEqual(feed.counts.down, eps.filter(e => e.current && !e.current.up).length);
      assert.strictEqual(feed.counts.noData, eps.filter(e => !e.current).length);
    }
    // Nothing stored at all: no data, never ok.
    h.db.exec('DELETE FROM uptime_samples');
    assert.ok(fleetHost.racknerdRollup(h.db, NOW).every(f => f.status === 'no-data' && f.lastAt === null));
  } finally { h.done(); }
});

// ---------------------------------------------------------------------------------------------
// Tier rows

const nodes = [
  { name: 'ph', enabled: 1 },
  { name: 'southcentral', enabled: 1 },
  { name: 'california', enabled: 1 },
  { name: 'durant-server', enabled: 1, full: 1 },
];

test('tier rows: last check-in comes from the tier store; 15-min agents judged on 15 min; central-iowa without a row shows no data', () => {
  const plans = {
    ph: { lastHeartbeatAt: NOW - 10 * MIN },
    southcentral: { lastHeartbeatAt: NOW - 2 * HOUR },
    california: { lastHeartbeatAt: null, lastErrors: ['scan timed out'] },
    'durant-server': { lastHeartbeatAt: NOW - 14 * MIN },
  };
  const rows = fleetHost.tierRows({ tierNodes: nodes, getTierPlan: n => plans[n] || null, lastReportAt: n => (n === 'california' ? NOW - 20 * MIN : null), now: NOW });
  const by = Object.fromEntries(rows.map(r => [r.key, r]));
  assert.deepStrictEqual(Object.keys(by), ['ph', 'southcentral', 'california', 'durant-server', 'central-iowa']);
  assert.strictEqual(by.ph.lastAt, plans.ph.lastHeartbeatAt);
  assert.strictEqual(by.ph.status, 'ok');
  assert.strictEqual(by.southcentral.status, 'stale');
  assert.strictEqual(by.california.lastAt, NOW - 20 * MIN, 'falls back to the last report when no heartbeat is recorded');
  assert.ok(by.california.notes.some(n => /1 error/.test(n)));
  assert.strictEqual(by['durant-server'].status, 'ok');
  assert.strictEqual(by['central-iowa'].status, 'no-data');
  assert.strictEqual(by['central-iowa'].lastAt, null);
  assert.match(by['central-iowa'].summary, /No telemetry row yet/);
  assert.strictEqual(by['central-iowa'].schedule, 'daily, 03:17 America/Chicago');
});

test('tier rows: central-iowa registered and reporting daily is ok at 20 h, stale past 36 h; fleet-disks row noted both ways', () => {
  const ci = { name: 'central-iowa', enabled: 1, monitor_only: 1 };
  const withDisk = { lastHeartbeatAt: NOW - 20 * HOUR, lastTelemetry: { filesystemTotalBytes: 8e12, filesystemFreeBytes: 2e12 } };
  let [row] = fleetHost.tierRows({ tierNodes: [ci], getTierPlan: () => withDisk, now: NOW });
  assert.strictEqual(row.status, 'ok');
  assert.ok(row.notes.includes('fleet-disks row present'));
  [row] = fleetHost.tierRows({ tierNodes: [ci], getTierPlan: () => ({ lastHeartbeatAt: NOW - 37 * HOUR, lastTelemetry: { smartHealth: [] } }), now: NOW });
  assert.strictEqual(row.status, 'stale');
  assert.ok(row.notes.some(n => /no fleet-disks row/.test(n)));
  // Registered but never reported: no data, never a made-up check-in.
  [row] = fleetHost.tierRows({ tierNodes: [ci], getTierPlan: () => ({ lastHeartbeatAt: null }), now: NOW });
  assert.strictEqual(row.status, 'no-data');
  assert.match(row.summary, /No telemetry row yet/);
  // A disabled node reads disabled.
  [row] = fleetHost.tierRows({ tierNodes: [{ name: 'ph', enabled: 0 }], getTierPlan: () => ({ lastHeartbeatAt: NOW }), now: NOW });
  assert.strictEqual(row.status, 'disabled');
});

// ---------------------------------------------------------------------------------------------
// Section render: empty and failing stores

test('section: empty stores render no-data rows, a Home → Uptime link, and no loading state', () => {
  const h = freshDb();
  try {
    const model = fleetHost.buildModel({ db: h.db, tierNodes: [], getTierPlan: () => null, now: NOW });
    const html = fleetHost.renderSection(model, { escapeHtml, fmtAgo });
    assert.ok(!/loading/i.test(html));
    assert.match(html, /<a href="#home" data-tab="home" data-scroll="svcUptime">Home → Uptime<\/a>/);
    assert.ok(!/data-fh-status="ok"/.test(html), 'nothing is ok without a report');
    assert.match(html, /central-iowa/);
    assert.strictEqual(fleetHost.countRows(model), 1 + 2 + inventory.heartbeats.length + inventory.inventory.length);
    // Every non-inventory row states what it is expected to do.
    assert.ok((html.match(/· expected /g) || []).length >= 1 + 2 + inventory.heartbeats.filter(h => h.period).length);
    assert.strictEqual((html.match(/schedule not set yet/g) || []).length, inventory.heartbeats.filter(h => !h.period).length);
  } finally { h.done(); }
});

test('section: a failed store query renders an error line for that group; the other groups still render', () => {
  const h = freshDb();
  try {
    h.db.exec('DROP TABLE automation_heartbeats; DROP TABLE uptime_samples');
    const model = fleetHost.buildModel({ db: h.db, tierNodes: nodes, getTierPlan: () => ({ lastHeartbeatAt: NOW - 5 * MIN }), now: NOW });
    assert.ok(model.heartbeats.error && model.racknerd.error);
    assert.ok(!model.tier.error && !model.inventory.error);
    const html = fleetHost.renderSection(model, { escapeHtml, fmtAgo });
    assert.strictEqual((html.match(/class="fh-error" role="alert"/g) || []).length, 2);
    assert.match(html, /data-key="fh-tier-ph" data-fh-status="ok"/);
    assert.match(html, /unknown, see log/);
    assert.ok(!/no such table/.test(html), 'the raw database error is not shown');
    // A tier store that throws fails only its own group.
    const broken = fleetHost.buildModel({ db: h.db, tierNodes: nodes, getTierPlan: () => { throw new Error('boom'); }, now: NOW });
    assert.ok(broken.tier.error);
    assert.strictEqual(broken.inventory.rows.length, 2);
  } finally { h.done(); }
});
