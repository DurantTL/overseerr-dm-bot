#!/usr/bin/env node
// §182 the agent's "kick" retry loop: the bot has no inbound path to the edge (pull-only, by
// design), so a play-promotion's "converge now" signal is a `kickPending: true` flag on the
// report response instead of a push. runWithKickRetries re-polls soon while it's set, bounded so
// a stuck pin can't spin the agent forever, and never fires at all for a deployment that never
// sets EDGE_PROMOTE_ON_PLAY (kickPending is simply never true).
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildCtx, runWithKickRetries } = require('../../agent/agent');
const { renderSyncthingStignore, computePlanHash } = require('../../src/tier');

function fakeSleeps() {
  const calls = [];
  return { sleep: ms => { calls.push(ms); return Promise.resolve(); }, calls };
}

test('tier-agent kick: re-polls while kickPending is true, stops the moment it clears', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-kick-'));
  const folderRoot = path.join(tmp, 'media');
  fs.mkdirSync(folderRoot, { recursive: true });
  fs.mkdirSync(path.join(folderRoot, '.stfolder'));

  const manifest = (() => {
    const m = { node: 'california', generatedAt: new Date().toISOString(), keep: [], drop: [] };
    m.planHash = computePlanHash(m);
    m.stignore = renderSyncthingStignore(m);
    return m;
  })();

  let reportCount = 0;
  let kickPendingUntilCall = 3; // clears on the 3rd report
  const bot = express();
  bot.use(express.json({ limit: '5mb' }));
  bot.get('/agent/manifest/:node', (_req, res) => res.json(manifest));
  bot.post('/agent/report/:node', (_req, res) => {
    reportCount += 1;
    res.json({ ok: true, heartbeat: true, kickPending: reportCount < kickPendingUntilCall });
  });
  const botSrv = await new Promise(r => { const s = bot.listen(0, () => r(s)); });

  const st = express();
  st.get('/rest/config/folders/:id', (req, res) => res.json({ id: req.params.id, type: 'receiveonly' }));
  st.get('/rest/db/status', (_req, res) => res.json({ state: 'idle' }));
  st.post('/rest/db/scan', (_req, res) => res.json({}));
  st.get('/rest/db/ignores', (_req, res) => res.json({ ignore: [] }));
  const stSrv = await new Promise(r => { const s = st.listen(0, () => r(s)); });

  const ctx = buildCtx({
    TIER_BOT_URL: `http://127.0.0.1:${botSrv.address().port}`,
    TIER_NODE: 'california', TIER_AGENT_TOKEN: 'test-token',
    TIER_FOLDER_ROOT: folderRoot, SYNCTHING_FOLDER_ID: 'media',
    SYNCTHING_URL: `http://127.0.0.1:${stSrv.address().port}`, SYNCTHING_API_KEY: 'key',
    TIER_STATE_DIR: path.join(tmp, 'state'),
  });
  ctx.log = () => {};

  const { sleep, calls: sleeps } = fakeSleeps();
  const result = await runWithKickRetries(ctx, { sleep, delayMs: 20000, maxAttempts: 6 });

  assert.strictEqual(reportCount, 3, 'stopped re-polling the moment kickPending cleared');
  assert.deepStrictEqual(sleeps, [20000, 20000], 'slept once between each of the two retry attempts');
  assert.strictEqual(result.kickPending, false);

  botSrv.close(); stSrv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('tier-agent kick: gives up after maxAttempts instead of polling forever on a stuck pin', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-kick-stuck-'));
  const folderRoot = path.join(tmp, 'media');
  fs.mkdirSync(folderRoot, { recursive: true });
  fs.mkdirSync(path.join(folderRoot, '.stfolder'));
  const manifest = (() => {
    const m = { node: 'california', generatedAt: new Date().toISOString(), keep: [], drop: [] };
    m.planHash = computePlanHash(m);
    m.stignore = renderSyncthingStignore(m);
    return m;
  })();

  let reportCount = 0;
  const bot = express();
  bot.use(express.json({ limit: '5mb' }));
  bot.get('/agent/manifest/:node', (_req, res) => res.json(manifest));
  bot.post('/agent/report/:node', (_req, res) => { reportCount += 1; res.json({ ok: true, heartbeat: true, kickPending: true }); });
  const botSrv = await new Promise(r => { const s = bot.listen(0, () => r(s)); });
  const st = express();
  st.get('/rest/config/folders/:id', (req, res) => res.json({ id: req.params.id, type: 'receiveonly' }));
  st.get('/rest/db/status', (_req, res) => res.json({ state: 'idle' }));
  st.post('/rest/db/scan', (_req, res) => res.json({}));
  st.get('/rest/db/ignores', (_req, res) => res.json({ ignore: [] }));
  const stSrv = await new Promise(r => { const s = st.listen(0, () => r(s)); });

  const ctx = buildCtx({
    TIER_BOT_URL: `http://127.0.0.1:${botSrv.address().port}`,
    TIER_NODE: 'california', TIER_AGENT_TOKEN: 'test-token',
    TIER_FOLDER_ROOT: folderRoot, SYNCTHING_FOLDER_ID: 'media',
    SYNCTHING_URL: `http://127.0.0.1:${stSrv.address().port}`, SYNCTHING_API_KEY: 'key',
    TIER_STATE_DIR: path.join(tmp, 'state'),
  });
  ctx.log = () => {};

  const { sleep, calls: sleeps } = fakeSleeps();
  const result = await runWithKickRetries(ctx, { sleep, delayMs: 5000, maxAttempts: 4 });

  assert.strictEqual(reportCount, 4, 'exactly maxAttempts reports, never unbounded');
  assert.strictEqual(sleeps.length, 3, 'one fewer sleep than attempts (no sleep after the last one)');
  assert.strictEqual(result.kickPending, true, 'still stuck — the systemd timer remains the real backstop');

  botSrv.close(); stSrv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('tier-agent kick: a deployment that never sees kickPending never retries', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-kick-off-'));
  const folderRoot = path.join(tmp, 'media');
  fs.mkdirSync(folderRoot, { recursive: true });
  fs.mkdirSync(path.join(folderRoot, '.stfolder'));
  const manifest = (() => {
    const m = { node: 'california', generatedAt: new Date().toISOString(), keep: [], drop: [] };
    m.planHash = computePlanHash(m);
    m.stignore = renderSyncthingStignore(m);
    return m;
  })();
  let reportCount = 0;
  const bot = express();
  bot.use(express.json({ limit: '5mb' }));
  bot.get('/agent/manifest/:node', (_req, res) => res.json(manifest));
  bot.post('/agent/report/:node', (_req, res) => { reportCount += 1; res.json({ ok: true, heartbeat: true }); }); // no kickPending field at all
  const botSrv = await new Promise(r => { const s = bot.listen(0, () => r(s)); });
  const st = express();
  st.get('/rest/config/folders/:id', (req, res) => res.json({ id: req.params.id, type: 'receiveonly' }));
  st.get('/rest/db/status', (_req, res) => res.json({ state: 'idle' }));
  st.post('/rest/db/scan', (_req, res) => res.json({}));
  st.get('/rest/db/ignores', (_req, res) => res.json({ ignore: [] }));
  const stSrv = await new Promise(r => { const s = st.listen(0, () => r(s)); });
  const ctx = buildCtx({
    TIER_BOT_URL: `http://127.0.0.1:${botSrv.address().port}`,
    TIER_NODE: 'california', TIER_AGENT_TOKEN: 'test-token',
    TIER_FOLDER_ROOT: folderRoot, SYNCTHING_FOLDER_ID: 'media',
    SYNCTHING_URL: `http://127.0.0.1:${stSrv.address().port}`, SYNCTHING_API_KEY: 'key',
    TIER_STATE_DIR: path.join(tmp, 'state'),
  });
  ctx.log = () => {};
  const { sleep, calls: sleeps } = fakeSleeps();
  await runWithKickRetries(ctx, { sleep, delayMs: 5000, maxAttempts: 6 });
  assert.strictEqual(reportCount, 1, 'exactly one report — no retries at all');
  assert.strictEqual(sleeps.length, 0);
  botSrv.close(); stSrv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
