#!/usr/bin/env node
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const vm = require('node:vm');
const { rateLimit } = require('express-rate-limit');
const { createApp, listen, close } = require('../../src/app');
const { escapeHtml, sqliteUtcMs, fmtAgo } = require('../../src/dashboard-render');
const { normalizeSearchQuery } = require('../../src/search');
const { registerDashboardReadRoutes } = require('../../src/routes/dashboard-read');
const { createTtlCache } = require('../../src/dashboard-cache');

function request(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, headers }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function fixture(overrides = {}) {
  const calls = { health: 0, doctor: [], preview: 0 };
  const app = createApp();
  const emptyStatement = {
    all: () => [],
    get: () => ({ c: 0 }),
  };
  const deps = {
    CONFIG: { SONARR_URL: '', RADARR_URL: '', RADARR_4K_URL: '', TIER_PLAN_STALE_DAYS: 7 },
    PASSKEY_RP: { rpID: 'example.test' },
    dashboardCache: createTtlCache(),
    arrSources: () => [],
    buildSyncPreview: async () => { calls.preview += 1; return { actions: [] }; },
    canEscalate: () => false,
    dashboardActionError: error => error.message,
    dashboardAuth: (req, res, next) => req.get('x-admin-token') === 'secret'
      ? next()
      : res.status(401).json({ ok: false, error: 'Unauthorized' }),
    db: { prepare: () => emptyStatement },
    discordReadyGuard: (_req, res) => res.status(503).json({ ok: false, error: 'Discord unavailable' }),
    escapeHtml,
    fetchArrQueues: async () => [],
    fetchDiskSpace: async () => [],
    fetchOverseerrUsers: async () => [],
    fmtAgo,
    fmtDuration: () => 'now',
    fmtSpace: value => String(value),
    forecastDisks: () => [],
    forecastLabel: () => 'stable',
    gatherHealth: async () => { calls.health += 1; return { overall: 'ok', errors: {} }; },
    gatherIncompleteRequests: async () => [],
    getGuildMembers: async () => [],
    getTierPlan: () => null,
    grabDailyAllowance: () => ({ limited: false, exhausted: false, remaining: 0 }),
    httpRateLimitKey: () => 'dashboard-read-test',
    listActiveGrabJobs: () => [],
    listActiveStageJobs: () => [],
    listMediaPriority: () => [],
    listPasskeys: () => [],
    listPendingRequests: () => [],
    listRadarrMovies: async () => [],
    listSeasonAlertStates: () => [],
    listSonarrMissingEpisodes: async () => [],
    listSonarrSeries: async () => [],
    listTierNodeFolders: () => [],
    listTierNodes: () => [{ name: 'ph', enabled: 1, full: 0, usable_bytes: 42 }],
    mediaTypeLabel: type => type || 'unknown',
    normalizeSearchQuery,
    queueItemLooksUnhealthy: () => false,
    queuePercent: () => 0,
    quotaBlockReason: async () => null,
    rateLimit,
    renderHealthBadges: () => 'health-badges',
    renderItemList: (items, empty) => items.length ? 'items' : empty,
    renderPage: (title, body) => `<title>${escapeHtml(title)}</title>${body}`,
    renderPasskeyManagement: () => 'passkeys',
    renderSettingsGroup: () => 'settings',
    renderStat: (label, value) => `${label}:${value}`,
    renderTable: rows => `rows:${rows.length}`,
    renderTierNodeSetup: () => 'tier-setup',
    runEdgeDiagnostics: async options => { calls.doctor.push(options); return [{ name: 'edge', ok: true }]; },
    runtimeSettings: { describeRuntimeSettings: () => [] },
    searchDashboard: () => ({ requests: [], users: [], library: [], audit: [] }),
    seasonAlertDashboardItems: () => [],
    settingsStore: {},
    sqliteUtcMs,
    tautulliApi: async () => ({ sessions: [] }),
    tautulliConfigured: () => false,
    tierNodeStatus: () => ({ state: 'ok', status: 'online', details: 'current', setup: false }),
    tunable: () => 0,
    ...overrides,
  };
  registerDashboardReadRoutes(app, deps);
  return { app, calls };
}

test('dashboard read routes authenticate before health work and preserve JSON contracts', async () => {
  const { app, calls } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const denied = await request(port, '/admin/health');
    assert.strictEqual(denied.statusCode, 401);
    assert.strictEqual(calls.health, 0);

    const headers = { 'x-admin-token': 'secret' };
    const health = await request(port, '/admin/health', headers);
    assert.strictEqual(health.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(health.body), { overall: 'ok', errors: {} });

    const doctor = await request(port, '/admin/doctor', headers);
    assert.strictEqual(doctor.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(doctor.body), {
      checks: [{ name: 'edge', ok: true }],
      tierNodes: [{ name: 'ph', enabled: true, full: false, usableBytes: 42 }],
    });
    assert.deepStrictEqual(calls.doctor, [{ live: true }]);
  } finally {
    await close(server);
  }
});

