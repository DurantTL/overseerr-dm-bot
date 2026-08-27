#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const bodyParser = require('body-parser');
const { createApp, listen, close } = require('../../src/app');
const { registerTierAgentRoutes } = require('../../src/routes/tier-agent');
const { sha256, safeEqual } = require('../../src/util');

function request(port, { method = 'GET', path = '/', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    if (payload) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
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
  const settings = new Map([['tier_manifest:edge', JSON.stringify({ planHash: 'current' })]]);
  const plans = new Map([['edge', { published: { planHash: 'current' }, lastTelemetryLevel: 'unknown' }]]);
  const calls = { heartbeats: [], reports: [], inventories: [], converged: [], missing: 0, recovered: 0 };
  const tokenHashes = new Map([['edge', sha256('valid')], ['edge2', sha256('valid2')]]);
  const app = createApp({ skipJsonPaths: ['/agent/'] });
  registerTierAgentRoutes(app, {
    config: { PORT: 3000, TUNNEL_DOMAIN: '', AGENT_READ_MAX_PER_MINUTE: 2, AGENT_REPORT_MAX_PER_MINUTE: 12, AGENT_REPORT_MAX_CONCURRENT: 2, NODE_TEMP_WARN_C: 80, NODE_TEMP_CRITICAL_C: 90 },
    getTierAgentTokenHash: node => tokenHashes.get(node), sha256, safeEqual,
    reportLimiter: (_req, _res, next) => next(), bodyLimiter: (_req, _res, next) => next(), jsonParser: bodyParser.json({ limit: '25mb' }),
    audit: () => {}, getSetting: key => settings.get(key), setSetting: (key, value) => settings.set(key, value),
    getTierPlan: node => plans.get(node), getTierNode: () => ({ atime_mask: null }), listTierNodeFiles: () => [],
    recordTierAgentHeartbeat: (node, value) => calls.heartbeats.push({ node, value }),
    recordTierAgentReport: (node, value) => calls.reports.push({ node, value }),
    replaceTierNodeFiles: (node, files) => calls.inventories.push({ node, files }),
    markTierPlanConverged: (node, value) => calls.converged.push({ node, value }),
    parseAtimeMask: () => null, maskSuspectAtimes: files => files,
    notifyTelemetryTransition: () => {}, notifyDriveMissing: () => { calls.missing += 1; },
    notifyDriveRecovered: () => { calls.recovered += 1; }, notifyAgentReport: () => {},
  });
  return { app, settings, calls };
}

test('tier-agent HTTP routes require auth and return the published manifest', async () => {
  const { app } = setup();
  const server = await listen(app, 0);
  try {
    assert.strictEqual((await request(server.address().port, { path: '/agent/manifest/edge' })).statusCode, 401);
    const response = await request(server.address().port, { path: '/agent/manifest/EDGE', token: 'valid' });
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { planHash: 'current' });
  } finally { await close(server); }
});

test('tier-agent read limiter runs after real auth and keeps independent per-node budgets', async () => {
  const { app } = setup();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    assert.strictEqual((await request(port, { path: '/agent/manifest/edge', token: 'wrong' })).statusCode, 401);
    assert.strictEqual((await request(port, { path: '/agent/manifest/edge', token: 'valid' })).statusCode, 200);
    assert.strictEqual((await request(port, { path: '/agent/manifest/edge', token: 'valid' })).statusCode, 200);
    assert.strictEqual((await request(port, { path: '/agent/manifest/edge', token: 'valid' })).statusCode, 429);
    assert.strictEqual((await request(port, { path: '/agent/manifest/edge2', token: 'valid2' })).statusCode, 404);
  } finally { await close(server); }
});

test('tier-agent HTTP report distinguishes heartbeat, stale convergence, and valid convergence', async () => {
  const { app, calls } = setup();
  const server = await listen(app, 0);
  try {
    let response = await request(server.address().port, { method: 'POST', path: '/agent/report/edge', token: 'valid', body: { heartbeat: true, planHash: 'current' } });
    assert.deepStrictEqual(JSON.parse(response.body), { ok: true, heartbeat: true });
    assert.strictEqual(calls.heartbeats.length, 1);
    response = await request(server.address().port, { method: 'POST', path: '/agent/report/edge', token: 'valid', body: { converged: true, planHash: 'stale' } });
    assert.deepStrictEqual(JSON.parse(response.body), { ok: true, converged: false });
    response = await request(server.address().port, { method: 'POST', path: '/agent/report/edge', token: 'valid', body: { converged: true, planHash: 'current' } });
    assert.deepStrictEqual(JSON.parse(response.body), { ok: true, converged: true });
    assert.strictEqual(calls.converged.length, 1);
  } finally { await close(server); }
});

test('tier-agent HTTP report preserves inventory cap and drive-missing transitions', async () => {
  const { app, settings, calls } = setup();
  const server = await listen(app, 0);
  try {
    let response = await request(server.address().port, { method: 'POST', path: '/agent/report/edge', token: 'valid', body: { driveMissing: true, mountErrors: ['gone'] } });
    assert.deepStrictEqual(JSON.parse(response.body), { ok: true, acknowledged: 'drive-missing' });
    assert.strictEqual(calls.missing, 1);
    assert.strictEqual(settings.get('tier_mount_state:edge'), 'missing');
    const inventory = Array.from({ length: 200005 }, (_, index) => ({ path: `f${index}` }));
    response = await request(server.address().port, { method: 'POST', path: '/agent/report/edge', token: 'valid', body: { planHash: 'current', inventory } });
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(calls.recovered, 1);
    assert.strictEqual(calls.inventories[0].files.length, 200000);
  } finally { await close(server); }
});
