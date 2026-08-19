#!/usr/bin/env node
// AvistaZ escalation: the pure state machine (src/escalation.js, imported directly) and the
// arr tag/search helpers (extracted from src/arr.js and run against a mock Radarr/Sonarr,
// since requiring arr.js directly would open the real SQLite database via src/db.js).
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const axios = require('axios');
const { loadSandbox } = require('./extract');
const runtimeSettings = require('../../src/runtime-settings');

const { decideEscalationAction, escalationEligible, autoEscalateAllowed, usesDirectGrabEscalation } = require('../../src/escalation');
const MIN = 60000;
const HOUR = 3600000;
const cfg = { delayMinutes: 45, maxAgeDays: 14 };
// Auto-escalation is Asian-only, so the baseline row/facts here are an
// obviously-Asian show — the case where 'escalate' is still the right answer.
const row = (over = {}) => ({ approved_at: 0, pre_authorized: 0, media_type: 'tv', ...over });
const noFacts = { isAvailable: false, hasQueueItem: false, hasFile: false, avistazFit: 'asian' };

test('escalation: decideEscalationAction state machine', () => {
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
});

test('escalation: autoEscalateAllowed gate, and the same rules through the state machine', () => {
  // Auto-escalation gate: AvistaZ only carries Asian movies and TV, so firing without a human
  // is limited to titles that obviously belong there. Everything else falls back to the button.
  assert.strictEqual(autoEscalateAllowed({ media_type: 'tv' }, 'asian'), true, 'asian show auto-escalates');
  assert.strictEqual(autoEscalateAllowed({ media_type: 'tv' }, 'non_asian'), false, 'non-asian show asks first');
  assert.strictEqual(autoEscalateAllowed({ media_type: 'tv' }, 'unknown'), false, 'unknown origin asks first');
  assert.strictEqual(autoEscalateAllowed({ media_type: 'tv' }, null), false, 'unassessed show asks first');
  assert.strictEqual(autoEscalateAllowed({ media_type: 'movie' }, 'asian'), true, 'asian movie can auto-escalate through Radarr');
  assert.strictEqual(autoEscalateAllowed({ media_type: 'movie' }, 'non_asian'), false, 'non-asian movie asks first');
  assert.strictEqual(autoEscalateAllowed({ media_type: 'movie' }, 'unknown'), false, 'unknown movie asks first');
  assert.strictEqual(usesDirectGrabEscalation({ media_type: 'movie' }), false, 'movie escalation stays inside Radarr');
  assert.strictEqual(usesDirectGrabEscalation({ media_type: 'tv' }), true, 'TV retains the direct-grab fallback');

  // ...and the same rules through the state machine, which is what the sweep actually calls.
  const past = 46 * MIN;
  const preAuth = over => row({ pre_authorized: 1, ...over });
  assert.strictEqual(decideEscalationAction(preAuth({ media_type: 'movie' }), noFacts, past, cfg), 'escalate', 'pre-authorized Asian movie escalates through Radarr');
  assert.strictEqual(decideEscalationAction(preAuth(), { ...noFacts, avistazFit: 'non_asian' }, past, cfg), 'alert', 'pre-authorized non-asian show alerts');
  assert.strictEqual(decideEscalationAction(preAuth(), { ...noFacts, avistazFit: 'unknown' }, past, cfg), 'alert', 'pre-authorized show of unknown origin alerts');
  assert.strictEqual(decideEscalationAction(preAuth(), { ...noFacts, avistazFit: undefined }, past, cfg), 'alert', 'missing verdict never auto-escalates');
  // The gate only narrows auto-escalation — it must not turn an alert into an escalation, nor
  // pre-empt resolve/expire/alert_missing.
  assert.strictEqual(decideEscalationAction(row(), noFacts, past, cfg), 'alert', 'asian show without pre-auth still alerts');
  assert.strictEqual(decideEscalationAction(preAuth({ media_type: 'movie' }), { ...noFacts, hasFile: true }, past, cfg), 'resolve', 'resolve still beats the gate');
  assert.strictEqual(decideEscalationAction(preAuth({ media_type: 'movie' }), noFacts, 15 * 24 * HOUR, cfg), 'expire', 'expiry still beats the gate');
});

