#!/usr/bin/env node
// /request helpers (search, request-as-user, Seerr user backfill), channel routing, config
// warnings, and Tautulli session formatting.
const assert = require('assert');
const axios = require('axios');
const express = require('express');
const { loadSandbox } = require('./extract');

const settingsStore = new Map();
const sandbox = loadSandbox(
  ['canonicalizeEmail', 'searchSeerr', 'createSeerrRequestAs', 'resolveSeerrUserId', 'fetchOverseerrUsers', 'channelFor', 'configWarnings', 'describeSession', 'stashPendingRequest', 'takePendingRequest', 'restashPendingRequest'],
  {
    axios,
    crypto: require('crypto'),
    CONFIG: {
      OVERSEERR_URL: '', OVERSEERR_API_KEY: 'k', ADMIN_CHANNEL_ID: 'ADMIN',
      TUNNEL_DOMAIN: 'x.example.com', WEBHOOK_SECRET: 's3cret', ENABLE_DELETION: false, DELETION_DRY_RUN: true,
      DASHBOARD_ENABLED: false, DASHBOARD_ADMIN_PASSWORD: '', DASHBOARD_ADMIN_TOKEN: '',
      PLAYBACK_CHECK_MINUTES: 5, PLAYBACK_CHANNEL_ID: '', TAUTULLI_URL: '', TAUTULLI_API_KEY: '',
    },
    markCalls: [],
    markOverseerrCreated: (discordId, id) => sandbox.markCalls.push({ discordId, id }),
    tautulliConfigured: () => !!(sandbox.CONFIG.TAUTULLI_URL && sandbox.CONFIG.TAUTULLI_API_KEY),
    // app_settings stand-in for the pending-request stash.
    getSetting: k => settingsStore.get(k) ?? null,
    setSetting: (k, v) => settingsStore.set(k, String(v)),
    db: { prepare: sql => ({ run: key => { if (/DELETE FROM app_settings/.test(sql)) settingsStore.delete(key); } }) },
  },
);

function mockSeerr() {
  const app = express();
  app.use(express.json());
  const state = { requests: [], failNext: null, users: [{ id: 9, email: 'Jane.Doe+x@gmail.com' }] };
  app.get('/api/v1/search', (req, res) => {
    state.lastSearchUrl = req.originalUrl;
    // Mimic the upstream Overseerr bug (sct/overseerr#2010): '+'-encoded spaces in the raw
    // query string are rejected with a 400. %20 must be used instead.
    if (String(req.originalUrl).includes('+')) return res.status(400).json({ message: 'invalid query' });
    res.json({ results: [
      { mediaType: 'person', id: 1, name: 'Someone' },
      { mediaType: 'movie', id: 603, title: 'The Matrix', releaseDate: '1999-03-30' },
      { mediaType: 'tv', id: 1396, name: 'Breaking Bad', firstAirDate: '2008-01-20' },
    ] });
  });
  app.get('/api/v1/user', (req, res) => res.json({ results: state.users }));
  app.post('/api/v1/request', (req, res) => {
    if (state.failNext) { const f = state.failNext; state.failNext = null; return res.status(f.code).json({ message: f.message }); }
    state.requests.push(req.body);
    res.json({ id: 77, status: 1, media: { tvdbId: req.body.mediaType === 'tv' ? 81189 : null } });
  });
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, state, port: server.address().port }));
  });
}

