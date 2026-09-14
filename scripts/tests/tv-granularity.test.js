#!/usr/bin/env node
// Season/episode-level TV cache planning (#183) — pure identity + planner-slice tests.
// src/tv-granularity.js is DB/Discord-free (like src/tier.js) so it's imported directly, and its
// output is fed straight into the REAL, unmodified src/tier.js planner (planNode/planTier) to
// prove selected-unit budget/eviction math works without touching src/tier.js itself.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  canonicalSeriesId, canonicalSeasonId, canonicalEpisodeId, parseTvUnitId, resolvePlayedUnit,
  buildTvUnitInventory, checkPromotionCap, computeMigrationPreview,
} = require('../../src/tv-granularity');
const { planNode } = require('../../src/tier');

const GB = 1024 ** 3;
const NOW = Date.parse('2026-09-14T00:00:00Z');

// ---- canonical ids ------------------------------------------------------------------------
test('tv-granularity: canonical id minting + round-trip parsing', () => {
  assert.strictEqual(canonicalSeriesId('tvdb:75978'), 'tvdb:75978');
  assert.strictEqual(canonicalSeriesId(75978), 'tvdb:75978');
  assert.strictEqual(canonicalSeasonId('tvdb:75978', 2), 'tvdb:75978:s2');
  assert.strictEqual(canonicalEpisodeId('tvdb:75978', 2, 5), 'tvdb:75978:s2e5');
  assert.strictEqual(canonicalSeasonId('tvdb:75978', null), null, 'missing season number yields no id');
  assert.strictEqual(canonicalEpisodeId('tvdb:75978', 2, null), null, 'missing episode number yields no id');

  assert.deepStrictEqual(parseTvUnitId('tvdb:75978'), { kind: 'series', tvdbId: '75978', seasonNumber: null, episodeNumber: null });
  assert.deepStrictEqual(parseTvUnitId('tvdb:75978:s2'), { kind: 'season', tvdbId: '75978', seasonNumber: 2, episodeNumber: null });
  assert.deepStrictEqual(parseTvUnitId('tvdb:75978:s2e5'), { kind: 'episode', tvdbId: '75978', seasonNumber: 2, episodeNumber: 5 });
  assert.strictEqual(parseTvUnitId('tmdb:603'), null, 'a movie id is not a TV unit id');
  assert.strictEqual(parseTvUnitId('garbage'), null);
});

// ---- resolvePlayedUnit: graceful degradation toward the safe legacy default ---------------
test('tv-granularity: resolvePlayedUnit honors granularity when data is complete', () => {
  assert.deepStrictEqual(
    resolvePlayedUnit({ tvdbId: 1, seasonNumber: 3, episodeNumber: 7, granularity: 'episode' }),
    { kind: 'episode', mediaId: 'tvdb:1:s3e7' },
  );
  assert.deepStrictEqual(
    resolvePlayedUnit({ tvdbId: 1, seasonNumber: 3, episodeNumber: 7, granularity: 'season' }),
    { kind: 'season', mediaId: 'tvdb:1:s3' },
  );
  assert.deepStrictEqual(
    resolvePlayedUnit({ tvdbId: 1, seasonNumber: 3, episodeNumber: 7, granularity: 'series' }),
    { kind: 'series', mediaId: 'tvdb:1' },
  );
});

test('tv-granularity: resolvePlayedUnit degrades to a coarser unit when finer data is missing, never invents one', () => {
  // episode requested but no episode number known → falls back to season, not series (season IS known).
  assert.deepStrictEqual(
    resolvePlayedUnit({ tvdbId: 1, seasonNumber: 3, episodeNumber: null, granularity: 'episode' }),
    { kind: 'season', mediaId: 'tvdb:1:s3' },
  );
  // season requested but no season number known → falls back to series (the only thing knowable).
  assert.deepStrictEqual(
    resolvePlayedUnit({ tvdbId: 1, seasonNumber: null, episodeNumber: null, granularity: 'season' }),
    { kind: 'series', mediaId: 'tvdb:1' },
  );
  // episode requested, nothing known beyond the series → series.
  assert.deepStrictEqual(
    resolvePlayedUnit({ tvdbId: 1, granularity: 'episode' }),
    { kind: 'series', mediaId: 'tvdb:1' },
  );
  // invalid granularity string → treated as 'series' (matches TIER_TV_GRANULARITY validation).
  assert.deepStrictEqual(
    resolvePlayedUnit({ tvdbId: 1, seasonNumber: 3, episodeNumber: 7, granularity: 'bogus' }),
    { kind: 'series', mediaId: 'tvdb:1' },
  );
  assert.strictEqual(resolvePlayedUnit({ tvdbId: null }), null, 'no series id at all → no unit to resolve');
});

