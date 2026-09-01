#!/usr/bin/env node
// /request helpers (search, request-as-user, Seerr user backfill), channel routing, config
// warnings, and Tautulli session formatting.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const Database = require('better-sqlite3');
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { loadSandbox } = require('./extract');
const { findUnprocessableTorrents, unacknowledgedTorrents, pruneAcknowledged, resolveAbsoluteDownloadDir } = require('../../src/adopt');
const runtimeSettings = require('../../src/runtime-settings');
const { detectStuckItems, groupStuckItems, isSeasonGroup } = require('../../src/stuck');
const { nextSeasonNoGrabAlert } = require('../../src/season-alert');

const settingsStore = new Map();
const sandbox = loadSandbox(
  ['canonicalizeEmail', 'searchSeerr', 'checkExistingSeerrMedia', 'createSeerrRequestAs', 'verifySeerrRequestCreated', 'resolveSeerrUserId', 'fetchOverseerrUsers', 'channelFor', 'configWarnings', 'describeSession', 'stashPendingRequest', 'takePendingRequest', 'restashPendingRequest'],
  {
    axios,
    crypto: require('crypto'),
    CONFIG: {
      LOG_LEVEL: 'info', LOG_FORMAT: 'text',
      PORT: 3000,
      OVERSEERR_URL: '', OVERSEERR_API_KEY: 'k', ADMIN_CHANNEL_ID: '100000000000000001',
      TUNNEL_DOMAIN: 'x.example.com', WEBHOOK_SECRET: 's3cret', TAUTULLI_WEBHOOK_SECRET: 'tautulli-secret', ENABLE_DELETION: false, DELETION_DRY_RUN: true,
      DASHBOARD_ENABLED: false, DASHBOARD_ADMIN_PASSWORD: '', DASHBOARD_ADMIN_TOKEN: '',
      PLAYBACK_CHECK_MINUTES: 5, PLAYBACK_CHANNEL_ID: '', TAUTULLI_URL: '', TAUTULLI_API_KEY: '',
      STAGING_ENABLED: false, STAGE_RCLONE_REMOTE: '', PH_SERVER_NAMES: [], CA_EDGE_SERVER_NAMES: [], PRIMARY_SERVER_NAMES: [],
      RTORRENT_URL: '', GRAB_MODE: 'approve', GRAB_RCLONE_REMOTE: '', GRAB_STAGING_PATH: '',
      PLACEHOLDER_WARNINGS: [],
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

test('request: searchSeerr, createSeerrRequestAs, checkExistingSeerrMedia, verifySeerrRequestCreated, resolveSeerrUserId against a mock Seerr', async () => {
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
});

test('request: channelFor fallback/override/deploy special case', () => {
  const cf = k => sandbox.run(`channelFor('${k}')`);
  for (const kind of ['requests', 'system', 'downloads', 'cleanup', 'audit', 'playback', 'admin']) {
    assert.strictEqual(cf(kind), '100000000000000001', `${kind}: falls back to admin when unset`);
  }
  assert.strictEqual(cf('deploy') || null, null, 'deploy: NO fallback when unset');
  sandbox.CONFIG.REQUESTS_CHANNEL_ID = '100000000000000002';
  sandbox.CONFIG.DEPLOY_CHANNEL_ID = '100000000000000003';
  assert.strictEqual(cf('requests'), '100000000000000002', 'configured channel wins');
  assert.strictEqual(cf('deploy'), '100000000000000003', 'deploy sends when configured');
  assert.strictEqual(cf('cleanup'), '100000000000000001', 'other kinds still fall back');
});

test('request: configWarnings quiet on a safe config, loud on risky combos', () => {
  // (length checks, not deepStrictEqual — vm-realm arrays have a different Array prototype
  // than the host's.) Blank WEBHOOK_SECRET/TAUTULLI_WEBHOOK_SECRET with TUNNEL_DOMAIN set is
  // no longer a warning here — validateConfig() now refuses to start in that case, tested
  // separately in config.test.js.
  assert.strictEqual(sandbox.run('configWarnings()').length, 0, 'safe config: no warnings');
  sandbox.CONFIG.ENABLE_DELETION = true;
  sandbox.CONFIG.DELETION_DRY_RUN = false;
  sandbox.CONFIG.DASHBOARD_ENABLED = true;
  sandbox.CONFIG.DASHBOARD_ADMIN_PASSWORD = 'short';
  sandbox.CONFIG.PLAYBACK_CHANNEL_ID = '100000000000000004';
  const warnings = sandbox.run('configWarnings()');
  assert.strictEqual(warnings.length, 3, `all three risky combos flagged, got: ${JSON.stringify(warnings)}`);
});

test('request: configWarnings flags a channel ID that is not a Discord snowflake', () => {
  // A mistyped/pasted-as-name channel ID never resolves, so every notification routed there is
  // dropped in silence — the failure mode that made a dead DEPLOY_CHANNEL_ID look like a healthy
  // startup. Warn at boot instead.
  sandbox.CONFIG.DEPLOY_CHANNEL_ID = '#media-admin-log';
  const warnings = sandbox.run('configWarnings()');
  assert.ok(warnings.some(w => w.includes('DEPLOY_CHANNEL_ID')), `malformed deploy ID flagged, got: ${JSON.stringify(warnings)}`);
  sandbox.CONFIG.DEPLOY_CHANNEL_ID = '100000000000000003';
  assert.ok(!sandbox.run('configWarnings()').some(w => w.includes('DEPLOY_CHANNEL_ID')), 'a real snowflake is accepted');
});

test('request: configWarnings names incomplete API pairs and Compose port drift', () => {
  sandbox.CONFIG.SONARR_URL = 'http://sonarr:8989';
  sandbox.CONFIG.SONARR_API_KEY = '';
  sandbox.CONFIG.PORT = 4000;
  const warnings = sandbox.run('configWarnings()');
  assert.ok(warnings.some(w => w.includes('SONARR_URL') && w.includes('SONARR_API_KEY')));
  assert.ok(warnings.some(w => w.includes('PORT=4000') && w.includes('3000:3000')));
  sandbox.CONFIG.SONARR_URL = '';
  sandbox.CONFIG.PORT = 3000;
});

test('discord: every registered command dispatches and bounded options stay bounded', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
  const block = source.match(/const slashCommands = \[([\s\S]*?)\]\.map\(v => v\.toJSON\(\)\);/)[1];
  const commands = Function('SlashCommandBuilder', 'PermissionFlagsBits', `return [${block}].map(v => v.toJSON());`)(SlashCommandBuilder, PermissionFlagsBits);
  assert.strictEqual(commands.length, 48);
  assert.strictEqual(new Set(commands.map(command => command.name)).size, commands.length);
  for (const command of commands) assert.match(source, new RegExp(`if \\(n === '${command.name}'\\) return handle`), `${command.name} dispatches`);

  const download = commands.find(command => command.name === 'download');
  const season = download.options.find(option => option.name === 'season');
  const episode = download.options.find(option => option.name === 'episode');
  assert.deepStrictEqual([season.min_value, season.max_value], [0, 99]);
  assert.deepStrictEqual([episode.min_value, episode.max_value], [1, 999]);

  const tierAdd = commands.find(command => command.name === 'tier-node').options.find(option => option.name === 'add');
  const option = name => tierAdd.options.find(value => value.name === name);
  assert.deepStrictEqual([option('headroom_pct').min_value, option('headroom_pct').max_value], [0, 95]);
  assert.strictEqual(option('usable_gb').min_value, 0);
  assert.deepStrictEqual([option('warm_days').min_value, option('warm_days').max_value], [0, 3650]);
  assert.ok(source.indexOf('startExpressServer();') < source.indexOf('registerSlashCommands();', source.indexOf("client.once('ready'")), 'HTTP starts before command registration');
});

test('discord: access setup reports partial failures for retry', async () => {
  const rows = new Map([['123', { discord_id: '123', email: 'user@example.com', invited: 0 }]]);
  const bed = loadSandbox(['applyFullChainLink'], {
    linkUserToEmail: () => ({ absorbed: null }),
    getUserByDiscordId: id => rows.get(id),
    inviteUserToPlex: async () => ({ successCount: 0, total: 1 }),
    homeServerFor: () => 'primary',
    markUserInvited: () => {},
    fetchOverseerrUsers: async () => [],
    canonicalizeEmail: value => value.toLowerCase(),
    createOverseerrUser: async () => 44,
    markOverseerrCreated: () => {},
    setOverseerrDiscordNotification: async () => true,
    grantMemberRole: async () => {},
    audit: () => {},
  });
  const result = await bed.run("applyFullChainLink('123', 'user@example.com', 'user')");
  assert.strictEqual(result.plexOk, false);
  assert.strictEqual(result.seerrOk, true);
  assert.match(result.plexStatus, /failed/);
  assert.match(result.seerrStatus, /created/);
});

test('request: notifyChannel reports drops instead of swallowing them', async () => {
  // The bug this guards: every failure path used to be `.catch(() => {})`, so a deploy ping into
  // a channel the bot cannot post in looked identical to a successful one.
  const logged = [];
  const bed = loadSandbox(['channelFor', 'notifyChannel', 'describeChannelError'], {
    CONFIG: { ADMIN_CHANNEL_ID: '100000000000000001', DEPLOY_CHANNEL_ID: '100000000000000003' },
    log: { warn: m => logged.push(m), info: () => {}, ok: () => {} },
    client: { channels: { fetch: async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }); } } },
  });

  assert.strictEqual(await bed.run("notifyChannel('deploy', 'hi')"), false, 'unknown channel reports failure');
  assert.match(logged.at(-1), /10003/, 'and says why');

  bed.CONFIG.DEPLOY_CHANNEL_ID = '';
  assert.strictEqual(await bed.run("notifyChannel('deploy', 'hi')"), false, 'unset deploy channel is a no-op');
  assert.strictEqual(logged.length, 1, 'opt-out is not an error');

  bed.CONFIG.DEPLOY_CHANNEL_ID = '100000000000000003';
  bed.client.channels.fetch = async () => ({ send: async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); } });
  assert.strictEqual(await bed.run("notifyChannel('deploy', 'hi')"), false, 'send failure reports failure');
  assert.match(logged.at(-1), /50013/, 'permission error named');

  const sent = [];
  bed.client.channels.fetch = async () => ({ send: async m => sent.push(m) });
  assert.strictEqual(await bed.run("notifyChannel('deploy', 'hi')"), true, 'happy path returns true');
  assert.deepStrictEqual(sent, ['hi'], 'message delivered');
  assert.strictEqual(logged.length, 2, 'no warning on success');
});

