#!/usr/bin/env node
// AvistaZ escalation: the pure state machine (src/escalation.js, imported directly) and the
// arr tag/search helpers (extracted from src/arr.js and run against a mock Radarr/Sonarr,
// since requiring arr.js directly would open the real SQLite database via src/db.js).
const assert = require('assert');
const express = require('express');
const axios = require('axios');
const { loadSandbox } = require('./extract');

(async () => {
  // --- Pure state machine ---
  const { decideEscalationAction, escalationEligible } = require('../../src/escalation');
  const MIN = 60000;
  const HOUR = 3600000;
  const cfg = { delayMinutes: 45, maxAgeDays: 14 };
  const row = (over = {}) => ({ approved_at: 0, pre_authorized: 0, ...over });
  const noFacts = { isAvailable: false, hasQueueItem: false, hasFile: false };

  assert.strictEqual(decideEscalationAction(row(), { ...noFacts, isAvailable: true }, 2 * HOUR, cfg), 'resolve', 'available resolves');
  assert.strictEqual(decideEscalationAction(row(), { ...noFacts, hasQueueItem: true }, 2 * HOUR, cfg), 'resolve', 'queue item resolves');
  assert.strictEqual(decideEscalationAction(row(), { ...noFacts, hasFile: true }, 2 * HOUR, cfg), 'resolve', 'file on disk resolves');
  assert.strictEqual(decideEscalationAction(row(), noFacts, 30 * MIN, cfg), 'wait', 'before deadline waits');
  assert.strictEqual(decideEscalationAction(row({ pre_authorized: 1 }), noFacts, 46 * MIN, cfg), 'escalate', 'past deadline + pre-auth escalates');
  assert.strictEqual(decideEscalationAction(row(), noFacts, 46 * MIN, cfg), 'alert', 'past deadline without pre-auth alerts');
  assert.strictEqual(decideEscalationAction(row(), noFacts, 15 * 24 * HOUR, cfg), 'expire', 'past max age expires');
  assert.strictEqual(decideEscalationAction(row({ pre_authorized: 1 }), { ...noFacts, isAvailable: true }, 46 * MIN, cfg), 'resolve', 'resolve beats escalate');

  const eCfg = { enabled: true, radarrConfigured: true, sonarrConfigured: true };
  assert.strictEqual(escalationEligible({ mediaType: 'movie', is4k: false }, eCfg), true, 'movie eligible');
  assert.strictEqual(escalationEligible({ mediaType: 'tv', is4k: false }, eCfg), true, 'tv eligible');
  assert.strictEqual(escalationEligible({ mediaType: 'movie', is4k: true }, eCfg), false, '4k never eligible');
  assert.strictEqual(escalationEligible({ mediaType: 'movie', is4k: false }, { ...eCfg, enabled: false }), false, 'disabled never eligible');
  assert.strictEqual(escalationEligible({ mediaType: 'movie', is4k: false }, { ...eCfg, radarrConfigured: false }), false, 'movie needs radarr');
  assert.strictEqual(escalationEligible({ mediaType: 'tv', is4k: false }, { ...eCfg, sonarrConfigured: false }), false, 'tv needs sonarr');

  // --- arr helpers against a mock Radarr/Sonarr ---
  const app = express();
  app.use(express.json());
  const state = { tags: [{ id: 7, label: 'avistaz' }], movieEditor: [], seriesEditor: [], commands: [], movies: [], series: [] };
  app.get('/api/v3/tag', (req, res) => res.json(state.tags));
  app.get('/api/v3/movie', (req, res) => res.json(state.movies.filter(m => m.tmdbId === Number(req.query.tmdbId))));
  app.get('/api/v3/series', (req, res) => res.json(state.series.filter(s => s.tvdbId === Number(req.query.tvdbId))));
  app.put('/api/v3/movie/editor', (req, res) => { state.movieEditor.push(req.body); res.json({}); });
  app.put('/api/v3/series/editor', (req, res) => { state.seriesEditor.push(req.body); res.json({}); });
  app.post('/api/v3/command', (req, res) => { state.commands.push(req.body); res.json({}); });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const CONFIG = { RADARR_URL: base, RADARR_API_KEY: 'rk', SONARR_URL: base, SONARR_API_KEY: 'sk', AVISTAZ_TAG: 'avistaz' };
  const audits = [];
  const sandbox = loadSandbox(
    ['getArrTagId', 'getMovieByTmdbId', 'getSeriesByTvdbId', 'addTagToMovie', 'addTagToSeries', 'triggerMovieSearch', 'triggerSeriesSearch', 'applyAvistazTag', 'escalateMediaToAvistaz', 'verifyAvistazTags'],
    {
      axios,
      CONFIG,
      audit: (action, details) => audits.push({ action, details }),
      // escalationSources is an arrow const in arr.js (not extractable); its contract is
      // "the escalation-eligible instances, radarr-4k excluded" — mirror that here.
      escalationSources: () => [
        { kind: 'movie', label: 'radarr', url: CONFIG.RADARR_URL, key: CONFIG.RADARR_API_KEY },
        { kind: 'tv', label: 'sonarr', url: CONFIG.SONARR_URL, key: CONFIG.SONARR_API_KEY },
      ],
    },
  );

  // Tag lookup: match is case-insensitive, absence is null (not a throw).
  assert.strictEqual(await sandbox.run(`getArrTagId({ url: '${base}', key: 'rk' }, 'AviStaZ')`), 7, 'tag lookup is case-insensitive');
  assert.strictEqual(await sandbox.run(`getArrTagId({ url: '${base}', key: 'rk' }, 'nope')`), null, 'missing tag returns null');

  // Movie happy path: editor gets applyTags:add with the right tag, then MoviesSearch fires.
  state.movies = [{ id: 42, tmdbId: 603, title: 'The Matrix', hasFile: false }];
  let result = await sandbox.run("escalateMediaToAvistaz({ mediaType: 'movie', tmdbId: 603 })");
  assert.strictEqual(result.ok, true, `movie escalation ok (got ${JSON.stringify(result)})`);
  assert.deepStrictEqual(state.movieEditor, [{ movieIds: [42], tags: [7], applyTags: 'add' }], 'movie editor adds (not replaces) the tag');
  assert.deepStrictEqual(state.commands, [{ name: 'MoviesSearch', movieIds: [42] }], 'movie search triggered');
  assert.strictEqual(audits.filter(a => a.action === 'avistaz_escalated').length, 1, 'escalation audited');

  // TV happy path keys off tvdb and uses SeriesSearch.
  state.commands = [];
  state.series = [{ id: 9, tvdbId: 81189, title: 'Breaking Bad' }];
  result = await sandbox.run("escalateMediaToAvistaz({ mediaType: 'tv', tmdbId: 1396, tvdbId: 81189 })");
  assert.strictEqual(result.ok, true, `tv escalation ok (got ${JSON.stringify(result)})`);
  assert.deepStrictEqual(state.seriesEditor, [{ seriesIds: [9], tags: [7], applyTags: 'add' }], 'series editor adds the tag');
  assert.deepStrictEqual(state.commands, [{ name: 'SeriesSearch', seriesId: 9 }], 'series search triggered');

  // Tag-only helper (approval-time pre-auth / direct-grab provenance): adds the tag through
  // the same additive editor but never triggers a search.
  state.commands = []; state.seriesEditor = [];
  result = await sandbox.run("applyAvistazTag({ mediaType: 'tv', tmdbId: 1396, tvdbId: 81189 })");
  assert.strictEqual(result.ok, true, `tag-only tv ok (got ${JSON.stringify(result)})`);
  assert.deepStrictEqual(state.seriesEditor, [{ seriesIds: [9], tags: [7], applyTags: 'add' }], 'tag-only uses the additive editor');
  assert.deepStrictEqual(state.commands, [], 'tag-only never triggers a search');
  result = await sandbox.run("applyAvistazTag({ mediaType: 'tv', tmdbId: 1396 })");
  assert.deepStrictEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: 'no_tvdb_id' }, 'tag-only tv without tvdbId fails cleanly');

  // Failure modes are stable reason strings, never throws.
  result = await sandbox.run("escalateMediaToAvistaz({ mediaType: 'tv', tmdbId: 1396 })");
  assert.deepStrictEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: 'no_tvdb_id' }, 'tv without tvdbId fails cleanly');
  result = await sandbox.run("escalateMediaToAvistaz({ mediaType: 'movie', tmdbId: 999 })");
  assert.deepStrictEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: 'not_in_arr' }, 'unknown movie fails cleanly');
  state.tags = [];
  result = await sandbox.run("escalateMediaToAvistaz({ mediaType: 'movie', tmdbId: 603 })");
  assert.deepStrictEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: 'tag_missing' }, 'missing tag fails cleanly');

  // Startup verification: warns per instance while the tag is missing, silent once it exists.
  let warnings = await sandbox.run("verifyAvistazTags('avistaz')");
  assert.strictEqual(warnings.length, 2, 'both instances warn when the tag is missing');
  state.tags = [{ id: 7, label: 'avistaz' }];
  warnings = await sandbox.run("verifyAvistazTags('avistaz')");
  assert.strictEqual(warnings.length, 0, 'no warnings once the tag exists');

  server.close();
  console.log('ok - escalation');
})().catch(err => { console.error('FAILED escalation:', err.message); process.exit(1); });