test('escalation: movies bypass direct candidates and use Radarr tag/search', async () => {
  const calls = [];
  const sandbox = loadSandbox(['runEscalation'], {
    usesDirectGrabEscalation,
    grabConfigured: () => true,
    runDirectGrabEscalation: async () => { throw new Error('movie must not enter direct grab'); },
    escalateMediaToAvistaz: async meta => {
      calls.push(['arr', meta]);
      return { ok: true, detail: "Tagged Radarr movie #42 'asian' and triggered a search." };
    },
    setEscalationState: (id, state) => calls.push(['state', id, state]),
    applyAvistazTag: async () => ({ ok: true }),
    audit: (...args) => calls.push(['audit', ...args]),
  });
  const result = await sandbox.run("runEscalation({ id: 7, media_id: 'tmdb:603', media_type: 'movie', tmdb_id: 603, tvdb_id: null, title: 'The General Daughter' })");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(JSON.stringify(calls[0]), JSON.stringify(['arr', { mediaType: 'movie', tmdbId: 603, tvdbId: null }]));
  assert.deepStrictEqual(calls[1], ['state', 7, 'escalated']);
  assert.match(result.detail, /Radarr movie/);
});

test('escalation: assessAsianOrigin (src/asian.js)', () => {
  const { assessAsianOrigin } = require('../../src/asian');
  const verdict = meta => assessAsianOrigin(meta).verdict;
  assert.strictEqual(verdict({ originalLanguage: 'ko', originCountry: ['KR'] }), 'asian', 'korean show is asian');
  assert.strictEqual(verdict({ originalLanguage: 'ja' }), 'asian', 'japanese language alone is enough');
  assert.strictEqual(verdict({ originalLanguage: 'hi', originCountry: ['IN'] }), 'asian', 'indian content is in scope');
  // Language and country disagreeing: either one saying "Asian" is enough, because AvistaZ
  // carries English-language Asian productions too.
  assert.strictEqual(verdict({ originalLanguage: 'en', originCountry: ['JP'] }), 'asian', 'japanese production in english is asian');
  assert.strictEqual(verdict({ originalLanguage: 'ko', productionCountries: [{ iso_3166_1: 'US' }] }), 'asian', 'korean-language US co-production is asian');
  // Script detection carries a record with no language or country at all.
  assert.strictEqual(verdict({ originalName: '킹덤' }), 'asian', 'hangul original title is asian');
  assert.strictEqual(verdict({ originalTitle: '鬼滅の刃' }), 'asian', 'japanese original title is asian');
  assert.strictEqual(verdict({ originalLanguage: 'en', productionCountries: [{ iso_3166_1: 'US' }], originalTitle: 'Breaking Bad' }), 'non_asian', 'US english show is non-asian');
  assert.strictEqual(verdict({ originCountry: ['GB'] }), 'non_asian', 'country alone can settle it');
  // Out-of-remit regions are not "asian" for AvistaZ's purposes — they get a human decision.
  assert.strictEqual(verdict({ originalLanguage: 'tr', originCountry: ['TR'] }), 'non_asian', 'turkish content is out of AvistaZ scope');
  // Nothing usable claims nothing — a Seerr outage must not read as "definitely not Asian".
  assert.strictEqual(verdict({}), 'unknown', 'empty record is unknown');
  assert.strictEqual(verdict({ originCountry: [], productionCountries: [] }), 'unknown', 'empty lists are unknown');
});

test('escalation: isAsianLanguageName (src/asian.js) — the auto-tag-for-AvistaZ gate that reads Sonarr\'s own record', () => {
  const { isAsianLanguageName } = require('../../src/asian');
  assert.strictEqual(isAsianLanguageName('Korean'), true, 'exact TheTVDB name matches');
  assert.strictEqual(isAsianLanguageName('korean'), true, 'case-insensitive');
  assert.strictEqual(isAsianLanguageName('  Japanese  '), true, 'whitespace is trimmed');
  assert.strictEqual(isAsianLanguageName('Hindi'), true, 'south asian languages are in scope');
  assert.strictEqual(isAsianLanguageName('English'), false, 'a Western show is never treated as Asian');
  assert.strictEqual(isAsianLanguageName('Turkish'), false, 'out-of-remit regions stay excluded, same as assessAsianOrigin');
  assert.strictEqual(isAsianLanguageName(undefined), false, 'a missing field never assumes Asian');
  assert.strictEqual(isAsianLanguageName(''), false, 'an empty string never assumes Asian');
  // TheTVDB doesn't always hand back a bare name from the known list.
  assert.strictEqual(isAsianLanguageName('Chinese (Traditional)'), true, 'a qualified variant still matches by substring');
  assert.strictEqual(isAsianLanguageName('Korean (South Korea)'), true, 'a parenthetical country suffix still matches');
  // Sonarr's language field isn't guaranteed to be localized to English — a native-script name
  // falls back to the same Unicode-script test assessAsianOrigin uses on titles.
  assert.strictEqual(isAsianLanguageName('한국어'), true, 'Hangul-script language name matches via script detection');
  assert.strictEqual(isAsianLanguageName('日本語'), true, 'Japanese-script language name matches via script detection');
  assert.strictEqual(isAsianLanguageName('ภาษาไทย'), true, 'Thai-script language name matches via script detection');
  assert.strictEqual(isAsianLanguageName('Français'), false, 'a non-Asian-script, non-listed name still stays non-Asian');
});

