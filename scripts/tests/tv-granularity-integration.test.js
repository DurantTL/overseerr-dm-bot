#!/usr/bin/env node
// #183 integration tests: Sonarr mapping, read-only preview assembly, and the promotion-unit
// floor logic wired into handleCaPlayStart. All data is mocked — no live Sonarr, no DB, no
// Discord. The live-planner inventory is intentionally whole-series here, matching production.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  resolvePromotableUnit,
  mapSonarrSeriesList,
  mapSonarrEpisodeFiles,
  previewTvGranularity,
} = require('../../src/tv-granularity');

const GB = 1024 ** 3;

// ---- resolvePromotableUnit: the fail-closed promotion-unit floor -----------------------------
test('promotable unit: default series granularity is a no-op returning the series id', () => {
  assert.strictEqual(
    resolvePromotableUnit({ tvdbId: 75978, seasonNumber: 2, episodeNumber: 5, granularity: 'series' }),
    'tvdb:75978');
  // even when an inventory set is provided, series needs no lookup
  assert.strictEqual(
    resolvePromotableUnit({ tvdbId: 75978, seasonNumber: 2, granularity: 'series', inventoryMediaIds: new Set(['tvdb:75978']) }),
    'tvdb:75978');
});

test('promotable unit: season pin against a series-only inventory fails closed to the series', () => {
  // This is the live-production shape: granularity configured finer, but the planner still emits
  // whole-series units. Pinning 'tvdb:75978:s2' would resolve to nothing in the manifest, so the
  // promotion must floor back to the series — never an unknown unit.
  assert.strictEqual(
    resolvePromotableUnit({ tvdbId: 75978, seasonNumber: 2, granularity: 'season', inventoryMediaIds: new Set(['tvdb:75978']) }),
    'tvdb:75978');
});

test('promotable unit: a season id the inventory actually knows is kept', () => {
  assert.strictEqual(
    resolvePromotableUnit({ tvdbId: 75978, seasonNumber: 2, granularity: 'season', inventoryMediaIds: new Set(['tvdb:75978', 'tvdb:75978:s2']) }),
    'tvdb:75978:s2');
});

test('promotable unit: episode granularity floors through season to series', () => {
  assert.strictEqual(
    resolvePromotableUnit({ tvdbId: 75978, seasonNumber: 2, episodeNumber: 5, granularity: 'episode', inventoryMediaIds: ['tvdb:75978'] }),
    'tvdb:75978');
  assert.strictEqual(
    resolvePromotableUnit({ tvdbId: 75978, seasonNumber: 2, episodeNumber: 5, granularity: 'episode', inventoryMediaIds: ['tvdb:75978', 'tvdb:75978:s2'] }),
    'tvdb:75978:s2');
  assert.strictEqual(
    resolvePromotableUnit({ tvdbId: 75978, seasonNumber: 2, episodeNumber: 5, granularity: 'episode', inventoryMediaIds: ['tvdb:75978', 'tvdb:75978:s2', 'tvdb:75978:s2e5'] }),
    'tvdb:75978:s2e5');
});

test('promotable unit: missing season number degrades to series; bad tvdb id returns null', () => {
  assert.strictEqual(
    resolvePromotableUnit({ tvdbId: 75978, granularity: 'season', inventoryMediaIds: new Set(['tvdb:75978']) }),
    'tvdb:75978');
  assert.strictEqual(resolvePromotableUnit({ tvdbId: null, granularity: 'season' }), null);
  assert.strictEqual(resolvePromotableUnit({ tvdbId: 'garbage', granularity: 'season' }), null);
});

// ---- Sonarr mapping ----------------------------------------------------------------------------
test('mapSonarrSeriesList: shapes raw /series records, drops tvdb-less series', () => {
  const items = mapSonarrSeriesList([
    { id: 7, tvdbId: 75978, title: 'The Show', path: '/media/tv/The Show', addedDate: '2026-01-02T03:04:05Z', statistics: { sizeOnDisk: 42 * GB } },
    { id: 8, title: 'No Tvdb', path: '/media/tv/No Tvdb', statistics: { sizeOnDisk: 1 } },
  ], { sourceRoot: '/media' });
  assert.strictEqual(items.length, 1);
  assert.deepStrictEqual(items[0], {
    mediaId: 'tvdb:75978',
    title: 'The Show',
    mediaType: 'tv',
    unit: 'series',
    seriesMediaId: 'tvdb:75978',
    sonarrId: 7,
    sizeBytes: 42 * GB,
    addedAt: Date.parse('2026-01-02T03:04:05Z'),
    path: '/media/tv/The Show',
    relPath: 'tv/The Show',
  });
});

