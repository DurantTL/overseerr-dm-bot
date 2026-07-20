#!/usr/bin/env node
// Plex Home staging: the server-identity gate that keeps PH playback events out of the delete
// flow, LRU eviction order + cache-pressure planning, invite scoping per home server, and
// stage-source resolution against a mock Radarr/Sonarr.
const assert = require('assert');
const express = require('express');
const axios = require('axios');
const path = require('path');
const { loadSandbox } = require('./extract');

(async () => {
  // --- classifyServerIdentity (pure; cfg injected) ---
  const sb = loadSandbox(['classifyServerIdentity', 'evictionOrder', 'planCacheSpace', 'planPlayPromotion'], {});
  const classify = (ids, cfg) => sb.run(`classifyServerIdentity(${JSON.stringify(ids)}, ${JSON.stringify(cfg)})`);
  const none = { phNames: [], primaryNames: [] };
  const phOnly = { phNames: ['ph-box'], primaryNames: [] };
  const both = { phNames: ['ph-box'], primaryNames: ['durant-master'] };

  assert.strictEqual(classify({}, none), 'primary', 'feature off → legacy primary');
  assert.strictEqual(classify({ serverName: 'anything' }, none), 'primary', 'feature off ignores names');
  assert.strictEqual(classify({ serverName: 'PH-Box' }, phOnly), 'ph', 'PH name matches case-insensitively');
  assert.strictEqual(classify({ machineId: 'ph-box' }, phOnly), 'ph', 'machine id matches too');
  assert.strictEqual(classify({}, phOnly), 'unknown', 'PH configured + no identity → unknown (fail-safe)');
  assert.strictEqual(classify({ serverName: '' }, phOnly), 'unknown', 'blank identity → unknown');
  assert.strictEqual(classify({ serverName: 'durant-master' }, phOnly), 'primary', 'named non-PH server → primary when primary list unset');
  assert.strictEqual(classify({ serverName: 'durant-master' }, both), 'primary', 'strict primary match');
  assert.strictEqual(classify({ serverName: 'neighbors-server' }, both), 'unknown', 'strict mode: unrecognized name → unknown');
  assert.strictEqual(classify({ serverName: 'ph-box', machineId: 'zzz' }, both), 'ph', 'PH wins when either id matches');

  // --- evictionOrder: unpinned only, least-recently-streamed first ---
  const GB = 1024 ** 3;
  const items = [
    { media_id: 'tmdb:1', title: 'Old Unwatched', pinned: 0, staged_at: 100, last_streamed_at: null, size_bytes: 10 * GB },
    { media_id: 'tmdb:2', title: 'Weekly Rewatch', pinned: 1, staged_at: 50, last_streamed_at: 60, size_bytes: 10 * GB },
    { media_id: 'tmdb:3', title: 'Watched Long Ago', pinned: 0, staged_at: 10, last_streamed_at: 20, size_bytes: 10 * GB },
    { media_id: 'tmdb:4', title: 'Watched Recently', pinned: 0, staged_at: 10, last_streamed_at: 900, size_bytes: 10 * GB },
  ];
  sb.run(`var items = ${JSON.stringify(items)}`);
  assert.strictEqual(sb.run('evictionOrder(items).map(i => i.media_id).join()'), 'tmdb:3,tmdb:1,tmdb:4', 'LRU order, pinned invisible');

  // --- planCacheSpace ---
  const plan = args => sb.run(`planCacheSpace(${JSON.stringify(args)})`);
  const p1 = plan({ freeBytes: null, neededBytes: 5 * GB, minFreeBytes: GB, items });
  assert.strictEqual(p1.ok, true, 'unknown free space proceeds');
  assert.strictEqual(p1.unguarded, true, '...but flagged unguarded');
  assert.strictEqual(p1.evict.length, 0, 'unguarded evicts nothing');

  const p2 = plan({ freeBytes: 50 * GB, neededBytes: 5 * GB, minFreeBytes: 10 * GB, items });
  assert.strictEqual(p2.ok, true, 'plenty of room');
  assert.strictEqual(p2.evict.length, 0, 'no evictions when free covers need + headroom');

  const p3 = plan({ freeBytes: 12 * GB, neededBytes: 5 * GB, minFreeBytes: 10 * GB, items });
  assert.strictEqual(p3.ok, true, 'short 3GB → evict one LRU item');
  assert.strictEqual(p3.evict.map(i => i.media_id).join(), 'tmdb:3', 'oldest-watched goes first, and only as many as needed');

  const p4 = plan({ freeBytes: 0, neededBytes: 15 * GB, minFreeBytes: 10 * GB, items });
  assert.strictEqual(p4.ok, true, 'deep shortfall walks further down the LRU list');
  assert.strictEqual(p4.evict.map(i => i.media_id).join(), 'tmdb:3,tmdb:1,tmdb:4', 'evicts all three unpinned');

  const p5 = plan({ freeBytes: 0, neededBytes: 100 * GB, minFreeBytes: 10 * GB, items });
  assert.strictEqual(p5.ok, false, 'impossible even after evicting everything unpinned → refuse');
  assert.strictEqual(p5.evict.length, 0, 'refusal evicts nothing (no pointless cache trashing)');
  assert.strictEqual(p5.shortfallBytes, 80 * GB, 'shortfall reported after counting all unpinned');

  // --- planPlayPromotion: play-triggered promotion decision (PH pilot) ---
  const promo = args => sb.run(`planPlayPromotion(${JSON.stringify(args)})`);
  const HOUR = 3600000;
  assert.strictEqual(promo({ enabled: false }).action, 'skip', 'disabled → skip');
  assert.strictEqual(promo({ enabled: false }).reason, 'disabled', 'disabled reason');
  assert.strictEqual(promo({ enabled: true, alreadyStaged: true }).action, 'skip', 'already local → skip');
  assert.strictEqual(promo({ enabled: true, alreadyStaged: true }).reason, 'already_local', 'already_local reason');
  const cool = promo({ enabled: true, alreadyStaged: false, lastPromoteAt: 1000, now: 1000 + HOUR, cooldownMs: 12 * HOUR });
  assert.strictEqual(cool.action, 'skip', 'within cooldown → skip');
  assert.strictEqual(cool.reason, 'cooldown', 'cooldown reason');
  const past = promo({ enabled: true, alreadyStaged: false, lastPromoteAt: 1000, now: 1000 + 13 * HOUR, cooldownMs: 12 * HOUR });
  assert.strictEqual(past.action, 'enqueue', 'past cooldown → enqueue');
  assert.strictEqual(promo({ enabled: true, alreadyStaged: false, rateLimitOk: false }).action, 'skip', 'over daily cap → skip');
  assert.strictEqual(promo({ enabled: true, alreadyStaged: false, rateLimitOk: false }).reason, 'rate_limited', 'rate_limited reason');
  assert.strictEqual(promo({ enabled: true, alreadyStaged: false, auditOnly: true }).action, 'audit', 'audit-only → audit, no copy');
  assert.strictEqual(promo({ enabled: true, alreadyStaged: false }).action, 'enqueue', 'clean path → enqueue');
  // Precedence: already-local beats cooldown beats rate-limit beats audit-only.
  assert.strictEqual(promo({ enabled: true, alreadyStaged: true, rateLimitOk: false, auditOnly: true }).reason, 'already_local', 'already_local wins over other skips');
  assert.strictEqual(promo({ enabled: true, alreadyStaged: false, rateLimitOk: false, auditOnly: true }).reason, 'rate_limited', 'rate-limit checked before audit-only');

  // --- serversForHomeServer: PH users get the PH box only, primary users everything else ---
  const plexSb = loadSandbox(['serversForHomeServer'], {
    CONFIG: { PH_SERVER_NAMES: ['ph-box'] },
  });
  const servers = [
    { name: 'Durant-Master', clientIdentifier: 'abc' },
    { name: 'PH-Box', clientIdentifier: 'def' },
  ];
  plexSb.run(`var servers = ${JSON.stringify(servers)}`);
  assert.strictEqual(plexSb.run("serversForHomeServer(servers, 'ph').map(s => s.name).join()"), 'PH-Box', 'ph user → PH box only');
  assert.strictEqual(plexSb.run("serversForHomeServer(servers, 'primary').map(s => s.name).join()"), 'Durant-Master', 'primary user → everything except PH box');
  plexSb.run('CONFIG.PH_SERVER_NAMES = []');
  assert.strictEqual(plexSb.run("serversForHomeServer(servers, 'primary').map(s => s.name).join()"), 'Durant-Master,PH-Box', 'feature off → all servers (legacy)');
  plexSb.run("CONFIG.PH_SERVER_NAMES = ['def']");
  assert.strictEqual(plexSb.run("serversForHomeServer(servers, 'ph').map(s => s.name).join()"), 'PH-Box', 'PH box matchable by clientIdentifier too');

  // --- resolveStageSource against a mock Radarr/Sonarr ---
  const app = express();
  app.use(express.json());
  const movie = { tmdbId: 603, title: 'The Matrix', year: 1999, hasFile: true, path: '/data/movies/The Matrix (1999)', sizeOnDisk: 8 * GB };
  const noFileMovie = { tmdbId: 604, title: 'The Matrix Reloaded', year: 2003, hasFile: false, path: '/data/movies/The Matrix Reloaded (2003)' };
  const series = { tvdbId: 121361, title: 'Bluey', path: '/data/tv/Bluey', statistics: { episodeFileCount: 52, sizeOnDisk: 30 * GB } };
  const emptySeries = { tvdbId: 999, title: 'Ghost Show', path: '/data/tv/Ghost Show', statistics: { episodeFileCount: 0 } };
  app.get('/api/v3/movie', (req, res) => res.json([movie, noFileMovie].filter(m => !req.query.tmdbId || m.tmdbId === Number(req.query.tmdbId))));
  app.get('/api/v3/series', (_req, res) => res.json([series, emptySeries]));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const CONFIG = {
    RADARR_URL: base, RADARR_API_KEY: 'rk', RADARR_4K_URL: '', RADARR_4K_API_KEY: '',
    SONARR_URL: base, SONARR_API_KEY: 'sk',
    PATH_REMAP_FROM: '/data', PATH_REMAP_TO: '/mnt/raid',
  };
  const stageSb = loadSandbox(['resolveStageSource', 'radarrGetFrom', 'sonarrGet', 'remapPath'], { axios, CONFIG, path });

  const m = await stageSb.run("resolveStageSource('tmdb:603')");
  assert.strictEqual(m.found, true, 'movie with file found');
  assert.strictEqual(m.srcPath, '/mnt/raid/movies/The Matrix (1999)', 'source path is remapped');
  assert.strictEqual(m.destSubPath, 'movies/The Matrix (1999)', 'dest keeps the folder name under movies/');
  assert.strictEqual(m.sizeBytes, 8 * GB, 'size from sizeOnDisk');

  const m2 = await stageSb.run("resolveStageSource('tmdb:604')");
  assert.strictEqual(m2.found, false, 'movie without file is not stageable');

  const t = await stageSb.run("resolveStageSource('tvdb:121361')");
  assert.strictEqual(t.found, true, 'series with episodes found');
  assert.strictEqual(t.srcPath, '/mnt/raid/tv/Bluey', 'series path remapped');
  assert.strictEqual(t.destSubPath, 'tv/Bluey', 'series dest under tv/');
  assert.strictEqual(t.sizeBytes, 30 * GB, 'series size from statistics');

  const t2 = await stageSb.run("resolveStageSource('tvdb:999')");
  assert.strictEqual(t2.found, false, 'series with no episode files is not stageable');

  const u = await stageSb.run("resolveStageSource('imdb:tt0133093')");
  assert.strictEqual(u.found, false, 'unknown media id scheme rejected');

  server.close();
  console.log('staging.test.js: all assertions passed');
})().catch(err => { console.error(err); process.exit(1); });