test('request: describeSession transcode vs direct play formatting', () => {
  sandbox.S = { friendly_name: 'John', full_title: 'Movie Title', video_decision: 'transcode', video_full_resolution: '4k', stream_video_full_resolution: '1080p', progress_percent: '45' };
  assert.strictEqual(sandbox.run('describeSession(S)'), '• **John** — Movie Title — 🔥 Transcoding — 4k → 1080p (45%)', 'transcode line');
  sandbox.S = { friendly_name: 'Sarah', full_title: 'Show S02E04', video_decision: 'direct play', transcode_decision: 'direct play', stream_video_full_resolution: '1080p' };
  assert.strictEqual(sandbox.run('describeSession(S)'), '• **Sarah** — Show S02E04 — ▶️ Direct Play — 1080p', 'direct play line');
});

test('request: approval-gate stash/take/restash round-trip', () => {
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
});

test('rate limits: download counters survive reloads, expire on the boundary, and prune old rows', () => {
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE rate_limit_hits (
    scope TEXT NOT NULL, identity TEXT NOT NULL, hit_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  ); CREATE INDEX idx_rate_limit_bucket ON rate_limit_hits(scope, identity, expires_at);
  CREATE INDEX idx_rate_limit_expiry ON rate_limit_hits(expires_at);`);
  const first = loadSandbox(['takePersistentRateLimit'], { db: database });
  assert.strictEqual(first.run("takePersistentRateLimit('download-command', 'member', 2, 60000, 1000)"), true);
  assert.strictEqual(first.run("takePersistentRateLimit('download-command', 'member', 2, 60000, 1000)"), true);

  const afterRestart = loadSandbox(['takePersistentRateLimit'], { db: database });
  assert.strictEqual(afterRestart.run("takePersistentRateLimit('download-command', 'member', 2, 60000, 2000)"), false);
  database.prepare('INSERT INTO rate_limit_hits VALUES (?, ?, ?, ?)').run('download-route', 'old', 0, 5);
  assert.strictEqual(afterRestart.run("takePersistentRateLimit('download-command', 'member', 2, 60000, 61000)"), true, 'a hit expires at the exact boundary');
  assert.strictEqual(database.prepare('SELECT COUNT(*) AS n FROM rate_limit_hits WHERE expires_at <= ?').get(61000).n, 0, 'expired inactive buckets are pruned');
  database.close();
});

test('alert cooldowns: a stuck-download alert stays suppressed after reload', async () => {
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE alert_cooldowns (
    scope TEXT NOT NULL, alert_key TEXT NOT NULL, last_alerted_at INTEGER NOT NULL,
    PRIMARY KEY (scope, alert_key)
  ); CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);`);
  let alerts = 0;
  const stubs = {
    db: database,
    stuckTracker: new Map(),
    fetchArrQueues: async () => [{}],
    detectStuckItems: () => [],
    groupStuckItems: () => new Map([['sonarr:1', { source: { label: 'sonarr' }, members: [{}], maxFrozenMs: 60000 }]]),
    stuckGroupKey: () => 'sonarr:1',
    tunable: () => 24,
    getSetting: () => null,
    buildStuckAlert: () => ({ embed: {}, row: {} }),
    notifyChannel: () => { alerts++; },
    audit: () => {},
    rtorrentConfigured: () => false,
    RTORRENT_PATH_ALERT_KEY: 'rtorrent:relative-paths',
  };
  const names = ['getAlertedAt', 'setAlertedAt', 'listAlertCooldowns', 'clearAlertCooldown', 'planStuckDownloads', 'classifyRelativePathTorrents', 'sweepStuckDownloads'];
  const first = loadSandbox(names, stubs);
  assert.strictEqual((await first.run('sweepStuckDownloads()')).alerted, 1);
  const afterRestart = loadSandbox(names, stubs);
  assert.strictEqual((await afterRestart.run('sweepStuckDownloads()')).alerted, 0);
  assert.strictEqual(alerts, 1);
  database.close();
});

