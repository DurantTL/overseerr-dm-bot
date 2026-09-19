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

function fakeManifest(name, { full = false, big = false } = {}) {
  return {
    node: name,
    planHash: big ? 'big' : `hash-${name}`,
    full,
    access: full ? 'open' : 'restricted',
    stats: { keepCount: 10, keepBytes: 100, dropCount: 2, dropBytes: 20, budgetBytes: 500 },
    keep: [],
    drop: [],
  };
}

function fixture(overrides = {}) {
  const state = {
    audits: [],
    published: [],
    enabled: [],
    folders: [],
    members: [],
  };
  const plans = {
    manifests: {
      california: fakeManifest('california', { big: true }),
      'durant-server': fakeManifest('durant-server', { full: true }),
    },
    nodes: [
      { name: 'california', full: false, access: 'restricted' },
      { name: 'durant-server', full: true, access: 'open' },
    ],
    warnings: ['a warning'],
    routingErrors: [],
    failedSources: [],
    planRecords: {},
  };
  const app = createApp();
  const deps = {
    CONFIG: { TUNNEL_DOMAIN: 'dashboard.example.test', PORT: 3000 },
    audit: (action, metadata) => state.audits.push({ action, metadata }),
    dashboardActionError: error => error.message,
    dashboardActor: () => ({ actorKind: 'dashboard' }),
    dashboardAuth: (req, res, next) => req.get('x-admin-token') === 'secret'
      ? next()
      : res.status(401).json({ ok: false, error: 'Unauthorized' }),
    dashboardCache: { invalidate: () => {} },
    discordReadyGuard: (_req, _res, next) => next(),
    httpRateLimitKey: () => 'dashboard-tier-planning-test',
    rateLimit,
    // Tier planning fakes.
    buildTierPlans: async () => plans,
    tierApplyCaps: () => ({ maxRealRemovalBytes: 10, maxRemovedTitles: 1, maxNewDownloadBytes: 10 }),
    assessApplyImpact: ({ manifest }) => ({
      realRemovalBytes: 5,
      removedTitles: 2,
      newDownloadBytes: 3,
      newDownloadTitles: 1,
      hasReport: true,
      exceeds: { realRemovalBytes: false, removedTitles: true, newDownloadBytes: false },
      requiresConfirm: manifest.planHash === 'big',
    }),
    computeTierActionPreview: () => ({
      downloadLocally: [{ title: 'A', sizeBytes: 3, folderId: 'movies', value: 0.9 }],
      removeLocal: [{ title: 'B', sizeBytes: 2, folderId: 'movies', value: 0.1 }],
      keptDownloading: [],
      alreadyAbsent: [],
      keptSynced: [{ title: 'C', sizeBytes: 10 }],
      totals: {
        downloadLocally: { count: 1, bytes: 3 },
        removeLocal: { count: 1, bytes: 2 },
        keptDownloading: { count: 0, bytes: 0 },
        alreadyAbsent: { count: 0, bytes: 0 },
        keptSynced: { count: 1, bytes: 10 },
      },
      hasReport: true,
    }),
    tierApplyConfirmCode: () => 'ABCD',
    publishTierNodePlan: (name, manifest) => {
      state.published.push({ name, planHash: manifest.planHash });
      return { published: { planHash: manifest.planHash } };
    },
    listTierNodeFiles: () => [],
    fmtSpace: bytes => `${bytes}B`,
    // Node / member management fakes.
    getTierNode: name => (name === 'california'
      ? { name, access: 'restricted', enabled: true }
      : (name === 'durant-server' ? { name, access: 'open', enabled: true } : null)),
    setTierNodeEnabled: (name, enabled) => { state.enabled.push({ name, enabled }); return true; },
    addTierNodeFolder: (name, folderId, folderRoot) => { state.folders.push({ op: 'add', name, folderId, folderRoot }); return true; },
    removeTierNodeFolder: (name, folderId) => { state.folders.push({ op: 'remove', name, folderId }); return true; },
    addTierNodeMember: (node, discordId) => { state.members.push({ op: 'add', node, discordId }); return true; },
    removeTierNodeMember: (node, discordId) => { state.members.push({ op: 'remove', node, discordId }); return true; },
    ...overrides,
  };
  registerDashboardMutationRoutes(app, deps);
  return { app, state, plans };
}