test('escalation: escalationEligible', () => {
  const eCfg = { enabled: true, radarrConfigured: true, sonarrConfigured: true };
  assert.strictEqual(escalationEligible({ mediaType: 'movie', is4k: false }, eCfg), true, 'movie eligible');
  assert.strictEqual(escalationEligible({ mediaType: 'tv', is4k: false }, eCfg), true, 'tv eligible');
  assert.strictEqual(escalationEligible({ mediaType: 'movie', is4k: true }, eCfg), false, '4k never eligible');
  assert.strictEqual(escalationEligible({ mediaType: 'movie', is4k: false }, { ...eCfg, enabled: false }), false, 'disabled never eligible');
  assert.strictEqual(escalationEligible({ mediaType: 'movie', is4k: false }, { ...eCfg, radarrConfigured: false }), false, 'movie needs radarr');
  assert.strictEqual(escalationEligible({ mediaType: 'tv', is4k: false }, { ...eCfg, sonarrConfigured: false }), false, 'tv needs sonarr');
});

// ---- Preview (#160) ----

const PREVIEW_NOW = Date.now();
const previewRow = (id, over = {}) => ({
  id, media_id: `tmdb:${id}`, title: `Title ${id}`, media_type: 'movie', tmdb_id: id,
  tvdb_id: null, approved_at: PREVIEW_NOW - HOUR, pre_authorized: 0,
  arr_missing_alerted: 0, avistaz_fit: null, ...over,
});

function escalationPreviewBed({
  rows = [], itemLimit = 60, available = [], movies = {}, series = {}, tvdbIds = {}, origins = {},
  config = {},
} = {}) {
  const calls = { watching: 0, queue: 0, movie: 0, series: 0, tvdb: 0, origin: 0 };
  const writes = [];
  const CONFIG = {
    ESCALATION_ENABLED: true,
    ESCALATION_DELAY_MINUTES: 45,
    ESCALATION_MAX_AGE_DAYS: 14,
    ESCALATION_ARR_GRACE_MINUTES: 10,
    ...config,
  };
  const sandbox = loadSandbox(
    ['previewEscalations', 'previewRuntimeValue', 'gatherEscalationFacts', 'resolveAvistazFit', 'escalationPreviewReason'],
    {
      CONFIG,
      PREVIEW_ITEM_LIMIT: itemLimit,
      runtimeSettings,
      tunable: key => CONFIG[key],
      decideEscalationAction,
      getWatchingEscalations: () => { calls.watching++; return rows; },
      fetchArrQueues: async () => { calls.queue++; return []; },
      db: {
        prepare: () => ({ get: mediaId => available.includes(mediaId) ? { found: 1 } : undefined }),
      },
      getMovieByTmdbId: async id => { calls.movie++; return Object.prototype.hasOwnProperty.call(movies, id) ? movies[id] : null; },
      getSeriesByTvdbId: async id => { calls.series++; return Object.prototype.hasOwnProperty.call(series, id) ? series[id] : null; },
      fetchSeerrTvdbId: async id => { calls.tvdb++; return tvdbIds[id] || null; },
      fetchSeerrMediaOrigin: async (_type, id) => { calls.origin++; return origins[id] || null; },
      assessAsianOrigin: meta => ({ verdict: meta?.verdict || 'unknown', reasons: meta?.reasons || [] }),
      setEscalationTvdbId: (...args) => writes.push(['tvdb', ...args]),
      setEscalationAvistazFit: (...args) => writes.push(['fit', ...args]),
      audit: (...args) => writes.push(['audit', ...args]),
    },
  );
  return { sandbox, calls, writes };
}