test('season alerts: durable per-season stand-down survives restart and changed results re-arm', () => {
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE alert_cooldowns (
    scope TEXT NOT NULL, alert_key TEXT NOT NULL, last_alerted_at INTEGER NOT NULL,
    attempt_count INTEGER DEFAULT 0, last_attempted_at INTEGER, fingerprint TEXT,
    stood_down INTEGER DEFAULT 0, metadata_json TEXT,
    PRIMARY KEY (scope, alert_key)
  );`);
  const names = ['seasonAlertKey', 'seasonAlertRow', 'getSeasonAlertState', 'recordSeasonNoGrab', 'clearSeasonAlertState', 'listSeasonAlertStates'];
  const make = () => loadSandbox(names, { db: database, nextSeasonNoGrabAlert, SEASON_ALERT_SCOPE: 'season-pack:no-grab' });
  let bed = make();
  const input = { seriesId: 7, seasonNumber: 2, seriesTitle: 'Revenge', fingerprint: 'same', missingCount: 22, releaseCount: 0 };
  const alerts = [];
  for (let attempt = 1; attempt <= 4; attempt++) alerts.push(bed.recordSeasonNoGrab({ ...input, now: attempt * 1000 }).shouldAlert);
  assert.deepStrictEqual(alerts, [true, true, false, true]);
  assert.strictEqual(bed.getSeasonAlertState(7, 2).stoodDown, true);

  bed = make(); // process restart, same SQLite rows
  const silent = bed.recordSeasonNoGrab({ ...input, now: 5000 });
  assert.strictEqual(silent.shouldAlert, false);
  assert.strictEqual(bed.listSeasonAlertStates({ stoodDownOnly: true })[0].seriesTitle, 'Revenge');

  const changed = bed.recordSeasonNoGrab({ ...input, fingerprint: 'new-release-list', releaseCount: 1, now: 6000 });
  assert.strictEqual(changed.shouldAlert, true);
  assert.strictEqual(changed.attemptCount, 1);
  assert.strictEqual(changed.stoodDown, false);
  assert.strictEqual(bed.clearSeasonAlertState(7, 2), true);
  assert.strictEqual(bed.getSeasonAlertState(7, 2), null);
  database.close();
});

test('whorequested: autocomplete searches all tracked requests and folds sibling rows', async () => {
  const rows = [
    { id: 3, media_id: 'tmdb:1396', title: 'Breaking Bad', media_type: 'tv', is_4k: 1, requested_by_discord_id: '123456789012345678', status: 'approved' },
    { id: 2, media_id: 'tmdb:1396', title: 'Breaking Bad', media_type: 'tv', is_4k: 0, requested_by_discord_id: '123456789012345678', status: 'approved' },
    { id: 1, media_id: 'tvdb:81189', title: 'Breaking Bad', media_type: 'tv', is_4k: 0, requested_by_discord_id: '123456789012345678', status: 'available' },
  ];
  const bed = loadSandbox(['handleAutocomplete'], {
    db: { prepare: () => ({ all: () => rows }) },
  });
  let choices;
  bed.interaction = {
    commandName: 'whorequested',
    options: { getFocused: () => ({ name: 'title', value: 'breaking' }) },
    respond: async value => { choices = value; },
  };
  await bed.run('handleAutocomplete(interaction)');
  assert.strictEqual(choices.length, 2);
  assert.deepStrictEqual(Array.from(choices, choice => choice.value), ['request:3', 'request:2']);
  assert.match(choices[1].name, /available/);
});

test('request progress: future release and stalled DMs persist once-only state', async () => {
  const settings = new Map();
  const messages = [];
  const row = {
    id: 7, overseerr_request_id: '77', media_id: 'tmdb:603', media_type: 'movie', is_4k: 0,
    title: 'The Matrix', requested_by_discord_id: '123456789012345678', status: 'approved', created_at: '2020-01-01 00:00:00',
  };
  const bed = loadSandbox(['sweepRequestProgressNotifications'], {
    db: { prepare: () => ({ all: () => [row] }) },
    fetchArrQueues: async () => [],
    isSnowflake: () => true,
    requestProgressDmEnabled: () => true,
    resolveTmdbId: () => 603,
    fetchSeerrTvdbId: async () => null,
    findRequestQueueItem: () => null,
    fetchReleaseEta: async () => ({ waiting: true, line: 'Digital release is January 1.' }),
    releaseEtaInfo: value => value,
    getSetting: key => settings.get(key) ?? null,
    setSetting: (key, value) => settings.set(key, value),
    dmUser: async (id, message) => { messages.push({ id, message }); return false; },
    audit: () => {},
    tunable: () => 72,
    sqliteUtcMs: value => Date.parse(`${value}Z`),
    fmtDuration: () => '1 day',
    COLORS: { INFO: 1, WARN: 2 },
    mediaTypeLabel: () => 'Movie',
    brandedEmbed: color => ({
      color, fields: [],
      setTitle(value) { this.title = value; return this; },
      setDescription(value) { this.description = value; return this; },
      addFields(...values) { this.fields.push(...values); return this; },
    }),
  });

  // Both DMs are branded embeds, not plain strings — a requester-facing notice should look like
  // every other embed the bot sends them, and the field layout is what carries the detail.
  const embedOf = message => message.embeds[0];
  const fieldNames = embed => embed.fields.map(field => field.name);

  assert.deepStrictEqual({ ...await bed.run('sweepRequestProgressNotifications([])') }, { eta: 1, stalled: 0 });
  assert.deepStrictEqual({ ...await bed.run('sweepRequestProgressNotifications([])') }, { eta: 0, stalled: 0 });
  assert.strictEqual(messages.length, 1, 'closed DMs still persist the once-only marker');
  assert.match(embedOf(messages[0].message).title, /Not Out Yet — The Matrix/);
  assert.match(embedOf(messages[0].message).description, /not available to download yet/);
  assert.deepStrictEqual(fieldNames(embedOf(messages[0].message)), ['Type', 'Expected', 'What happens next']);
  assert.match(embedOf(messages[0].message).fields[1].value, /Digital release is January 1\./);

  settings.clear();
  messages.length = 0;
  bed.fetchReleaseEta = async () => null;
  assert.deepStrictEqual({ ...await bed.run('sweepRequestProgressNotifications([])') }, { eta: 0, stalled: 1 });
  assert.deepStrictEqual({ ...await bed.run('sweepRequestProgressNotifications([])') }, { eta: 0, stalled: 0 });
  assert.strictEqual(messages.length, 1);
  assert.match(embedOf(messages[0].message).title, /Still Looking — The Matrix/);
  assert.match(embedOf(messages[0].message).description, /cannot confirm an active download or a future release date/);
  assert.deepStrictEqual(fieldNames(embedOf(messages[0].message)), ['Type', 'Waiting', 'What happens next']);
});

test('request progress: member preference mutes automated outcome DMs', async () => {
  const row = {
    id: 8, overseerr_request_id: '78', media_id: 'tmdb:604', media_type: 'movie', title: 'Muted title',
    requested_by_discord_id: '123456789012345678', created_at: '2020-01-01 00:00:00',
  };
  let sent = 0;
  const bed = loadSandbox(['sweepRequestProgressNotifications'], {
    db: { prepare: () => ({ all: () => [row] }) },
    fetchArrQueues: async () => [],
    isSnowflake: () => true,
    requestProgressDmEnabled: () => false,
    dmUser: async () => { sent++; },
  });
  assert.deepStrictEqual({ ...await bed.run('sweepRequestProgressNotifications([])') }, { eta: 0, stalled: 0 });
  assert.strictEqual(sent, 0);
});

test('notifications: command persists and clears the member preference', async () => {
  const settings = new Map();
  const bed = loadSandbox(['handleNotificationsCommand'], {
    setSetting: (key, value) => settings.set(key, value),
    deleteSetting: key => settings.delete(key),
    audit: () => {},
  });
  let reply;
  bed.interaction = {
    user: { id: '123456789012345678' },
    options: { getBoolean: () => false },
    reply: async value => { reply = value; },
  };
  await bed.run('handleNotificationsCommand(interaction)');
  assert.strictEqual(settings.get('request_progress_dm:123456789012345678'), '0');
  assert.match(reply.content, /muted/);
  bed.interaction.options.getBoolean = () => true;
  await bed.run('handleNotificationsCommand(interaction)');
  assert.strictEqual(settings.has('request_progress_dm:123456789012345678'), false);
  assert.match(reply.content, /enabled/);
});

test('whorequested: reports requester, subscribers, and live pipeline state', async () => {
  const rows = [
    { id: 2, overseerr_request_id: '77', media_id: 'tvdb:81189', media_type: 'tv', is_4k: 0, title: 'Breaking Bad', requested_by_discord_id: '123456789012345678', status: 'approved', created_at: '2026-08-10 12:00:00' },
    { id: 1, overseerr_request_id: null, media_id: 'tmdb:1396', media_type: 'tv', is_4k: 0, title: 'Breaking Bad', requested_by_discord_id: '123456789012345678', status: 'approved', created_at: '2026-08-10 12:00:00' },
  ];
  const util = require('../../src/util');
  const { sqliteUtcMs } = require('../../src/dashboard-render');
  const bed = loadSandbox(['findRequestQueueItem', 'handleWhoRequestedCommand'], {
    requireAdmin: async () => true,
    db: { prepare: _sql => ({
      get: () => rows[0],
      all: () => rows,
    }) },
    sqliteUtcMs,
    discordTimestamp: util.discordTimestamp,
    isSnowflake: util.isSnowflake,
    requestStatusBadge: util.requestStatusBadge,
    mediaTypeEmoji: util.mediaTypeEmoji,
    subscriberKeyFor: (tmdbId, is4k) => `tmdb:${tmdbId}${is4k ? ':4k' : ''}`,
    listRequestSubscribers: () => ['123456789012345678', '987654321098765432'],
    resolveTmdbId: () => null,
    fetchArrQueues: async () => [{ title: 'Breaking Bad', source: { kind: 'tv', label: 'Sonarr' }, messages: [], status: 'downloading' }],
    queueItemLooksUnhealthy: () => false,
    queuePercent: () => 42,
    COLORS: { INFO: 1 },
    brandedEmbed: () => ({ setTitle(value) { this.title = value; return this; }, addFields(...value) { this.fields = value; return this; } }),
    audit: () => {},
  });
  let reply;
  bed.interaction = {
    user: { id: '999999999999999999' },
    options: { getString: () => 'request:2' },
    deferReply: async value => { assert.strictEqual(value.ephemeral, true); },
    editReply: async value => { reply = value; },
  };
  await bed.run('handleWhoRequestedCommand(interaction)');
  const fields = Object.fromEntries(reply.embeds[0].fields.map(field => [field.name, field.value]));
  assert.match(fields['Requested by'], /<@123456789012345678>/);
  assert.strictEqual(fields['Seerr request'], '#77');
  assert.strictEqual(fields.Pipeline, 'Downloading — Sonarr, 42%');
  assert.strictEqual(fields['Also waiting'], '<@987654321098765432>');

  bed.fetchArrQueues = async () => [{ title: 'Breaking Bad', source: { kind: 'tv', label: 'Sonarr' }, messages: ['No seeders'], status: 'warning' }];
  bed.queueItemLooksUnhealthy = () => true;
  await bed.run('handleWhoRequestedCommand(interaction)');
  assert.match(Object.fromEntries(reply.embeds[0].fields.map(field => [field.name, field.value])).Pipeline, /^Stalled — No seeders/);
});

test('stuck preview: evaluates the unsaved threshold without disturbing the live tracker', async () => {
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE alert_cooldowns (
    scope TEXT NOT NULL, alert_key TEXT NOT NULL, last_alerted_at INTEGER NOT NULL,
    PRIMARY KEY (scope, alert_key)
  ); CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);`);
  const now = Date.now();
  const item = {
    source: { label: 'sonarr', kind: 'tv' }, queueId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1,
    title: 'Winter Sonata S01E01', sizeleft: 500, status: 'downloading', trackedState: 'downloading',
    messages: [], trackedStatus: '',
  };
  // The tracker says this item has not moved a byte in 30 minutes.
  const stuckTracker = new Map([['sonarr:1', { sizeleft: 500, since: now - 30 * 60000 }]]);
  const snapshot = JSON.stringify([...stuckTracker]);

  const bed = loadSandbox(
    ['getAlertedAt', 'setAlertedAt', 'planStuckDownloads', 'previewStuckDownloads', 'previewRuntimeValue'],
    {
      db: database,
      stuckTracker,
      runtimeSettings,
      fetchArrQueues: async () => [item],
      detectStuckItems, groupStuckItems, isSeasonGroup,
      getSetting: () => null,
      tunable: key => (key === 'STUCK_AFTER_MINUTES' ? 45 : 6),
    },
  );

  // At the saved 45-minute threshold a 30-minute freeze is not yet stuck.
  assert.strictEqual((await bed.run('previewStuckDownloads({})')).length, 0);

  // Dropping the threshold to 15 without saving must surface it — that is the point of preview.
  const items = [...await bed.run("previewStuckDownloads({ STUCK_AFTER_MINUTES: '15' })")];
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].title, 'Winter Sonata Season 1', 'a stuck season reports as one consolidated group');
  assert.strictEqual(items[0].stage, 'alert');
  assert.match(items[0].reason, /frozen for 30 minutes at the 15-minute threshold/);

  // detectStuckItems re-arms clocks and prunes departed entries in the map it is handed. The
  // preview must be doing that to a copy, or previewing would silently reset the real sweep's
  // freeze timers and delay every genuine alert.
  assert.strictEqual(JSON.stringify([...stuckTracker]), snapshot, 'the live tracker is untouched by a preview');
  database.close();
});

