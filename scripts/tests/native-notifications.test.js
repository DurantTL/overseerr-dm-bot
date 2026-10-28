#!/usr/bin/env node
// Native app notifications (src/native-notifications.js): plans read only, apply touches only the
// connection it names, Seerr keeps its webhook and only changes types, Tautulli gets one notifier,
// and the Discord webhook never appears in a plan, result, or error.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const N = require('../../src/native-notifications');

const HOOK = 'https://discord.com/api/webhooks/123/SECRET-HOOK-TOKEN';
const SEERR_HOOK = 'https://discord.com/api/webhooks/999/SEERR-MEMBER-PINGS';

function arrSchema(extra = {}) {
  return {
    implementation: 'Discord', configContract: 'DiscordSettings', name: '',
    onGrab: false, onDownload: false, onUpgrade: false, onRename: false, onSeriesDelete: false,
    onEpisodeFileDelete: false, onHealthIssue: false, onHealthRestored: false, onApplicationUpdate: false,
    onManualInteractionRequired: false, includeHealthWarnings: false, supportsOnGrab: true,
    fields: [{ name: 'webHookUrl', value: '' }, { name: 'username', value: '' }],
    ...extra,
  };
}

// One express app standing in for every service, routed by path prefix.
function fakeFleet({ arrExisting = {}, seerr = { enabled: true, types: 2 | 4 | 8 | 16, options: { webhookUrl: SEERR_HOOK } }, tautulliNotifiers = [], tautulliActions = {} } = {}) {
  const writes = [];
  const app = express();
  app.use(express.json());
  for (const svc of ['sonarr', 'prowlarr']) {
    const api = svc === 'prowlarr' ? 'v1' : 'v3';
    const list = arrExisting[svc] || [{ id: 1, name: 'Somebody else', implementation: 'Discord', onGrab: true, fields: [] }];
    app.get(`/${svc}/api/${api}/notification`, (req, res) => (req.get('x-api-key') === `${svc}-key` ? res.json(list) : res.status(401).end()));
    app.get(`/${svc}/api/${api}/notification/schema`, (_req, res) => res.json([{ implementation: 'Email' }, svc === 'prowlarr' ? arrSchema({ onDownload: undefined, onManualInteractionRequired: undefined }) : arrSchema()]));
    app.post(`/${svc}/api/${api}/notification`, (req, res) => { writes.push({ svc, method: 'POST', body: req.body }); res.status(201).json({ id: 7, ...req.body }); });
    app.put(`/${svc}/api/${api}/notification/:id`, (req, res) => { writes.push({ svc, method: 'PUT', id: req.params.id, body: req.body }); res.status(202).json(req.body); });
  }
  app.get('/seerr/api/v1/settings/notifications/discord', (_req, res) => res.json(seerr));
  app.post('/seerr/api/v1/settings/notifications/discord', (req, res) => { writes.push({ svc: 'seerr', method: 'POST', body: req.body }); res.json(req.body); });
  app.get('/tautulli/api/v2', (req, res) => {
    const { cmd } = req.query;
    const ok = data => res.json({ response: { result: 'success', data } });
    if (cmd === 'get_available_notifier_agents') return ok([{ id: 17, name: 'pushover' }, { id: 25, name: 'discord' }]);
    if (cmd === 'get_notifiers') return ok(tautulliNotifiers);
    if (cmd === 'get_notifier_config') return ok({ id: Number(req.query.notifier_id), config: { discord_hook: HOOK }, actions: tautulliActions });
    if (cmd === 'add_notifier_config') { writes.push({ svc: 'tautulli', cmd, query: { ...req.query } }); return ok({ notifier_id: 41 }); }
    if (cmd === 'set_notifier_config') { writes.push({ svc: 'tautulli', cmd, query: { ...req.query } }); return ok(null); }
    return res.status(400).json({ response: { result: 'error' } });
  });
  return { app, writes };
}

async function withFleet(opts, fn) {
  const { app, writes } = fakeFleet(opts);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const b = `http://127.0.0.1:${server.address().port}`;
  const config = {
    SONARR_URL: `${b}/sonarr/`, SONARR_API_KEY: 'sonarr-key',
    PROWLARR_URL: `${b}/prowlarr`, PROWLARR_API_KEY: 'prowlarr-key',
    OVERSEERR_URL: `${b}/seerr`, OVERSEERR_API_KEY: 'seerr-key',
    TAUTULLI_URL: `${b}/tautulli`, TAUTULLI_API_KEY: 'tautulli-key',
  };
  try { return await fn({ config, writes, http: require('axios') }); } finally { server.close(); }
}

const noHook = value => assert.ok(!JSON.stringify(value).includes('SECRET-HOOK-TOKEN'), 'webhook must not appear');

