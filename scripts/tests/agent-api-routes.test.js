#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { ipKeyGenerator } = require('express-rate-limit');
const { createApp, listen, close } = require('../../src/app');
const { registerAgentApiRoutes } = require('../../src/routes/agent-api');
const { sha256, safeEqual } = require('../../src/util');

function request(port, { method = 'GET', path = '/', token, query = '', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    let payload = null;
    if (body !== null) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: path + query, headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function setup() {
  const tokenHash = sha256('valid-agent-token');
  const auditCalls = [];
  const queueItems = [{
    source: { label: 'radarr', kind: 'movie', url: 'http://radarr:7878', key: 'SECRET-KEY-MUST-NOT-LEAK' },
    title: 'Example Movie',
    status: 'downloading',
    trackedStatus: 'ok',
    size: 1000,
    sizeleft: 250,
    timeleft: '00:10:00',
    messages: ['a message'],
  }];
  const seerrRequests = [
    // Real Seerr /api/v1/request items join only the Media row (tmdbId/status) — no title.
    { id: 1, status: 1, media: { mediaType: 'movie', tmdbId: 101, status: 2 }, requestedBy: { displayName: 'Alice' }, createdAt: '2026-01-01' },
    { id: 2, status: 5, media: { mediaType: 'tv', tmdbId: 202, status: 5 }, requestedBy: { displayName: 'Bob' }, createdAt: '2026-01-02' },
    { id: 3, status: 2, media: { mediaType: 'movie', tmdbId: 103, status: 5 }, requestedBy: { displayName: 'Cara' }, createdAt: '2026-01-03' },
    { id: 4, status: 3, media: { mediaType: 'movie', tmdbId: 104, status: 2 }, requestedBy: { displayName: 'Dan' }, createdAt: '2026-01-04' },
    { id: 5, status: 4, media: { mediaType: 'tv', tmdbId: 205, status: 2 }, requestedBy: { displayName: 'Erin' }, createdAt: '2026-01-05' },
    { id: 6, status: 2, media: { mediaType: 'movie', tmdbId: 0, status: 3 }, requestedBy: { displayName: 'Frank' }, createdAt: '2026-01-06' },
  ];
  const seerrTitles = {
    'movie:101': 'Pending Film',
    'tv:202': 'Available Show',
    'movie:103': 'Approved And Ready',
    'movie:104': 'Declined Flick',
    'tv:205': 'Failed Series',
  };
  const httpClient = {
    get: async (url, opts = {}) => {
      assert.ok(!String(url).includes('SECRET'), 'no secret may appear in outbound URLs');
      assert.ok(!String(url).includes('seerr-key'), 'Seerr API key must not appear in outbound URLs');
      const seerrDetail = String(url).match(/\/api\/v1\/(movie|tv)\/(\d+)$/);
      if (seerrDetail) {
        assert.strictEqual(opts.headers?.['X-Api-Key'], 'seerr-key', 'Seerr API key travels in a header');
        const title = seerrTitles[`${seerrDetail[1]}:${seerrDetail[2]}`];
        if (!title) throw new Error('not found');
        return { data: seerrDetail[1] === 'movie' ? { title } : { name: title } };
      }
      return {
        data: {
          MediaContainer: {
            Metadata: [
              { title: 'Example Movie', year: 2024, type: 'movie', librarySectionTitle: 'Movies' },
              { title: 'Example Show', year: 2023, type: 'show', librarySectionTitle: 'TV Shows' },
            ],
          },
        },
      };
    },
  };
  const app = createApp();
  registerAgentApiRoutes(app, {
    config: { AGENT_API_READ_MAX_PER_MINUTE: 1000, OVERSEERR_URL: 'http://seerr:5055', OVERSEERR_API_KEY: 'seerr-key' },
    getAgentApiTokenHashes: () => [tokenHash],
    touchAgentApiTokenUse: () => {},
    sha256,
    safeEqual,
    audit: (action, details) => auditCalls.push({ action, details }),
    gatherHealth: async () => ({
      timestamp: '2026-01-01T00:00:00.000Z', overall: 'ok',
      discord: 'ok', sqlite: 'ok', backup: 'ok',
      backupLastSuccessfulAt: '2026-01-01T00:00:00.000Z', backupAgeMs: 7200000,
      plex: 'ok', overseerr: 'down', radarr: 'ok', sonarr: 'skipped',
    }),
    fetchArrQueues: async () => queueItems,
    fetchSeerrRequests: async () => seerrRequests,
    getPlexToken: async () => 'plex-token',
    getPlexServers: async () => [{ name: 'Main', connections: [{ uri: 'http://plex:32400', local: true, relay: false }] }],
    httpRateLimitKey: req => ipKeyGenerator(req.ip || 'unknown'),
    httpClient,
  });
  return { app, auditCalls };
}

test('agent API rejects missing/invalid tokens with 401 JSON and audits', async () => {
  const { app, auditCalls } = setup();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const noAuth = await request(port, { path: '/api/v1/health' });
    assert.strictEqual(noAuth.statusCode, 401);
    assert.deepStrictEqual(JSON.parse(noAuth.body), { error: 'Unauthorized' });
    const badAuth = await request(port, { path: '/api/v1/health', token: 'wrong' });
    assert.strictEqual(badAuth.statusCode, 401);
    assert.ok(auditCalls.some(c => c.action === 'agent_api_auth_failed'), 'auth failures are audited');
    const good = await request(port, { path: '/api/v1/health', token: 'valid-agent-token' });
    assert.strictEqual(good.statusCode, 200);
  } finally { await close(server); }
});

test('agent API health projects bot and downstream status without raw errors', async () => {
  const { app } = setup();
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, { path: '/api/v1/health', token: 'valid-agent-token' });
    assert.deepStrictEqual(JSON.parse(res.body), {
      ok: true,
      timestamp: '2026-01-01T00:00:00.000Z',
      overall: 'ok',
      backupLastSuccessfulAt: '2026-01-01T00:00:00.000Z',
      backupAgeHours: 2,
      bot: { discord: 'ok', sqlite: 'ok', backup: 'ok' },
      downstream: { plex: 'ok', seerr: 'down', radarr: 'ok', sonarr: 'skipped' },
    });
  } finally { await close(server); }
});

