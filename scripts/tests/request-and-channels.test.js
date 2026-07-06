#!/usr/bin/env node
// /request helpers (search, request-as-user, Seerr user backfill), channel routing, config
// warnings, and Tautulli session formatting.
const assert = require('assert');
const axios = require('axios');
const express = require('express');
const { loadSandbox } = require('./extract');

const sandbox = loadSandbox(
  ['canonicalizeEmail', 'searchSeerr', 'createSeerrRequestAs', 'resolveSeerrUserId', 'fetchOverseerrUsers', 'channelFor', 'configWarnings', 'describeSession'],
  {
    axios,
    CONFIG: {
      OVERSEERR_URL: '', OVERSEERR_API_KEY: 'k', ADMIN_CHANNEL_ID: 'ADMIN',
      TUNNEL_DOMAIN: 'x.example.com', WEBHOOK_SECRET: 's3cret', ENABLE_DELETION: false, DELETION_DRY_RUN: true,
      DASHBOARD_ENABLED: false, DASHBOARD_ADMIN_PASSWORD: '', DASHBOARD_ADMIN_TOKEN: '',
      PLAYBACK_CHECK_MINUTES: 5, PLAYBACK_CHANNEL_ID: '', TAUTULLI_URL: '', TAUTULLI_API_KEY: '',
    },
    markCalls: [],
    markOverseerrCreated: (discordId, id) => sandbox.markCalls.push({ discordId, id }),
    tautulliConfigured: () => !!(sandbox.CONFIG.TAUTULLI_URL && sandbox.CONFIG.TAUTULLI_API_KEY),
  },
);

function mockSeerr() {
  const app = express();
  app.use(express.json());
  const state = { requests: [], failNext: null, users: [{ id: 9, email: 'Jane.Doe+x@gmail.com' }] };
  app.get('/api/v1/search', (req, res) => res.json({ results: [
    { mediaType: 'person', id: 1, name: 'Someone' },
    { mediaType: 'movie', id: 603, title: 'The Matrix', releaseDate: '1999-03-30' },
    { mediaType: 'tv', id: 1396, name: 'Breaking Bad', firstAirDate: '2008-01-20' },
  ] }));
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

  console.log('ok - request-and-channels');
})().catch(err => { console.error('FAILED request-and-channels:', err.message); process.exit(1); });
