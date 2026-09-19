#!/usr/bin/env node
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { rateLimit } = require('express-rate-limit');
const { createApp, listen, close } = require('../../src/app');
const { registerDashboardMutationRoutes } = require('../../src/routes/dashboard-mutations');

function post(port, requestPath, body, headers = {}) {
  const payload = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...headers,
      },
    }, res => {
      let responseBody = '';
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: responseBody }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function fakeAutomationRegistry(overrides = {}) {
  const sweeps = [];
  return {
    ids: () => ['stuck'],
    preview: async name => ({ ok: true, result: [{ name }] }),
    run: async name => { sweeps.push(name); return { ok: true, result: { alerted: 2 } }; },
    _sweeps: sweeps,
    ...overrides,
  };
}

function fixture(overrides = {}) {
  const state = {
    audits: [],
    clearedAlerts: [],
    movieSearches: [],
    priorities: [],
    revoked: [],
    settings: new Map(),
  };
  const registry = fakeAutomationRegistry();
  const app = createApp();
  const deps = {
    CONFIG: { TUNNEL_DOMAIN: 'dashboard.example.test', PORT: 3000 },
    approveGatedRequest: async () => ({ ok: true }),
    audit: (action, metadata) => state.audits.push({ action, metadata }),
    clearMediaPriority: key => state.priorities.push({ operation: 'clear', key }),
    clearSeasonAlertState: (seriesId, seasonNumber) => {
      state.clearedAlerts.push({ seriesId, seasonNumber });
      return true;
    },
    dashboardActionError: error => error.message,
    dashboardActor: () => ({ actorKind: 'dashboard' }),
    dashboardAuth: (req, res, next) => req.get('x-admin-token') === 'secret'
      ? next()
      : res.status(401).json({ ok: false, error: 'Unauthorized' }),
    dashboardGateActor: () => ({ kind: 'dashboard', id: 'test' }),
    dashboardGateResponse: result => result,
    db: {
      prepare: () => ({ run: () => ({ changes: 1 }) }),
      transaction: fn => fn,
    },
    denyGatedRequest: async () => ({ ok: true }),
    discordReadyGuard: (_req, _res, next) => next(),
    findAvistazIndexer: async () => null,
    getArrTagId: async () => null,
    getAutomationRegistry: () => registry,
    getEscalationById: id => id === 7
      ? { id, state: 'watching', media_id: 'tvdb:7', title: 'Example' }
      : null,
    getSeasonEpisodeFallback: () => null,
    getSeasonSearchTimes: () => ({}),
    getSeriesEpisodes: async () => [],
    getTierNode: () => null,
    grabConfigured: () => false,
    grabDailyAllowance: () => ({ exhausted: false, remaining: 4 }),
    httpRateLimitKey: () => 'dashboard-mutation-test',
    listMediaPriority: () => [],
    listSonarrSeries: async () => [],
    monitorSeasonSearch: () => {},
    nextRank: () => 1,
    pad: value => String(value).padStart(2, '0'),
    prepareTierNodeInstall: value => value,
    rateLimit,
    recordSeasonSearch: () => 0,
    replaceTierNodeFolders: () => {},
    revokeAllDownloadLinks: discordId => state.revoked.push(discordId === undefined ? null : discordId),
    runEscalation: async () => ({ ok: true, detail: 'Escalated.' }),
    runSeasonDirectGrab: async () => ({ status: 'no_results' }),
    runtimeSettings: {
      setOverride: (key, raw) => {
        if (key === 'bad') return { ok: false, error: 'Invalid setting.' };
        state.settings.set(key, raw);
        return { ok: true, value: raw };
      },
      clearOverride: key => {
        state.settings.delete(key);
        return { ok: true };
      },
    },
    seasonSearchCooldown: () => ({ cooling: false }),
    setMediaPriority: value => state.priorities.push({ operation: 'set', ...value }),
    setTierAgentToken: () => 'token',
    settingsStore: {},
    sonarrSeriesAliases: () => [],
    tierInstallCommand: () => 'install',
    triggerEpisodeSearch: async () => {},
    triggerMovieSearch: async (movieId, options) => state.movieSearches.push({ movieId, options }),
    triggerSeasonSearch: async () => ({ id: 1 }),
    tunable: () => false,
    upsertTierNode: value => ({ created: true, node: value }),
    usesDirectGrabEscalation: () => false,
    ...overrides,
  };
  registerDashboardMutationRoutes(app, deps);
  return { app, state, registry };
}

test('dashboard mutations authenticate before any destructive handler', async () => {
  const { app, state } = fixture();
  const server = await listen(app, 0);
  try {
    const response = await post(server.address().port, '/admin/action/revoke-all', {});
    assert.strictEqual(response.statusCode, 401);
    assert.deepStrictEqual(state.revoked, []);
  } finally {
    await close(server);
  }
});

