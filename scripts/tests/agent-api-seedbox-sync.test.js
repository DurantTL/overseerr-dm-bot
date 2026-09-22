#!/usr/bin/env node
// The seedbox sync job model behind POST /api/v1/seedbox/sync and GET /seedbox/sync-status.
//
// The old model tracked state in marker files next to the media, which lied in two directions: a
// marker orphaned by a restart reported a folder as syncing forever (the cleanup lived in the
// child's close handler, which dies with the parent), and any folder that merely existed on disk
// reported `done` — so a half-copied season looked complete and got imported. State now lives in
// memory, where it can only be honest, and a staged folder with no job behind it is `unknown`.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { EventEmitter } = require('node:events');
const { createApp, listen, close } = require('../../src/app');
const { registerAgentApiRoutes } = require('../../src/routes/agent-api');
const { sha256, safeEqual } = require('../../src/util');

function request(port, { method = 'GET', path = '/', token, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    let payload = null;
    if (body !== null) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
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

const post = (port, path, body) => request(port, { method: 'POST', path, token: 'valid-agent-token', body });
const get = (port, path) => request(port, { path, token: 'valid-agent-token' });

// A stand-in for the rclone child: the test decides when (and how) it exits, so the
// in-progress -> done/failed transitions are observable rather than timing-dependent.
function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  return child;
}

function setup({ configOverrides = {}, spawnImpl } = {}) {
  const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'seedbox-sync-'));
  const staging = nodePath.join(tmp, 'staging');
  fs.mkdirSync(staging, { recursive: true });
  const tokenHash = sha256('valid-agent-token');
  const auditCalls = [];
  const spawns = [];
  const children = [];
  const app = createApp();
  registerAgentApiRoutes(app, {
    config: {
      AGENT_API_READ_MAX_PER_MINUTE: 1000,
      AGENT_API_WRITE_MAX_PER_MINUTE: 1000,
      GRAB_RCLONE_REMOTE: 'seedbox:/downloads',
      GRAB_STAGING_PATH: staging,
      GRAB_RCLONE_FLAGS: ['--config', '/app/data/rclone.conf'],
      ...configOverrides,
    },
    getAgentApiTokenHashes: () => [tokenHash],
    getAgentApiTokenLabel: hash => (hash === tokenHash ? 'test-client' : null),
    touchAgentApiTokenUse: () => {},
    sha256,
    safeEqual,
    audit: (action, details) => auditCalls.push({ action, details }),
    gatherHealth: async () => ({ overall: 'ok' }),
    fetchArrQueues: async () => [],
    fetchSeerrRequests: async () => [],
    getPlexToken: async () => 'plex-token',
    getPlexServers: async () => [],
    httpRateLimitKey: () => 'test',
    httpClient: { get: async () => ({ data: {} }), post: async () => ({ data: {} }) },
    spawnProcess: spawnImpl || ((bin, args, opts) => {
      spawns.push({ bin, args, opts });
      const child = fakeChild();
      children.push(child);
      return child;
    }),
  });
  return { app, auditCalls, spawns, children, tmp, staging };
}

async function withServer(fixture, fn) {
  const server = await listen(fixture.app, 0);
  try {
    return await fn(server.address().port);
  } finally {
    await close(server);
    fs.rmSync(fixture.tmp, { recursive: true, force: true });
  }
}

test('sync refuses a second run for the same folder while one is in flight', async () => {
  const fixture = setup();
  await withServer(fixture, async port => {
    const first = await post(port, '/api/v1/seedbox/sync', { folder: 'Season 4' });
    assert.strictEqual(first.statusCode, 202);
    assert.strictEqual(JSON.parse(first.body).status, 'in-progress');
    assert.strictEqual(fixture.spawns.length, 1, 'one rclone started');

    const second = await post(port, '/api/v1/seedbox/sync', { folder: 'Season 4' });
    assert.strictEqual(second.statusCode, 409, 'the same folder is refused while it runs');
    assert.match(JSON.parse(second.body).error, /already running/);
    assert.strictEqual(fixture.spawns.length, 1, 'no second rclone was spawned onto the same dest');
    assert.ok(
      fixture.auditCalls.some(c => c.action === 'agent_api_seedbox_sync' && c.details.reason === 'already_running'),
      'the refusal is audited',
    );

    // A different folder is unaffected — the guard is per folder, not global.
    const other = await post(port, '/api/v1/seedbox/sync', { folder: 'Season 5' });
    assert.strictEqual(other.statusCode, 202);
    assert.strictEqual(fixture.spawns.length, 2);

    // Once it finishes, the same folder may be synced again (rclone copies are resumable).
    fixture.children[0].emit('close', 0);
    const again = await post(port, '/api/v1/seedbox/sync', { folder: 'Season 4' });
    assert.strictEqual(again.statusCode, 202, 'a finished folder can be re-synced');
  });
});