test('dashboard action previews keep readiness and cleanup filtering contracts', async () => {
  const { app, calls } = fixture({
    fetchOverseerrUsers: async () => [
      { id: 1, userType: 2, displayName: 'deleted_user_1', email: 'old@example.test', username: 'old' },
      { id: 2, userType: 1, displayName: 'deleted_user_owner', email: 'owner@example.test', username: 'owner' },
      { id: 3, userType: 2, displayName: 'Active', email: 'active@example.test', username: 'active' },
    ],
  });
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const headers = { 'x-admin-token': 'secret' };
    const preview = await request(port, '/admin/action/sync-preview', headers);
    assert.strictEqual(preview.statusCode, 503);
    assert.strictEqual(calls.preview, 0);

    const cleanup = await request(port, '/admin/action/cleanup-preview', headers);
    assert.strictEqual(cleanup.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(cleanup.body), {
      wouldRemove: 1,
      users: [{ id: 1, email: 'old@example.test', username: 'old' }],
    });
  } finally {
    await close(server);
  }
});

test('dashboard page and search routes render over a real ephemeral HTTP server', async () => {
  const { app } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const headers = { 'x-admin-token': 'secret' };
    const dashboard = await request(port, '/admin', headers);
    assert.strictEqual(dashboard.statusCode, 200);
    assert.match(dashboard.headers['content-type'], /^text\/html/);
    assert.match(dashboard.body, /<title>Dashboard<\/title>/);
    assert.match(dashboard.body, /Overall: <strong>OK<\/strong>/);
    // #187: the inline "Working…" action-feedback text was mojibake (UTF-8 bytes misread as
    // Latin-1) — assert the correct ellipsis character renders and the corrupted form is gone.
    assert.match(dashboard.body, /Working…/);
    assert.doesNotMatch(dashboard.body, /Workingâ€¦/);
    const inlineScripts = dashboard.body.split('<script>').slice(1)
      .map(block => block.split('</script>', 1)[0])
      .filter(Boolean);
    for (const script of inlineScripts) {
      assert.doesNotThrow(() => new vm.Script(script, { filename: 'dashboard-inline.js' }));
    }

    const empty = await request(port, '/admin/search', headers);
    assert.strictEqual(empty.statusCode, 200);
    assert.match(empty.body, /Enter at least 2 characters/);

    const short = await request(port, '/admin/search?q=x', headers);
    assert.strictEqual(short.statusCode, 400);
    assert.match(short.body, /at least 2 characters/);

    const search = await request(port, '/admin/search?q=matrix', headers);
    assert.strictEqual(search.statusCode, 200);
    assert.match(search.body, /<title>Search: matrix<\/title>/);
    assert.match(search.body, /Requests/);
  } finally {
    await close(server);
  }
});

test('#189: repeated /admin renders within the TTL do not refetch every integration', async () => {
  const { app, calls } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const headers = { 'x-admin-token': 'secret' };

    await request(port, '/admin', headers);
    await request(port, '/admin', headers);
    await request(port, '/admin', headers);
    assert.strictEqual(calls.health, 1, 'three renders inside the TTL window should hit gatherHealth once');
    assert.strictEqual(calls.doctor.length, 1, 'the edge-diagnostics snapshot is shared across renders too');
  } finally {
    await close(server);
  }
});

test('#189: concurrent /admin renders coalesce into a single upstream call', async () => {
  const { app, calls } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const headers = { 'x-admin-token': 'secret' };
    // Several "open tabs" refreshing at once must not each trigger their own fan-out.
    await Promise.all([
      request(port, '/admin', headers),
      request(port, '/admin', headers),
      request(port, '/admin', headers),
      request(port, '/admin', headers),
    ]);
    assert.strictEqual(calls.health, 1);
  } finally {
    await close(server);
  }
});

test('#189: an expired TTL triggers exactly one refresh, and a failed refresh serves the last good value as stale', async () => {
  let clock = 1000;
  const cache = createTtlCache(() => clock);
  const { app, calls } = fixture({ dashboardCache: cache });
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const headers = { 'x-admin-token': 'secret' };
    await request(port, '/admin', headers);
    assert.strictEqual(calls.health, 1);

    clock += 16000; // past the 15s health TTL
    const stale = await request(port, '/admin', headers);
    assert.strictEqual(calls.health, 2, 'TTL elapsed: refetched once');
    assert.doesNotMatch(stale.body, /<strong>stale<\/strong>/, 'a successful refresh is not flagged stale');
  } finally {
    await close(server);
  }
});

test('#189: the very first health check ever failing renders "unknown" instead of crashing', async () => {
  const { app } = fixture({
    gatherHealth: async () => { throw new Error('down before anything ever succeeded'); },
  });
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const rendered = await request(port, '/admin', { 'x-admin-token': 'secret' });
    assert.strictEqual(rendered.statusCode, 200);
    assert.match(rendered.body, /Overall: <strong>UNKNOWN<\/strong>/);
  } finally {
    await close(server);
  }
});

test('#189: a page render reports staleness when a refresh fails after the TTL expires', async () => {
  let clock = 1000;
  const cache = createTtlCache(() => clock);
  let fail = false;
  const { app } = fixture({
    dashboardCache: cache,
    gatherHealth: async () => { if (fail) throw new Error('down'); return { overall: 'ok', errors: {} }; },
  });
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const headers = { 'x-admin-token': 'secret' };
    await request(port, '/admin', headers); // seeds a good cached value
    fail = true;
    clock += 16000; // past the 15s health TTL, so the next render actually attempts a refresh
    const rendered = await request(port, '/admin', headers);
    assert.strictEqual(rendered.statusCode, 200, 'one failed integration never takes the whole dashboard down');
    assert.match(rendered.body, /Overall: <strong>OK<\/strong>/, 'the last good health value keeps rendering');
    assert.match(rendered.body, /<strong>stale<\/strong>/, 'the render says it is showing a stale value');
  } finally {
    await close(server);
  }
});