// ---- buildTvUnitInventory -------------------------------------------------------------------
const seriesItem = (mediaId, title, sizeGb, path) => ({
  mediaId, title, mediaType: 'tv', sizeBytes: sizeGb * GB, addedAt: Date.parse('2026-01-01'), path, relPath: path.replace(/^\/mnt\/raid\//, ''),
});
const movieItem = { mediaId: 'tmdb:1', title: 'A Movie', mediaType: 'movie', sizeBytes: 5 * GB, addedAt: NOW, path: '/mnt/raid/movies/A', relPath: 'movies/A' };

test('tv-granularity: granularity "series" is a byte-identical pass-through (default/legacy behavior unchanged)', () => {
  const items = [seriesItem('tvdb:75978', 'Show', 30, '/mnt/raid/tv/Show'), movieItem];
  const { items: out, warnings } = buildTvUnitInventory({ seriesItems: items, granularity: 'series' });
  assert.strictEqual(warnings.length, 0);
  assert.strictEqual(out.length, 2);
  const show = out.find(i => i.mediaId === 'tvdb:75978');
  assert.strictEqual(show.sizeBytes, 30 * GB, 'series-mode keeps the whole-series byte total');
  assert.strictEqual(show.unit, 'series');
  const movie = out.find(i => i.mediaId === 'tmdb:1');
  assert.deepStrictEqual(movie, movieItem, 'movie items pass through byte-for-byte, untouched');
});

test('tv-granularity: default granularity (omitted) behaves exactly like "series"', () => {
  const items = [seriesItem('tvdb:75978', 'Show', 30, '/mnt/raid/tv/Show')];
  const { items: out } = buildTvUnitInventory({ seriesItems: items });
  assert.strictEqual(out[0].sizeBytes, 30 * GB);
  assert.strictEqual(out[0].unit, 'series');
});

test('tv-granularity: a series with no episode-file data falls back to a whole-series unit and warns (never dropped)', () => {
  const items = [seriesItem('tvdb:75978', 'Show', 30, '/mnt/raid/tv/Show')];
  const { items: out, warnings } = buildTvUnitInventory({ seriesItems: items, episodeFilesBySeries: {}, granularity: 'season' });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].mediaId, 'tvdb:75978', 'title stays present under its legacy series id');
  assert.strictEqual(out[0].sizeBytes, 30 * GB);
  assert.strictEqual(out[0].unit, 'series');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /no episode-file data available/);
});

function fileRec(seasonNumber, episodeNumber, sizeGb, path, addedAt = NOW) {
  return { seasonNumber, episodeNumber, sizeBytes: sizeGb * GB, path, addedAt };
}

test('tv-granularity: granularity "season" splits a multi-season series into per-season units summing to the series total', () => {
  const items = [seriesItem('tvdb:75978', 'Bluey', 30, '/mnt/raid/tv/Bluey')];
  const episodeFiles = {
    75978: [
      fileRec(1, 1, 5, '/mnt/raid/tv/Bluey/Season 01/e1.mkv'),
      fileRec(1, 2, 5, '/mnt/raid/tv/Bluey/Season 01/e2.mkv'),
      fileRec(2, 1, 10, '/mnt/raid/tv/Bluey/Season 02/e1.mkv'),
      fileRec(2, 2, 10, '/mnt/raid/tv/Bluey/Season 02/e2.mkv'),
    ],
  };
  const { items: out, warnings } = buildTvUnitInventory({
    seriesItems: items, episodeFilesBySeries: episodeFiles, granularity: 'season', sourceRoot: '/mnt/raid',
  });
  assert.strictEqual(warnings.length, 0);
  assert.strictEqual(out.length, 2, 'two seasons, no leftover whole-series item');
  const s1 = out.find(i => i.mediaId === 'tvdb:75978:s1');
  const s2 = out.find(i => i.mediaId === 'tvdb:75978:s2');
  assert.strictEqual(s1.sizeBytes, 10 * GB);
  assert.strictEqual(s2.sizeBytes, 20 * GB);
  assert.strictEqual(s1.seriesMediaId, 'tvdb:75978');
  assert.strictEqual(s1.unit, 'season');
  assert.strictEqual(s1.relPath, 'tv/Bluey/Season 01', 'season relPath derived from the common file directory');
  assert.strictEqual(s1.sizeBytes + s2.sizeBytes, 30 * GB, 'season bytes sum to the original series total');
});

