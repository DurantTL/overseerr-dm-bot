#!/usr/bin/env node
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const vm = require('node:vm');
const { rateLimit } = require('express-rate-limit');
const { createApp, listen, close } = require('../../src/app');
const { escapeHtml, sqliteUtcMs, fmtAgo, renderItemList, renderDirectorPanel, renderPasskeySetupBanner } = require('../../src/dashboard-render');
const { normalizeSearchQuery } = require('../../src/search');
const { registerDashboardReadRoutes, extractLiveFragment } = require('../../src/routes/dashboard-read');
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
    listTierNodeMembers: () => [],
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
    runEdgeDiagnostics: async options => {
      calls.doctor.push(options);
      return [{ name: 'edge', ok: true }, { name: 'Philippines cache read', status: 'fail', detail: 'ssh: handshake failed for caleb@ph.example.net via sftp://ph.example.net:22/mnt\nsecond line with more' }];
    },
    checkPublicOriginReadiness: async () => [{ name: 'Public HTTPS origin', status: 'ok', detail: 'https://admin.example/live answered HTTP 200' }],
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

    for (const path of ['/admin/doctor', '/admin/doctor/edge']) {
      assert.strictEqual((await request(port, path)).statusCode, 401, `${path} needs auth`);
    }
    assert.deepStrictEqual(calls.doctor, [], 'nothing runs before auth');

    const doctor = await request(port, '/admin/doctor', headers);
    assert.strictEqual(doctor.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(doctor.body), { checks: [{ name: 'Public HTTPS origin', status: 'ok', detail: 'https://admin.example/live answered HTTP 200' }] },
      'origin, TLS, proxy and liveness checks only');
    assert.deepStrictEqual(calls.doctor, [], 'the edge checks no longer run for /admin/doctor');

    const edge = await request(port, '/admin/doctor/edge', headers);
    assert.strictEqual(edge.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(edge.body), {
      checks: [
        { name: 'edge', ok: true },
        { name: 'Philippines cache read', status: 'fail', detail: 'ssh: handshake failed for <user@host> via <url>' },
      ],
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

test('tier planning and node management cards render with enable/disable, folders, and members', async () => {
  const { app } = fixture({
    renderItemList,
    listTierNodes: () => [
      { name: 'california', enabled: 1, full: 0, access: 'restricted', usable_bytes: 42 },
      { name: 'durant-server', enabled: 0, full: 1, access: 'open', usable_bytes: 43 },
    ],
    listTierNodeFolders: node => (node === 'california' ? [{ folderId: 'movies', folderRoot: '/m' }] : []),
    listTierNodeMembers: node => (node === 'california' ? ['123'] : []),
    getGuildMembers: async () => [{ user: { id: '123', username: 'alex' }, displayName: 'Alex' }],
  });
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const headers = { 'x-admin-token': 'secret' };
    const dashboard = await request(port, '/admin', headers);
    assert.strictEqual(dashboard.statusCode, 200);
    // Tier planning card.
    assert.match(dashboard.body, /Tier Planning/);
    assert.match(dashboard.body, /tier-plan-preview/);
    // Node management card: folders + restricted members with remove buttons.
    assert.match(dashboard.body, /Tier Node Management/);
    assert.match(dashboard.body, /tier-node\/folder-remove/);
    assert.match(dashboard.body, /tier-member\/remove/);
    assert.match(dashboard.body, /Alex/);
    // Enable/disable actions on the node list.
    assert.match(dashboard.body, /tier-node\/disable/);
    assert.match(dashboard.body, /tier-node\/enable/);
    // The new inline scripts parse.
    const inlineScripts = dashboard.body.split('<script>').slice(1)
      .map(block => block.split('</script>', 1)[0])
      .filter(Boolean);
    for (const script of inlineScripts) {
      assert.doesNotThrow(() => new vm.Script(script, { filename: 'dashboard-inline.js' }));
    }
  } finally {
    await close(server);
  }
});

test('#189: repeated /admin renders within the TTL do not refetch every integration', async () => {  const { app, calls } = fixture();
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

test('overview shows the passkey setup banner only for nudged sessions without passkeys', async () => {
  const headers = { 'x-admin-token': 'secret' };
  const nudged = { 'x-admin-token': 'secret', cookie: 'dm_setup_nudge=1' };

  // Nudged session, no passkeys: banner renders.
  {
    const { app } = fixture({ renderPasskeySetupBanner: () => 'SETUP-BANNER-MARKER' });
    const server = await listen(app, 0);
    try {
      const res = await request(server.address().port, '/admin', nudged);
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.body.includes('SETUP-BANNER-MARKER'), 'banner shows for nudged session without passkeys');
    } finally { await close(server); }
  }

  // Same session shape, but a passkey already exists: no banner.
  {
    const { app } = fixture({
      listPasskeys: () => [{ credential_id: 'abc' }],
      renderPasskeySetupBanner: () => 'SETUP-BANNER-MARKER',
    });
    const server = await listen(app, 0);
    try {
      const res = await request(server.address().port, '/admin', nudged);
      assert.strictEqual(res.statusCode, 200);
      assert.ok(!res.body.includes('SETUP-BANNER-MARKER'), 'no banner once a passkey exists');
    } finally { await close(server); }
  }

  // No nudge cookie at all: no banner, even with zero passkeys.
  {
    const { app } = fixture({ renderPasskeySetupBanner: () => 'SETUP-BANNER-MARKER' });
    const server = await listen(app, 0);
    try {
      const res = await request(server.address().port, '/admin', headers);
      assert.strictEqual(res.statusCode, 200);
      assert.ok(!res.body.includes('SETUP-BANNER-MARKER'), 'no banner without the nudge cookie');
    } finally { await close(server); }
  }
});

test('overview renders the agent API token card', async () => {
  const headers = { 'x-admin-token': 'secret' };
  const { app } = fixture({
    listAgentApiTokens: () => [{ id: 7, label: 'Edith', createdAt: 1700000000000, lastUsedAt: null, revoked: false }],
    renderAgentApiTokens: tokens => `AGENT-TOKENS:${tokens.map(t => t.label).join(',')}`,
  });
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, '/admin', headers);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes('AGENT-TOKENS:Edith'), 'token card renders with the token list');
  } finally { await close(server); }
});