test('agent API library search validates input and filters by type', async () => {
  const { app } = setup();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const missing = await request(port, { path: '/api/v1/library/search', token: 'valid-agent-token' });
    assert.strictEqual(missing.statusCode, 400);
    const badType = await request(port, { path: '/api/v1/library/search', token: 'valid-agent-token', query: '?title=xmen&type=book' });
    assert.strictEqual(badType.statusCode, 400);
    const all = await request(port, { path: '/api/v1/library/search', token: 'valid-agent-token', query: '?title=example' });
    const allBody = JSON.parse(all.body);
    assert.strictEqual(allBody.count, 2);
    assert.strictEqual(allBody.results[0].server, 'Main');
    assert.strictEqual(allBody.results[0].library, 'Movies');
    const tv = await request(port, { path: '/api/v1/library/search', token: 'valid-agent-token', query: '?title=example&type=tv' });
    const tvBody = JSON.parse(tv.body);
    assert.strictEqual(tvBody.count, 1);
    assert.strictEqual(tvBody.results[0].type, 'tv');
    assert.strictEqual(tvBody.results[0].title, 'Example Show');
  } finally { await close(server); }
});

test('agent API queue strips instance secrets and computes progress', async () => {
  const { app } = setup();
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, { path: '/api/v1/queue', token: 'valid-agent-token' });
    const body = JSON.parse(res.body);
    assert.strictEqual(body.count, 1);
    const item = body.items[0];
    assert.strictEqual(item.source, 'radarr');
    assert.strictEqual(item.kind, 'movie');
    assert.strictEqual(item.progress, 0.75);
    assert.strictEqual(item.sizeBytes, 1000);
    assert.ok(!JSON.stringify(body).includes('SECRET-KEY-MUST-NOT-LEAK'), 'API keys must not leak');
    assert.ok(!JSON.stringify(body).includes('http://radarr:7878'), 'instance URLs must not leak');
  } finally { await close(server); }
});