test('tv-granularity: granularity "episode" splits down to per-episode units, with an unresolved-episode-number fallback', () => {
  const items = [seriesItem('tvdb:1', 'Show', 6, '/mnt/raid/tv/Show')];
  const episodeFiles = {
    1: [
      fileRec(1, 1, 2, '/mnt/raid/tv/Show/Season 01/e1.mkv'),
      fileRec(1, 2, 2, '/mnt/raid/tv/Show/Season 01/e2.mkv'),
      fileRec(1, null, 2, '/mnt/raid/tv/Show/Season 01/e3-e4-multi.mkv'), // unresolved episode number
    ],
  };
  const { items: out, warnings } = buildTvUnitInventory({
    seriesItems: items, episodeFilesBySeries: episodeFiles, granularity: 'episode', sourceRoot: '/mnt/raid',
  });
  assert.strictEqual(out.length, 3);
  const e1 = out.find(i => i.mediaId === 'tvdb:1:s1e1');
  assert.strictEqual(e1.sizeBytes, 2 * GB);
  assert.strictEqual(e1.seasonMediaId, 'tvdb:1:s1');
  assert.strictEqual(e1.seriesMediaId, 'tvdb:1');
  const unresolved = out.find(i => i.episodeNumber === null);
  assert.ok(unresolved, 'the multi-episode file with no resolvable episode number is kept as its own unit');
  assert.strictEqual(unresolved.sizeBytes, 2 * GB);
  assert.ok(warnings.some(w => /no resolvable episode number/.test(w)));
});

test('tv-granularity: a >5% byte drift between series sizeOnDisk and summed episode files is warned but never dropped', () => {
  const items = [seriesItem('tvdb:1', 'Show', 100, '/mnt/raid/tv/Show')]; // series claims 100 GB
  const episodeFiles = { 1: [fileRec(1, 1, 40, '/mnt/raid/tv/Show/Season 01/e1.mkv')] }; // files sum to 40 GB
  const { items: out, warnings } = buildTvUnitInventory({ seriesItems: items, episodeFilesBySeries: episodeFiles, granularity: 'season' });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].sizeBytes, 40 * GB, 'unit bytes come from the real episode files, not the stale series total');
  assert.ok(warnings.some(w => /differ from the series/.test(w)));
});

// ---- oversized-promotion cap -----------------------------------------------------------------
test('tv-granularity: checkPromotionCap gates a unit above the configured cap, 0/null disables it', () => {
  assert.deepStrictEqual(checkPromotionCap({ unitBytes: 50 * GB, capBytes: 30 * GB }).requiresConfirm, true);
  assert.deepStrictEqual(checkPromotionCap({ unitBytes: 10 * GB, capBytes: 30 * GB }).requiresConfirm, false);
  assert.strictEqual(checkPromotionCap({ unitBytes: 500 * GB, capBytes: 0 }).requiresConfirm, false, '0 disables the cap');
  assert.strictEqual(checkPromotionCap({ unitBytes: 500 * GB, capBytes: null }).requiresConfirm, false, 'null disables the cap');
});

// ---- read-only migration preview ---------------------------------------------------------------
test('tv-granularity: computeMigrationPreview reports the split with no side effects and flags oversized units', () => {
  const legacyEntries = [
    { mediaId: 'tvdb:75978', title: 'Bluey', relPath: 'tv/Bluey', sizeBytes: 30 * GB },
    { mediaId: 'tmdb:1', title: 'A Movie', relPath: 'movies/A', sizeBytes: 5 * GB }, // ignored (not TV)
  ];
  const expandedItems = [
    { mediaId: 'tvdb:75978:s1', title: 'Bluey — Season 1', unit: 'season', seriesMediaId: 'tvdb:75978', relPath: 'tv/Bluey/Season 01', sizeBytes: 10 * GB },
    { mediaId: 'tvdb:75978:s2', title: 'Bluey — Season 2', unit: 'season', seriesMediaId: 'tvdb:75978', relPath: 'tv/Bluey/Season 02', sizeBytes: 20 * GB },
  ];
  const report = computeMigrationPreview({ legacyEntries, expandedItems, capBytes: 15 * GB });
  assert.strictEqual(report.readOnly, true);
  assert.strictEqual(report.live, false);
  assert.strictEqual(report.perSeries.length, 1, 'only the TV entry produces a preview row');
  const row = report.perSeries[0];
  assert.strictEqual(row.legacyBytes, 30 * GB);
  assert.strictEqual(row.unitBytes, 30 * GB);
  assert.strictEqual(row.byteDeltaBytes, 0, 'splitting doesn\'t change total bytes, only their grouping');
  assert.strictEqual(row.units.length, 2);
  assert.strictEqual(row.units.find(u => u.mediaId === 'tvdb:75978:s2').requiresConfirm, true, '20 GB season exceeds the 15 GB cap');
  assert.strictEqual(row.units.find(u => u.mediaId === 'tvdb:75978:s1').requiresConfirm, false);
  assert.strictEqual(report.totals.seriesCount, 1);
  assert.strictEqual(report.totals.oversizedUnitCount, 1);
  assert.strictEqual(report.totals.totalLegacyBytes, 30 * GB);
  assert.strictEqual(report.totals.totalUnitBytes, 30 * GB);
});