test('mapSonarrEpisodeFiles: shapes raw /episodefile records, drops season-less files', () => {
  const files = mapSonarrEpisodeFiles([
    { seasonNumber: 2, episodeNumber: 5, sizeOnDisk: 3 * GB, path: '/media/tv/The Show/Season 2/f.mkv', dateAdded: '2026-02-03T04:05:06Z' },
    { seasonNumber: 2, episodeNumber: null, sizeOnDisk: 1 * GB, path: '/media/tv/The Show/Season 2/g.mkv' },
    { seasonNumber: 'x', episodeNumber: 1, sizeOnDisk: 1, path: '/media/tv/x.mkv' },
    { sizeOnDisk: 1, path: '/media/tv/y.mkv' },
  ]);
  assert.strictEqual(files.length, 2);
  assert.strictEqual(files[0].episodeNumber, 5);
  assert.strictEqual(files[0].addedAt, Date.parse('2026-02-03T04:05:06Z'));
  assert.strictEqual(files[1].episodeNumber, null, 'multi-episode file keeps a null episode number');
  assert.strictEqual(files[1].addedAt, null, 'missing dateAdded becomes null, not NaN');
});

// ---- read-only preview assembly ------------------------------------------------------------------
const mockSeries = () => mapSonarrSeriesList([
  { id: 7, tvdbId: 75978, title: 'The Show', path: '/media/tv/The Show', statistics: { sizeOnDisk: 10 * GB } },
  { id: 8, tvdbId: 12345, title: 'Other Show', path: '/media/tv/Other Show', statistics: { sizeOnDisk: 4 * GB } },
], { sourceRoot: '/media' });

const mockFiles = () => new Map([
  ['75978', mapSonarrEpisodeFiles([
    { seasonNumber: 1, episodeNumber: 1, sizeOnDisk: 4 * GB, path: '/media/tv/The Show/Season 1/a.mkv' },
    { seasonNumber: 1, episodeNumber: 2, sizeOnDisk: 4 * GB, path: '/media/tv/The Show/Season 1/b.mkv' },
    { seasonNumber: 2, episodeNumber: 1, sizeOnDisk: 2 * GB, path: '/media/tv/The Show/Season 2/c.mkv' },
  ])],
  // '12345' deliberately has no episode-file data — it must stay whole with a warning.
]);

test('previewTvGranularity: expands to seasons, keeps dataless series whole, stays read-only', () => {
  const preview = previewTvGranularity({ seriesItems: mockSeries(), episodeFilesBySeries: mockFiles(), granularity: 'season', capBytes: 60 * GB, sourceRoot: '/media' });
  assert.strictEqual(preview.readOnly, true, 'the result is explicitly marked a report, not a plan');
  assert.strictEqual(preview.live, false);
  assert.strictEqual(preview.granularity, 'season');
  assert.strictEqual(preview.previewedSeries, 2);
  assert.strictEqual(preview.totals.unitCount, 3, '2 seasons + 1 kept-whole series');
  assert.strictEqual(preview.totals.seriesMissingChildData, 0);
  assert.ok(preview.buildWarnings.length >= 1, 'warns about the dataless series');
  assert.ok(preview.buildWarnings.some(w => w.includes('no episode-file data available')), 'the dataless-series warning names the cause');
  const theShow = preview.perSeries.find(s => s.seriesMediaId === 'tvdb:75978');
  assert.deepStrictEqual(theShow.units.map(u => u.mediaId).sort(), ['tvdb:75978:s1', 'tvdb:75978:s2']);
  assert.strictEqual(theShow.missingChildData, false);
  const other = preview.perSeries.find(s => s.seriesMediaId === 'tvdb:12345');
  assert.strictEqual(other.missingChildData, false);
  assert.strictEqual(other.units.length, 1, 'the dataless series migrates to a single whole-series unit');
  assert.strictEqual(other.units[0].mediaId, 'tvdb:12345');
  assert.strictEqual(other.units[0].unit, 'series');
});

test('previewTvGranularity: flags units over the promotion cap', () => {
  const preview = previewTvGranularity({ seriesItems: mockSeries(), episodeFilesBySeries: mockFiles(), granularity: 'season', capBytes: 5 * GB });
  assert.strictEqual(preview.totals.oversizedUnitCount, 1, 'the 8 GB season 1 exceeds the 5 GB cap');
  const s1 = preview.perSeries.find(s => s.seriesMediaId === 'tvdb:75978').units.find(u => u.mediaId === 'tvdb:75978:s1');
  assert.strictEqual(s1.requiresConfirm, true);
});

test('previewTvGranularity: episode granularity splits to episodes', () => {
  const preview = previewTvGranularity({ seriesItems: mockSeries(), episodeFilesBySeries: mockFiles(), granularity: 'episode' });
  assert.strictEqual(preview.granularity, 'episode');
  const theShow = preview.perSeries.find(s => s.seriesMediaId === 'tvdb:75978');
  assert.deepStrictEqual(theShow.units.map(u => u.mediaId).sort(), ['tvdb:75978:s1e1', 'tvdb:75978:s1e2', 'tvdb:75978:s2e1']);
});
