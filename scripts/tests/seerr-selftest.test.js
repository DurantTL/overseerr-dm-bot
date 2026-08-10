#!/usr/bin/env node
// runSeerrSelfTest (/seerr-test): version check, Discord-agent check, throwaway-user round-trip,
// cleanup semantics — against mock Seerr servers.
const { test } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');
const express = require('express');
const crypto = require('crypto');
const { loadSandbox } = require('./extract');

const ADMIN_ID = '123456789012345678';
const sandbox = loadSandbox(
  ['setOverseerrDiscordNotification', 'createOverseerrUser', 'runSeerrSelfTest'],
  { axios, crypto, CONFIG: { OVERSEERR_URL: '', OVERSEERR_API_KEY: 'test-key' }, audit: () => {} },
);

function mockSeerr({ version = '3.3.0', agentEnabled = true, modern = true, storeIds = true }) {
  const app = express();
  app.use(express.json());
  const state = { deleted: [], created: [], userSettings: {}, otherSettings: { pgpKey: 'K' } };
  app.get('/api/v1/status', (req, res) => res.json({ version }));
  app.get('/api/v1/settings/notifications/discord', (req, res) =>
    res.json({ enabled: agentEnabled, options: { webhookUrl: agentEnabled ? 'https://discord.com/api/webhooks/x' : '' } }));
  app.post('/api/v1/user', (req, res) => {
    const id = 500 + state.created.length;
    state.created.push({ id, ...req.body });
    state.userSettings[id] = modern ? { discordIds: [] } : { discordId: '' };
    res.json({ id });
  });
  app.get('/api/v1/user/:id/settings/notifications', (req, res) =>
    res.json({ ...state.otherSettings, ...state.userSettings[req.params.id] }));
  app.post('/api/v1/user/:id/settings/notifications', (req, res) => {
    if (storeIds) {
      state.userSettings[req.params.id] = modern
        ? { discordIds: req.body.discordIds?.filter(id => id !== '') ?? [] }
        : { discordId: req.body.discordId };
    }
    res.json({});
  });
  app.delete('/api/v1/user/:id', (req, res) => { state.deleted.push(req.params.id); res.json({}); });
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, state, port: server.address().port }));
  });
}

async function runCase(opts, testOpts = {}) {
  const { server, state, port } = await mockSeerr(opts);
  sandbox.CONFIG.OVERSEERR_URL = `http://127.0.0.1:${port}`;
  const result = await sandbox.run(`runSeerrSelfTest('${ADMIN_ID}', ${JSON.stringify(testOpts)})`);
  server.close();
  return { result, state };
}
const step = (result, name) => result.steps.find(s => s.name === name);

test('seerr-selftest: runSeerrSelfTest across version/agent/legacy/keep scenarios', async () => {
  let { result, state } = await runCase({ version: '3.3.0', agentEnabled: true, modern: true });
  assert.ok(result.steps.every(s => s.ok), '3.3 happy path: all steps ok');
  assert.match(step(result, 'Discord ID stored').detail, /discordIds/, '3.3: verified via plural field');
  assert.strictEqual(state.deleted.length, 1, '3.3: fake user deleted');
  assert.ok(state.created[0].email.endsWith('@seerr-test.local'), 'test email is synthetic');

  ({ result } = await runCase({ agentEnabled: false }));
  const agentStep = step(result, 'Discord agent enabled');
  assert.strictEqual(agentStep.ok, false, 'agent off: flagged');
  assert.match(agentStep.detail, /Settings → Notifications → Discord/, 'agent off: says where to enable');
  assert.strictEqual(step(result, 'Discord ID stored').ok, true, 'agent off: round-trip still verified');

  ({ result } = await runCase({ version: '1.33.2', modern: false }));
  assert.strictEqual(step(result, 'Discord ID stored').ok, true, 'pre-3.3: verified');
  assert.match(step(result, 'Discord ID stored').detail, /legacy field/, 'pre-3.3: legacy field reported');

  ({ result, state } = await runCase({ storeIds: false }));
  assert.strictEqual(step(result, 'Discord ID stored').ok, false, 'no-store: verify fails');
  assert.strictEqual(state.deleted.length, 1, 'no-store: cleanup still deletes');

  ({ result, state } = await runCase({}, { keep: true }));
  assert.strictEqual(state.deleted.length, 0, 'keep: user NOT deleted');
  assert.match(step(result, 'Cleanup').detail, /Users → bot-selftest/, 'keep: points at the Seerr UI');

  sandbox.CONFIG.OVERSEERR_URL = 'http://127.0.0.1:1';
  const down = await sandbox.run(`runSeerrSelfTest('${ADMIN_ID}', {})`);
  assert.strictEqual(down.steps.length, 1, 'down: bails after reachability');
  assert.strictEqual(down.testUserId, null, 'down: no user created');
});
