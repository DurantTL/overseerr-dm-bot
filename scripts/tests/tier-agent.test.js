#!/usr/bin/env node
// Node sync-agent against mock bot + Syncthing HTTP: the ignore-before-prune ordering, the
// receive-only safety abort, path confinement, the atime inventory report, and the no-op
// skip on an unchanged plan hash.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildCtx, runOnce } = require('../../agent/agent');
const { renderSyncthingStignore, computePlanHash } = require('../../src/tier');

(async () => {
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
  assert.ok(r1.errors.some(e => e.includes('../outside')), 'escaping path reported, not silently skipped');
  assert.strictEqual(reports.length, 1, 'report posted');
  assert.ok(reports[0].inventory.some(f => f.relPath === 'movies/Keep Movie (2024)/keep.mkv'), 'inventory reports kept media files');
  assert.ok(reports[0].inventory.every(f => Number.isFinite(f.atime) && f.sizeBytes >= 0), 'inventory rows carry atime + size');
  process.exitCode = 0; // the traversal entry counts as an error by design; reset for the suite

  // --- run 2: plan unchanged, inventory changed (the prune itself changed it) → report only ---
  stCalls.length = 0;
  await runOnce(ctx);
  assert.deepStrictEqual(stCalls, [], 'unchanged plan → Syncthing untouched');
  assert.strictEqual(reports.length, 2, 'post-prune inventory delta still reported');
  assert.ok(!reports[1].inventory.some(f => f.relPath.startsWith('movies/Old Movie')), 'pruned files gone from the report');

  // --- run 3: nothing changed at all → skip the heavy work, but still heartbeat ---
  const r3 = await runOnce(ctx);
  assert.strictEqual(r3.skipped, true, 'unchanged plan + unchanged inventory → skip prune/inventory');
  assert.strictEqual(r3.heartbeat, true, 'a no-op run still checks in');
  assert.strictEqual(reports.length, 3, 'no-op run posts a lightweight heartbeat (proof of life)');
  assert.strictEqual(reports[2].heartbeat, true, 'the no-op post is a heartbeat');
  assert.ok(!reports[2].inventory, 'heartbeat carries no inventory payload');

  // --- receive-only violation: abort before touching anything ---
  mkMedia('movies/Another Old (1999)/x.mkv', 1024);
  manifest = mkManifest([{ mediaId: 'tmdb:3', relPath: 'movies/Another Old (1999)', sizeBytes: 1024 }]);
  folderType = 'sendreceive';
  stCalls.length = 0;
  const r4 = await runOnce(ctx);
  assert.ok(r4.errors.some(e => e.includes('SAFETY ABORT')), 'send-receive folder → hard abort');
  assert.deepStrictEqual(stCalls, ['config'], 'abort happens at the topology check — no rescan, no prune');
  assert.ok(fs.existsSync(path.join(folderRoot, 'movies/Another Old (1999)/x.mkv')), 'nothing deleted on abort');
  assert.strictEqual(reports.length, 4, 'abort still reported to the bot (after run 3\'s heartbeat)');
  process.exitCode = 0;

  // --- fixed folder type: the same plan converges on the next run (state not poisoned) ---
  folderType = 'receiveonly';
  doomedAtScan = 'movies/Another Old (1999)/x.mkv';
  const r5 = await runOnce(ctx);
  assert.strictEqual(r5.converged, true, 'retry after abort converges');
  assert.ok(!fs.existsSync(path.join(folderRoot, 'movies/Another Old (1999)')), 'pruned on the healthy retry');

  // --- heartbeat delivery failure must not read as a clean run ---
  // r5 pruned a file, so r6 reports the post-prune inventory delta (a full report), and r7 is then a
  // true no-op that only heartbeats. Make the report endpoint fail on r7: the undeliverable
  // heartbeat must set a non-zero exit code, not a masked "clean skip" the systemd timer trusts.
  await runOnce(ctx);                       // r6: settle the post-prune inventory
  process.exitCode = 0;
  failReports = true;
  const r7 = await runOnce(ctx);
  assert.strictEqual(r7.skipped, true, 'r7 is still a no-op run');
  assert.strictEqual(r7.heartbeat, false, 'an undeliverable heartbeat is not reported as healthy');
  assert.strictEqual(process.exitCode, 1, 'undeliverable heartbeat sets a non-zero exit code');
  process.exitCode = 0;
  failReports = false;

  botSrv.close();
  stSrv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('tier-agent.test.js: all assertions passed');
})().catch(err => { console.error(err); process.exit(1); });
