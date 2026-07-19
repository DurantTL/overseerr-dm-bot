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

  // inArr=false (Seerr lost the arr hand-off): one alert after the grace period, then hold —
  // never escalate a title the arr doesn't have. Unknown (null/undefined) changes nothing.
  assert.strictEqual(decideEscalationAction(row(), { ...noFacts, inArr: false }, 5 * MIN, cfg), 'wait', 'missing from arr inside grace waits');
  assert.strictEqual(decideEscalationAction(row(), { ...noFacts, inArr: false }, 15 * MIN, cfg), 'alert_missing', 'missing from arr past grace alerts');
  assert.strictEqual(decideEscalationAction(row({ pre_authorized: 1 }), { ...noFacts, inArr: false }, 46 * MIN, cfg), 'alert_missing', 'missing-arr alert beats escalate');
  assert.strictEqual(decideEscalationAction(row({ arr_missing_alerted: 1 }), { ...noFacts, inArr: false }, 46 * MIN, cfg), 'wait', 'already-alerted missing row holds');
  assert.strictEqual(decideEscalationAction(row({ pre_authorized: 1 }), { ...noFacts, inArr: null }, 46 * MIN, cfg), 'escalate', 'unknown arr state never blocks escalation');
  assert.strictEqual(decideEscalationAction(row(), { ...noFacts, inArr: false }, 15 * 24 * HOUR, cfg), 'expire', 'expiry beats the missing-arr alert');

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
  const state = { tags: [{ id: 7, label: 'avistaz' }], movieEditor: [], seriesEditor: [], commands: [], movies: [], series: [], movieAdds: [], seriesAdds: [] };
  app.get('/api/v3/tag', (req, res) => res.json(state.tags));
  app.get('/api/v3/movie/lookup/tmdb', (req, res) => res.json({ title: 'Lost Movie', tmdbId: Number(req.query.tmdbId) }));
  app.get('/api/v3/movie', (req, res) => res.json(state.movies.filter(m => m.tmdbId === Number(req.query.tmdbId))));
  app.get('/api/v3/series/lookup', (req, res) => res.json([{ title: 'Lost Show', tvdbId: 999 }]));
  app.get('/api/v3/series', (req, res) => res.json(state.series.filter(s => s.tvdbId === Number(req.query.tvdbId))));
  app.get('/api/v3/rootfolder', (req, res) => res.json([{ path: '/data/media' }]));
  app.get('/api/v3/qualityprofile', (req, res) => res.json([{ id: 5, name: 'HD-1080p' }]));
  app.get('/api/v3/languageprofile', (req, res) => res.json([{ id: 2, name: 'English' }]));
  app.post('/api/v3/movie', (req, res) => { state.movieAdds.push(req.body); res.json({ id: 77 }); });
  app.post('/api/v3/series', (req, res) => { state.seriesAdds.push(req.body); res.json({ id: 88 }); });
  app.put('/api/v3/movie/editor', (req, res) => { state.movieEditor.push(req.body); res.json({}); });
  app.put('/api/v3/series/editor', (req, res) => { state.seriesEditor.push(req.body); res.json({}); });
  app.post('/api/v3/command', (req, res) => { state.commands.push(req.body); res.json({}); });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const CONFIG = { RADARR_URL: base, RADARR_API_KEY: 'rk', SONARR_URL: base, SONARR_API_KEY: 'sk', AVISTAZ_TAG: 'avistaz' };
  const audits = [];
  const sandbox = loadSandbox(
    ['getArrTagId', 'getMovieByTmdbId', 'getSeriesByTvdbId', 'addTagToMovie', 'addTagToSeries', 'triggerMovieSearch', 'triggerSeriesSearch', 'applyAvistazTag', 'escalateMediaToAvistaz', 'addMediaToArr', 'extractEpisodeNumber', 'pairFilesToEpisodes', 'verifyAvistazTags'],
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

  // Direct-add rescue (addMediaToArr): builds the add from the arr's own lookup + first
  // root folder / quality profile, applies the tag when given, and starts a search.
  state.series = [];
  result = await sandbox.run("addMediaToArr({ mediaType: 'tv', tvdbId: 999, tagLabel: 'avistaz' })");
  assert.strictEqual(result.ok, true, `series direct add ok (got ${JSON.stringify(result)})`);
  const addedSeries = state.seriesAdds[0];
  assert.strictEqual(addedSeries.tvdbId, 999, 'series lookup result posted');
  assert.strictEqual(addedSeries.rootFolderPath, '/data/media', 'first root folder used');
  assert.strictEqual(addedSeries.qualityProfileId, 5, 'first quality profile used');
  assert.deepStrictEqual(addedSeries.tags, [7], 'tag applied in the same add call');
  assert.strictEqual(addedSeries.monitored, true, 'series added monitored');
  assert.strictEqual(addedSeries.addOptions.searchForMissingEpisodes, true, 'series add searches immediately');
  assert.strictEqual(addedSeries.languageProfileId, 2, 'language profile set when the endpoint exists (Sonarr v3)');

  state.series = [{ id: 9, tvdbId: 999, title: 'Lost Show' }];
  result = await sandbox.run("addMediaToArr({ mediaType: 'tv', tvdbId: 999 })");
  assert.deepStrictEqual({ ok: result.ok, already: result.already }, { ok: true, already: true }, 'already-in-arr short-circuits');
  assert.strictEqual(state.seriesAdds.length, 1, 'no duplicate add posted');

  state.movies = [];
  result = await sandbox.run("addMediaToArr({ mediaType: 'movie', tmdbId: 777 })");
  assert.strictEqual(result.ok, true, `movie direct add ok (got ${JSON.stringify(result)})`);
  assert.deepStrictEqual(state.movieAdds[0].tags, [], 'no tag requested, none applied');
  assert.strictEqual(state.movieAdds[0].addOptions.searchForMovie, true, 'movie add searches immediately');

  result = await sandbox.run("addMediaToArr({ mediaType: 'tv' })");
  assert.deepStrictEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: 'no_tvdb_id' }, 'tv without tvdbId fails cleanly');

  // Guided-import pairing: episode numbers from filenames when they parse (skipping years and
  // resolutions), natural-order fallback when they don't.
  assert.strictEqual(sandbox.run("extractEpisodeNumber('Show.E05.1080p.mkv', 20)"), 5, 'E05 marker wins');
  assert.strictEqual(sandbox.run("extractEpisodeNumber('They Kiss Again (2007) ep12 hardsub.avi', 20)"), 12, 'ep12 marker parses');
  assert.strictEqual(sandbox.run("extractEpisodeNumber('TKA.2007.03.720p.mkv', 20)"), 3, 'year and resolution are skipped, last plausible number wins');
  assert.strictEqual(sandbox.run("extractEpisodeNumber('finale.mkv', 20)"), null, 'no number at all is null');
  const eps = JSON.stringify([{ id: 101, episodeNumber: 1 }, { id: 102, episodeNumber: 2 }, { id: 103, episodeNumber: 3 }]);
  let mapped = sandbox.run(`pairFilesToEpisodes([{ path: '/x/ep02.avi' }, { path: '/x/ep01.avi' }, { path: '/x/ep03.avi' }], ${eps})`);
  assert.strictEqual(mapped.strategy, 'numbered', 'clean episode markers use numbered strategy');
  assert.strictEqual(JSON.stringify(mapped.pairs.map(p => [String(p.path).split('/').pop(), p.episodeId])),
    JSON.stringify([['ep01.avi', 101], ['ep02.avi', 102], ['ep03.avi', 103]]), 'files map to the right episode ids regardless of input order');
  mapped = sandbox.run(`pairFilesToEpisodes([{ path: '/x/part-b.avi' }, { path: '/x/part-a.avi' }], ${eps})`);
  assert.strictEqual(mapped.strategy, 'ordinal', 'numberless names fall back to ordinal order');
  assert.strictEqual(JSON.stringify(mapped.pairs.map(p => [String(p.path).split('/').pop(), p.episodeNumber])),
    JSON.stringify([['part-a.avi', 1], ['part-b.avi', 2]]), 'ordinal pairing follows natural filename order');
  assert.strictEqual(mapped.leftoverEpisodes, 1, 'unmatched episodes are counted');
  mapped = sandbox.run(`pairFilesToEpisodes([{ path: '/x/ep2.avi' }, { path: '/x/ep02.avi' }], ${eps})`);
  assert.strictEqual(mapped.strategy, 'ordinal', 'duplicate episode numbers fall back to ordinal (never two files on one episode)');

  server.close();
  console.log('ok - escalation');
})().catch(err => { console.error('FAILED escalation:', err.message); process.exit(1); });
