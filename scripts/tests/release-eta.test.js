#!/usr/bin/env node
// Release ETA: the pure formatter (src/util.js, imported directly) and fetchReleaseEta
// (extracted from src/arr.js and run against a mock Radarr/Sonarr, since requiring arr.js
// directly would open the real SQLite database via src/db.js).
const assert = require('assert');
const express = require('express');
const axios = require('axios');
const { loadSandbox } = require('./extract');

(async () => {
  // --- Pure formatter ---
  const { releaseEtaInfo } = require('../../src/util');
  const DAY = 86400000;
  const now = Date.parse('2026-07-15T00:00:00Z');
  const iso = t => new Date(t).toISOString();

  assert.strictEqual(releaseEtaInfo(null, now), null, 'no info → no line');

  let r = releaseEtaInfo({ kind: 'movie', digitalRelease: iso(now + 45 * DAY) }, now);
  assert.strictEqual(r.waiting, true, 'future digital release is waiting');
  assert.match(r.line, /Digital release expected/, 'future digital release names the date');
  assert.match(r.line, /<t:\d+:D>/, 'dates render as Discord timestamps');

  r = releaseEtaInfo({ kind: 'movie', physicalRelease: iso(now + 60 * DAY) }, now);
  assert.strictEqual(r.waiting, true, 'physical date substitutes when digital is unknown');

  r = releaseEtaInfo({ kind: 'movie', digitalRelease: iso(now - 5 * DAY) }, now);
  assert.deepStrictEqual({ waiting: r.waiting, recent: /Digitally released/.test(r.line) }, { waiting: false, recent: true }, 'recent digital release is informative, not waiting');
  assert.strictEqual(releaseEtaInfo({ kind: 'movie', digitalRelease: iso(now - 90 * DAY) }, now), null, 'long-released movie adds nothing');

  r = releaseEtaInfo({ kind: 'movie', inCinemas: iso(now + 20 * DAY) }, now);
  assert.deepStrictEqual({ waiting: r.waiting, theaters: /theaters/.test(r.line) }, { waiting: true, theaters: true }, 'future theatrical without digital date');
  r = releaseEtaInfo({ kind: 'movie', inCinemas: iso(now - 20 * DAY) }, now);
  assert.deepStrictEqual({ waiting: r.waiting, since: /In theaters since/.test(r.line) }, { waiting: true, since: true }, 'in theaters now, digital date unannounced');
  r = releaseEtaInfo({ kind: 'movie', status: 'announced' }, now);
  assert.strictEqual(r.waiting, true, 'announced with no dates still waits');
  assert.strictEqual(releaseEtaInfo({ kind: 'movie', status: 'released' }, now), null, 'released with no dates adds nothing');
  assert.strictEqual(releaseEtaInfo({ kind: 'movie', status: 'released', inCinemas: iso(now - 20 * DAY) }, now), null, 'released status outranks a theaters-only date');
  assert.strictEqual(releaseEtaInfo({ kind: 'movie', status: 'inCinemas', inCinemas: iso(now - 300 * DAY) }, now), null, 'stale theaters-only date is not "waiting"');

  r = releaseEtaInfo({ kind: 'tv', firstAired: iso(now + 10 * DAY), status: 'upcoming' }, now);
  assert.deepStrictEqual({ waiting: r.waiting, prem: /Premieres/.test(r.line) }, { waiting: true, prem: true }, 'unaired show shows premiere date');
  r = releaseEtaInfo({ kind: 'tv', firstAired: iso(now - 300 * DAY), nextAiring: iso(now + 3 * DAY), status: 'continuing' }, now);
  assert.deepStrictEqual({ waiting: r.waiting, next: /Next episode airs/.test(r.line) }, { waiting: false, next: true }, 'continuing show shows next air date');
  r = releaseEtaInfo({ kind: 'tv', status: 'upcoming' }, now);
  assert.strictEqual(r.waiting, true, 'upcoming show with no dates still waits');
  assert.strictEqual(releaseEtaInfo({ kind: 'tv', firstAired: iso(now - 300 * DAY), status: 'ended' }, now), null, 'ended show adds nothing');

  assert.strictEqual(releaseEtaInfo({ kind: 'movie', digitalRelease: 'garbage' }, now), null, 'unparseable dates are ignored');

  // --- fetchReleaseEta against a mock Radarr/Sonarr ---
  const app = express();
  const state = { movies: [], movies4k: [], series: [], fail: false };
  app.get('/main/api/v3/movie', (req, res) => state.fail ? res.status(500).end() : res.json(state.movies.filter(m => m.tmdbId === Number(req.query.tmdbId))));
  app.get('/fourk/api/v3/movie', (req, res) => res.json(state.movies4k.filter(m => m.tmdbId === Number(req.query.tmdbId))));
  app.get('/main/api/v3/series', (req, res) => res.json(state.series.filter(s => s.tvdbId === Number(req.query.tvdbId))));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const CONFIG = { RADARR_URL: `${base}/main`, RADARR_API_KEY: 'rk', RADARR_4K_URL: `${base}/fourk`, RADARR_4K_API_KEY: 'r4k', SONARR_URL: `${base}/main`, SONARR_API_KEY: 'sk' };
  const audits = [];
  const sandbox = loadSandbox(['fetchReleaseEta', 'getSeriesByTvdbId'], {
    axios,
    CONFIG,
    audit: (action, details) => audits.push({ action, details }),
  });

  state.movies = [{ tmdbId: 603, status: 'announced', inCinemas: '2026-08-01T00:00:00Z', digitalRelease: '2026-10-15T00:00:00Z' }];
  let info = await sandbox.run("fetchReleaseEta({ mediaType: 'movie', tmdbId: 603 })");
  // {...info}: sandbox objects live in the vm realm, whose Object.prototype fails deepStrictEqual.
  assert.deepStrictEqual({ ...info }, { kind: 'movie', status: 'announced', inCinemas: '2026-08-01T00:00:00Z', digitalRelease: '2026-10-15T00:00:00Z', physicalRelease: null }, 'movie dates come from Radarr');

  state.movies = [];
  state.movies4k = [{ tmdbId: 604, status: 'inCinemas', inCinemas: '2026-06-01T00:00:00Z' }];
  info = await sandbox.run("fetchReleaseEta({ mediaType: 'movie', tmdbId: 604 })");
  assert.strictEqual(info?.status, 'inCinemas', '4K-only movies fall through to Radarr-4K');

  info = await sandbox.run("fetchReleaseEta({ mediaType: 'movie', tmdbId: 999 })");
  assert.strictEqual(info, null, 'movie missing from both instances → null');

  state.series = [{ tvdbId: 81189, status: 'continuing', firstAired: '2008-01-20T00:00:00Z', nextAiring: '2026-07-19T02:00:00Z' }];
  info = await sandbox.run("fetchReleaseEta({ mediaType: 'tv', tvdbId: 81189 })");
  assert.deepStrictEqual({ ...info }, { kind: 'tv', status: 'continuing', firstAired: '2008-01-20T00:00:00Z', nextAiring: '2026-07-19T02:00:00Z' }, 'series dates come from Sonarr');

  info = await sandbox.run("fetchReleaseEta({ mediaType: 'tv', tmdbId: 1396 })");
  assert.strictEqual(info, null, 'tv without a tvdb id → null');

  state.fail = true;
  info = await sandbox.run("fetchReleaseEta({ mediaType: 'movie', tmdbId: 603 })");
  assert.strictEqual(info, null, 'API failure fails open to null');
  assert.strictEqual(audits.filter(a => a.action === 'external_api_error' && a.details.action === 'release_eta').length, 1, 'API failure is audited');

  server.close();
  console.log('ok - release-eta');
})().catch(err => { console.error('FAILED release-eta:', err.message); process.exit(1); });
