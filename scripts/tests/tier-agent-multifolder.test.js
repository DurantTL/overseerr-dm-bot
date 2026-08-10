#!/usr/bin/env node
// R2.1 multi-folder sync agent: one manifest that spans several Syncthing folders. The agent
// must assert Receive Only on EVERY folder, write each folder's own .stignore into its own root,
// rescan+confirm each, prune within each root (traversal-confined), and report the inventory
// tagged with folder ids. Also covers TIER_FOLDERS parsing and the receive-only abort on ONE of
// several folders.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildCtx, runOnce, parseFolders, resolveFolderPlans } = require('../../agent/agent');
const { planTier, renderFolderStignore } = require('../../src/tier');

(async () => {
  // --- parseFolders: both forms ---
  assert.deepStrictEqual(
    parseFolders({ TIER_FOLDERS: 'mov:/data/Movies;tv:/data/TV Shows/' }),
    [{ id: 'mov', root: '/data/Movies' }, { id: 'tv', root: '/data/TV Shows' }],
    'compact id:path;id:path form (trailing slash trimmed)',
  );
  assert.deepStrictEqual(
    parseFolders({ TIER_FOLDERS: '[{"id":"mov","path":"/data/Movies"},{"id":"tv","path":"/data/TV"}]' }),
    [{ id: 'mov', root: '/data/Movies' }, { id: 'tv', root: '/data/TV' }],
    'JSON array form',
  );
  assert.deepStrictEqual(
    parseFolders({ SYNCTHING_FOLDER_ID: 'media', TIER_FOLDER_ROOT: '/media/' }),
    [{ id: 'media', root: '/media' }],
    'single-folder fallback from legacy env',
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-mf-test-'));
  const roots = {
    mov: path.join(tmp, 'Movies'),
    fourk: path.join(tmp, '4k'),
    tv: path.join(tmp, 'TV Shows'),
  };
  const mkMedia = (root, rel, bytes = 1024) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(bytes));
  };
  // Movies: a title to drop + a title to keep. 4k: a title to drop. TV: a title to keep.
  mkMedia(roots.mov, 'Old Movie (2001)/old.mkv', 4096);
  mkMedia(roots.mov, 'Keep Movie (2024)/keep.mkv', 2048);
  mkMedia(roots.fourk, 'Cold 4k (2010)/cold.mkv', 8192);
  mkMedia(roots.tv, 'Kept Show/S01/e1.mkv', 1024);
  for (const r of Object.values(roots)) fs.mkdirSync(path.join(r, '.stfolder'), { recursive: true });

  // --- build a real multi-folder manifest via the planner, then attach per-folder stignore ---
  const GB = 1024 ** 3;
  const NOW = Date.now();
  const daysAgo = d => NOW - d * 86400000;
  const home = { name: 'home', enabled: 1, full: 1, usable_bytes: 10000 * GB, headroom_pct: 0, access: 'open', demand_source: 'tautulli' };
  const cali = {
    name: 'cali', enabled: 1, usable_bytes: 20 * GB, headroom_pct: 0, access: 'open', demand_source: 'atime',
    folders: [
      { folderId: 'mov', folderRoot: '/remote/Movies' },   // planner-side roots differ from local
      { folderId: 'fourk', folderRoot: '/remote/4k' },
      { folderId: 'tv', folderRoot: '/remote/TV Shows' },
    ],
  };
  const t = (mediaId, mt, abs, hotDays) => ({ mediaId, title: mediaId, mediaType: mt, sizeBytes: 10 * GB, addedAt: daysAgo(400), path: abs, relPath: abs, _hot: hotDays });
  const inv = [
    t('tmdb:1', 'movie', '/remote/Movies/Old Movie (2001)'),
    t('tmdb:2', 'movie', '/remote/Movies/Keep Movie (2024)'),
    t('tmdb:3', 'movie', '/remote/4k/Cold 4k (2010)'),
    t('tvdb:4', 'tv', '/remote/TV Shows/Kept Show'),
  ];
  // atime: keep the 2024 movie + the show; the 2001 movie and the 4k title are cold → dropped.
  const atimeReports = { cali: [
    { folderId: 'mov', relPath: 'Keep Movie (2024)/keep.mkv', sizeBytes: 10 * GB, atime: daysAgo(1) },
    { folderId: 'tv', relPath: 'Kept Show/S01/e1.mkv', sizeBytes: 10 * GB, atime: daysAgo(2) },
    { folderId: 'mov', relPath: 'Old Movie (2001)/old.mkv', sizeBytes: 10 * GB, atime: daysAgo(200) },
    { folderId: 'fourk', relPath: 'Cold 4k (2010)/cold.mkv', sizeBytes: 10 * GB, atime: daysAgo(300) },
  ] };
  const planned = planTier({ nodes: [home, cali], inventory: inv, atimeReports, now: NOW }).manifests.cali;
  const manifest = { ...planned, folders: planned.folders.map(f => ({ ...f, stignore: renderFolderStignore(f, planned) })) };
  assert.strictEqual(manifest.drop.map(e => e.mediaId).sort().join(), 'tmdb:1,tmdb:3', 'planner dropped the two cold titles across two folders');

  // --- mock bot ---
  const reports = [];
  const bot = express();
  bot.use(express.json({ limit: '5mb' }));
  const requireToken = (req, res, next) => (req.headers.authorization === 'Bearer tok' ? next() : res.status(401).json({ error: 'nope' }));
  bot.get('/agent/manifest/:node', requireToken, (_req, res) => res.json(manifest));
  bot.post('/agent/report/:node', requireToken, (req, res) => { reports.push(req.body); res.json({ ok: true }); });
  const botSrv = await new Promise(r => { const s = bot.listen(0, () => r(s)); });

  // --- mock Syncthing: tracks per-folder calls, folder types settable per id ---
  const folderType = { mov: 'receiveonly', fourk: 'receiveonly', tv: 'receiveonly' };
  const scanned = [];
  const st = express();
  st.get('/rest/config/folders/:id', (req, res) => res.json({ id: req.params.id, type: folderType[req.params.id] || 'receiveonly' }));
  st.post('/rest/db/scan', (req, res) => {
    const id = req.query.folder;
    scanned.push(id);
    // stignore for THIS folder must already be on disk, and its doomed files must still exist.
    assert.ok(fs.existsSync(path.join(roots[id], '.stignore')), `stignore written to ${id} before its rescan`);
    res.json({});
  });
  st.get('/rest/db/ignores', (req, res) => {
    const id = req.query.folder;
    const lines = fs.readFileSync(path.join(roots[id], '.stignore'), 'utf8').split('\n').filter(l => l && !l.startsWith('//'));
    res.json({ ignore: lines });
  });
  const stSrv = await new Promise(r => { const s = st.listen(0, () => r(s)); });

  const stateDir = path.join(tmp, 'state');
  const ctx = buildCtx({
    TIER_BOT_URL: `http://127.0.0.1:${botSrv.address().port}`,
    TIER_NODE: 'cali',
    TIER_AGENT_TOKEN: 'tok',
    TIER_FOLDERS: `mov:${roots.mov};fourk:${roots.fourk};tv:${roots.tv}`,
    SYNCTHING_URL: `http://127.0.0.1:${stSrv.address().port}`,
    SYNCTHING_API_KEY: 'k',
    TIER_STATE_DIR: stateDir,
  });
  ctx.log = () => {};

  // resolveFolderPlans maps the manifest's remote roots onto the local roots by folder id.
  const fps = resolveFolderPlans(ctx, manifest);
  assert.strictEqual(fps.length, 3, 'one plan per folder');
  assert.strictEqual(fps.find(f => f.folderId === 'mov').folderRoot, roots.mov, 'local root used, not the manifest\'s remote root');

  // --- run 1: converge every folder ---
  const r1 = await runOnce(ctx);
  assert.deepStrictEqual(scanned.slice().sort(), ['fourk', 'mov', 'tv'], 'every folder rescanned (receive-only asserted + ignores written first)');
  assert.ok(!fs.existsSync(path.join(roots.mov, 'Old Movie (2001)')), 'cold movie pruned from Movies root');
  assert.ok(!fs.existsSync(path.join(roots.fourk, 'Cold 4k (2010)')), 'cold title pruned from the 4k root');
  assert.ok(fs.existsSync(path.join(roots.mov, 'Keep Movie (2024)/keep.mkv')), 'kept movie untouched');
  assert.ok(fs.existsSync(path.join(roots.tv, 'Kept Show/S01/e1.mkv')), 'kept show untouched');
  // Freed bytes are estimated from the planner's inventory size (each dropped title is 10 GB here),
  // not a synchronous walk of the on-disk stub files — the two cold titles sum to 20 GB.
  assert.strictEqual(r1.bytesFreed, 2 * 10 * GB, 'bytes freed summed across folders from inventory sizes');
  assert.strictEqual(r1.errors.length, 0, 'clean converge');
  assert.ok(r1.dropped.every(d => d.folderId), 'each drop attributed to its folder');
  // Inventory report is aggregated across all folders and tagged with folder ids.
  const inv1 = reports[0].inventory;
  assert.ok(inv1.some(f => f.folderId === 'mov' && f.relPath === 'Keep Movie (2024)/keep.mkv'), 'Movies inventory folder-relative + tagged');
  assert.ok(inv1.some(f => f.folderId === 'tv' && f.relPath === 'Kept Show/S01/e1.mkv'), 'TV inventory tagged');
  // The inventory is walked BEFORE the prune loop runs, but the REPORT reconciles it against
  // what actually got pruned this same run — the 4k root's only file was just dropped above, so
  // it must already be gone from THIS report, not lingering until a later run catches up.
  assert.ok(!inv1.some(f => f.folderId === 'fourk'), 'the just-pruned 4k folder is already empty in the same report — no stale pre-prune entries');

  // --- run 2: plan unchanged, and the inventory was already settled by run 1's own report →
  // a true no-op heartbeat, not a second full report ---
  scanned.length = 0;
  const r2noop = await runOnce(ctx);
  assert.deepStrictEqual(scanned, [], 'unchanged plan → Syncthing untouched');
  assert.strictEqual(r2noop.skipped, true, 'no-op skip on unchanged plan + already-settled inventory');
  assert.strictEqual(r2noop.heartbeat, true, 'a no-op run still checks in');
  assert.strictEqual(reports.length, 2, 'no-op run posts a lightweight heartbeat');
  assert.strictEqual(reports[1].heartbeat, true, 'the no-op post is a heartbeat, not a full report');

  // --- receive-only violation on ONE folder aborts that folder, still processes the safe ones ---
  folderType.fourk = 'sendreceive';
  mkMedia(roots.mov, 'Another Cold (1999)/x.mkv', 512);
  mkMedia(roots.fourk, 'New Cold 4k/y.mkv', 512);
  // New manifest: drop the two new cold titles (bump plan hash).
  const inv2 = [
    ...inv,
    t('tmdb:5', 'movie', '/remote/Movies/Another Cold (1999)'),
    t('tmdb:6', 'movie', '/remote/4k/New Cold 4k'),
  ];
  const atime2 = { cali: [...atimeReports.cali,
    { folderId: 'mov', relPath: 'Another Cold (1999)/x.mkv', sizeBytes: 10 * GB, atime: daysAgo(500) },
    { folderId: 'fourk', relPath: 'New Cold 4k/y.mkv', sizeBytes: 10 * GB, atime: daysAgo(500) },
  ] };
  const planned2 = planTier({ nodes: [home, cali], inventory: inv2, atimeReports: atime2, now: NOW }).manifests.cali;
  manifest.folders = planned2.folders.map(f => ({ ...f, stignore: renderFolderStignore(f, planned2) }));
  manifest.drop = planned2.drop;
  manifest.keep = planned2.keep;
  manifest.planHash = planned2.planHash;

  const r3 = await runOnce(ctx);
  assert.ok(r3.errors.some(e => e.includes('SAFETY ABORT')), 'the send-receive folder hard-aborts');
  assert.ok(fs.existsSync(path.join(roots.fourk, 'New Cold 4k/y.mkv')), 'nothing deleted in the flipped folder');
  assert.ok(!fs.existsSync(path.join(roots.mov, 'Another Cold (1999)')), 'the healthy Movies folder still converged');
  assert.strictEqual(r3.converged, false, 'a folder abort means the run did not fully converge');

  botSrv.close();
  stSrv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = 0;
  console.log('tier-agent-multifolder.test.js: all assertions passed');
})().catch(err => { console.error(err); process.exit(1); });