test('sync-status reports in-progress, then done, from the job rather than from disk', async () => {
  const fixture = setup();
  await withServer(fixture, async port => {
    const started = await post(port, '/api/v1/seedbox/sync', { folder: 'Season 4' });
    assert.strictEqual(started.statusCode, 202);

    const running = JSON.parse((await get(port, '/api/v1/seedbox/sync-status?folder=Season%204')).body);
    assert.strictEqual(running.status, 'in-progress');
    assert.strictEqual(running.finished, null);

    // rclone writes the folder as it goes; mid-copy the status must not read as done.
    fs.mkdirSync(nodePath.join(fixture.staging, 'Season 4'), { recursive: true });
    fs.writeFileSync(nodePath.join(fixture.staging, 'Season 4', 'ep01.mkv'), 'partial');
    const midCopy = JSON.parse((await get(port, '/api/v1/seedbox/sync-status?folder=Season%204')).body);
    assert.strictEqual(midCopy.status, 'in-progress', 'a folder existing on disk does not mean done');
    assert.strictEqual(midCopy.fileCount, 1, 'progress is still reported while running');
    assert.strictEqual(midCopy.totalBytes, 7);

    fixture.children[0].emit('close', 0);
    const done = JSON.parse((await get(port, '/api/v1/seedbox/sync-status?folder=Season%204')).body);
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(done.exitCode, 0);
    assert.ok(done.finished, 'a finished job records when');
    assert.strictEqual(done.error, null);
  });
});

test('sync-status calls a staged folder with no job unknown, never done', async () => {
  const fixture = setup();
  // A folder staged by a previous process (the bot restarted mid-copy, say). The old model
  // reported this as `done` purely because the directory existed.
  fs.mkdirSync(nodePath.join(fixture.staging, 'Season 9'), { recursive: true });
  fs.writeFileSync(nodePath.join(fixture.staging, 'Season 9', 'ep01.mkv'), 'half');
  await withServer(fixture, async port => {
    const res = JSON.parse((await get(port, '/api/v1/seedbox/sync-status?folder=Season%209')).body);
    assert.strictEqual(res.status, 'unknown', 'an unexplained folder is never reported as done');
    assert.match(res.detail, /may be incomplete/);
    assert.strictEqual(res.fileCount, 1, 'what is on disk is still reported');

    const absent = JSON.parse((await get(port, '/api/v1/seedbox/sync-status?folder=Nope')).body);
    assert.strictEqual(absent.status, 'not-started');
  });
});

test('an orphaned in-progress marker no longer pins a folder to syncing forever', async () => {
  const fixture = setup();
  // Exactly what the old model left behind when the bot died mid-copy.
  fs.writeFileSync(nodePath.join(fixture.staging, 'Season 4.sync-in-progress'), '{}');
  fs.mkdirSync(nodePath.join(fixture.staging, 'Season 4'), { recursive: true });
  await withServer(fixture, async port => {
    const stale = JSON.parse((await get(port, '/api/v1/seedbox/sync-status?folder=Season%204')).body);
    assert.strictEqual(stale.status, 'unknown', 'the stale marker is ignored, not believed');

    // A new sync clears its own leftovers: a stray marker in staging is an unmatched file that
    // would make a Move import-scan refuse.
    const res = await post(port, '/api/v1/seedbox/sync', { folder: 'Season 4' });
    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(
      fs.existsSync(nodePath.join(fixture.staging, 'Season 4.sync-in-progress')),
      false,
      'the legacy marker is cleaned up',
    );
  });
});