test('Home renders the director storage cards through the real render wiring', async () => {
  // Regression: Sep 19, 2026 — index.js never passed renderDirectorPanel into
  // registerDashboardReadRoutes, so the route's () => '' default silently rendered
  // an empty Director panel on the live server. Render with the real functions
  // (the same ones index.js now passes) and assert the prototype markers land.
  const headers = { 'x-admin-token': 'secret' };
  const { app } = fixture({ renderDirectorPanel, renderPasskeySetupBanner });
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, '/admin', headers);
    assert.strictEqual(res.statusCode, 200);
    // Home is the Services board now; the director render contributes storage and fleet sync
    // under it, without its own page heading (the board already has one).
    assert.match(res.body, /data-panel="home"/);
    assert.match(res.body, /<h2>Disk space<\/h2>/);
    assert.match(res.body, /<h2>Fleet sync<\/h2>/);
    assert.doesNotMatch(res.body, /The whole stack, one glance\./);
  } finally { await close(server); }
});

test('director tab shows an em dash, not "0", for disk free when no disks report', async () => {
  // Regression: Sep 19, 2026 — the live Director tab showed "0 MB DISK FREE"
  // because the *arr diskspace call yielded [] (not null) and the route summed
  // the empty list. An empty/unknown disk list must render "—", never zero.
  const headers = { 'x-admin-token': 'secret' };
  const { app } = fixture({
    renderDirectorPanel,
    renderPasskeySetupBanner,
    // An *arr is configured but its diskspace call yields nothing: disks is []
    // (not null) on this path.
    arrSources: () => [{ label: 'radarr', url: 'http://radarr.test', key: 'k' }],
  });
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, '/admin', headers);
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body, /<strong>—<\/strong><span>Disk free/);
    assert.ok(!/<strong>0<\/strong><span>Disk free/.test(res.body), 'disk-free metric must not render zero when disks are unknown');
  } finally { await close(server); }
});

// ---- Item 9: recently-added strip and its poster proxy ----
const RECENT = [
  { ratingKey: '501', type: 'movie', title: 'The Wild Robot', detail: '2024', library: 'Movies', addedAt: Date.now() - 2 * 3600000, thumb: '/library/metadata/501/thumb/1730000000' },
  { ratingKey: '777', type: 'episode', title: 'Slow Horses', detail: 'S5E3', library: 'TV Shows', addedAt: Date.now() - 5 * 3600000, thumb: null },
];

test('overview renders the recently-added strip from Tautulli, posters through the proxy', async () => {
  const { app } = fixture({ tautulliConfigured: () => true, fetchRecentlyAdded: async () => RECENT });
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, '/admin', { 'x-admin-token': 'secret' });
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body, /Recently added/);
    assert.match(res.body, /src="\/admin\/api\/poster\/501"/);
    assert.ok(!res.body.includes('/admin/api/poster/777'), 'no img for an item without a poster path');
    assert.match(res.body, /Slow Horses S5E3/);
  } finally { await close(server); }
});