test('agent API requests resolve titles and map every Seerr status', async () => {
  const { app } = setup();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const all = JSON.parse((await request(port, { path: '/api/v1/requests', token: 'valid-agent-token' })).body);
    assert.strictEqual(all.total, 6);
    const byId = Object.fromEntries(all.requests.map(r => [r.id, r]));
    // Titles resolve through the Seerr movie/tv detail endpoints (the request list payload
    // carries only tmdbId — no title).
    assert.strictEqual(byId[1].title, 'Pending Film');
    assert.strictEqual(byId[1].mediaType, 'movie');
    assert.strictEqual(byId[2].title, 'Available Show');
    assert.strictEqual(byId[2].mediaType, 'tv');
    assert.strictEqual(byId[1].requestedBy, 'Alice');
    // Status labels follow the bot's own Seerr mapping (src/request-tracking.js).
    assert.strictEqual(byId[1].status, 'pending');
    assert.strictEqual(byId[2].status, 'available'); // request status 5 = completed
    assert.strictEqual(byId[3].status, 'available'); // approved, but the media itself is available
    assert.strictEqual(byId[4].status, 'declined'); // request status 3 — never "available"
    assert.strictEqual(byId[5].status, 'failed');
    assert.strictEqual(byId[6].status, 'approved');
    // An unresolvable title degrades gracefully instead of failing the request.
    assert.strictEqual(byId[6].title, 'Unknown');
  } finally { await close(server); }
});

test('agent API requests filter accepts every mapped status label', async () => {
  const { app } = setup();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    for (const [status, expectedIds] of [
      ['pending', [1]],
      ['approved', [6]],
      ['available', [2, 3]],
      ['declined', [4]],
      ['failed', [5]],
    ]) {
      const body = JSON.parse((await request(port, { path: '/api/v1/requests', token: 'valid-agent-token', query: `?status=${status}` })).body);
      assert.deepStrictEqual(body.requests.map(r => r.id), expectedIds, `filter ${status}`);
    }
    const bad = await request(port, { path: '/api/v1/requests', token: 'valid-agent-token', query: '?status=bogus' });
    assert.strictEqual(bad.statusCode, 400);
  } finally { await close(server); }
});

test('agent API accepts dashboard-minted tokens and the legacy env token side by side', async () => {
  const dbTokenHash = sha256('dashboard-minted-token');
  const legacyHash = sha256('legacy-env-token');
  const touched = [];
  const app = createApp();
  registerAgentApiRoutes(app, {
    config: { AGENT_API_READ_MAX_PER_MINUTE: 1000 },
    getAgentApiTokenHashes: () => [dbTokenHash],
    legacyTokenHash: legacyHash,
    touchAgentApiTokenUse: hash => touched.push(hash),
    sha256,
    safeEqual,
    audit: () => {},
    gatherHealth: async () => ({ timestamp: '2026-01-01T00:00:00.000Z', overall: 'ok' }),
    fetchArrQueues: async () => [],
    fetchSeerrRequests: async () => [],
    getPlexToken: async () => 'plex-token',
    getPlexServers: async () => [],
    httpRateLimitKey: req => ipKeyGenerator(req.ip || 'unknown'),
    httpClient: { get: async () => ({ data: {} }) },
  });
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const viaDashboard = await request(port, { path: '/api/v1/health', token: 'dashboard-minted-token' });
    assert.strictEqual(viaDashboard.statusCode, 200, 'dashboard-minted token is accepted');
    const viaLegacy = await request(port, { path: '/api/v1/health', token: 'legacy-env-token' });
    assert.strictEqual(viaLegacy.statusCode, 200, 'legacy env token still works');
    assert.deepStrictEqual(touched, [dbTokenHash], 'only the dashboard token records last-use');
    const revoked = await request(port, { path: '/api/v1/health', token: 'revoked-token' });
    assert.strictEqual(revoked.statusCode, 401, 'unknown token is rejected');
  } finally { await close(server); }
});

test('agent API with no tokens configured rejects everything', async () => {
  const app = createApp();
  registerAgentApiRoutes(app, {
    config: { AGENT_API_READ_MAX_PER_MINUTE: 1000 },
    getAgentApiTokenHashes: () => [],
    sha256,
    safeEqual,
    audit: () => {},
    gatherHealth: async () => ({ overall: 'ok' }),
    fetchArrQueues: async () => [],
    fetchSeerrRequests: async () => [],
    getPlexToken: async () => 'plex-token',
    getPlexServers: async () => [],
    httpRateLimitKey: req => ipKeyGenerator(req.ip || 'unknown'),
    httpClient: { get: async () => ({ data: {} }) },
  });
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, { path: '/api/v1/health', token: 'anything' });
    assert.strictEqual(res.statusCode, 401, 'no token configured means no access');
  } finally { await close(server); }
});