test('stuck sweep: a relative rTorrent download path is reported even though no queue item exists', async () => {
  // The failure the queue-based watchdog structurally cannot see: Sonarr refuses these torrents
  // outright, so they finish downloading and are dropped with no queue item and no failure event.
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE alert_cooldowns (
    scope TEXT NOT NULL, alert_key TEXT NOT NULL, last_alerted_at INTEGER NOT NULL,
    PRIMARY KEY (scope, alert_key)
  ); CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);`);
  const notices = [];
  const audits = [];
  const torrents = [
    { name: 'The.Road.to.Splendor.S01E34.1080p.DSNP.WEB-DL-ANDY.mkv', basePath: './The.Road.to.Splendor.S01E34.mkv' },
    { name: 'The.Road.to.Splendor.S01.2026.1080p.WETV.WEB-DL-ANDY', basePath: './The.Road.to.Splendor.S01' },
    { name: 'Healthy.Show.S01E01.mkv', basePath: '/home/seed/downloads/Healthy.Show.S01E01.mkv' },
    { name: 'Not.Allocated.Yet', basePath: '' },
  ];
  const stubs = {
    db: database,
    stuckTracker: new Map(),
    fetchArrQueues: async () => [],
    detectStuckItems: () => [],
    groupStuckItems: () => new Map(),
    stuckGroupKey: () => 'sonarr:1',
    tunable: () => 24,
    getSetting: () => null,
    buildStuckAlert: () => ({ embed: {}, row: {} }),
    notifyChannel: (channel, msg) => notices.push({ channel, msg }),
    audit: (action, detail) => audits.push({ action, detail }),
    rtorrentConfigured: () => true,
    listRtorrentTorrents: async () => torrents,
    findUnprocessableTorrents,
    unacknowledgedTorrents,
    pruneAcknowledged,
    readPathAcks: () => [],
    resolveAbsoluteDownloadDir,
    getRtorrentPaths: async () => ({ cwd: '/home/seed', defaultDirectory: './downloads' }),
    RTORRENT_PATH_ALERT_KEY: 'rtorrent:relative-paths',
    COLORS: { DANGER: 4 },
    brandedEmbed: color => ({
      color,
      setTitle(value) { this.title = value; return this; },
      setDescription(value) { this.description = value; return this; },
    }),
  };
  const names = ['getAlertedAt', 'setAlertedAt', 'listAlertCooldowns', 'clearAlertCooldown', 'planStuckDownloads', 'classifyRelativePathTorrents', 'sweepStuckDownloads'];
  const first = loadSandbox(names, stubs);
  const result = await first.run('sweepStuckDownloads()');
  assert.strictEqual(result.unprocessable, 2, 'absolute paths and unallocated torrents are not misconfigurations');
  assert.strictEqual(result.alerted, 1);
  const embed = notices[0].msg.embeds[0];
  assert.match(embed.title, /rTorrent Downloads Cannot Be Imported — 2 torrents/);
  assert.match(embed.description, /never imported, and never reported as a failure/);
  // The fix that needs no shell access is the *arrs' Directory field, and that needs an absolute
  // path the operator cannot otherwise discover — so the alert works it out from rTorrent itself.
  assert.match(embed.description, /Absolute path to use: `\/home\/seed\/downloads`/);
  assert.match(embed.description, /Directory\*\* field on the rTorrent client/, 'the alert names the no-shell fix');
  assert.ok(audits.some(row => row.detail.resolvedDownloadDir === '/home/seed/downloads'));
  assert.ok(audits.some(row => row.action === 'rtorrent_unprocessable_paths' && row.detail.count === 2));

  // One relative directory affects every torrent at once, so this is one alert for the whole
  // condition, and it stays suppressed across a restart like any other stuck alert.
  const afterRestart = loadSandbox(names, stubs);
  assert.strictEqual((await afterRestart.run('sweepStuckDownloads()')).alerted, 0);
  assert.strictEqual(notices.length, 1);
  database.close();
});

test('stuck sweep: an unreadable rTorrent still reports the paths, just without a computed one', async () => {
  // rTorrent builds vary in which introspection methods they expose. A probe that answers
  // nothing must still leave the operator with the diagnosis, not swallow the whole alert.
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE alert_cooldowns (
    scope TEXT NOT NULL, alert_key TEXT NOT NULL, last_alerted_at INTEGER NOT NULL,
    PRIMARY KEY (scope, alert_key)
  ); CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);`);
  const notices = [];
  const sandbox = loadSandbox(['getAlertedAt', 'setAlertedAt', 'listAlertCooldowns', 'clearAlertCooldown', 'planStuckDownloads', 'classifyRelativePathTorrents', 'sweepStuckDownloads'], {
    db: database,
    stuckTracker: new Map(),
    fetchArrQueues: async () => [],
    detectStuckItems: () => [],
    groupStuckItems: () => new Map(),
    stuckGroupKey: () => 'sonarr:1',
    tunable: () => 24,
    getSetting: () => null,
    buildStuckAlert: () => ({ embed: {}, row: {} }),
    notifyChannel: (channel, msg) => notices.push({ channel, msg }),
    audit: () => {},
    rtorrentConfigured: () => true,
    listRtorrentTorrents: async () => [{ name: 'Show.S01E01.mkv', basePath: './Show.S01E01.mkv' }],
    findUnprocessableTorrents,
    unacknowledgedTorrents,
    pruneAcknowledged,
    readPathAcks: () => [],
    resolveAbsoluteDownloadDir,
    getRtorrentPaths: async () => { throw new Error('unknown method'); },
    RTORRENT_PATH_ALERT_KEY: 'rtorrent:relative-paths',
    COLORS: { DANGER: 4 },
    brandedEmbed: color => ({
      color,
      setTitle(value) { this.title = value; return this; },
      setDescription(value) { this.description = value; return this; },
    }),
  });
  assert.strictEqual((await sandbox.run('sweepStuckDownloads()')).alerted, 1);
  const embed = notices[0].msg.embeds[0];
  assert.doesNotMatch(embed.description, /Absolute path to use/, 'no path is claimed when none could be resolved');
  assert.match(embed.description, /check ruTorrent for the full path/, 'and the operator is told how to find it');
  database.close();
});

