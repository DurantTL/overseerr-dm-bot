#!/usr/bin/env node
// syncthingApi() wraps a rejected fetch() as syncthingUnreachable so the caller retries the whole
// folder next cycle instead of hard-failing — but AbortSignal.timeout() can fire in two different
// places, and only one of them was ever exercised by a test (tier-agent.test.js's dead-port case,
// which is a connection REFUSAL, not a timeout at all). These tests exercise the actual timeout
// via a real HTTP server that stalls, covering both places the abort can land:
//   (a) before fetch() resolves at all — our own forced POST /rest/db/scan blocks server-side
//       until a large folder's scan completes, so no response arrives before TIER_HTTP_TIMEOUT_MS.
//   (b) after fetch() resolves, while res.text() is still streaming the body — e.g. a large
//       /rest/db/ignores payload slow to fully transmit on a loaded node.
// Both must be a benign skip-and-retry (converged:false, errors:[], skipped:[...], exitCode
// untouched), matching the connection-refused case already covered elsewhere.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildCtx, runOnce } = require('../../agent/agent');
const { renderSyncthingStignore, computePlanHash } = require('../../src/tier');

function mkTmp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-agent-timeout-'));
  const folderRoot = path.join(tmp, 'media');
  fs.mkdirSync(path.join(folderRoot, 'movies/Old Movie (2001)'), { recursive: true });
  fs.writeFileSync(path.join(folderRoot, 'movies/Old Movie (2001)/old.mkv'), Buffer.alloc(1024));
  return { tmp, folderRoot };
}

async function mkBot() {
  let manifest;
  const reports = [];
  const bot = express();
  bot.use(express.json());
  bot.get('/agent/manifest/:node', (_req, res) => res.json(manifest));
  bot.post('/agent/report/:node', (req, res) => { reports.push(req.body); res.json({ ok: true }); });
  const srv = await new Promise(r => { const s = bot.listen(0, () => r(s)); });
  return {
    srv,
    reports,
    setManifest: m => { manifest = m; },
    url: `http://127.0.0.1:${srv.address().port}`,
  };
}

function mkManifest() {
  const m = {
    node: 'timeout-test',
    generatedAt: new Date().toISOString(),
    keep: [],
    drop: [{ mediaId: 'tmdb:1', relPath: 'movies/Old Movie (2001)', sizeBytes: 1024 }],
  };
  m.planHash = computePlanHash(m);
  m.stignore = renderSyncthingStignore(m);
  return m;
}

test('tier-agent: our own forced db/scan stalling past the timeout is a benign retry, not a hard error', async () => {
  const { tmp, folderRoot } = mkTmp();
  const bot = await mkBot();
  bot.setManifest(mkManifest());

  // Raw http server (not express) so /rest/db/scan can simply never respond — reproducing
  // Syncthing blocking on POST /rest/db/scan until a large folder's initial scan completes.
  const st = http.createServer((req, res) => {
    if (req.url.startsWith('/rest/config/folders/')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ id: 'media', type: 'receiveonly' }));
    }
    if (req.url.startsWith('/rest/db/status')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ state: 'idle' }));
    }
    if (req.url.startsWith('/rest/db/scan')) {
      return; // never respond — the request just hangs until TIER_HTTP_TIMEOUT_MS aborts it
    }
    res.statusCode = 404;
    res.end();
  });
  const stSrv = await new Promise(r => st.listen(0, () => r(st)));

  const ctx = buildCtx({
    TIER_BOT_URL: bot.url,
    TIER_NODE: 'timeout-test',
    TIER_AGENT_TOKEN: 'test-token',
    TIER_FOLDER_ROOT: folderRoot,
    SYNCTHING_URL: `http://127.0.0.1:${stSrv.address().port}`,
    SYNCTHING_API_KEY: 'st-key',
    SYNCTHING_FOLDER_ID: 'media',
    TIER_STATE_DIR: path.join(tmp, 'state'),
    TIER_HTTP_TIMEOUT_MS: '150',
  });
  const logs = [];
  ctx.log = m => logs.push(m);

  const result = await runOnce(ctx);

  assert.strictEqual(result.converged, false, 'a stalled forced scan has not reached the plan yet');
  assert.strictEqual(result.errors.length, 0, 'a request timeout is not reported as a hard error');
  assert.ok(result.skipped.some(s => /unreachable/.test(s)), 'the skip is visible and explains why');
  assert.notStrictEqual(process.exitCode, 1, 'a stalled forced scan must not fail the systemd unit');
  assert.ok(fs.existsSync(path.join(folderRoot, 'movies/Old Movie (2001)/old.mkv')), 'nothing pruned while the scan call is stalled');
  assert.ok(logs.some(l => /unreachable/.test(l)), 'logged for operator visibility');

  await new Promise(r => stSrv.close(r));
  await new Promise(r => bot.srv.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('tier-agent: a response body that stalls mid-stream past the timeout is a benign retry, not a hard error', async () => {
  const { tmp, folderRoot } = mkTmp();
  const bot = await mkBot();
  bot.setManifest(mkManifest());

  // /rest/db/ignores sends headers and a partial body immediately (so fetch() itself resolves),
  // then never finishes writing — reproducing a large ignore list slow to fully stream on a
  // loaded node. This is the gap that used to fall through as an UNWRAPPED hard error, because it
  // fires during res.text() rather than during fetch() itself.
  const st = http.createServer((req, res) => {
    if (req.url.startsWith('/rest/config/folders/')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ id: 'media', type: 'receiveonly' }));
    }
    if (req.url.startsWith('/rest/db/status')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ state: 'idle' }));
    }
    if (req.url.startsWith('/rest/db/scan')) {
      res.setHeader('content-type', 'application/json');
      return res.end('{}');
    }
    if (req.url.startsWith('/rest/db/ignores')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"ignore": ['); // headers + partial body flushed — fetch() resolves here
      return; // then hang — res.text() is left waiting until the abort fires
    }
    res.statusCode = 404;
    res.end();
  });
  const stSrv = await new Promise(r => st.listen(0, () => r(st)));

  const ctx = buildCtx({
    TIER_BOT_URL: bot.url,
    TIER_NODE: 'timeout-test',
    TIER_AGENT_TOKEN: 'test-token',
    TIER_FOLDER_ROOT: folderRoot,
    SYNCTHING_URL: `http://127.0.0.1:${stSrv.address().port}`,
    SYNCTHING_API_KEY: 'st-key',
    SYNCTHING_FOLDER_ID: 'media',
    TIER_STATE_DIR: path.join(tmp, 'state'),
    TIER_HTTP_TIMEOUT_MS: '150',
  });
  const logs = [];
  ctx.log = m => logs.push(m);

  const result = await runOnce(ctx);

  assert.strictEqual(result.converged, false, 'an ignore-list stalled mid-stream has not confirmed the plan');
  assert.strictEqual(result.errors.length, 0, 'a body-read timeout is not reported as a hard error');
  assert.ok(result.skipped.some(s => /unreachable/.test(s)), 'the skip is visible and explains why');
  assert.notStrictEqual(process.exitCode, 1, 'a body-read timeout must not fail the systemd unit');
  assert.ok(fs.existsSync(path.join(folderRoot, 'movies/Old Movie (2001)/old.mkv')), 'nothing pruned while ignores are unconfirmed');

  await new Promise(r => stSrv.close(r));
  await new Promise(r => bot.srv.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});
