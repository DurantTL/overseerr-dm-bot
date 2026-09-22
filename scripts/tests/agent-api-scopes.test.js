#!/usr/bin/env node
// Per-token scopes on the agent API: read / write / discord, plus an explicit allowlist of the
// Discord actions a token may drive. Until this existed every token was all-or-nothing admin,
// which is not something to point an autonomous client at.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApp, listen, close } = require('../../src/app');
const { registerAgentApiRoutes } = require('../../src/routes/agent-api');
const { sha256, safeEqual } = require('../../src/util');

function call(port, { method = 'GET', path = '/api/v1/health', token, body = null } = {}) {
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

// One token per grant shape, so a request's outcome names the grant that produced it.
const TOKENS = {
  observer: { raw: 'tok-observer-000000000000000000000000', scopes: ['read'], discordActions: [] },
  repairer: { raw: 'tok-repairer-000000000000000000000000', scopes: ['read', 'write'], discordActions: [] },
  director: { raw: 'tok-director-000000000000000000000000', scopes: ['read', 'write', 'discord'], discordActions: ['queue', 'season', 'adopt_do'] },
  grandfathered: { raw: 'tok-old-00000000000000000000000000000', scopes: ['read', 'write', 'discord'], discordActions: ['*'] },
};
const LEGACY_ENV = 'tok-legacy-env-0000000000000000000000';

function setup() {
  const byHash = {};
  for (const [name, t] of Object.entries(TOKENS)) byHash[sha256(t.raw)] = { name, ...t };
  const audits = [];
  const dispatched = { commands: [], buttons: [] };
  const app = createApp();
  registerAgentApiRoutes(app, {
    config: { AGENT_API_READ_MAX_PER_MINUTE: 1000, AGENT_API_WRITE_MAX_PER_MINUTE: 1000 },
    getAgentApiTokenHashes: () => Object.keys(byHash),
    getAgentApiTokenLabel: hash => byHash[hash]?.name || null,
    getAgentApiTokenGrants: hash => (byHash[hash] ? { scopes: byHash[hash].scopes, discordActions: byHash[hash].discordActions } : null),
    legacyTokenHash: sha256(LEGACY_ENV),
    touchAgentApiTokenUse: () => {},
    sha256,
    safeEqual,
    audit: (action, details) => audits.push({ action, details }),
    gatherHealth: async () => ({ overall: 'ok' }),
    fetchArrQueues: async () => [],
    fetchSeerrRequests: async () => [],
    getPlexToken: async () => 'plex-token',
    getPlexServers: async () => [],
    httpRateLimitKey: () => 'test',
    automationRegistry: {
      list: () => [{ id: 'season-pack' }],
      preview: async () => ({ ok: true, result: [] }),
      run: async () => ({ ok: true, result: {} }),
    },
    discordExec: async ({ command }) => { dispatched.commands.push(command); return { ok: true, replies: [] }; },
    discordInteract: async ({ customId }) => { dispatched.buttons.push(customId); return { ok: true, replies: [] }; },
    getDiscordCommandDefs: () => [{ name: 'queue', description: 'q', options: [] }],
  });
  return { app, audits, dispatched };
}

async function withServer(fixture, fn) {
  const server = await listen(fixture.app, 0);
  try {
    return await fn(server.address().port);
  } finally {
    await close(server);
  }
}

const sweep = { sweep: 'season-pack', mode: 'preview' };

test('a read-only token reads but cannot mutate or drive Discord', async () => {
  const fixture = setup();
  await withServer(fixture, async port => {
    const t = TOKENS.observer.raw;
    assert.strictEqual((await call(port, { token: t, path: '/api/v1/health' })).statusCode, 200);
    assert.strictEqual((await call(port, { token: t, path: '/api/v1/queue' })).statusCode, 200);

    const write = await call(port, { token: t, method: 'POST', path: '/api/v1/automation/sweep', body: sweep });
    assert.strictEqual(write.statusCode, 403, 'no write scope');
    const body = JSON.parse(write.body);
    assert.strictEqual(body.needed, 'write');
    assert.match(body.error, /does not hold the "write" scope/);
    assert.match(body.error, /it has: read/, 'the refusal says what the token does hold');

    const exec = await call(port, { token: t, method: 'POST', path: '/api/v1/discord/exec', body: { command: 'queue' } });
    assert.strictEqual(exec.statusCode, 403, 'no discord scope');
    assert.strictEqual(JSON.parse(exec.body).needed, 'discord');
    assert.deepStrictEqual(fixture.dispatched.commands, [], 'nothing was dispatched');

    const denied = fixture.audits.filter(a => a.action === 'agent_api_scope_denied');
    assert.strictEqual(denied.length, 2, 'both refusals are audited');
    assert.strictEqual(denied[0].details.actor, 'agent:observer');
    assert.strictEqual(denied[0].details.needed, 'write');
    assert.strictEqual(denied[0].details.held, 'read');
  });
});

test('a write token repairs but still cannot reach the Discord bridge', async () => {
  const fixture = setup();
  await withServer(fixture, async port => {
    const t = TOKENS.repairer.raw;
    assert.strictEqual((await call(port, { token: t, method: 'POST', path: '/api/v1/automation/sweep', body: sweep })).statusCode, 200);
    assert.strictEqual((await call(port, { token: t, path: '/api/v1/health' })).statusCode, 200);
    assert.strictEqual(
      (await call(port, { token: t, method: 'POST', path: '/api/v1/discord/exec', body: { command: 'queue' } })).statusCode,
      403,
      'write does not imply discord — the bridge reaches every command, which is the wider power',
    );
    assert.strictEqual(
      (await call(port, { token: t, method: 'POST', path: '/api/v1/discord/interact', body: { custom_id: 'adopt_do:abc' } })).statusCode,
      403,
    );
  });
});

test('the discord allowlist is enforced per command, before anything dispatches', async () => {
  const fixture = setup();
  await withServer(fixture, async port => {
    const t = TOKENS.director.raw;
    const allowed = await call(port, { token: t, method: 'POST', path: '/api/v1/discord/exec', body: { command: 'queue' } });
    assert.strictEqual(allowed.statusCode, 200);
    assert.deepStrictEqual(fixture.dispatched.commands, ['queue']);

    // /downsize deletes a library file. This token was never granted it.
    const refused = await call(port, { token: t, method: 'POST', path: '/api/v1/discord/exec', body: { command: 'downsize', options: { movie: 'Dune' } } });
    assert.strictEqual(refused.statusCode, 403);
    assert.match(JSON.parse(refused.body).error, /not allowed the Discord action "downsize"/);
    assert.deepStrictEqual(fixture.dispatched.commands, ['queue'], 'the handler never ran');

    // Case and surrounding whitespace do not get a token past its allowlist.
    for (const command of ['DOWNSIZE', ' downsize ', 'Downsize']) {
      assert.strictEqual(
        (await call(port, { token: t, method: 'POST', path: '/api/v1/discord/exec', body: { command } })).statusCode,
        403,
        `${JSON.stringify(command)} is still refused`,
      );
    }
    assert.deepStrictEqual(fixture.dispatched.commands, ['queue']);
  });
});

test('button presses are gated on the action prefix, not left open', async () => {
  const fixture = setup();
  await withServer(fixture, async port => {
    const t = TOKENS.director.raw;
    const allowed = await call(port, { token: t, method: 'POST', path: '/api/v1/discord/interact', body: { custom_id: 'adopt_do:offer42:0:radarr' } });
    assert.strictEqual(allowed.statusCode, 200, 'the granted action, with its payload, is pressable');
    assert.deepStrictEqual(fixture.dispatched.buttons, ['adopt_do:offer42:0:radarr']);

    // The case that makes button gating necessary: plex_approve is addressed by a Discord user
    // id, not by an unguessable offer nonce, so an agent could press it without ever having
    // been handed the button.
    const refused = await call(port, { token: t, method: 'POST', path: '/api/v1/discord/interact', body: { custom_id: 'plex_approve:123456789012345678' } });
    assert.strictEqual(refused.statusCode, 403);
    assert.match(JSON.parse(refused.body).error, /not allowed the Discord action "plex_approve"/);
    assert.deepStrictEqual(fixture.dispatched.buttons, ['adopt_do:offer42:0:radarr'], 'the press never reached handleButton');

    const audited = fixture.audits.find(a => a.action === 'agent_api_discord_action_denied');
    assert.ok(audited, 'the refusal is audited');
    assert.strictEqual(audited.details.kind, 'button');
    assert.strictEqual(audited.details.action, 'plex_approve');
  });
});

test('a grandfathered wildcard token reaches everything, so nothing breaks on upgrade', async () => {
  const fixture = setup();
  await withServer(fixture, async port => {
    const t = TOKENS.grandfathered.raw;
    assert.strictEqual((await call(port, { token: t, path: '/api/v1/health' })).statusCode, 200);
    assert.strictEqual((await call(port, { token: t, method: 'POST', path: '/api/v1/automation/sweep', body: sweep })).statusCode, 200);
    assert.strictEqual((await call(port, { token: t, method: 'POST', path: '/api/v1/discord/exec', body: { command: 'downsize' } })).statusCode, 200);
    assert.strictEqual((await call(port, { token: t, method: 'POST', path: '/api/v1/discord/interact', body: { custom_id: 'plex_approve:1' } })).statusCode, 200);
    assert.deepStrictEqual(
      fixture.audits.filter(a => a.action === 'agent_api_scope_denied' || a.action === 'agent_api_discord_action_denied'),
      [],
      'a pre-scopes token is refused nothing',
    );
  });
});

test('the legacy env token keeps full access — it has no row to carry grants', async () => {
  const fixture = setup();
  await withServer(fixture, async port => {
    assert.strictEqual((await call(port, { token: LEGACY_ENV, path: '/api/v1/health' })).statusCode, 200);
    assert.strictEqual((await call(port, { token: LEGACY_ENV, method: 'POST', path: '/api/v1/automation/sweep', body: sweep })).statusCode, 200);
    assert.strictEqual(
      (await call(port, { token: LEGACY_ENV, method: 'POST', path: '/api/v1/discord/exec', body: { command: 'downsize' } })).statusCode,
      200,
      'clearing AGENT_API_TOKEN is still the way to retire it, not a scope',
    );
  });
});

test('every route is scoped: no endpoint is reachable with the wrong scope', async () => {
  const fixture = setup();
  await withServer(fixture, async port => {
    const observer = TOKENS.observer.raw;
    // Each write route refuses a read-only token. Payloads are deliberately invalid: a 403 must
    // come from the scope check, ahead of any body validation.
    const writeRoutes = [
      '/api/v1/automation/sweep',
      '/api/v1/requests/1/retry',
      '/api/v1/search/season',
      '/api/v1/import-scan',
      '/api/v1/seedbox/sync',
      '/api/v1/seedbox/import-force',
    ];
    for (const path of writeRoutes) {
      assert.strictEqual(
        (await call(port, { token: observer, method: 'POST', path, body: {} })).statusCode,
        403,
        `${path} refuses a read-only token`,
      );
    }
    // And the read routes admit it.
    for (const path of ['/api/v1/health', '/api/v1/queue', '/api/v1/requests', '/api/v1/discord/commands']) {
      assert.strictEqual(
        (await call(port, { token: observer, path })).statusCode,
        200,
        `${path} admits a read-only token`,
      );
    }
  });
});