test('stuck sweep: acknowledged relative paths stop alerting, and the count says why', async () => {
  // rTorrent never revisits a torrent's stored directory, so historical relative paths stay
  // forever. Repeating their count every cooldown, after an admin has said "these are history",
  // buries the ones that are genuinely still arriving broken.
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE alert_cooldowns (
    scope TEXT NOT NULL, alert_key TEXT NOT NULL, last_alerted_at INTEGER NOT NULL,
    PRIMARY KEY (scope, alert_key)
  ); CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);`);
  const torrents = [
    { name: 'Old.S01E01.mkv', basePath: './Downloads/Old.S01E01.mkv', hash: 'AAA' },
    { name: 'Old.S01E02.mkv', basePath: './Downloads/Old.S01E02.mkv', hash: 'BBB' },
    { name: 'New.S01E03.mkv', basePath: './Downloads/New.S01E03.mkv', hash: 'CCC' },
  ];
  const run = acks => {
    const notices = [];
    const sandbox = loadSandbox(['getAlertedAt', 'setAlertedAt', 'listAlertCooldowns', 'clearAlertCooldown', 'planStuckDownloads', 'classifyRelativePathTorrents', 'sweepStuckDownloads'], {
      db: database,
      stuckTracker: new Map(),
      fetchArrQueues: async () => [],
      detectStuckItems: () => [],
      groupStuckItems: () => new Map(),
      stuckGroupKey: () => 'sonarr:1',
      tunable: () => 0,
      getSetting: () => null,
      buildStuckAlert: () => ({ embed: {}, row: {} }),
      notifyChannel: (channel, msg) => notices.push({ channel, msg }),
      audit: () => {},
      rtorrentConfigured: () => true,
      listRtorrentTorrents: async () => torrents,
      findUnprocessableTorrents,
      unacknowledgedTorrents,
      pruneAcknowledged,
      readPathAcks: () => acks,
      resolveAbsoluteDownloadDir,
      getRtorrentPaths: async () => ({ cwd: '/mnt/001/seed', defaultDirectory: './Downloads' }),
      RTORRENT_PATH_ALERT_KEY: 'rtorrent:relative-paths',
      COLORS: { DANGER: 4 },
      brandedEmbed: color => ({
        color,
        setTitle(value) { this.title = value; return this; },
        setDescription(value) { this.description = value; return this; },
      }),
    });
    return { sandbox, notices };
  };

  // Two acknowledged, one still arriving broken: alert on the one, explain the two.
  const partial = run(['AAA', 'BBB']);
  assert.strictEqual((await partial.sandbox.run('sweepStuckDownloads()')).unprocessable, 1);
  const embed = partial.notices[0].msg.embeds[0];
  assert.match(embed.title, /Cannot Be Imported — 1 torrent$/);
  assert.match(embed.description, /2 already acknowledged as historical and not counted here/);
  // The old advice ("re-downloading them after the fix is the simplest route") was wrong: the
  // files are already on the seedbox and adoption copies them home over rclone, which never
  // consults the path Sonarr is refusing.
  assert.match(embed.description, /do \*\*not\*\* need re-downloading/);
  assert.match(embed.description, /rtorrent adopt search/);
  assert.match(embed.description, /stores a directory at add time and never revisits it/,
    'and it says why fixing the Directory field cannot clear these');

  // Everything acknowledged: silence, not a repeat of the same count forever.
  database.exec('DELETE FROM alert_cooldowns');
  const quiet = run(['AAA', 'BBB', 'CCC']);
  const result = await quiet.sandbox.run('sweepStuckDownloads()');
  assert.strictEqual(result.unprocessable, 0);
  assert.strictEqual(quiet.notices.length, 0, 'a fully acknowledged history says nothing');
  database.close();
});