test('escalation preview: every verdict has a stable reason and preview lookups never persist', async () => {
  const rows = [
    previewRow(1, { title: 'Delivered' }),
    previewRow(2, { title: 'Waiting', approved_at: PREVIEW_NOW - 20 * MIN }),
    previewRow(3, { title: 'Auto show', media_type: 'tv', pre_authorized: 1 }),
    previewRow(4, { title: 'Manual movie' }),
    previewRow(5, { title: 'Expired', approved_at: PREVIEW_NOW - 15 * 24 * HOUR, avistaz_fit: 'non_asian' }),
    previewRow(6, { title: 'Lost show', media_type: 'tv', tvdb_id: 606 }),
  ];
  const bed = escalationPreviewBed({
    rows,
    available: ['tmdb:1'],
    movies: { 2: { hasFile: false }, 4: { hasFile: false }, 5: { hasFile: false } },
    series: { 303: { statistics: { episodeFileCount: 0 } }, 606: null },
    tvdbIds: { 3: 303 },
    origins: { 3: { verdict: 'asian' }, 4: { verdict: 'non_asian' }, 6: { verdict: 'asian' } },
  });

  const items = [...await bed.sandbox.previewEscalations({})];
  const byTitle = new Map(items.map(item => [item.title, item]));
  assert.deepStrictEqual(items.map(item => item.stage), ['resolve', 'wait', 'escalate', 'alert', 'expire', 'alert_missing']);
  assert.strictEqual(byTitle.get('Delivered').reason, 'public pipeline already has the title');
  assert.match(byTitle.get('Waiting').reason, /^waiting on delay until .*Z$/);
  assert.strictEqual(byTitle.get('Auto show').reason, 'pre-authorized and eligible for AvistaZ now');
  assert.strictEqual(byTitle.get('Manual movie').reason, 'ready for administrator approval now');
  assert.strictEqual(byTitle.get('Expired').reason, 'older than 14 days');
  assert.strictEqual(byTitle.get('Lost show').reason, 'missing from Sonarr');
  assert.strictEqual(bed.calls.tvdb, 1, 'the TVDB backfill path was exercised');
  assert.ok(bed.calls.origin > 0, 'the Seerr origin path was exercised');
  assert.deepStrictEqual(bed.writes, [], 'preview passes persist:false through both lookup helpers');
  assert.throws(
    () => bed.sandbox.escalationPreviewReason('new_verdict', rows[0], {}, PREVIEW_NOW, { delayMinutes: 45, maxAgeDays: 14 }),
    /Unmapped escalation preview action: new_verdict/,
    'a new decision verdict cannot silently leak its internal name into the UI',
  );
});

test('escalation preview: unsaved thresholds drive verdicts and invalid values stop before external calls', async () => {
  let bed = escalationPreviewBed({
    rows: [previewRow(20, { title: 'Threshold title', approved_at: PREVIEW_NOW - 30 * MIN })],
    movies: { 20: { hasFile: false } }, origins: { 20: { verdict: 'non_asian' } },
  });
  assert.strictEqual((await bed.sandbox.previewEscalations({}))[0].stage, 'wait', 'saved 45-minute delay still waits');
  assert.strictEqual((await bed.sandbox.previewEscalations({ ESCALATION_DELAY_MINUTES: '15' }))[0].stage, 'alert', 'unsaved 15-minute delay applies');

  bed = escalationPreviewBed({
    rows: [previewRow(21, { approved_at: PREVIEW_NOW - 2 * 24 * HOUR, avistaz_fit: 'non_asian' })],
    movies: { 21: { hasFile: false } },
  });
  assert.strictEqual((await bed.sandbox.previewEscalations({}))[0].stage, 'alert', 'saved 14-day age still alerts');
  assert.strictEqual((await bed.sandbox.previewEscalations({ ESCALATION_MAX_AGE_DAYS: '1' }))[0].stage, 'expire', 'unsaved one-day age expires');

  const invalid = escalationPreviewBed({ rows: [previewRow(22)] });
  await assert.rejects(
    () => invalid.sandbox.previewEscalations({ ESCALATION_DELAY_MINUTES: 'nonsense' }),
    /ESCALATION_DELAY_MINUTES must be a whole number/,
  );
  assert.deepStrictEqual(invalid.calls, { watching: 0, queue: 0, movie: 0, series: 0, tvdb: 0, origin: 0 },
    'invalid settings are rejected before the watch list or external services are touched');
});

test('escalation preview: disabled costs no external calls and enabled previews are bounded', async () => {
  let bed = escalationPreviewBed({ rows: [previewRow(30)] });
  assert.deepStrictEqual([...await bed.sandbox.previewEscalations({ ESCALATION_ENABLED: 'false' })], []);
  assert.deepStrictEqual(bed.calls, { watching: 0, queue: 0, movie: 0, series: 0, tvdb: 0, origin: 0 });

  const rows = Array.from({ length: 5 }, (_, i) => previewRow(40 + i, { avistaz_fit: 'non_asian' }));
  const movies = Object.fromEntries(rows.map(row => [row.tmdb_id, { hasFile: false }]));
  bed = escalationPreviewBed({ rows, movies, itemLimit: 2 });
  assert.strictEqual((await bed.sandbox.previewEscalations({})).length, 2, 'the shared preview item cap bounds the result');
  assert.strictEqual(bed.calls.movie, 2, 'rows beyond the cap spend no arr or Seerr lookups');
});

test('escalation: arr tag/search helpers against a mock Radarr/Sonarr', async () => {
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
});
