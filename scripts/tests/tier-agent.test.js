#!/usr/bin/env node
// Node sync-agent against mock bot + Syncthing HTTP: the ignore-before-prune ordering, the
// receive-only safety abort, path confinement, the atime inventory report, and the no-op
// skip on an unchanged plan hash.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildCtx, runOnce } = require('../../agent/agent');
const { renderSyncthingStignore, computePlanHash } = require('../../src/tier');

test('tier-agent: a registered node waits cleanly until its first manifest is published', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-agent-awaiting-plan-'));
  const folderRoot = path.join(tmp, 'media');
  fs.mkdirSync(folderRoot);
  let report;
  const bot = express();
  bot.use(express.json());
  bot.get('/agent/manifest/:node', (_req, res) => res.status(404).json({ error: 'No manifest published' }));
  bot.post('/agent/report/:node', (req, res) => { report = req.body; res.json({ ok: true }); });
  const botSrv = await new Promise(resolve => { const server = bot.listen(0, () => resolve(server)); });
  const ctx = buildCtx({
    TIER_BOT_URL: `http://127.0.0.1:${botSrv.address().port}`,
    TIER_NODE: 'new-edge',
    TIER_AGENT_TOKEN: 'test-token',
    TIER_FOLDER_ROOT: folderRoot,
    SYNCTHING_FOLDER_ID: 'media',
    TIER_STATE_DIR: path.join(tmp, 'state'),
  });
  const logs = [];
  ctx.log = message => logs.push(message);

  const result = await runOnce(ctx);

  assert.deepStrictEqual(result, { skipped: true, heartbeat: true, awaitingManifest: true });
  assert.strictEqual(report.heartbeat, true);
  assert.strictEqual(report.awaitingManifest, true);
  assert.ok(report.telemetry && typeof report.telemetry === 'object');
  assert.ok(logs.some(line => line.includes('waiting for /tier apply')));
  assert.notStrictEqual(process.exitCode, 1, 'an unpublished first plan is not a systemd failure');
  await new Promise(resolve => botSrv.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('tier-agent: ignore-before-prune ordering, receive-only abort, path confinement, inventory, no-op skip', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-agent-test-'));
  const folderRoot = path.join(tmp, 'media');
  const stateDir = path.join(tmp, 'state');
  const mkMedia = (rel, bytes = 1024) => {
    const abs = path.join(folderRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(bytes));
  };
  mkMedia('movies/Old Movie (2001)/old.mkv', 4096);
  mkMedia('movies/Keep Movie (2024)/keep.mkv', 2048);
  fs.mkdirSync(path.join(folderRoot, '.stfolder'));

  // --- mock bot ---
  let manifest;
  const reports = [];
  const bot = express();
  bot.use(express.json({ limit: '5mb' }));
  const requireToken = (req, res, next) => {
    if (req.headers.authorization !== 'Bearer test-token') return res.status(401).json({ error: 'Unauthorized' });
    next();
  };
  let failReports = false; // toggle to simulate an unreachable/erroring bot on the report endpoint
  bot.get('/agent/manifest/:node', requireToken, (_req, res) => res.json(manifest));
  bot.post('/agent/report/:node', requireToken, (req, res) => {
    if (failReports) return res.status(503).json({ error: 'bot down' });
    reports.push(req.body);
    res.json({ ok: true });
  });
  const botSrv = await new Promise(r => { const s = bot.listen(0, () => r(s)); });

  // --- mock Syncthing ---
  let folderType = 'receiveonly';
  let doomedAtScan = 'movies/Old Movie (2001)/old.mkv'; // per run: the file the plan will prune
  const stCalls = [];
  const st = express();
  st.get('/rest/config/folders/:id', (req, res) => {
    stCalls.push('config');
    res.json({ id: req.params.id, type: folderType });
  });
  st.post('/rest/db/scan', (_req, res) => {
    // The whole point of the ordering: when the rescan happens, the ignore file must already
    // be on disk and the doomed file must still exist (prune comes after confirmation).
    stCalls.push('scan');
    assert.ok(fs.existsSync(path.join(folderRoot, '.stignore')), 'stignore written BEFORE rescan');
    assert.ok(fs.existsSync(path.join(folderRoot, doomedAtScan)), 'prune must not run before ignores are confirmed');
    res.json({});
  });
  st.get('/rest/db/ignores', (_req, res) => {
    stCalls.push('ignores');
    const lines = fs.readFileSync(path.join(folderRoot, '.stignore'), 'utf8').split('\n').filter(l => l && !l.startsWith('//'));
    res.json({ ignore: lines });
  });
  const stSrv = await new Promise(r => { const s = st.listen(0, () => r(s)); });

  const mkManifest = drop => {
    const m = {
      node: 'cali',
      generatedAt: new Date().toISOString(),
      keep: [{ mediaId: 'tmdb:2', relPath: 'movies/Keep Movie (2024)', sizeBytes: 2048 }],
      drop,
    };
    m.planHash = computePlanHash(m);
    m.stignore = renderSyncthingStignore(m);
    return m;
  };
  manifest = mkManifest([
    { mediaId: 'tmdb:1', relPath: 'movies/Old Movie (2001)', sizeBytes: 4096 },
    { mediaId: 'tmdb:evil', relPath: '../outside', sizeBytes: 1 },
  ]);

  const ctx = buildCtx({
    TIER_BOT_URL: `http://127.0.0.1:${botSrv.address().port}`,
    TIER_NODE: 'cali',
    TIER_AGENT_TOKEN: 'test-token',
    TIER_FOLDER_ROOT: folderRoot,
    SYNCTHING_URL: `http://127.0.0.1:${stSrv.address().port}`,
    SYNCTHING_API_KEY: 'st-key',
    SYNCTHING_FOLDER_ID: 'media',
    TIER_STATE_DIR: stateDir,
  });
  ctx.log = () => {};

  // --- run 1: full converge ---
  const r1 = await runOnce(ctx);
  assert.deepStrictEqual(stCalls, ['config', 'scan', 'ignores'], 'receive-only asserted first, then rescan, then ignore confirmation');
  assert.ok(!fs.existsSync(path.join(folderRoot, 'movies/Old Movie (2001)')), 'dropped title pruned');
  assert.ok(fs.existsSync(path.join(folderRoot, 'movies/Keep Movie (2024)/keep.mkv')), 'kept title untouched');
  assert.ok(!fs.existsSync(path.join(tmp, 'outside')), 'path traversal confined to folder root');
  assert.strictEqual(r1.bytesFreed, 4096, 'freed bytes accounted');
  // Reported, never silent — but as a SKIP, not an error: the file is ignored either way, so the
  // node still reached its plan. Counting it as an error used to force converged:false forever.
  assert.ok(r1.skipped.some(e => e.includes('../outside')), 'escaping path reported, not silently skipped');
  assert.strictEqual(r1.errors.length, 0, 'a refused traversal is not a run failure');
  assert.strictEqual(r1.converged, true, 'the run still converged despite the refused entry');
  assert.notStrictEqual(process.exitCode, 1, 'and did not fail the systemd unit');
  assert.strictEqual(reports.length, 1, 'report posted');
  assert.ok(reports[0].inventory.some(f => f.relPath === 'movies/Keep Movie (2024)/keep.mkv'), 'inventory reports kept media files');
  assert.ok(reports[0].inventory.every(f => Number.isFinite(f.atime) && f.sizeBytes >= 0), 'inventory rows carry atime + size');
  // The inventory is walked BEFORE the prune loop runs, but the REPORT must reflect what the
  // prune actually did — this run's own report, not a later one, since the bot fully replaces
  // its known file set from report.inventory on every report that carries one.
  assert.ok(!reports[0].inventory.some(f => f.relPath.startsWith('movies/Old Movie')), 'the SAME report already excludes the just-pruned title — no stale pre-prune entries');

  // --- run 2: plan unchanged, and the inventory was already settled by run 1's own report →
  // a true no-op heartbeat, not a second full report ---
  stCalls.length = 0;
  const r2 = await runOnce(ctx);
  assert.deepStrictEqual(stCalls, [], 'unchanged plan → Syncthing untouched');
  assert.strictEqual(r2.skipped, true, 'unchanged plan + already-settled inventory → skip prune/inventory');
  assert.strictEqual(r2.heartbeat, true, 'a no-op run still checks in');
  assert.strictEqual(reports.length, 2, 'no-op run posts a lightweight heartbeat (proof of life)');
  assert.strictEqual(reports[1].heartbeat, true, 'the no-op post is a heartbeat');
  assert.ok(!reports[1].inventory, 'heartbeat carries no inventory payload');

  // --- receive-only violation: abort before touching anything ---
  mkMedia('movies/Another Old (1999)/x.mkv', 1024);
  manifest = mkManifest([{ mediaId: 'tmdb:3', relPath: 'movies/Another Old (1999)', sizeBytes: 1024 }]);
  folderType = 'sendreceive';
  stCalls.length = 0;
  const r4 = await runOnce(ctx);
  assert.ok(r4.errors.some(e => e.includes('SAFETY ABORT')), 'send-receive folder → hard abort');
  assert.deepStrictEqual(stCalls, ['config'], 'abort happens at the topology check — no rescan, no prune');
  assert.ok(fs.existsSync(path.join(folderRoot, 'movies/Another Old (1999)/x.mkv')), 'nothing deleted on abort');
  assert.strictEqual(reports.length, 3, 'abort still reported to the bot (after run 2\'s heartbeat)');
  process.exitCode = 0;

  // --- fixed folder type: the same plan converges on the next run (state not poisoned) ---
  folderType = 'receiveonly';
  doomedAtScan = 'movies/Another Old (1999)/x.mkv';
  const r5 = await runOnce(ctx);
  assert.strictEqual(r5.converged, true, 'retry after abort converges');
  assert.ok(!fs.existsSync(path.join(folderRoot, 'movies/Another Old (1999)')), 'pruned on the healthy retry');
  assert.ok(!reports[reports.length - 1].inventory.some(f => f.relPath.startsWith('movies/Another Old')), 'r5\'s own report already excludes the file it just pruned — no separate settle run needed');

  // --- heartbeat delivery failure must not read as a clean run ---
  // r5 already reported the settled post-prune inventory in the SAME run (the fix under test),
  // so the very next call is already a true no-op — no extra "settle" run needed first. Make the
  // report endpoint fail on it: the undeliverable heartbeat must set a non-zero exit code, not a
  // masked "clean skip" the systemd timer trusts.
  failReports = true;
  const r6 = await runOnce(ctx);
  assert.strictEqual(r6.skipped, true, 'r6 is a no-op run — r5 already settled the inventory');
  assert.strictEqual(r6.heartbeat, false, 'an undeliverable heartbeat is not reported as healthy');
  assert.strictEqual(process.exitCode, 1, 'undeliverable heartbeat sets a non-zero exit code');
  process.exitCode = 0;
  failReports = false;

  // --- a benign per-file skip must NOT report the node as unconverged ---
  // The agent advances its own plan hash after a skip and never retries that plan, so reporting
  // converged:false for one would wedge the node at "published but pending" with nothing able to
  // clear it — and the bot only carries a node's hysteresis keep-set forward from a CONVERGED
  // state, so the node would also re-derive its keep set from scratch on every later plan.
  mkMedia('movies/Skippable (1998)/s.mkv', 1024);
  // A drop whose path escapes the folder root is the cheapest way to force the skip branch; the
  // real file alongside it must still be pruned in the same run.
  doomedAtScan = 'movies/Skippable (1998)/s.mkv';
  manifest = mkManifest([
    { relPath: 'movies/Skippable (1998)/s.mkv', sizeBytes: 1024 },
    { relPath: '../outside/evil.mkv', sizeBytes: 1 },
  ]);
  const before = reports.length;
  const r8 = await runOnce(ctx);
  const rep8 = reports[before];
  assert.strictEqual(r8.converged, true, 'a benign skip still converges — the file is ignored either way');
  assert.strictEqual(rep8.errors.length, 0, 'a skip is not reported as an error');
  assert.strictEqual(rep8.skipped.length, 1, 'the skip is reported separately, so it stays visible');
  assert.match(rep8.skipped[0], /escapes folder root/, 'and says what was skipped and why');
  assert.notStrictEqual(process.exitCode, 1, 'a benign skip does not fail the systemd unit');
  assert.ok(!fs.existsSync(path.join(folderRoot, 'movies/Skippable (1998)/s.mkv')), 'the legitimate drop in the same run is still pruned');
  assert.ok(!fs.existsSync(path.join(tmp, 'outside/evil.mkv')), 'the escaping path was never touched');

  botSrv.close();
  stSrv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
