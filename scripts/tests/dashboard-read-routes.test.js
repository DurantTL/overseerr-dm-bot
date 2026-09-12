#!/usr/bin/env node
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { rateLimit } = require('express-rate-limit');
const { createApp, listen, close } = require('../../src/app');
const { escapeHtml, sqliteUtcMs, fmtAgo } = require('../../src/dashboard-render');
const { normalizeSearchQuery } = require('../../src/search');
const { registerDashboardReadRoutes } = require('../../src/routes/dashboard-read');

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
