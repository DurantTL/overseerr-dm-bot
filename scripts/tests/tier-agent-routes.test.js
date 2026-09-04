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
  const calls = { heartbeats: [], reports: [], inventories: [], converged: [], missing: 0, recovered: 0, errorAlerts: [], agentReports: [] };
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
    recordTierErrorAlertState: (node, value) => {
      calls.errorAlerts.push({ node, value });
      plans.set(node, { ...(plans.get(node) || {}), errorAlert: value });
    },
    replaceTierNodeFiles: (node, files) => calls.inventories.push({ node, files }),
    markTierPlanConverged: (node, value) => calls.converged.push({ node, value }),
    parseAtimeMask: () => null, maskSuspectAtimes: files => files,
    notifyTelemetryTransition: () => {}, notifyDriveMissing: () => { calls.missing += 1; },
    notifyDriveRecovered: () => { calls.recovered += 1; },
    notifyAgentReport: payload => calls.agentReports.push(payload),
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

test('tier-agent HTTP report backs off repeated identical errors and posts one recovery note when they clear', async () => {
  const { app, calls } = setup();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const errorBody = { planHash: 'current', errors: ['timed out'] };
    for (let i = 0; i < 4; i++) {
      await request(port, { method: 'POST', path: '/agent/report/edge', token: 'valid', body: errorBody });
    }
    // Attempts 1, 2, 4 alert; attempt 3 is suppressed by the backoff.
    assert.deepStrictEqual(calls.agentReports.map(r => r.errorAlert.attemptCount), [1, 2, 4]);
    assert.strictEqual(calls.agentReports[2].errorAlert.stoodDown, true);

    await request(port, { method: 'POST', path: '/agent/report/edge', token: 'valid', body: { planHash: 'current', errors: ['timed out'] } });
    // Attempt 5 is still stood down and silent.
    assert.strictEqual(calls.agentReports.length, 3);

    await request(port, { method: 'POST', path: '/agent/report/edge', token: 'valid', body: { planHash: 'current', converged: true } });
    assert.strictEqual(calls.agentReports.length, 4);
    assert.strictEqual(calls.agentReports[3].recoveredFromErrors, true);
    assert.strictEqual(calls.agentReports[3].errors.length, 0);
  } finally { await close(server); }
});

test('tier-agent HTTP report passes the self-reported agent version through on every path, capped', async () => {
  const { app, calls } = setup();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    await request(port, { method: 'POST', path: '/agent/report/edge', token: 'valid', body: { heartbeat: true, planHash: 'current', agentVersion: '5b09b3f7eb8c' } });
    assert.strictEqual(calls.heartbeats[0].value.agentVersion, '5b09b3f7eb8c', 'heartbeat carries the version');

    await request(port, { method: 'POST', path: '/agent/report/edge', token: 'valid', body: { driveMissing: true, mountErrors: ['gone'], agentVersion: '5b09b3f7eb8c' } });
    assert.strictEqual(calls.heartbeats[1].value.agentVersion, '5b09b3f7eb8c', 'a drive-missing report (also a heartbeat) carries the version');

    await request(port, { method: 'POST', path: '/agent/report/edge', token: 'valid', body: { planHash: 'current', converged: true, agentVersion: '5b09b3f7eb8c' } });
    assert.strictEqual(calls.reports[0].value.agentVersion, '5b09b3f7eb8c', 'a full report carries the version');

    const longVersion = 'x'.repeat(200);
    await request(port, { method: 'POST', path: '/agent/report/edge', token: 'valid', body: { heartbeat: true, planHash: 'current', agentVersion: longVersion } });
    assert.strictEqual(calls.heartbeats[2].value.agentVersion.length, 40, 'an oversized version string is capped, not stored raw');

    await request(port, { method: 'POST', path: '/agent/report/edge', token: 'valid', body: { heartbeat: true, planHash: 'current', agentVersion: { not: 'a string' } } });
    assert.strictEqual(calls.heartbeats[3].value.agentVersion, null, 'a non-string version is dropped rather than stored as-is');
  } finally { await close(server); }
});
