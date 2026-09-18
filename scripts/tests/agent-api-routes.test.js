#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { ipKeyGenerator } = require('express-rate-limit');
const { createApp, listen, close } = require('../../src/app');
const { registerAgentApiRoutes } = require('../../src/routes/agent-api');
const { sha256, safeEqual } = require('../../src/util');

function request(port, { method = 'GET', path = '/', token, query = '' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const req = http.request({ host: '127.0.0.1', port, method, path: path + query, headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
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
    getAgentApiTokenHash: () => tokenHash,
    sha256,
    safeEqual,
    audit: (action, details) => auditCalls.push({ action, details }),
    gatherHealth: async () => ({
      timestamp: '2026-01-01T00:00:00.000Z', overall: 'ok',
      discord: 'ok', sqlite: 'ok', backup: 'ok',
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