// ---- v1.1: checks (disks, backup age) + audited fix endpoints ----

const os = require('node:os');
const fs = require('node:fs');
const nodePath = require('node:path');

function setupV11() {
  const tokenHash = sha256('valid-agent-token');
  const auditCalls = [];
  const tmpStaging = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'agent-api-staging-'));
  fs.mkdirSync(nodePath.join(tmpStaging, 'Show.S01'));
  fs.mkdirSync(nodePath.join(tmpStaging, '.incoming'));
  const registry = {
    list: () => [{ id: 'season-pack' }, { id: 'escalations' }],
    preview: async () => ({ ok: true, result: [{ title: 'Some Show', stage: 'search', reason: 'missing episodes' }] }),
    run: async () => ({ ok: true, result: { acted: 3 } }),
  };
  const addedToArr = [];
  let manualImportPreview = [];
  const httpClient = {
    get: async url => {
      if (String(url).includes('/api/v3/manualimport')) return { data: manualImportPreview };
      return { data: {} };
    },
    post: async url => {
      assert.ok(String(url).includes('/api/v3/command'), 'import scan posts a command to the arr');
      return { data: { id: 42 } };
    },
  };
  const app = createApp();
  registerAgentApiRoutes(app, {
    config: {
      AGENT_API_READ_MAX_PER_MINUTE: 1000,
      AGENT_API_WRITE_MAX_PER_MINUTE: 1000,
      AVISTAZ_TAG: 'avistaz',
      PREMIUMIZE_STAGING_PATH: tmpStaging,
      PREMIUMIZE_IMPORT_PATH: '/arr/imports',
      SONARR_URL: 'http://sonarr:8989',
      SONARR_API_KEY: 'sonarr-key',
      RADARR_URL: 'http://radarr:7878',
      RADARR_API_KEY: 'radarr-key',
    },
    getAgentApiTokenHashes: () => [tokenHash],
    getAgentApiTokenLabel: hash => (hash === tokenHash ? 'test-client' : null),
    touchAgentApiTokenUse: () => {},
    sha256,
    safeEqual,
    audit: (action, details) => auditCalls.push({ action, details }),
    gatherHealth: async () => ({ overall: 'ok' }),
    fetchArrQueues: async () => [],
    fetchSeerrRequests: async () => [
      { id: 5, status: 4, media: { mediaType: 'movie', tmdbId: 999, status: 3 }, requestedBy: { displayName: 'Erin' } },
      { id: 6, status: 2, media: { mediaType: 'movie', tmdbId: 1000, status: 3 }, requestedBy: { displayName: 'Frank' } },
    ],
    fetchDiskSpace: async () => [
      { path: '/share/media', displayPath: '/share/media', totalSpace: 8e12, freeSpace: 2e12 },
      { path: '/', totalSpace: 1e11, freeSpace: 5e10 },
    ],
    // Fleet disks: tier-agent telemetry merges with the *arr volumes.
    listTierNodes: () => [{ name: 'california' }, { name: 'europe' }],
    getTierPlan: name => {
      if (name === 'california') {
        return { lastTelemetry: { agentVersion: 'x', at: Date.now(), collectedAt: Date.now(), node: 'california', host: 'california', filesystemTotalBytes: 8e12, filesystemFreeBytes: 1e12, smartHealth: [{ device: '/dev/sda', health: 'failing' }] } };
      }
      if (name === 'europe') {
        return { lastTelemetry: { agentVersion: 'x', at: Date.now(), collectedAt: Date.now() - 40 * 60 * 1000, node: 'europe', host: 'europe', filesystemTotalBytes: 1e12, filesystemFreeBytes: 9e11 } };
      }
      return null;
    },
    getPlexToken: async () => 'plex-token',
    getPlexServers: async () => [],
    httpRateLimitKey: req => ipKeyGenerator(req.ip || 'unknown'),
    httpClient,
    automationRegistry: registry,
    addMediaToArr: async args => {
      addedToArr.push(args);
      return { ok: true, arrId: 11, title: 'Failed Film', detail: 'Added Failed Film to Radarr and started a search.' };
    },
    fetchSeerrTvdbId: async () => null,
    listSonarrSeries: async () => [{ id: 7, title: 'Test Show', tags: [], year: 2024 }],
    getSeriesEpisodes: async () => [
      { id: 1, seasonNumber: 2, episodeNumber: 1, monitored: true, hasFile: false, airDateUtc: '2020-01-01T00:00:00Z' },
      { id: 2, seasonNumber: 2, episodeNumber: 2, monitored: true, hasFile: true, airDateUtc: '2020-01-08T00:00:00Z' },
    ],
    getArrTagId: async () => null,
    triggerSeasonSearch: async (seriesId, season) => ({ id: 99, seriesId, season }),
    runSeasonDirectGrab: async () => { throw new Error('should not route to AvistaZ when untagged'); },
    findAvistazIndexer: async () => null,
    grabDailyAllowance: () => 5,
    grabConfigured: () => false,
    tunable: () => false,
    clearSeasonAlertState: () => {},
    recordSeasonSearch: () => 0,
    getSeasonSearchTimes: () => ({}),
    seasonSearchCooldown: () => ({ cooling: false }),
    getSeasonEpisodeFallback: () => null,
    monitorSeasonSearch: () => {},
    sonarrSeriesAliases: () => [],
    summarizeManualImportPreview: (data, target) => {
      const matched = data.filter(f => (target === 'radarr' ? f.movie : f.series) && !(f.rejections || []).length).length;
      return { totalFiles: data.length, matchedFiles: matched, unmatchedFiles: data.length - matched, folders: [] };
    },
  });
  return { app, auditCalls, registry, addedToArr, tmpStaging, setManualImportPreview: rows => { manualImportPreview = rows; } };
}