test('poster proxy: admin-only, serves only items in the current strip, never echoes the upstream URL', async () => {
  const asked = [];
  const { app } = fixture({
    tautulliConfigured: () => true,
    fetchRecentlyAdded: async () => RECENT,
    fetchPoster: async thumb => { asked.push(thumb); return { type: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff]) }; },
  });
  const server = await listen(app, 0);
  const port = server.address().port;
  const admin = { 'x-admin-token': 'secret' };
  try {
    assert.strictEqual((await request(port, '/admin/api/poster/501')).statusCode, 401);
    assert.strictEqual((await request(port, '/admin/api/poster/abc', admin)).statusCode, 404);
    assert.strictEqual((await request(port, '/admin/api/poster/999', admin)).statusCode, 404, 'not in the strip');
    assert.strictEqual((await request(port, '/admin/api/poster/777', admin)).statusCode, 404, 'no poster path');
    const ok = await request(port, '/admin/api/poster/501', admin);
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(ok.headers['content-type'], 'image/jpeg');
    assert.match(ok.headers['cache-control'], /private, max-age=86400/);
    assert.deepStrictEqual(asked, ['/library/metadata/501/thumb/1730000000']);
  } finally { await close(server); }

  const failing = fixture({
    tautulliConfigured: () => true,
    fetchRecentlyAdded: async () => RECENT,
    fetchPoster: async () => { throw new Error('upstream http://tautulli:8181/api/v2?apikey=SECRET failed'); },
  });
  const server2 = await listen(failing.app, 0);
  try {
    const res = await request(server2.address().port, '/admin/api/poster/501', admin);
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.body, '', 'upstream error text is never sent to the browser');
  } finally { await close(server2); }
});

test('director tab: Fleet sync card per node and folder, stale node marked, node secrets never rendered', async () => {
  const now = Date.now();
  const plans = {
    ph: { folderCompletion: { at: now - 6 * 60000, folders: [
      { folderId: 'movies-ph', completion: 78.4, globalBytes: 2e12, needBytes: 412e9, needItems: 31 },
      { folderId: 'family-ph', completion: 100, globalBytes: 5e11, needBytes: 0, needItems: 0 },
    ] } },
    california: { folderCompletion: { at: now - 6 * 86400000, folders: [{ folderId: 'movies-ca', completion: 52, needBytes: 880e9, needItems: 0 }] } },
  };
  const { app } = fixture({
    renderDirectorPanel,
    renderPasskeySetupBanner,
    listTierNodes: () => [
      { name: 'ph', enabled: 1, tautulli_api_key: 'TAUTULLI-SECRET', plex_token: 'PLEX-SECRET' },
      { name: 'california', enabled: 1 },
      { name: 'southcentral', enabled: 1 },
      { name: 'retired', enabled: 0 },
    ],
    getTierPlan: name => plans[name] || null,
    listTierNodeFolders: name => (name === 'ph'
      ? [{ folderId: 'movies-ph', folderRoot: '/mnt/media/Movies' }, { folderId: 'family-ph', folderRoot: '/mnt/media/Family Films/' }]
      : []),
  });
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, '/admin', { 'x-admin-token': 'secret' });
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body, /<h2>Fleet sync<\/h2>/);
    assert.match(res.body, /<b>ph<\/b><span>reported 6m ago<\/span>/);
    assert.match(res.body, /Movies<\/div><div class="d-node-meta">31 items left/);
    assert.match(res.body, /aria-valuenow="78"/);
    assert.match(res.body, />Family Films<\/div>/, 'folder label comes from the folder root');
    assert.match(res.body, /d-fleet-node stale/);
    assert.match(res.body, /No report in 6d\. These are the last numbers it sent\./);
    assert.match(res.body, />movies-ca<\/div>/, 'unknown folder ids fall back to the id');
    assert.match(res.body, /<b>southcentral<\/b><span>no folder report yet<\/span>/);
    assert.ok(!res.body.includes('<b>retired</b>'), 'disabled nodes are left out');
    assert.ok(!/TAUTULLI-SECRET|PLEX-SECRET/.test(res.body), 'node credentials never reach the page');
  } finally { await close(server); }
});

test('extractLiveFragment returns only the named live region, or null when it is missing', () => {
  const page = '<main><!--live:a--><p>A</p><!--/live:a--><!--live:ab--><p>AB</p><!--/live:ab--></main>';
  assert.strictEqual(extractLiveFragment(page, 'a'), '<p>A</p>');
  assert.strictEqual(extractLiveFragment(page, 'ab'), '<p>AB</p>');
  assert.strictEqual(extractLiveFragment(page, 'b'), null);
  assert.strictEqual(extractLiveFragment('<!--live:x--><p>open</p>', 'x'), null);
});