test('a failed sync reports an exit code with no raw rclone output or stack', async () => {
  const fixture = setup();
  await withServer(fixture, async port => {
    await post(port, '/api/v1/seedbox/sync', { folder: 'Season 4' });
    // rclone's stderr can echo the remote and its credentials, so it must never reach the caller.
    fixture.children[0].stderr.emit('data', 'ERROR: seedbox:/downloads — auth failed for user hunter2\n');
    fixture.children[0].emit('close', 3);

    const failed = JSON.parse((await get(port, '/api/v1/seedbox/sync-status?folder=Season%204')).body);
    assert.strictEqual(failed.status, 'failed');
    assert.strictEqual(failed.exitCode, 3);
    assert.strictEqual(failed.error, 'rclone exited 3');
    assert.strictEqual(failed.errorCode, 'EXIT_3');
    assert.ok(!/hunter2/.test(JSON.stringify(failed)), 'rclone stderr never reaches the caller');
    // It does reach the audit log, where only operators see it — otherwise a failure is
    // undiagnosable.
    const audited = fixture.auditCalls.find(c => c.details.reason === 'rclone_failed');
    assert.ok(audited, 'the failure is audited');
    assert.match(String(audited.details.error), /auth failed/, 'the audit keeps the rclone output');
  });
});

test('a spawn failure is a failed job and a fixed 502, not the raw error', async () => {
  const fixture = setup({
    spawnImpl: () => { const err = new Error('spawn /usr/bin/rclone ENOENT'); err.code = 'ENOENT'; throw err; },
  });
  await withServer(fixture, async port => {
    const res = await post(port, '/api/v1/seedbox/sync', { folder: 'Season 4' });
    assert.strictEqual(res.statusCode, 502);
    const body = JSON.parse(res.body);
    assert.match(body.error, /Failed to start rclone/);
    assert.ok(!/ENOENT|usr\/bin/.test(body.error), 'no binary path or errno in the response body');
    assert.strictEqual(body.stack, undefined, 'no stack trace is ever returned');

    const status = JSON.parse((await get(port, '/api/v1/seedbox/sync-status?folder=Season%204')).body);
    assert.strictEqual(status.status, 'failed', 'the job records the failure for a later poll');
    assert.strictEqual(status.errorCode, 'ENOENT');
  });
});

test('sync keeps its folder guards and passes the configured rclone flags through', async () => {
  const fixture = setup();
  await withServer(fixture, async port => {
    for (const folder of ['../evil', 'a/./b', '.incoming', '.incoming/x', '']) {
      const res = await post(port, '/api/v1/seedbox/sync', { folder });
      assert.strictEqual(res.statusCode, 400, `${JSON.stringify(folder)} is refused`);
    }
    assert.strictEqual(fixture.spawns.length, 0, 'no rclone ran for any refused folder');

    await post(port, '/api/v1/seedbox/sync', { folder: 'Season 4' });
    const call = fixture.spawns[0];
    assert.deepStrictEqual(call.args, [
      'copy', 'seedbox:/downloads/Season 4', nodePath.join(fixture.staging, 'Season 4'),
      '--config', '/app/data/rclone.conf',
    ]);
    assert.deepStrictEqual(call.opts.stdio, ['ignore', 'ignore', 'pipe'], 'stderr is captured for the audit');
  });
});

test('sync refuses when the staging filesystem is nearly full', async () => {
  const fixture = setup();
  const realStatfs = fs.statfsSync;
  // bavail, not bfree: bfree counts root-reserved blocks the bot's uid cannot write into.
  fs.statfsSync = () => ({ bavail: 1, bfree: 10n ** 9n, bsize: 4096 });
  try {
    await withServer(fixture, async port => {
      const res = await post(port, '/api/v1/seedbox/sync', { folder: 'Season 4' });
      assert.strictEqual(res.statusCode, 409);
      assert.match(JSON.parse(res.body).error, /GB free on staging/);
      assert.strictEqual(fixture.spawns.length, 0, 'nothing is spawned when the disk is full');
    });
  } finally {
    fs.statfsSync = realStatfs;
  }
});
