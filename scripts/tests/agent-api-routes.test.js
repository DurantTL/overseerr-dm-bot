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
    { id: 1, status: 1, media: { mediaType: 'movie', title: 'Pending Film' }, requestedBy: { displayName: 'Alice' }, createdAt: '2026-01-01' },
    { id: 2, status: 3, media: { mediaType: 'tv', name: 'Available Show' }, requestedBy: { displayName: 'Bob' }, createdAt: '2026-01-02' },
  ];
  const httpClient = {
    get: async url => {
      assert.ok(!String(url).includes('SECRET'), 'no secret may appear in outbound URLs');
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
    config: { AGENT_API_READ_MAX_PER_MINUTE: 1000 },
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

test('agent API requests map status and support filtering', async () => {
  const { app } = setup();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const all = JSON.parse((await request(port, { path: '/api/v1/requests', token: 'valid-agent-token' })).body);
    assert.strictEqual(all.total, 2);
    assert.strictEqual(all.requests[0].status, 'pending');
    assert.strictEqual(all.requests[0].requestedBy, 'Alice');
    assert.strictEqual(all.requests[1].status, 'available');
    const pending = JSON.parse((await request(port, { path: '/api/v1/requests', token: 'valid-agent-token', query: '?status=pending' })).body);
    assert.strictEqual(pending.count, 1);
    assert.strictEqual(pending.requests[0].id, 1);
    const bad = await request(port, { path: '/api/v1/requests', token: 'valid-agent-token', query: '?status=bogus' });
    assert.strictEqual(bad.statusCode, 400);
  } finally { await close(server); }
});