test('tv-granularity: computeMigrationPreview flags a series with no expanded children instead of guessing', () => {
  const legacyEntries = [{ mediaId: 'tvdb:9', title: 'No Data Show', relPath: 'tv/No Data Show', sizeBytes: 12 * GB }];
  const report = computeMigrationPreview({ legacyEntries, expandedItems: [] });
  assert.strictEqual(report.perSeries[0].missingChildData, true);
  assert.strictEqual(report.perSeries[0].units.length, 0);
  assert.strictEqual(report.totals.seriesMissingChildData, 1);
  assert.ok(report.warnings.some(w => /no season\/episode breakdown available/.test(w)));
});

// ---- integration proof: season-granularity items flow through the REAL, unmodified tier.js
// planner correctly — this is the acceptance-criteria evidence that (a) playing one episode
// pins/promotes only the configured unit, not the whole series, and (b) budget/eviction math uses
// real selected-unit bytes, without any change to src/tier.js itself.
test('tv-granularity + tier.js: a season-granularity floor pin admits only that season\'s bytes, not the whole series', () => {
  const items = [seriesItem('tvdb:1', 'Show', 300, '/mnt/raid/tv/Show')]; // 300 GB whole series — the motivating case in the issue
  const episodeFiles = {
    1: [
      fileRec(1, 1, 40, '/mnt/raid/tv/Show/Season 01/e1.mkv'),
      fileRec(2, 1, 40, '/mnt/raid/tv/Show/Season 02/e1.mkv'), // the season actually being watched
      fileRec(3, 1, 40, '/mnt/raid/tv/Show/Season 03/e1.mkv'),
    ],
  };
  const { items: seasonInventory } = buildTvUnitInventory({
    seriesItems: items, episodeFilesBySeries: episodeFiles, granularity: 'season', sourceRoot: '/mnt/raid',
  });
  assert.strictEqual(seasonInventory.length, 3);
  const watchedSeasonId = resolvePlayedUnit({ tvdbId: 1, seasonNumber: 2, episodeNumber: 1, granularity: 'season' }).mediaId;
  assert.strictEqual(watchedSeasonId, 'tvdb:1:s2');

  // A small edge node (60 GB budget) with ONLY the watched season pinned via the floor — exactly
  // what a play-triggered promotion would do once wired up. It must fit; a whole-series pin (300 GB)
  // could never fit an edge node this size, which is precisely the bug #183 exists to fix.
  const node = { name: 'edge', enabled: 1, usable_bytes: 60 * GB, headroom_pct: 0, full: 0, access: 'open', demand_source: 'tautulli' };
  const manifest = planNode({
    node, inventory: seasonInventory, values: new Map(), floorIds: new Set([watchedSeasonId]), now: NOW,
  });
  const keptIds = manifest.keep.map(e => e.mediaId);
  assert.deepStrictEqual(keptIds, ['tvdb:1:s2'], 'only the watched season is kept — the other two seasons are not implicitly pulled in');
  assert.strictEqual(manifest.stats.keepBytes, 40 * GB, 'budget/eviction accounting uses the real season bytes (40 GB), not the 300 GB series total');
  assert.ok(manifest.stats.keepBytes <= manifest.stats.budgetBytes);
});

test('tv-granularity + tier.js: with granularity "series" (the default), the same play still pins the whole 300 GB series — unchanged legacy behavior', () => {
  const items = [seriesItem('tvdb:1', 'Show', 300, '/mnt/raid/tv/Show')];
  const { items: seriesInventory } = buildTvUnitInventory({ seriesItems: items, granularity: 'series' });
  const watchedId = resolvePlayedUnit({ tvdbId: 1, seasonNumber: 2, episodeNumber: 1, granularity: 'series' }).mediaId;
  assert.strictEqual(watchedId, 'tvdb:1');

  const node = { name: 'edge', enabled: 1, usable_bytes: 1000 * GB, headroom_pct: 0, full: 0, access: 'open', demand_source: 'tautulli' };
  const manifest = planNode({ node, inventory: seriesInventory, values: new Map(), floorIds: new Set([watchedId]), now: NOW });
  assert.deepStrictEqual(manifest.keep.map(e => e.mediaId), ['tvdb:1']);
  assert.strictEqual(manifest.stats.keepBytes, 300 * GB, 'legacy behavior: the whole series is the unit, unchanged when granularity is off/default');
});