const headers = { 'x-admin-token': 'secret' };

test('tier preview requires auth and returns per-node plans with impact', async () => {
  const { app } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    assert.strictEqual((await post(port, '/admin/action/tier-preview', {}, {})).statusCode, 401);

    const res = await post(port, '/admin/action/tier-preview', {}, headers);
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.nodes.length, 2);
    const ca = body.nodes.find(n => n.name === 'california');
    assert.strictEqual(ca.keepCount, 10);
    assert.strictEqual(ca.impact.requiresConfirm, true);
    assert.strictEqual(ca.impact.confirmCode, 'ABCD');
    assert.strictEqual(ca.actions.download.count, 1);
    assert.strictEqual(ca.topChanges.length, 2);
    assert.deepStrictEqual(body.warnings, ['a warning']);
    const master = body.nodes.find(n => n.name === 'durant-server');
    assert.strictEqual(master.full, true);
    assert.strictEqual(master.impact, null);
  } finally {
    await close(server);
  }
});

test('tier preview scopes to one node and 404s on unknown nodes', async () => {
  const { app } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const scoped = await post(port, '/admin/action/tier-preview', { node: 'california' }, headers);
    assert.strictEqual(scoped.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(scoped.body).nodes.map(n => n.name), ['california']);
    assert.strictEqual((await post(port, '/admin/action/tier-preview', { node: 'nope' }, headers)).statusCode, 404);
  } finally {
    await close(server);
  }
});

test('tier apply publishes, holds large rebalances without the confirm code, and audits', async () => {
  const { app, state } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    // Full master publishes without a confirm gate; california (big) is held.
    const held = await post(port, '/admin/action/tier-apply', {}, headers);
    assert.strictEqual(held.statusCode, 200);
    const heldBody = JSON.parse(held.body);
    assert.deepStrictEqual(heldBody.applied, ['durant-server']);
    assert.deepStrictEqual(heldBody.held, [{ node: 'california', confirmCode: 'ABCD' }]);
    assert.deepStrictEqual(state.published.map(p => p.name), ['durant-server']);
    assert.ok(state.audits.some(a => a.action === 'tier_apply_blocked' && a.metadata.node === 'california'));

    // Wrong code stays held; right code publishes.
    const wrong = await post(port, '/admin/action/tier-apply', { node: 'california', confirm: 'ZZZZ' }, headers);
    assert.deepStrictEqual(JSON.parse(wrong.body).held, [{ node: 'california', confirmCode: 'ABCD' }]);
    const right = await post(port, '/admin/action/tier-apply', { node: 'california', confirm: 'ABCD' }, headers);
    const rightBody = JSON.parse(right.body);
    assert.deepStrictEqual(rightBody.applied, ['california']);
    assert.deepStrictEqual(rightBody.held, []);
    assert.ok(state.audits.some(a => a.action === 'tier_plan_published' && a.metadata.node === 'california' && a.metadata.confirmed === true));
  } finally {
    await close(server);
  }
});

