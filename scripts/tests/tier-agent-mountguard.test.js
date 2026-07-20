#!/usr/bin/env node
// Mount guard: the tier agent must refuse to write, prune, or (crucially) report an inventory
// when the external media drive is absent — otherwise a walk of the empty mount directory would
// post an empty inventory that wipes the node's known contents and re-seeds onto the system disk.
// Covers: guard off by default (back-compat), drive-missing abort, folder-outside-mount, and the
// healthy pass-through where the guard is a no-op and normal convergence still happens.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildCtx, runOnce, checkMountGuard } = require('../../agent/agent');
const { renderSyncthingStignore, computePlanHash } = require('../../src/tier');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-mountguard-'));
  const mountRoot = path.join(tmp, 'media');       // stands in for /mnt/media
  const folderRoot = path.join(mountRoot, 'Movies');
  const stateDir = path.join(tmp, 'state');
  const mkMedia = (rel, bytes = 1024) => {
    const abs = path.join(folderRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(bytes));
  };
  mkMedia('Old Movie (2001)/old.mkv', 4096);
  mkMedia('Keep Movie (2024)/keep.mkv', 2048);
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
  bot.get('/agent/manifest/:node', requireToken, (_req, res) => res.json(manifest));
  bot.post('/agent/report/:node', requireToken, (req, res) => { reports.push(req.body); res.json({ ok: true }); });
  const botSrv = await new Promise(r => { const s = bot.listen(0, () => r(s)); });

  // --- mock Syncthing (should be untouched whenever the guard fails) ---
  const stCalls = [];
  const st = express();
  st.get('/rest/config/folders/:id', (req, res) => { stCalls.push('config'); res.json({ id: req.params.id, type: 'receiveonly' }); });
  st.post('/rest/db/scan', (_req, res) => { stCalls.push('scan'); res.json({}); });
  st.get('/rest/db/ignores', (_req, res) => {
    stCalls.push('ignores');
    const lines = fs.readFileSync(path.join(folderRoot, '.stignore'), 'utf8').split('\n').filter(l => l && !l.startsWith('//'));
    res.json({ ignore: lines });
  });
  const stSrv = await new Promise(r => { const s = st.listen(0, () => r(s)); });

  manifest = (() => {
    const m = {
      node: 'ph', generatedAt: new Date().toISOString(),
      keep: [{ mediaId: 'tmdb:2', relPath: 'Keep Movie (2024)', sizeBytes: 2048 }],
      drop: [{ mediaId: 'tmdb:1', relPath: 'Old Movie (2001)', sizeBytes: 4096 }],
    };
    m.planHash = computePlanHash(m);
    m.stignore = renderSyncthingStignore(m);
    return m;
  })();

  const mkCtx = extraEnv => {
    const ctx = buildCtx({
      TIER_BOT_URL: `http://127.0.0.1:${botSrv.address().port}`,
      TIER_NODE: 'ph',
      TIER_AGENT_TOKEN: 'test-token',
      TIER_FOLDER_ROOT: folderRoot,
      SYNCTHING_URL: `http://127.0.0.1:${stSrv.address().port}`,
      SYNCTHING_API_KEY: 'st-key',
      SYNCTHING_FOLDER_ID: 'media',
      TIER_STATE_DIR: stateDir,
      ...extraEnv,
    });
    ctx.log = () => {};
    return ctx;
  };

  // --- config: uuid/marker without a mount root is a hard config error ---
  assert.throws(() => buildCtx({
    TIER_BOT_URL: 'http://x', TIER_NODE: 'ph', TIER_AGENT_TOKEN: 't',
    TIER_FOLDER_ROOT: folderRoot, SYNCTHING_FOLDER_ID: 'media',
    TIER_EXPECTED_UUID: 'deadbeef',
  }), /require TIER_MOUNT_ROOT/, 'UUID without a mount root is rejected');

  // --- guard OFF by default: no TIER_MOUNT_ROOT → checked:false, run proceeds normally ---
  const offGuard = checkMountGuard(mkCtx({}));
  assert.strictEqual(offGuard.checked, false, 'no mount root → guard not checked');
  assert.strictEqual(offGuard.ok, true, 'no mount root → guard passes (back-compat)');

  // --- healthy: mount root set and proven present → guard passes, convergence as usual ---
  // A tmpdir is not a real mount point, so prove the drive with a sentinel marker (exactly the
  // cross-platform backstop the docs recommend); a real /mnt/media satisfies proof-1 on its own.
  fs.writeFileSync(path.join(mountRoot, '.tier-media-ok'), '');
  const okCtx = mkCtx({ TIER_MOUNT_ROOT: mountRoot, TIER_MOUNT_MARKER: '.tier-media-ok' });
  const okGuard = checkMountGuard(okCtx);
  assert.strictEqual(okGuard.ok, true, `healthy drive passes the guard (reasons: ${okGuard.reasons.join('; ')})`);
  const rOk = await runOnce(okCtx);
  assert.notStrictEqual(rOk.driveMissing, true, 'healthy run is not a drive-missing abort');
  assert.ok(!fs.existsSync(path.join(folderRoot, 'Old Movie (2001)')), 'dropped title pruned on the healthy run');
  assert.ok(fs.existsSync(path.join(folderRoot, 'Keep Movie (2024)/keep.mkv')), 'kept title untouched');
  assert.ok(reports.length >= 1 && Array.isArray(reports[reports.length - 1].inventory), 'healthy run reports an inventory');
  assert.deepStrictEqual(stCalls, ['config', 'scan', 'ignores'], 'healthy run drives Syncthing normally');
  process.exitCode = 0;

  // --- drive missing: mount root points at a path that is not a mount point / does not exist ---
  const before = reports.length;
  stCalls.length = 0;
  const missingCtx = mkCtx({ TIER_MOUNT_ROOT: path.join(tmp, 'not-mounted') });
  const missGuard = checkMountGuard(missingCtx);
  assert.strictEqual(missGuard.ok, false, 'absent mount root fails the guard');
  assert.ok(missGuard.reasons.some(r => /does not exist|not a mount point/.test(r)), 'reason names the missing drive');
  const rMiss = await runOnce(missingCtx);
  assert.strictEqual(rMiss.driveMissing, true, 'runOnce aborts with driveMissing');
  assert.strictEqual(stCalls.length, 0, 'Syncthing never touched when the drive is missing');
  assert.strictEqual(reports.length, before + 1, 'the drive-missing state is still reported to the bot');
  const rep = reports[reports.length - 1];
  assert.strictEqual(rep.driveMissing, true, 'report flags driveMissing');
  assert.ok(!('inventory' in rep), 'report OMITS inventory so the bot keeps last-known contents');
  assert.ok(Array.isArray(rep.mountErrors) && rep.mountErrors.length, 'report carries the mount errors');
  process.exitCode = 0;

  // --- folder outside the mount root: caught even if the mount root itself looks fine ---
  const strayRoot = path.join(tmp, 'stray');           // a folder NOT under mountRoot
  fs.mkdirSync(strayRoot, { recursive: true });
  const strayGuard = checkMountGuard(mkCtx({ TIER_MOUNT_ROOT: mountRoot, TIER_FOLDER_ROOT: strayRoot }));
  assert.strictEqual(strayGuard.ok, false, 'a folder root outside the mount is rejected');
  assert.ok(strayGuard.reasons.some(r => /outside the media mount/.test(r)), 'reason names the stray folder');

  // --- marker: absent sentinel fails even when the path exists (.tier-media-ok exists from the
  // healthy run above; a different, never-created marker must fail) ---
  const markerGuard = checkMountGuard(mkCtx({ TIER_MOUNT_ROOT: mountRoot, TIER_MOUNT_MARKER: '.absent-marker' }));
  assert.strictEqual(markerGuard.ok, false, 'missing marker fails the guard');
  assert.ok(markerGuard.reasons.some(r => /mount marker/.test(r)), 'reason names the missing marker');
  const markerOk = checkMountGuard(mkCtx({ TIER_MOUNT_ROOT: mountRoot, TIER_MOUNT_MARKER: '.tier-media-ok' }));
  assert.strictEqual(markerOk.ok, true, `present marker passes (reasons: ${markerOk.reasons.join('; ')})`);

  botSrv.close();
  stSrv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('tier-agent-mountguard.test.js: all assertions passed');
})().catch(err => { console.error(err); process.exit(1); });