test('native notifications: preview reads every app and writes nothing', async () => {
  await withFleet({}, async ({ config, writes, http }) => {
    const plans = await N.planAll(config, { http, webhookUrl: HOOK });
    assert.deepStrictEqual(plans.map(p => [p.app, p.action]), [['Sonarr', 'create'], ['Prowlarr', 'create'], ['Seerr', 'update'], ['Tautulli', 'create']]);
    assert.strictEqual(writes.length, 0);
    assert.match(plans[0].detail, /health issues, health restored, imports needing manual interaction \(warnings included\); every other event off/);
    assert.match(plans[1].detail, /health issues, health restored \(warnings/, 'Prowlarr has no manual-interaction event');
    assert.match(plans[2].detail, /stops: media pending, media approved, media available/);
    assert.match(plans[3].detail, /Plex down \(internal\), Plex back up \(internal\), Plex update available/);
    noHook(plans.map(p => [p.app, p.action, p.detail]));
  });
});

test('native notifications: apply creates only the named connection with failure/health events', async () => {
  await withFleet({}, async ({ config, writes, http }) => {
    const plans = await N.planAll(config, { http, webhookUrl: HOOK });
    const results = await N.applyPlan(plans, config, { http });
    assert.ok(results.every(r => r.ok), JSON.stringify(results));
    const sonarr = writes.find(w => w.svc === 'sonarr');
    assert.strictEqual(sonarr.method, 'POST');
    assert.strictEqual(sonarr.body.name, N.CONNECTION_NAME);
    assert.strictEqual(sonarr.body.implementation, 'Discord');
    const on = Object.keys(sonarr.body).filter(k => /^on[A-Z]/.test(k) && sonarr.body[k] === true).sort();
    assert.deepStrictEqual(on, ['onHealthIssue', 'onHealthRestored', 'onManualInteractionRequired']);
    assert.strictEqual(sonarr.body.includeHealthWarnings, true);
    assert.strictEqual(sonarr.body.fields.find(f => f.name === 'webHookUrl').value, HOOK);
    assert.ok(!('id' in sonarr.body));
    assert.ok(!writes.some(w => w.method === 'PUT'), 'the other existing connection is never edited');

    const seerr = writes.find(w => w.svc === 'seerr');
    assert.strictEqual(seerr.body.types, N.SEERR_WANTED);
    assert.strictEqual(seerr.body.options.webhookUrl, SEERR_HOOK, 'Seerr keeps its own webhook');
    assert.strictEqual(seerr.body.enabled, true);

    const [add, set] = writes.filter(w => w.svc === 'tautulli');
    assert.strictEqual(add.cmd, 'add_notifier_config');
    assert.strictEqual(add.query.agent_id, '25');
    assert.strictEqual(set.query.notifier_id, '41');
    assert.strictEqual(set.query.discord_hook, HOOK);
    assert.deepStrictEqual(['on_intdown', 'on_intup', 'on_pmsupdate'].map(k => set.query[k]), ['1', '1', '1']);
    noHook(results);
  });
});

test('native notifications: already-correct settings are left alone; drift is updated in place', async () => {
  const good = { id: 9, ...N.desiredArrNotification(arrSchema(), HOOK), name: N.CONNECTION_NAME };
  const drifted = { ...good, onGrab: true };
  const opts = {
    arrExisting: { sonarr: [good], prowlarr: [drifted] },
    seerr: { enabled: true, types: N.SEERR_WANTED, options: { webhookUrl: SEERR_HOOK } },
    tautulliNotifiers: [{ id: 5, agent_name: 'discord', friendly_name: N.CONNECTION_NAME }],
    tautulliActions: { on_play: 1, on_intdown: 1, on_intup: 1, on_pmsupdate: 1 },
  };
  await withFleet(opts, async ({ config, writes, http }) => {
    const plans = await N.planAll(config, { http, webhookUrl: HOOK });
    assert.deepStrictEqual(plans.map(p => [p.app, p.action]), [['Sonarr', 'none'], ['Prowlarr', 'update'], ['Seerr', 'none'], ['Tautulli', 'update']]);
    assert.match(plans[1].detail, /onGrab off/);
    assert.match(plans[3].detail, /on_play off/);
    await N.applyPlan(plans, config, { http });
    assert.deepStrictEqual(writes.map(w => [w.svc, w.method || w.cmd]), [['prowlarr', 'PUT'], ['tautulli', 'set_notifier_config']]);
    assert.strictEqual(writes[0].id, '9');
    assert.strictEqual(writes[1].query.on_play, '0');
    assert.strictEqual(writes[1].query.notifier_id, '5');
  });
});

test('native notifications: a masked stored webhook is not counted as a change', () => {
  const desired = N.desiredArrNotification(arrSchema(), HOOK);
  const stored = JSON.parse(JSON.stringify(desired));
  stored.fields.find(f => f.name === 'webHookUrl').value = '********';
  assert.deepStrictEqual(N.arrDifferences(stored, desired), []);
  stored.fields.find(f => f.name === 'webHookUrl').value = 'https://discord.com/api/webhooks/1/old';
  assert.deepStrictEqual(N.arrDifferences(stored, desired), ['webhook changed']);
});

test('native notifications: Seerr with its agent off is skipped, never switched on', async () => {
  await withFleet({ seerr: { enabled: false, types: 0, options: {} } }, async ({ config, http }) => {
    const plans = await N.planAll(config, { http, webhookUrl: HOOK });
    const seerr = plans.find(p => p.app === 'Seerr');
    assert.strictEqual(seerr.action, 'skip');
    assert.match(seerr.detail, /turn it on in Seerr first/);
  });
});

test('native notifications: an unreadable app is reported without stopping the others or leaking', async () => {
  await withFleet({}, async ({ config, http }) => {
    const plans = await N.planAll({ ...config, SONARR_API_KEY: 'wrong' }, { http, webhookUrl: HOOK });
    assert.deepStrictEqual(plans[0], { app: 'Sonarr', action: 'error', detail: 'could not read settings (HTTP 401)' });
    assert.strictEqual(plans[1].action, 'create');
    noHook(plans.map(p => p.detail));
  });
  await assert.rejects(N.planAll({}, { http: {}, webhookUrl: '' }), /NATIVE_ALERTS_DISCORD_WEBHOOK is not set/);
});

test('native notifications: Seerr wanted types are failed + the four issue events', () => {
  assert.deepStrictEqual(N.seerrTypeNames(N.SEERR_WANTED), ['media failed', 'issue created', 'issue comment', 'issue resolved', 'issue reopened']);
});