test('tier apply is blocked on routing errors and incomplete inventory', async () => {
  const routing = fixture({
    buildTierPlans: async () => ({
      manifests: { california: fakeManifest('california') },
      nodes: [{ name: 'california', full: false, access: 'restricted' }],
      warnings: [],
      routingErrors: [{ node: 'california', count: 3, examples: ['/x'] }],
      failedSources: [],
      planRecords: {},
    }),
  });
  const server = await listen(routing.app, 0);
  try {
    const res = await post(server.address().port, '/admin/action/tier-apply', {}, headers);
    assert.strictEqual(res.statusCode, 409);
    assert.ok(routing.state.audits.some(a => a.action === 'tier_apply_blocked_routing'));
    assert.deepStrictEqual(routing.state.published, []);
  } finally {
    await close(server);
  }

  const incomplete = fixture({
    buildTierPlans: async () => ({
      manifests: { california: fakeManifest('california') },
      nodes: [{ name: 'california', full: false, access: 'restricted' }],
      warnings: [],
      routingErrors: [],
      failedSources: [{ label: 'Radarr HD', error: 'timeout' }],
      planRecords: {},
    }),
  });
  const server2 = await listen(incomplete.app, 0);
  try {
    const res = await post(server2.address().port, '/admin/action/tier-apply', {}, headers);
    assert.strictEqual(res.statusCode, 409);
    assert.ok(incomplete.state.audits.some(a => a.action === 'tier_apply_blocked_incomplete_inventory'));
  } finally {
    await close(server2);
  }
});

test('tier node enable/disable validates the node and audits', async () => {
  const { app, state } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    assert.strictEqual((await post(port, '/admin/action/tier-node/disable', { name: 'nope' }, headers)).statusCode, 404);
    const disabled = await post(port, '/admin/action/tier-node/disable', { name: 'california' }, headers);
    assert.strictEqual(disabled.statusCode, 200);
    assert.deepStrictEqual(state.enabled, [{ name: 'california', enabled: false }]);
    assert.ok(state.audits.some(a => a.action === 'dashboard_tier_node_disabled' && a.metadata.ok === true));
    const enabled = await post(port, '/admin/action/tier-node/enable', { name: 'california' }, headers);
    assert.strictEqual(enabled.statusCode, 200);
    assert.deepStrictEqual(state.enabled[1], { name: 'california', enabled: true });
  } finally {
    await close(server);
  }
});

test('tier folder add/remove validates input and audits', async () => {
  const { app, state } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    assert.strictEqual((await post(port, '/admin/action/tier-node/folder-add', { name: 'california' }, headers)).statusCode, 400);
    assert.strictEqual((await post(port, '/admin/action/tier-node/folder-add', { name: 'nope', folderId: 'movies', folderRoot: '/m' }, headers)).statusCode, 404);
    const added = await post(port, '/admin/action/tier-node/folder-add', { name: 'california', folderId: 'movies', folderRoot: '/m' }, headers);
    assert.strictEqual(added.statusCode, 200);
    assert.deepStrictEqual(state.folders[0], { op: 'add', name: 'california', folderId: 'movies', folderRoot: '/m' });
    const removed = await post(port, '/admin/action/tier-node/folder-remove', { name: 'california', folderId: 'movies' }, headers);
    assert.strictEqual(removed.statusCode, 200);
    assert.ok(state.audits.some(a => a.action === 'dashboard_tier_node_folder_removed'));
  } finally {
    await close(server);
  }
});

test('tier member add/remove requires restricted nodes and valid discord ids', async () => {
  const { app, state } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    // Open node has no member set.
    assert.strictEqual((await post(port, '/admin/action/tier-member/add', { name: 'durant-server', discordId: '12345' }, headers)).statusCode, 400);
    // Bad discord id.
    assert.strictEqual((await post(port, '/admin/action/tier-member/add', { name: 'california', discordId: 'abc' }, headers)).statusCode, 400);
    const added = await post(port, '/admin/action/tier-member/add', { name: 'california', discordId: '123456789' }, headers);
    assert.strictEqual(added.statusCode, 200);
    assert.deepStrictEqual(state.members[0], { op: 'add', node: 'california', discordId: '123456789' });
    const removed = await post(port, '/admin/action/tier-member/remove', { name: 'california', discordId: '123456789' }, headers);
    assert.strictEqual(removed.statusCode, 200);
    assert.ok(state.audits.some(a => a.action === 'dashboard_tier_member_added' && a.metadata.ok === true));
  } finally {
    await close(server);
  }
});