function post(port, path, token, body) {
  return request(port, { method: 'POST', path, token, body });
}

test('agent API v1.1: mutation endpoints reject missing tokens with 401', async () => {
  const { app } = setupV11();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    for (const [path, body] of [
      ['/api/v1/automation/sweep', { sweep: 'season-pack', mode: 'preview' }],
      ['/api/v1/requests/5/retry', null],
      ['/api/v1/search/season', { series: 'Test Show', season: 2 }],
      ['/api/v1/import-scan', { target: 'sonarr', folder: 'Show.S01', mode: 'copy' }],
    ]) {
      const res = await request(port, { method: 'POST', path, body });
      assert.strictEqual(res.statusCode, 401, `${path} requires auth`);
    }
  } finally { await close(server); }
});

test('agent API v1.1: disks merge *arr volumes with tier-agent fleet disks', async () => {
  const { app } = setupV11();
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, { path: '/api/v1/disks', token: 'valid-agent-token' });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.count, 4);
    assert.deepStrictEqual(body.disks[0], { name: '/share/media', freeBytes: 2e12, totalBytes: 8e12, percentUsed: 75, source: 'arr', node: 'durant-server', telemetryAgeMs: null, smartHealth: null });
    assert.deepStrictEqual(body.disks[1], { name: '/', freeBytes: 5e10, totalBytes: 1e11, percentUsed: 50, source: 'arr', node: 'durant-server', telemetryAgeMs: null, smartHealth: null });
    const cal = body.disks[2];
    assert.deepStrictEqual({ ...cal, telemetryAgeMs: 'number' }, { name: 'california', freeBytes: 1e12, totalBytes: 8e12, percentUsed: 87.5, source: 'tier-agent', node: 'california', telemetryAgeMs: 'number', smartHealth: [{ device: '/dev/sda', health: 'failing' }] });
    assert.strictEqual(typeof cal.telemetryAgeMs, 'number');
    // Stale telemetry is still included, flagged with its age.
    const europe = body.disks[3];
    assert.strictEqual(europe.node, 'europe');
    assert.ok(europe.telemetryAgeMs > 39 * 60 * 1000, 'stale telemetry carries its age');
    assert.strictEqual(europe.smartHealth, null);
  } finally { await close(server); }
});

