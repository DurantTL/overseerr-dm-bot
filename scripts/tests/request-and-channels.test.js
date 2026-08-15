#!/usr/bin/env node
// /request helpers (search, request-as-user, Seerr user backfill), channel routing, config
// warnings, and Tautulli session formatting.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { loadSandbox } = require('./extract');

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
  assert.strictEqual(commands.length, 44);
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

test('whorequested: reports requester, subscribers, and live pipeline state', async () => {
  const rows = [
    { id: 2, overseerr_request_id: '77', media_id: 'tvdb:81189', media_type: 'tv', is_4k: 0, title: 'Breaking Bad', requested_by_discord_id: '123456789012345678', status: 'approved', created_at: '2026-08-10 12:00:00' },
    { id: 1, overseerr_request_id: null, media_id: 'tmdb:1396', media_type: 'tv', is_4k: 0, title: 'Breaking Bad', requested_by_discord_id: '123456789012345678', status: 'approved', created_at: '2026-08-10 12:00:00' },
  ];
  const util = require('../../src/util');
  const { sqliteUtcMs } = require('../../src/dashboard-render');
  const bed = loadSandbox(['handleWhoRequestedCommand'], {
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
    fetchArrQueues: async () => [{ title: 'Breaking Bad', source: { label: 'Sonarr' }, messages: [], status: 'downloading' }],
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

  bed.fetchArrQueues = async () => [{ title: 'Breaking Bad', source: { label: 'Sonarr' }, messages: ['No seeders'], status: 'warning' }];
  bed.queueItemLooksUnhealthy = () => true;
  await bed.run('handleWhoRequestedCommand(interaction)');
  assert.match(Object.fromEntries(reply.embeds[0].fields.map(field => [field.name, field.value])).Pipeline, /^Stalled — No seeders/);
});