test('gate, tier, search, and priority routes preserve validation and audit contracts', async () => {
  const { app, state } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const headers = { 'x-admin-token': 'secret' };

    assert.strictEqual((await post(port, '/admin/action/gate', { operation: 'approve', nonce: 'bad' }, headers)).statusCode, 400);
    assert.strictEqual((await post(port, '/admin/action/tier-node', { name: 'bad name' }, headers)).statusCode, 400);
    assert.strictEqual((await post(port, '/admin/action/tier-token', { node: 'ph' }, headers)).statusCode, 400);
    assert.strictEqual((await post(port, '/admin/action/search', { kind: 'wrong' }, headers)).statusCode, 400);
    assert.strictEqual((await post(port, '/admin/action/priority', { operation: 'pin', key: 'bad' }, headers)).statusCode, 400);

    const tier = await post(port, '/admin/action/tier-node', {
      name: 'ph', usableGb: 100, access: 'restricted', demandSource: 'tautulli', full: false,
    }, headers);
    assert.strictEqual(tier.statusCode, 200);
    assert.strictEqual(JSON.parse(tier.body).message, 'Node registered.');

    const rearm = await post(port, '/admin/action/search', {
      kind: 'rearm-alert', seriesId: 12, seasonNumber: 1,
    }, headers);
    assert.strictEqual(rearm.statusCode, 200);
    assert.deepStrictEqual(state.clearedAlerts, [{ seriesId: 12, seasonNumber: 1 }]);

    assert.strictEqual((await post(port, '/admin/action/search', { kind: 'movie' }, headers)).statusCode, 400);
    assert.strictEqual((await post(port, '/admin/action/search', { kind: 'movie', movieId: 0 }, headers)).statusCode, 400);
    const movieSearch = await post(port, '/admin/action/search', { kind: 'movie', movieId: 42 }, headers);
    assert.strictEqual(movieSearch.statusCode, 200);
    assert.deepStrictEqual(state.movieSearches, [{ movieId: 42, options: { is4k: false } }]);
    assert.ok(state.audits.some(row => row.action === 'dashboard_search' && row.metadata.ok && row.metadata.kind === 'movie'));
    const movieSearch4k = await post(port, '/admin/action/search', { kind: 'movie', movieId: 7, is4k: true }, headers);
    assert.strictEqual(movieSearch4k.statusCode, 200);
    assert.deepStrictEqual(state.movieSearches[1], { movieId: 7, options: { is4k: true } });

    const pin = await post(port, '/admin/action/priority', {
      operation: 'pin', key: 'tvdb:12', mediaType: 'tv', title: 'Example',
    }, headers);
    assert.strictEqual(pin.statusCode, 200);
    assert.strictEqual(state.priorities[0].key, 'tvdb:12');
    assert.ok(state.audits.some(row => row.action === 'dashboard_priority' && row.metadata.ok));
  } finally {
    await close(server);
  }
});

test('preview and run-now routes preserve success, busy, and unknown responses', async () => {
  const { app, registry } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const headers = { 'x-admin-token': 'secret' };

    const preview = await post(port, '/admin/action/sweep-preview', { name: 'stuck' }, headers);
    assert.strictEqual(preview.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(preview.body), { ok: true, items: [{ name: 'stuck' }] });

    assert.strictEqual((await post(port, '/admin/action/sweep', { name: 'unknown' }, headers)).statusCode, 400);
    const run = await post(port, '/admin/action/sweep', { name: 'stuck' }, headers);
    assert.strictEqual(run.statusCode, 200);
    assert.strictEqual(JSON.parse(run.body).result.alerted, 2);
    assert.deepStrictEqual(registry._sweeps, ['stuck']);
  } finally {
    await close(server);
  }

  const busyRegistry = fakeAutomationRegistry({ run: async () => ({ ok: false, busy: true }) });
  const busyFixture = fixture({ getAutomationRegistry: () => busyRegistry });
  const busyServer = await listen(busyFixture.app, 0);
  try {
    const busy = await post(busyServer.address().port, '/admin/action/sweep', { name: 'stuck' }, { 'x-admin-token': 'secret' });
    assert.strictEqual(busy.statusCode, 409);
    assert.match(JSON.parse(busy.body).error, /already running/);
  } finally {
    await close(busyServer);
  }
});

test('escalation requires confirmation and reports successful execution', async () => {
  const { app } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const headers = { 'x-admin-token': 'secret' };
    assert.strictEqual((await post(port, '/admin/action/escalate', { id: 7 }, headers)).statusCode, 400);
    assert.strictEqual((await post(port, '/admin/action/escalate', { id: 99, confirmed: true }, headers)).statusCode, 409);

    const response = await post(port, '/admin/action/escalate', { id: 7, confirmed: true }, headers);
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { ok: true, message: 'Escalated.', remaining: 4 });
  } finally {
    await close(server);
  }
});