test('agent API v1.1: automation sweep validates names and audits with the agent label', async () => {
  const { app, auditCalls, registry } = setupV11();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const unknown = await post(port, '/api/v1/automation/sweep', 'valid-agent-token', { sweep: 'nope', mode: 'preview' });
    assert.strictEqual(unknown.statusCode, 400);
    assert.ok(JSON.parse(unknown.body).error.includes('season-pack'), 'error names valid sweeps');
    const badMode = await post(port, '/api/v1/automation/sweep', 'valid-agent-token', { sweep: 'season-pack', mode: 'yeet' });
    assert.strictEqual(badMode.statusCode, 400);
    const preview = await post(port, '/api/v1/automation/sweep', 'valid-agent-token', { sweep: 'season-pack', mode: 'preview' });
    assert.strictEqual(preview.statusCode, 200);
    const previewBody = JSON.parse(preview.body);
    assert.strictEqual(previewBody.count, 1);
    assert.strictEqual(previewBody.items[0].title, 'Some Show');
    const run = await post(port, '/api/v1/automation/sweep', 'valid-agent-token', { sweep: 'escalations', mode: 'run' });
    assert.strictEqual(run.statusCode, 200);
    assert.strictEqual(JSON.parse(run.body).actions, 3);
    registry.preview = async () => ({ ok: false, busy: true });
    const busy = await post(port, '/api/v1/automation/sweep', 'valid-agent-token', { sweep: 'season-pack', mode: 'preview' });
    assert.strictEqual(busy.statusCode, 409);
    const entries = auditCalls.filter(c => c.action === 'agent_api_automation_sweep');
    assert.ok(entries.length >= 4, 'every sweep attempt is audited');
    assert.ok(entries.every(c => c.details.actor === 'agent:test-client'), 'audit names the token label');
    assert.ok(entries.some(c => c.details.ok === true && c.details.mode === 'run'), 'run is audited as ok');
  } finally { await close(server); }
});

test('agent API v1.1: request retry only repairs failed requests', async () => {
  const { app, auditCalls, addedToArr } = setupV11();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const notFailed = await post(port, '/api/v1/requests/6/retry', 'valid-agent-token', null);
    assert.strictEqual(notFailed.statusCode, 404, 'non-failed requests are not retried');
    const missing = await post(port, '/api/v1/requests/999/retry', 'valid-agent-token', null);
    assert.strictEqual(missing.statusCode, 404, 'unknown ids are 404');
    const badId = await post(port, '/api/v1/requests/abc/retry', 'valid-agent-token', null);
    assert.strictEqual(badId.statusCode, 400);
    const retry = await post(port, '/api/v1/requests/5/retry', 'valid-agent-token', null);
    assert.strictEqual(retry.statusCode, 200);
    const body = JSON.parse(retry.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.arrId, 11);
    assert.strictEqual(addedToArr.length, 1);
    assert.deepStrictEqual(addedToArr[0], { mediaType: 'movie', tmdbId: 999, tvdbId: null, tagLabel: 'avistaz' });
    const entry = auditCalls.find(c => c.action === 'agent_api_request_retry' && c.details.ok === true);
    assert.ok(entry, 'successful retry is audited');
    assert.strictEqual(entry.details.actor, 'agent:test-client');
    assert.strictEqual(entry.details.requestId, 5);
  } finally { await close(server); }
});

test('agent API v1.1: season search validates input and resolves series like the dashboard', async () => {
  const { app, auditCalls } = setupV11();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const badSeason = await post(port, '/api/v1/search/season', 'valid-agent-token', { series: 'Test Show', season: -1 });
    assert.strictEqual(badSeason.statusCode, 400);
    const missingSeries = await post(port, '/api/v1/search/season', 'valid-agent-token', { season: 2 });
    assert.strictEqual(missingSeries.statusCode, 400);
    const unknown = await post(port, '/api/v1/search/season', 'valid-agent-token', { series: 'No Such Show', season: 2 });
    assert.strictEqual(unknown.statusCode, 404);
    const byId = await post(port, '/api/v1/search/season', 'valid-agent-token', { series: '7', season: 2 });
    assert.strictEqual(byId.statusCode, 200);
    const byIdBody = JSON.parse(byId.body);
    assert.strictEqual(byIdBody.ok, true);
    assert.strictEqual(byIdBody.route, 'sonarr', 'untagged series goes through Sonarr');
    assert.strictEqual(byIdBody.commandId, 99);
    const byTitle = await post(port, '/api/v1/search/season', 'valid-agent-token', { series: 'test show', season: 2 });
    assert.strictEqual(byTitle.statusCode, 200, 'title resolution is case-insensitive');
    const nothingMissing = await post(port, '/api/v1/search/season', 'valid-agent-token', { series: 'Test Show', season: 9 });
    assert.strictEqual(nothingMissing.statusCode, 409, 'seasons with no missing episodes are refused');
    const entry = auditCalls.find(c => c.action === 'agent_api_season_search' && c.details.ok === true);
    assert.ok(entry && entry.details.actor === 'agent:test-client', 'successful search is audited with the agent label');
  } finally { await close(server); }
});

