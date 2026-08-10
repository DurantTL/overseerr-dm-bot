#!/usr/bin/env node
// /request helpers (search, request-as-user, Seerr user backfill), channel routing, config
// warnings, and Tautulli session formatting.
const assert = require('assert');
const axios = require('axios');
const express = require('express');
const { loadSandbox } = require('./extract');

const settingsStore = new Map();
const sandbox = loadSandbox(
  ['canonicalizeEmail', 'searchSeerr', 'checkExistingSeerrMedia', 'createSeerrRequestAs', 'verifySeerrRequestCreated', 'resolveSeerrUserId', 'fetchOverseerrUsers', 'channelFor', 'configWarnings', 'describeSession', 'stashPendingRequest', 'takePendingRequest', 'restashPendingRequest'],
  {
    axios,
    crypto: require('crypto'),
    CONFIG: {
      LOG_LEVEL: 'info', LOG_FORMAT: 'text',
      OVERSEERR_URL: '', OVERSEERR_API_KEY: 'k', ADMIN_CHANNEL_ID: 'ADMIN',
      TUNNEL_DOMAIN: 'x.example.com', WEBHOOK_SECRET: 's3cret', TAUTULLI_WEBHOOK_SECRET: 'tautulli-secret', ENABLE_DELETION: false, DELETION_DRY_RUN: true,
      DASHBOARD_ENABLED: false, DASHBOARD_ADMIN_PASSWORD: '', DASHBOARD_ADMIN_TOKEN: '',
      PLAYBACK_CHECK_MINUTES: 5, PLAYBACK_CHANNEL_ID: '', TAUTULLI_URL: '', TAUTULLI_API_KEY: '',
      STAGING_ENABLED: false, STAGE_RCLONE_REMOTE: '', PH_SERVER_NAMES: [], CA_EDGE_SERVER_NAMES: [], PRIMARY_SERVER_NAMES: [],
      RTORRENT_URL: '', GRAB_MODE: 'approve', GRAB_RCLONE_REMOTE: '', GRAB_STAGING_PATH: '',
    },
    markCalls: [],
    markOverseerrCreated: (discordId, id) => sandbox.markCalls.push({ discordId, id }),
    audit: () => {},
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
  const state = { requests: [], failNext: null, users: [{ id: 9, email: 'Jane.Doe+x@gmail.com' }], media: {}, tvSeasons: [] };
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
  // Media detail endpoints used by the duplicate pre-check: mediaInfo is present only for
  // titles Seerr already tracks, mirroring the real API.
  app.get('/api/v1/movie/:id', (req, res) => res.json({ id: Number(req.params.id), mediaInfo: state.media[`movie:${req.params.id}`] }));
  app.get('/api/v1/tv/:id', (req, res) => res.json({ id: Number(req.params.id), seasons: state.tvSeasons, mediaInfo: state.media[`tv:${req.params.id}`] }));
  // Request read-back used by post-create verification; state.requestGet = null mimics Seerr
  // rolling the request back after accepting it.
  app.get('/api/v1/request/:id', (req, res) => {
    if (!state.requestGet) return res.status(404).json({ message: 'Request not found.' });
    res.json(state.requestGet);
  });
  app.post('/api/v1/request', (req, res) => {
    if (state.failNext) { const f = state.failNext; state.failNext = null; return res.status(f.code).json({ message: f.message }); }
    if (state.respondNext) { const r = state.respondNext; state.respondNext = null; return res.status(r.code || 200).json(r.body); }
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

  // Overseerr's "nothing left to request" is a 2xx (202 + message, NO request created) — it must
  // surface as an error, not a phantom success (the bug that ate approved TV requests).
  state.failNext = { code: 202, message: 'No seasons available to request' };
  let noSeasons = null;
  try { await sandbox.run(`createSeerrRequestAs(9, 'tv', 1396, false)`); } catch (err) { noSeasons = { status: err.response?.status, message: err.message }; }
  assert.strictEqual(noSeasons?.status, 202, '202 no-op response rejected');
  assert.strictEqual(noSeasons?.message, 'No seasons available to request', 'Seerr 202 message becomes the error message');

  // But unfamiliar SUCCESS shapes must not be rejected — some Seerr variants nest the created
  // request or omit the id, and treating those as failures broke every real request.
  state.respondNext = { code: 201, body: { request: { id: 88 } } };
  const nested = await sandbox.run(`createSeerrRequestAs(9, 'movie', 603, false)`);
  assert.strictEqual(nested.request.id, 88, 'nested-id success shape accepted');
  state.respondNext = { code: 200, body: { status: 1 } };
  const odd = await sandbox.run(`createSeerrRequestAs(9, 'movie', 603, false)`);
  assert.strictEqual(odd.status, 1, '2xx with no id and no message still counts as success');

  // checkExistingSeerrMedia: the /request duplicate pre-check.
  assert.strictEqual(await sandbox.run(`checkExistingSeerrMedia('movie', 603, false)`), null, 'movie unknown to Seerr → requestable');
  state.media['movie:603'] = { status: 5, status4k: 1 };
  assert.match(await sandbox.run(`checkExistingSeerrMedia('movie', 603, false)`), /available on Plex/, 'available movie blocked');
  assert.strictEqual(await sandbox.run(`checkExistingSeerrMedia('movie', 603, true)`), null, '4K tracked separately: HD copy does not block a 4K request');
  state.media['movie:603'] = { status: 2 };
  assert.match(await sandbox.run(`checkExistingSeerrMedia('movie', 603, false)`), /already requested/, 'pending movie blocked');
  state.tvSeasons = [{ seasonNumber: 0, episodeCount: 3 }, { seasonNumber: 1, episodeCount: 10 }, { seasonNumber: 2, episodeCount: 8 }];
  state.media['tv:1396'] = { status: 4, seasons: [{ seasonNumber: 1, status: 5 }] };
  assert.strictEqual(await sandbox.run(`checkExistingSeerrMedia('tv', 1396, false)`), null, 'tv with an unrequested season → still requestable');
  state.media['tv:1396'] = { status: 4, seasons: [{ seasonNumber: 1, status: 5 }, { seasonNumber: 2, status: 3 }] };
  assert.match(await sandbox.run(`checkExistingSeerrMedia('tv', 1396, false)`), /every season/, 'tv with all seasons requested/downloading blocked');
  state.media['tv:1396'] = { status: 5 };
  assert.match(await sandbox.run(`checkExistingSeerrMedia('tv', 1396, false)`), /fully available/, 'fully available tv blocked');
  sandbox.CONFIG.OVERSEERR_URL = 'http://127.0.0.1:1'; // unreachable
  assert.strictEqual(await sandbox.run(`checkExistingSeerrMedia('movie', 603, false)`), null, 'Seerr outage fails open');
  sandbox.CONFIG.OVERSEERR_URL = `http://127.0.0.1:${port}`;

  // verifySeerrRequestCreated: Seerr can accept a request and lose it moments later
  // ('Media data not found') — the read-back has to catch that instead of reporting success.
  state.requestGet = { id: 77, media: { id: 1620, tvdbId: 81189 } };
  assert.strictEqual((await sandbox.run(`verifySeerrRequestCreated(77, 'tv', 0)`)).ok, true, 'intact request verifies');
  state.requestGet = { id: 77, media: { id: 1620, tvdbId: null } };
  assert.strictEqual((await sandbox.run(`verifySeerrRequestCreated(77, 'movie', 0)`)).ok, true, 'movies never need a TVDB id');
  let v = await sandbox.run(`verifySeerrRequestCreated(77, 'tv', 0)`);
  assert.strictEqual(v.ok, false, 'tv without a TVDB id fails verification');
  assert.match(v.reason, /TVDB/, 'reason names the TVDB mapping');
  state.requestGet = { id: 77 };
  assert.strictEqual((await sandbox.run(`verifySeerrRequestCreated(77, 'movie', 0)`)).ok, false, 'missing media record fails verification');
  state.requestGet = null;
  v = await sandbox.run(`verifySeerrRequestCreated(77, 'tv', 0)`);
  assert.strictEqual(v.ok, false, '404 read-back (rolled back) fails verification');
  assert.match(v.reason, /rolled it back/, 'reason explains the rollback');
  sandbox.CONFIG.OVERSEERR_URL = 'http://127.0.0.1:1';
  assert.strictEqual((await sandbox.run(`verifySeerrRequestCreated(77, 'tv', 0)`)).ok, true, 'network error while verifying fails open');
  sandbox.CONFIG.OVERSEERR_URL = `http://127.0.0.1:${port}`;

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
  // Blank WEBHOOK_SECRET/TAUTULLI_WEBHOOK_SECRET with TUNNEL_DOMAIN set is no longer a warning
  // here — validateConfig() now refuses to start in that case, tested separately in config.test.js.
  assert.strictEqual(sandbox.run('configWarnings()').length, 0, 'safe config: no warnings');
  sandbox.CONFIG.ENABLE_DELETION = true;
  sandbox.CONFIG.DELETION_DRY_RUN = false;
  sandbox.CONFIG.DASHBOARD_ENABLED = true;
  sandbox.CONFIG.DASHBOARD_ADMIN_PASSWORD = 'short';
  sandbox.CONFIG.PLAYBACK_CHANNEL_ID = 'PLAY';
  const warnings = sandbox.run('configWarnings()');
  assert.strictEqual(warnings.length, 3, `all three risky combos flagged, got: ${JSON.stringify(warnings)}`);

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
