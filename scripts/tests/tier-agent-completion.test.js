#!/usr/bin/env node
// §182 follow-up: the agent's per-folder Syncthing completion signal (collectFolderCompletion),
// the report route's sanitizeFolderCompletion, and the tier-plan storage it lands in
// (recordTierFolderCompletion), plus the audit-trail counter the diagnostics summary reads
// (countAuditActionsSince). The agent half is exercised against a real local HTTP server that
// fakes just enough of Syncthing's REST surface (/rest/system/status, /rest/db/completion);
// the db half uses a scratch database like scripts/tests/edge-diagnostics.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { collectFolderCompletion } = require('../../agent/agent');
const { sanitizeFolderCompletion } = require('../../src/routes/tier-agent');

function mkSyncthing({ myID = 'LOCAL-DEVICE-ID', completion = {} } = {}) {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/rest/system/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ myID }));
    }
    if (url.pathname === '/rest/db/completion') {
      const folder = url.searchParams.get('folder');
      if (completion[folder] === 'boom') {
        res.writeHead(500);
        return res.end('nope');
      }
      const c = completion[folder] || { completion: 100, globalBytes: 1000, needBytes: 0, needItems: 0 };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(c));
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({
    srv,
    url: `http://127.0.0.1:${srv.address().port}`,
    close: () => new Promise(r => srv.close(r)),
  })));
}

const mkCtx = url => ({ syncthingUrl: url, syncthingApiKey: '', timeoutMs: 5000, log: () => {} });

test('tier-agent-completion: collectFolderCompletion reports per-folder completion from Syncthing', async t => {
  const { url, close } = await mkSyncthing({
    completion: {
      'movies-id': { completion: 100, globalBytes: 50e9, needBytes: 0, needItems: 0 },
      'tv-id': { completion: 42.5, globalBytes: 200e9, needBytes: 115e9, needItems: 17 },
    },
  });
  t.after(close);
  const out = await collectFolderCompletion(mkCtx(url), [
    { folderId: 'movies', syncFolderId: 'movies-id' },
    { folderId: 'tv', syncFolderId: 'tv-id' },
  ]);
  assert.deepStrictEqual(out, [
    { folderId: 'movies', syncFolderId: 'movies-id', completion: 100, globalBytes: 50000000000, needBytes: 0, needItems: 0 },
    { folderId: 'tv', syncFolderId: 'tv-id', completion: 42.5, globalBytes: 200000000000, needBytes: 115000000000, needItems: 17 },
  ], 'keyed by the planner folderId the bot maps titles through, carrying the Syncthing folder id too');
});

test('tier-agent-completion: a failing folder is omitted, not fatal; an unreachable daemon yields null', async t => {
  const { url, close } = await mkSyncthing({
    completion: { 'bad-id': 'boom', 'good-id': { completion: 100, globalBytes: 1, needBytes: 0, needItems: 0 } },
  });
  t.after(close);
  const out = await collectFolderCompletion(mkCtx(url), [
    { folderId: 'bad', syncFolderId: 'bad-id' },
    { folderId: 'good', syncFolderId: 'good-id' },
  ]);
  assert.strictEqual(out.length, 1, 'the 500ing folder is omitted');
  assert.strictEqual(out[0].folderId, 'good');

  const dead = await collectFolderCompletion(mkCtx('http://127.0.0.1:1'), [{ folderId: 'x', syncFolderId: 'y' }]);
  assert.strictEqual(dead, null, 'Syncthing unreachable → null, never a throw');
});

test('tier-agent-completion: completion is clamped and non-numeric snapshots are dropped', async t => {
  const { url, close } = await mkSyncthing({
    completion: { 'weird-id': { completion: 140, globalBytes: 'lots', needBytes: -3, needItems: 2.7 } },
  });
  t.after(close);
  const out = await collectFolderCompletion(mkCtx(url), [{ folderId: 'weird', syncFolderId: 'weird-id' }]);
  assert.strictEqual(out[0].completion, 100, 'clamped to 0–100');
  assert.strictEqual(out[0].globalBytes, 0, 'non-numeric byte counts floor to 0');
  assert.strictEqual(out[0].needBytes, 0, 'negative byte counts floor to 0');
  assert.strictEqual(out[0].needItems, 2, 'item counts are floored');
});

test('tier-agent-completion: sanitizeFolderCompletion validates the inbound snapshot', () => {
  assert.strictEqual(sanitizeFolderCompletion(null), null);
  assert.strictEqual(sanitizeFolderCompletion('junk'), null);
  assert.strictEqual(sanitizeFolderCompletion([]), null);
  assert.deepStrictEqual(
    sanitizeFolderCompletion([
      { folderId: 'movies', completion: 99.5, globalBytes: 10, needBytes: 1, needItems: 2 },
      { folderId: '', completion: 50 },
      { folderId: 'nope' },
      { folderId: 'over', completion: 250 },
      null,
    ]),
    [
      { folderId: 'movies', completion: 99.5, globalBytes: 10, needBytes: 1, needItems: 2 },
      { folderId: 'over', completion: 100, globalBytes: 0, needBytes: 0, needItems: 0 },
    ],
    'keeps valid rows, clamps completion, drops rows without a folderId or numeric completion',
  );
  const many = Array.from({ length: 40 }, (_, i) => ({ folderId: `f${i}`, completion: 100 }));
  assert.strictEqual(sanitizeFolderCompletion(many).length, 25, 'capped at 25 folders');
});

// ---- db half: scratch database, same pattern as edge-diagnostics.test.js ----
function withScratchDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-completion-db-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/db')];
  try {
    const db = require('../../src/db');
    db.runMigrations();
    return fn(db);
  } finally {
    delete process.env.DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('tier-agent-completion: recordTierFolderCompletion round-trips on the tier plan', () => {
  withScratchDb(db => {
    const at = Date.now();
    const folders = [{ folderId: 'movies', completion: 100, globalBytes: 5e10, needBytes: 0, needItems: 0 }];
    db.recordTierFolderCompletion('california', { at, folders });
    const plan = db.getTierPlan('california');
    // The read normalizer keeps only what the locality decision needs (folderId + completion)
    // and validates the shape defensively.
    assert.deepStrictEqual(plan.folderCompletion, { at, folders: [{ folderId: 'movies', completion: 100 }] });
    // A second report replaces the snapshot — never appends.
    db.recordTierFolderCompletion('california', { at: at + 1, folders: [] });
    assert.strictEqual(db.getTierPlan('california').folderCompletion, null, 'an empty folder list normalizes to null');
  });
});

test('tier-agent-completion: countAuditActionsSince counts by action inside the window', () => {
  withScratchDb(db => {
    db.audit('edge_playback_observed', { edge: 'california' });
    db.audit('edge_playback_observed', { edge: 'california' });
    db.audit('edge_promote_would_pin', {});
    db.audit('unrelated_action', {});
    const counts = db.countAuditActionsSince(
      ['edge_playback_observed', 'edge_promote_would_pin', 'edge_promote_pinned'],
      Date.now() - 3600000,
    );
    assert.deepStrictEqual(counts, {
      edge_playback_observed: 2,
      edge_promote_would_pin: 1,
      edge_promote_pinned: 0,
    }, 'missing actions come back 0; unrelated actions are excluded');
    const old = db.countAuditActionsSince(['edge_playback_observed'], Date.now() + 1000);
    assert.strictEqual(old.edge_playback_observed, 0, 'a future window sees nothing');
    assert.deepStrictEqual(db.countAuditActionsSince([], Date.now()), {}, 'empty input never throws');
  });
});