(async () => {
  const { server, state, port } = await mockSeerr();
  sandbox.CONFIG.OVERSEERR_URL = `http://127.0.0.1:${port}`;

  const results = await sandbox.run(`searchSeerr('matrix')`);
  assert.deepStrictEqual(results.map(r => r.mediaType), ['movie', 'tv'], 'person results filtered out');

  // Regression test for PR #18: multi-word queries must be %-encoded (%20), never '+', because
  // Overseerr 400s on '+'-encoded spaces. The mock rejects any '+' in the raw query string.
  const multi = await sandbox.run(`searchSeerr('the last of us')`);
  assert.strictEqual(multi.length, 2, 'multi-word search succeeds against a plus-rejecting server');
  assert.ok(state.lastSearchUrl.includes('the%20last%20of%20us'), `raw query uses %20 (got ${state.lastSearchUrl})`);
  assert.ok(!state.lastSearchUrl.includes('+'), 'raw query contains no + encoding');

  await sandbox.run(`createSeerrRequestAs(9, 'movie', 603, true)`);
  assert.deepStrictEqual(state.requests[0], { mediaType: 'movie', mediaId: 603, is4k: true, userId: 9 }, 'movie body: userId + is4k, no seasons');

  await sandbox.run(`createSeerrRequestAs(9, 'tv', 1396, false)`);
  assert.deepStrictEqual(state.requests[1], { mediaType: 'tv', mediaId: 1396, is4k: false, userId: 9, seasons: 'all' }, 'tv body: seasons all');

  state.failNext = { code: 409, message: 'Request for this media already exists.' };
  let surfaced = null;
  try { await sandbox.run(`createSeerrRequestAs(9, 'movie', 603, false)`); } catch (err) { surfaced = err.response?.data?.message; }
  assert.strictEqual(surfaced, 'Request for this media already exists.', 'Seerr rejection message surfaced');

  assert.strictEqual(await sandbox.run(`resolveSeerrUserId({ discord_id: '1', email: 'x@y.z', overseerr_user_id: 42 })`), 42, 'existing id used directly');
  assert.strictEqual(sandbox.markCalls.length, 0, 'no backfill when id present');
  assert.strictEqual(await sandbox.run(`resolveSeerrUserId({ discord_id: '2', email: 'janedoe@gmail.com', overseerr_user_id: null })`), 9, 'backfilled by canonical email');
  assert.deepStrictEqual(sandbox.markCalls, [{ discordId: '2', id: 9 }], 'backfill persisted');
  assert.strictEqual(await sandbox.run(`resolveSeerrUserId({ discord_id: '3', email: 'nobody@nowhere.io', overseerr_user_id: null })`), null, 'unknown email → null');
  server.close();

  // channelFor: fallback + override + deploy special case.
  const cf = k => sandbox.run(`channelFor('${k}')`);
  for (const kind of ['requests', 'system', 'downloads', 'cleanup', 'audit', 'playback', 'admin']) {
    assert.strictEqual(cf(kind), 'ADMIN', `${kind}: falls back to admin when unset`);
  }
  assert.strictEqual(cf('deploy') || null, null, 'deploy: NO fallback when unset');
  sandbox.CONFIG.REQUESTS_CHANNEL_ID = 'REQ';
  sandbox.CONFIG.DEPLOY_CHANNEL_ID = 'DEP';
  assert.strictEqual(cf('requests'), 'REQ', 'configured channel wins');
  assert.strictEqual(cf('deploy'), 'DEP', 'deploy sends when configured');
  assert.strictEqual(cf('cleanup'), 'ADMIN', 'other kinds still fall back');

  // configWarnings: quiet on a safe config, loud on risky combos. (length checks, not
  // deepStrictEqual — vm-realm arrays have a different Array prototype than the host's)
  assert.strictEqual(sandbox.run('configWarnings()').length, 0, 'safe config: no warnings');
  sandbox.CONFIG.WEBHOOK_SECRET = '';
  sandbox.CONFIG.ENABLE_DELETION = true;
  sandbox.CONFIG.DELETION_DRY_RUN = false;
  sandbox.CONFIG.DASHBOARD_ENABLED = true;
  sandbox.CONFIG.DASHBOARD_ADMIN_PASSWORD = 'short';
  sandbox.CONFIG.PLAYBACK_CHANNEL_ID = 'PLAY';
  const warnings = sandbox.run('configWarnings()');
  assert.strictEqual(warnings.length, 4, `all four risky combos flagged, got: ${JSON.stringify(warnings)}`);

  // describeSession: transcode vs direct play formatting.
  sandbox.S = { friendly_name: 'John', full_title: 'Movie Title', video_decision: 'transcode', video_full_resolution: '4k', stream_video_full_resolution: '1080p', progress_percent: '45' };
  assert.strictEqual(sandbox.run('describeSession(S)'), '• **John** — Movie Title — 🔥 Transcoding — 4k → 1080p (45%)', 'transcode line');
  sandbox.S = { friendly_name: 'Sarah', full_title: 'Show S02E04', video_decision: 'direct play', transcode_decision: 'direct play', stream_video_full_resolution: '1080p' };
  assert.strictEqual(sandbox.run('describeSession(S)'), '• **Sarah** — Show S02E04 — ▶️ Direct Play — 1080p', 'direct play line');

  // Approval-gate stash: stash → take round-trip, take consumes, restash revives (failed approve).
  sandbox.PAYLOAD = { discordId: '123456789012345678', email: 'a@b.c', seerrUserId: 9, mediaType: 'movie', tmdbId: 603, is4k: false, label: 'The Matrix' };
  const nonce = sandbox.run('stashPendingRequest(PAYLOAD)');
  assert.match(nonce, /^[0-9a-f]{8}$/, 'stash returns an 8-hex nonce');
  const taken = sandbox.run(`takePendingRequest('${nonce}')`);
  assert.strictEqual(taken.label, 'The Matrix', 'take returns the stashed payload');
  assert.strictEqual(taken.seerrUserId, 9, 'payload fields intact');
  assert.strictEqual(sandbox.run(`takePendingRequest('${nonce}')`), null, 'second take (double-click) returns null');
  sandbox.TAKEN = taken;
  sandbox.run(`restashPendingRequest('${nonce}', TAKEN)`);
  assert.strictEqual(sandbox.run(`takePendingRequest('${nonce}')`).label, 'The Matrix', 'restash revives the entry for retry');
  assert.strictEqual(sandbox.run(`takePendingRequest('zzzz')`), null, 'malformed nonce rejected');

  console.log('ok - request-and-channels');
})().catch(err => { console.error('FAILED request-and-channels:', err.message); process.exit(1); });