test('settings and revocation mutations preserve their response bodies', async () => {
  const { app, state } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const headers = { 'x-admin-token': 'secret' };

    const settings = await post(port, '/admin/settings', { values: { GOOD: '4', bad: 'x' } }, headers);
    assert.strictEqual(settings.statusCode, 400);
    assert.deepStrictEqual(JSON.parse(settings.body), {
      ok: false,
      applied: [{ key: 'GOOD', value: '4' }],
      errors: ['Invalid setting.'],
    });
    const reset = await post(port, '/admin/settings/reset', { keys: ['GOOD'] }, headers);
    assert.strictEqual(reset.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(reset.body), { ok: true, cleared: ['GOOD'] });

    assert.strictEqual((await post(port, '/admin/action/revoke-all', {}, headers)).statusCode, 200);
    const user = await post(port, '/admin/action/revoke-user/123', {}, headers);
    assert.deepStrictEqual(JSON.parse(user.body), { ok: true, discordId: '123' });
    assert.deepStrictEqual(state.revoked, [null, '123']);
  } finally {
    await close(server);
  }
});

test('#189: a successful mutation invalidates the dashboard cache; a failed one and a preview do not', async () => {
  let invalidated = 0;
  const { app } = fixture({ dashboardCache: { invalidate: () => { invalidated += 1; } } });
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const headers = { 'x-admin-token': 'secret' };

    await post(port, '/admin/action/revoke-all', {}, headers);
    assert.strictEqual(invalidated, 1, 'a successful mutation invalidates the cache');

    await post(port, '/admin/action/tier-node', { name: 'bad name' }, headers); // 400
    assert.strictEqual(invalidated, 1, 'a failed mutation leaves the cache alone');

    await post(port, '/admin/action/sweep-preview', { name: 'stuck' }, headers);
    assert.strictEqual(invalidated, 1, 'a preview changes nothing, so it must not invalidate the cache');
  } finally {
    await close(server);
  }
});

test('agent API token routes require auth, validate input, and confirm revokes', async () => {
  const tokens = [];
  const { app, state } = fixture({
    createAgentApiToken: label => {
      const record = { id: tokens.length + 1, label, token: `raw-token-${tokens.length + 1}` };
      tokens.push(record);
      return record;
    },
    revokeAgentApiToken: id => {
      const index = tokens.findIndex(t => t.id === id);
      if (index === -1) return false;
      tokens.splice(index, 1);
      return true;
    },
  });
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const headers = { 'x-admin-token': 'secret' };

    assert.strictEqual((await post(port, '/admin/action/agent-api-token', { label: 'Edith' })).statusCode, 401);
    assert.strictEqual((await post(port, '/admin/action/agent-api-token', { label: '' }, headers)).statusCode, 400);
    assert.strictEqual((await post(port, '/admin/action/agent-api-token', { label: 'x'.repeat(65) }, headers)).statusCode, 400);

    const created = await post(port, '/admin/action/agent-api-token', { label: 'Edith' }, headers);
    assert.strictEqual(created.statusCode, 200);
    assert.strictEqual(created.headers['cache-control'], 'no-store');
    const body = JSON.parse(created.body);
    assert.deepStrictEqual({ ...body, token: 'redacted' }, { ok: true, id: 1, label: 'Edith', token: 'redacted' });
    assert.ok(body.token.length >= 10, 'the raw token is returned once at creation');
    const createdAudit = state.audits.find(a => a.action === 'dashboard_agent_api_token_created');
    assert.ok(createdAudit, 'creation is audited');
    assert.ok(!JSON.stringify(createdAudit.metadata).includes(body.token), 'audit metadata never contains the token');

    const unconfirmed = await post(port, '/admin/action/agent-api-token-revoke', { id: 1 }, headers);
    assert.strictEqual(unconfirmed.statusCode, 400, 'revoke requires confirmed: true');

    const revoked = await post(port, '/admin/action/agent-api-token-revoke', { id: 1, confirmed: true }, headers);
    assert.strictEqual(revoked.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(revoked.body), { ok: true });
    assert.ok(state.audits.some(a => a.action === 'dashboard_agent_api_token_revoked'), 'revocation is audited');

    const again = await post(port, '/admin/action/agent-api-token-revoke', { id: 1, confirmed: true }, headers);
    assert.strictEqual(again.statusCode, 404, 'revoking an already-revoked id 404s');
    assert.strictEqual((await post(port, '/admin/action/agent-api-token-revoke', { id: 99, confirmed: true }, headers)).statusCode, 404);
    assert.strictEqual((await post(port, '/admin/action/agent-api-token-revoke', { id: 99, confirmed: true })).statusCode, 401);
  } finally { await close(server); }
});
