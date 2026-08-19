#!/usr/bin/env node
// rerouteDeadPremiumizeTransfer is extracted from index.js and run against stubbed Sonarr/Radarr
// queue, Prowlarr search, and executeGrab — covering the matching, AvistaZ-exclusion, and
// confidence-gate logic without booting the bot, opening SQLite, or exercising the real grab
// pipeline (executeGrab itself is covered by the AvistaZ direct-grab flow elsewhere).
const { test } = require('node:test');
const assert = require('node:assert');
const { loadSandbox } = require('./extract');
const { normalizeTitle, splitTitleYear, rankAvistazResults, seriesAliasMatch } = require('../../src/grab');

const sonarrSeriesAliases = series => [normalizeTitle(series?.title)].filter(Boolean);

function build({
  queue = [], searchResults = [], series = null, movie = null,
  minConfidence = 60, grabResult = { ok: true, job: { id: 42 } },
} = {}) {
  const searches = [];
  const grabs = [];
  const audits = [];
  const CONFIG = { AVISTAZ_INDEXER_NAME: 'avistaz' };
  const sandbox = loadSandbox(['rerouteDeadPremiumizeTransfer'], {
    CONFIG,
    tunable: key => (key === 'PREMIUMIZE_REROUTE_MIN_CONFIDENCE' ? minConfidence : null),
    grabConfigured: () => true,
    fetchArrQueues: async () => queue,
    normalizeTitle,
    splitTitleYear,
    getSeriesByTvdbId: async () => series,
    getMovieByTmdbId: async () => movie,
    sonarrSeriesAliases,
    searchAvistaz: async (args) => { searches.push(args); return searchResults; },
    rankAvistazResults,
    seriesAliasMatch,
    executeGrab: async (top, meta) => { grabs.push({ top, meta }); return grabResult; },
    audit: (action, details) => audits.push({ action, details }),
  });
  return { sandbox, searches, grabs, audits };
}

const tvQueueItem = (over = {}) => ({
  source: { kind: 'tv' }, sourceTitle: 'Revenge.S01E01.1080p.WEB-DL-RARBG',
  seriesTvdbId: 250910, seasonNumber: 1, ...over,
});
const movieQueueItem = (over = {}) => ({
  source: { kind: 'movie' }, sourceTitle: 'The.Matrix.1999.1080p.WEB-DL-RARBG',
  movieTmdbId: 603, ...over,
});
const result = (over = {}) => ({ title: 'Revenge.S01.1080p.WEB-DL-GROUP', downloadUrl: 'http://prowlarr/dl/1', seeders: 20, size: 4 * 1024 ** 3, indexer: 'PublicTracker', indexerFlags: [], ...over });

test('rerouteDeadPremiumizeTransfer: no queue match returns no_match without searching', async () => {
  const h = build({ queue: [tvQueueItem({ sourceTitle: 'Something.Else.S01E01' })] });
  const out = await h.sandbox.rerouteDeadPremiumizeTransfer({ id: 1, name: 'Revenge.S01E01.1080p.WEB-DL-RARBG' });
  assert.strictEqual(out.status, 'no_match');
  assert.strictEqual(h.searches.length, 0, 'no search spent when nothing to identify the release with');
});

test('rerouteDeadPremiumizeTransfer: TV match searches, excludes AvistaZ results, and grabs the top public candidate', async () => {
  const h = build({
    queue: [tvQueueItem()],
    series: { id: 9, tvdbId: 250910, title: 'Revenge', year: 2011 },
    searchResults: [
      result({ title: 'Revenge.S01.COMPLETE.1080p.WEB-DL-GROUP', indexer: 'AvistaZ (API)', seeders: 50 }),
      result({ title: 'Revenge.S01.COMPLETE.1080p.WEB-DL-GROUP2' }),
    ],
  });
  const out = await h.sandbox.rerouteDeadPremiumizeTransfer({ id: 1, name: 'Revenge.S01E01.1080p.WEB-DL-RARBG' });
  assert.strictEqual(h.searches.length, 1, 'searched once');
  assert.strictEqual(h.searches[0].indexerId, undefined, 'no indexerId restriction — searches every configured indexer');
  assert.strictEqual(h.grabs.length, 1, 'grabbed exactly one candidate');
  assert.match(h.grabs[0].top.releaseTitle, /GROUP2/, 'the AvistaZ-indexer result was excluded from ranking, so the public one won');
  assert.strictEqual(h.grabs[0].meta.origin, 'premiumize_reroute');
  assert.strictEqual(h.grabs[0].meta.mediaId, 'tvdb:250910');
  assert.strictEqual(out.status, 'grabbed');
  assert.strictEqual(h.audits.filter(a => a.action === 'premiumize_reroute_grabbed').length, 1);
});

test('rerouteDeadPremiumizeTransfer: movie match resolves via tmdbId and grabs', async () => {
  const h = build({
    queue: [movieQueueItem()],
    movie: { id: 5, tmdbId: 603, title: 'The Matrix', year: 1999 },
    searchResults: [result({ title: 'The.Matrix.1999.1080p.WEB-DL-GROUP' })],
  });
  const out = await h.sandbox.rerouteDeadPremiumizeTransfer({ id: 2, name: 'The.Matrix.1999.1080p.WEB-DL-RARBG' });
  assert.strictEqual(out.status, 'grabbed');
  assert.strictEqual(h.grabs[0].meta.mediaType, 'movie');
  assert.strictEqual(h.grabs[0].meta.mediaId, 'tmdb:603');
});

test('rerouteDeadPremiumizeTransfer: below-confidence top result is not grabbed', async () => {
  const h = build({
    queue: [tvQueueItem()],
    series: { id: 9, tvdbId: 250910, title: 'Revenge', year: 2011 },
    searchResults: [result({ title: 'Revenge.S04E01.HDTV.x264-BADGRP', seeders: 0, size: 1 })],
    minConfidence: 90,
  });
  const out = await h.sandbox.rerouteDeadPremiumizeTransfer({ id: 1, name: 'Revenge.S01E01.1080p.WEB-DL-RARBG' });
  assert.strictEqual(out.status, 'low_confidence');
  assert.strictEqual(h.grabs.length, 0, 'never grabs below the configured confidence floor');
});

test('rerouteDeadPremiumizeTransfer: no search results at all returns no_results', async () => {
  const h = build({ queue: [tvQueueItem()], series: { id: 9, tvdbId: 250910, title: 'Revenge', year: 2011 }, searchResults: [] });
  const out = await h.sandbox.rerouteDeadPremiumizeTransfer({ id: 1, name: 'Revenge.S01E01.1080p.WEB-DL-RARBG' });
  assert.strictEqual(out.status, 'no_results');
});

test('rerouteDeadPremiumizeTransfer: not configured short-circuits before any queue fetch', async () => {
  const searches = [];
  const sandbox = loadSandbox(['rerouteDeadPremiumizeTransfer'], {
    CONFIG: { AVISTAZ_INDEXER_NAME: 'avistaz' },
    tunable: () => 60,
    grabConfigured: () => false,
    fetchArrQueues: async () => { searches.push('called'); return []; },
    normalizeTitle, splitTitleYear, rankAvistazResults, seriesAliasMatch,
    getSeriesByTvdbId: async () => null, getMovieByTmdbId: async () => null, sonarrSeriesAliases,
    searchAvistaz: async () => [], executeGrab: async () => ({ ok: false }), audit: () => {},
  });
  const out = await sandbox.rerouteDeadPremiumizeTransfer({ id: 1, name: 'anything' });
  assert.strictEqual(out.status, 'not_configured');
  assert.strictEqual(searches.length, 0);
});
