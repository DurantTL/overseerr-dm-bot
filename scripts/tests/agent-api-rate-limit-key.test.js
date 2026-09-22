#!/usr/bin/env node
// Agent API budgets are charged to the token, not the source address.
//
// Both limiters mount after `auth`, so the token that would be charged is already known. Keying
// on the IP meant every client behind one egress address — a Director and a dashboard poller
// through the same tunnel — shared a single budget, so one client's burst starved the others,
// and conversely a token could multiply its budget by rotating addresses.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApp, listen, close } = require('../../src/app');
const { registerAgentApiRoutes, agentRateLimitKey } = require('../../src/routes/agent-api');
const { createAgentApiAuth } = require('../../src/routes/agent-api-auth');
const { sha256, safeEqual } = require('../../src/util');

function req(port, { path = '/api/v1/health', token, method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    let payload = null;
    if (body !== null) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// Two live tokens, so "same IP, different tokens" is expressible — every request in this file
// comes from loopback, which is exactly the situation the old IP key conflated.
const ALPHA = 'token-alpha-aaaaaaaaaaaaaaaaaaaaaaaa';
const BRAVO = 'token-bravo-bbbbbbbbbbbbbbbbbbbbbbbb';

function setup({ readLimit = 2, writeLimit = 2, sharedLabel = false } = {}) {
  const hashes = { [sha256(ALPHA)]: sharedLabel ? 'shared' : 'alpha', [sha256(BRAVO)]: sharedLabel ? 'shared' : 'bravo' };
  const app = createApp();
  registerAgentApiRoutes(app, {
    config: { AGENT_API_READ_MAX_PER_MINUTE: readLimit, AGENT_API_WRITE_MAX_PER_MINUTE: writeLimit },
    getAgentApiTokenHashes: () => Object.keys(hashes),
    getAgentApiTokenLabel: hash => hashes[hash] || null,
    touchAgentApiTokenUse: () => {},
    sha256,
    safeEqual,
    audit: () => {},
    gatherHealth: async () => ({ overall: 'ok' }),
    fetchArrQueues: async () => [],
    fetchSeerrRequests: async () => [],
    getPlexToken: async () => 'plex-token',
    getPlexServers: async () => [],
    // Every request here is loopback, so the old key was constant across both tokens.
    httpRateLimitKey: () => 'same-ip',
    automationRegistry: { list: () => [{ id: 'season-pack' }], preview: async () => ({ ok: true, result: [] }), run: async () => ({ ok: true, result: {} }) },
  });
  return app;
}

async function withServer(app, fn) {
  const server = await listen(app, 0);
  try {
    return await fn(server.address().port);
  } finally {
    await close(server);
  }
}

test('agentRateLimitKey charges the token, and falls back to the IP key when unidentified', () => {
  const key = agentRateLimitKey(() => 'ip-key');
  assert.strictEqual(key({ agentTokenId: 'abc123' }), 'token:abc123');
  assert.strictEqual(key({}), 'ip-key', 'no token identity falls back to the address');
  // A missing identity must never read as "unlimited" — it degrades to a constant key.
  assert.strictEqual(agentRateLimitKey(undefined)({}), 'unidentified');
  assert.notStrictEqual(key({ agentTokenId: 'abc123' }), key({ agentTokenId: 'def456' }));
});

test('auth attaches a per-token identity that is unique even when labels collide', () => {
  const alphaHash = sha256(ALPHA);
  const bravoHash = sha256(BRAVO);
  const auth = createAgentApiAuth({
    getAgentApiTokenHashes: () => [alphaHash, bravoHash],
    // Both tokens deliberately carry the same label: the label is not an identity.
    getAgentApiTokenLabel: () => 'shared',
    sha256,
    safeEqual,
    audit: () => {},
  });
  const run = token => {
    const r = { headers: { authorization: `Bearer ${token}` }, socket: {}, path: '/x' };
    auth(r, { status: () => ({ json: () => {} }) }, () => {});
    return r;
  };
  const a = run(ALPHA);
  const b = run(BRAVO);
  assert.strictEqual(a.agentTokenLabel, b.agentTokenLabel, 'the labels are the same');
  assert.notStrictEqual(a.agentTokenId, b.agentTokenId, 'but the identities are not');
  assert.strictEqual(a.agentTokenId, alphaHash);
});

test('one token exhausting its read budget does not touch another from the same address', async () => {
  await withServer(setup({ readLimit: 2 }), async port => {
    assert.strictEqual((await req(port, { token: ALPHA })).statusCode, 200);
    assert.strictEqual((await req(port, { token: ALPHA })).statusCode, 200);
    assert.strictEqual((await req(port, { token: ALPHA })).statusCode, 429, 'alpha spends its own budget');

    // Same loopback address, different token: previously this was already 429.
    assert.strictEqual((await req(port, { token: BRAVO })).statusCode, 200, 'bravo has its own budget');
    assert.strictEqual((await req(port, { token: BRAVO })).statusCode, 200);
    assert.strictEqual((await req(port, { token: BRAVO })).statusCode, 429, 'and spends only that');

    // Alpha stays limited — the budgets are separate, not reset by bravo's traffic.
    assert.strictEqual((await req(port, { token: ALPHA })).statusCode, 429);
  });
});

test('identical labels still get separate budgets, because the identity is the token', async () => {
  await withServer(setup({ readLimit: 1, sharedLabel: true }), async port => {
    assert.strictEqual((await req(port, { token: ALPHA })).statusCode, 200);
    assert.strictEqual((await req(port, { token: ALPHA })).statusCode, 429);
    assert.strictEqual(
      (await req(port, { token: BRAVO })).statusCode,
      200,
      'a shared label must not merge two tokens into one budget',
    );
  });
});

test('read and write budgets stay separate per token', async () => {
  await withServer(setup({ readLimit: 1, writeLimit: 1 }), async port => {
    assert.strictEqual((await req(port, { token: ALPHA })).statusCode, 200, 'read budget spent');
    assert.strictEqual((await req(port, { token: ALPHA })).statusCode, 429);

    // The write budget is untouched by the reads.
    const write = await req(port, {
      token: ALPHA, method: 'POST', path: '/api/v1/automation/sweep',
      body: { sweep: 'season-pack', mode: 'preview' },
    });
    assert.strictEqual(write.statusCode, 200, 'writes have their own budget');
    const second = await req(port, {
      token: ALPHA, method: 'POST', path: '/api/v1/automation/sweep',
      body: { sweep: 'season-pack', mode: 'preview' },
    });
    assert.strictEqual(second.statusCode, 429, 'and it is spent independently');
  });
});

test('an unauthenticated request is rejected before it can spend any budget', async () => {
  await withServer(setup({ readLimit: 1 }), async port => {
    assert.strictEqual((await req(port, { token: 'nope' })).statusCode, 401);
    assert.strictEqual((await req(port, {})).statusCode, 401);
    // The valid token's budget is untouched by those rejections.
    assert.strictEqual((await req(port, { token: ALPHA })).statusCode, 200);
  });
});