test('agent API v1.1: import scan enforces every safety guard from the Discord flow', async () => {
  const { app, auditCalls, tmpStaging, setManualImportPreview } = setupV11();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const token = 'valid-agent-token';
    const traversal = await post(port, '/api/v1/import-scan', token, { target: 'sonarr', folder: '../evil', mode: 'copy' });
    assert.strictEqual(traversal.statusCode, 400, 'path traversal is rejected');
    const dotdot = await post(port, '/api/v1/import-scan', token, { target: 'sonarr', folder: 'a/./b', mode: 'copy' });
    assert.strictEqual(dotdot.statusCode, 400, 'dot segments are rejected');
    const incoming = await post(port, '/api/v1/import-scan', token, { target: 'sonarr', folder: '.incoming', mode: 'copy' });
    assert.strictEqual(incoming.statusCode, 400, '.incoming is never importable');
    const badTarget = await post(port, '/api/v1/import-scan', token, { target: 'plex', folder: 'Show.S01', mode: 'copy' });
    assert.strictEqual(badTarget.statusCode, 400);
    const missing = await post(port, '/api/v1/import-scan', token, { target: 'sonarr', folder: 'Nope.S01', mode: 'copy' });
    assert.strictEqual(missing.statusCode, 404, 'nonexistent folders are 404');
    // Whole-folder scan while .incoming holds a file — the mid-copy guard.
    fs.writeFileSync(nodePath.join(tmpStaging, '.incoming', 'part.bin'), 'x');
    const busy = await post(port, '/api/v1/import-scan', token, { target: 'sonarr', mode: 'copy' });
    assert.strictEqual(busy.statusCode, 409, 'whole-folder scan is refused while a transfer is mid-copy');
    fs.rmSync(nodePath.join(tmpStaging, '.incoming', 'part.bin'));
    // Move mode with a partial match refuses instead of asking an interactive confirm.
    setManualImportPreview([
      { relativePath: 'Show.S01/ep1.mkv', series: { id: 7 }, rejections: [] },
      { relativePath: 'Show.S01/ep2.mkv', rejections: [{ reason: 'Unknown Series' }] },
    ]);
    const partial = await post(port, '/api/v1/import-scan', token, { target: 'sonarr', folder: 'Show.S01', mode: 'move' });
    assert.strictEqual(partial.statusCode, 409, 'partial Move match is refused');
    const partialBody = JSON.parse(partial.body);
    assert.strictEqual(partialBody.unmatchedFiles, 1);
    // Copy mode skips the destructive preview and succeeds.
    const copy = await post(port, '/api/v1/import-scan', token, { target: 'sonarr', folder: 'Show.S01', mode: 'copy' });
    assert.strictEqual(copy.statusCode, 200);
    const copyBody = JSON.parse(copy.body);
    assert.strictEqual(copyBody.commandId, 42);
    assert.strictEqual(copyBody.mode, 'Copy');
    assert.strictEqual(copyBody.path, '/arr/imports/Show.S01', 'the arr sees its own import path');
    const entry = auditCalls.find(c => c.action === 'agent_api_import_scan' && c.details.ok === true);
    assert.ok(entry, 'successful scan is audited');
    assert.strictEqual(entry.details.actor, 'agent:test-client');
    assert.strictEqual(entry.details.commandId, 42);
    assert.ok(auditCalls.some(c => c.action === 'agent_api_import_scan' && c.details.reason === 'unsafe_path'), 'rejections are audited too');
  } finally {
    await close(server);
    fs.rmSync(tmpStaging, { recursive: true, force: true });
  }
});
