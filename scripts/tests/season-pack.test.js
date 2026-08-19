#!/usr/bin/env node
// Season-pack-first searching: the age gate and the per-season decision (src/season-pack.js,
// imported directly — it's pure, so no Sonarr and no SQLite are involved).
const { test } = require('node:test');
const assert = require('node:assert');
const { assessSeriesAge, planSeasonSearches, seasonSearchTargets, describeSeasonSearch, summarizeSeasonFillActivity } = require('../../src/season-pack');

const DAY = 86400000;
const NOW = Date.parse('2026-08-09T00:00:00Z');
const daysAgo = n => new Date(NOW - n * DAY).toISOString();
const daysAhead = n => new Date(NOW + n * DAY).toISOString();
const cfg = { dormantDays: 365, minMissing: 3, cooldownHours: 24 };
const ep = (season, number, over = {}) => ({
  seasonNumber: season, episodeNumber: number, monitored: true, hasFile: false,
  airDateUtc: daysAgo(1000), ...over,
});
const seasonsOf = plan => plan.map(s => s.season);

test('season-pack: assessSeriesAge age gate', () => {
  assert.strictEqual(assessSeriesAge({ status: 'ended', previousAiring: daysAgo(4000) }, NOW, cfg).old, true, 'an ended series is old');
  assert.strictEqual(assessSeriesAge({ ended: true }, NOW, cfg).old, true, 'the boolean ended flag counts too');
  assert.strictEqual(assessSeriesAge({ status: 'continuing', previousAiring: daysAgo(800) }, NOW, cfg).old, true, 'a long-dormant continuing series is old');
  assert.strictEqual(assessSeriesAge({ status: 'continuing', previousAiring: daysAgo(30) }, NOW, cfg).old, false, 'a recently-aired series is current');
  assert.strictEqual(assessSeriesAge({ status: 'continuing', previousAiring: daysAgo(800), nextAiring: daysAhead(3) }, NOW, cfg).old, false,
    'a scheduled airing makes a series current however long it has been dormant');
  // The gate that protects a currently-airing show: episode 8 aired last night, no pack exists,
  // and treating it as old would stall the season waiting for one.
  assert.strictEqual(assessSeriesAge({ status: 'ended', nextAiring: daysAhead(7) }, NOW, cfg).old, false,
    'a scheduled airing beats even an ended status');
  assert.strictEqual(assessSeriesAge({ status: 'continuing' }, NOW, cfg).old, false, 'no air dates claims nothing');
  assert.strictEqual(assessSeriesAge({}, NOW, cfg).old, false, 'an empty series is never assumed old');
  assert.match(assessSeriesAge({ status: 'continuing', previousAiring: daysAgo(800) }, NOW, cfg).reason, /800 days/, 'the dormant reason names the gap');
});

test('season-pack: planSeasonSearches per-season decisions', () => {
  // A whole season missing is the clean pack case, whatever the episode count.
  assert.deepStrictEqual(seasonsOf(planSeasonSearches([ep(1, 1), ep(1, 2)], NOW, cfg)), [1],
    'an entirely missing season qualifies even below minMissing');

  // A partially-present season needs enough gaps to be worth a whole pack.
  const partial = n => [
    ...Array.from({ length: n }, (_, i) => ep(2, i + 1)),
    ...Array.from({ length: 10 - n }, (_, i) => ep(2, n + i + 1, { hasFile: true })),
  ];
  assert.deepStrictEqual(seasonsOf(planSeasonSearches(partial(3), NOW, cfg)), [2], '3 missing of 10 hits the threshold');
  assert.deepStrictEqual(seasonsOf(planSeasonSearches(partial(2), NOW, cfg)), [],
    'a season missing 1-2 episodes is left to per-episode search — a 20 GB pack for one gap is worse');

  // Nothing to do, and things that must never be swept in.
  assert.deepStrictEqual(seasonsOf(planSeasonSearches([ep(1, 1, { hasFile: true }), ep(1, 2, { hasFile: true })], NOW, cfg)), [],
    'a complete season is not searched');
  assert.deepStrictEqual(seasonsOf(planSeasonSearches([ep(0, 1), ep(0, 2), ep(0, 3)], NOW, cfg)), [],
    'specials (season 0) never get a pack search');
  assert.deepStrictEqual(seasonsOf(planSeasonSearches([ep(1, 1, { monitored: false }), ep(1, 2, { monitored: false }), ep(1, 3, { monitored: false })], NOW, cfg)), [],
    'unmonitored episodes were excluded on purpose and do not count as missing');
  assert.deepStrictEqual(seasonsOf(planSeasonSearches([ep(3, 1, { airDateUtc: daysAhead(5) }), ep(3, 2, { airDateUtc: daysAhead(12) })], NOW, cfg)), [],
    'unaired episodes cannot be downloaded and never trigger a search');
  // An old show mid-season: the aired half is missing, the unaired half is not counted.
  assert.deepStrictEqual(seasonsOf(planSeasonSearches([ep(4, 1), ep(4, 2), ep(4, 3), ep(4, 4, { airDateUtc: daysAhead(2) })], NOW, cfg)), [4],
    'a season is judged on its aired episodes only');
  assert.deepStrictEqual(seasonsOf(planSeasonSearches([ep(2, 1), ep(2, 2), ep(2, 3), ep(1, 1), ep(1, 2), ep(1, 3)], NOW, cfg)), [1, 2],
    'multiple qualifying seasons come back in season order');
});

test('season-pack: seasonSearchTargets composed decision (age gate + queue + cooldown)', () => {
  const episodes = [ep(1, 1), ep(1, 2), ep(1, 3), ep(2, 1), ep(2, 2), ep(2, 3)];
  const ended = { status: 'ended' };

  let t = seasonSearchTargets({ series: ended, episodes }, NOW, cfg);
  assert.deepStrictEqual(seasonsOf(t.seasons), [1, 2], 'an ended show with two gappy seasons plans both');

  t = seasonSearchTargets({ series: { status: 'continuing', previousAiring: daysAgo(10) }, episodes }, NOW, cfg);
  assert.deepStrictEqual(t.seasons, [], 'a currently-airing show is never season-searched');

  t = seasonSearchTargets({ series: ended, episodes, inQueue: [1] }, NOW, cfg);
  assert.deepStrictEqual(seasonsOf(t.seasons), [2], 'a season already downloading is not searched again');

  t = seasonSearchTargets({ series: ended, episodes, searchedAt: { 1: NOW - 2 * 3600000 } }, NOW, cfg);
  assert.deepStrictEqual(seasonsOf(t.seasons), [2], 'a season inside its cooldown is skipped');
  assert.deepStrictEqual(seasonsOf(t.held), [1], 'a cooldown-held season remains visible to previews');
  assert.strictEqual(t.held[0].nextEligible, NOW + 22 * 3600000, 'the held season reports its exact next eligible time');

  t = seasonSearchTargets({ series: ended, episodes, searchedAt: { 1: NOW - 30 * 3600000 } }, NOW, cfg);
  assert.deepStrictEqual(seasonsOf(t.seasons), [1, 2], 'a season past its cooldown is retried');
});

test('season-pack: a stalled season\'s cooldown backs off exponentially instead of retrying at a fixed cadence', () => {
  const episodes = [ep(1, 1), ep(1, 2), ep(1, 3), ep(2, 1), ep(2, 2), ep(2, 3)];
  const ended = { status: 'ended' };
  const backoffCfg = { ...cfg, maxBackoffSteps: 4 };

  // Base cooldown is 24h. One stalled sweep doubles it to 48h — 25h ago is still inside it.
  let t = seasonSearchTargets({ series: ended, episodes, searchedAt: { 1: NOW - 25 * 3600000 }, stallCounts: { 1: 1 } }, NOW, backoffCfg);
  assert.deepStrictEqual(seasonsOf(t.seasons), [2], 'one stalled sweep already doubles the cooldown');
  assert.strictEqual(t.held[0].nextEligible, NOW - 25 * 3600000 + 48 * 3600000, 'the held season reports the backed-off eligible time');

  // Three stalled sweeps: 24h * 2^3 = 192h. 100h ago is still well inside it.
  t = seasonSearchTargets({ series: ended, episodes, searchedAt: { 1: NOW - 100 * 3600000 }, stallCounts: { 1: 3 } }, NOW, backoffCfg);
  assert.deepStrictEqual(seasonsOf(t.seasons), [2], 'repeated stalls keep pushing the cooldown out');

  // The backoff is capped at maxBackoffSteps (4 → 16x = 384h here), so it never grows unbounded.
  t = seasonSearchTargets({ series: ended, episodes, searchedAt: { 1: NOW - 385 * 3600000 }, stallCounts: { 1: 50 } }, NOW, backoffCfg);
  assert.deepStrictEqual(seasonsOf(t.seasons), [1, 2], 'the cap stops the backoff from growing past 2^maxBackoffSteps');

  // A season with no recorded stall (0, or absent) behaves exactly like the plain cooldown test.
  t = seasonSearchTargets({ series: ended, episodes, searchedAt: { 1: NOW - 25 * 3600000 }, stallCounts: { 1: 0 } }, NOW, backoffCfg);
  assert.deepStrictEqual(seasonsOf(t.seasons), [1, 2], 'zero stalls means no backoff at all');
});

test('season-pack: requested shows bypass the age gate; describeSeasonSearch summary', () => {
  const episodes = [ep(1, 1), ep(1, 2), ep(1, 3), ep(2, 1), ep(2, 2), ep(2, 3)];
  const ended = { status: 'ended' };
  // Most releases are an "S01" season pack whatever the show's age, and somebody is waiting on a
  // requested show — so a current series that was actually requested gets the pack treatment too.
  const airing = { status: 'continuing', previousAiring: daysAgo(3), nextAiring: daysAhead(4) };

  let t = seasonSearchTargets({ series: airing, episodes, requested: true }, NOW, cfg);
  assert.deepStrictEqual(seasonsOf(t.seasons), [1, 2], 'a requested show is season-searched even while airing');
  assert.strictEqual(t.old, false, 'the age verdict is still reported honestly');
  assert.strictEqual(t.eligible, true, 'eligibility is what the sweep acts on');
  assert.strictEqual(t.reason, 'requested', 'the reason distinguishes a request from an ended show');

  t = seasonSearchTargets({ series: airing, episodes, requested: false }, NOW, cfg);
  assert.deepStrictEqual(t.seasons, [], 'an airing show nobody requested is still left alone');

  t = seasonSearchTargets({ series: ended, episodes, requested: true }, NOW, cfg);
  assert.strictEqual(t.reason, 'series has ended', 'an old show reports its age, not the request');

  t = seasonSearchTargets({ series: airing, episodes, requested: true }, NOW, { ...cfg, includeRequested: false });
  assert.deepStrictEqual(t.seasons, [], 'SEASON_PACK_REQUESTED=false restores the age-only gate');

  // The safety property that makes this OK on a live season: only AIRED episodes count, so a
  // season halfway through its run has nothing to search for until episodes actually go missing.
  const midSeason = [ep(1, 1, { hasFile: true }), ep(1, 2, { hasFile: true }), ep(1, 3, { airDateUtc: daysAhead(3) }), ep(1, 4, { airDateUtc: daysAhead(10) })];
  t = seasonSearchTargets({ series: airing, episodes: midSeason, requested: true }, NOW, cfg);
  assert.deepStrictEqual(t.seasons, [], 'a requested season that is up to date is not searched');

  assert.strictEqual(describeSeasonSearch('Winter Sonata', { season: 1, missing: 3, aired: 20 }),
    '**Winter Sonata** S01 — 3 of 20 aired episode(s) missing', 'summary line');
});

test('season-pack: queue and history rows identify pack, episode, mixed, and unknown fills', () => {
  assert.deepStrictEqual(summarizeSeasonFillActivity([]), {
    mode: 'none', releaseCount: 0, packReleases: 0, episodeReleases: 0, unknownReleases: 0,
  });

  const pack = summarizeSeasonFillActivity([
    { downloadId: 'pack-1', sourceTitle: 'Drama.S01.1080p', episodeNumber: 1 },
    { downloadId: 'pack-1', sourceTitle: 'Drama.S01.1080p', episodeNumber: 2 },
    { downloadId: 'pack-1', sourceTitle: 'Drama.S01.1080p', episodeNumber: 3 },
  ]);
  assert.deepStrictEqual(pack, {
    mode: 'pack', releaseCount: 1, packReleases: 1, episodeReleases: 0, unknownReleases: 0,
  });

  const episodes = summarizeSeasonFillActivity([
    { downloadId: 'ep-1', sourceTitle: 'Drama.S01E01.1080p', episodeNumber: 1 },
    { downloadId: 'ep-2', sourceTitle: 'Drama.S01E02.1080p', episodeNumber: 2 },
  ]);
  assert.deepStrictEqual(episodes, {
    mode: 'episodes', releaseCount: 2, packReleases: 0, episodeReleases: 2, unknownReleases: 0,
  });

  assert.strictEqual(summarizeSeasonFillActivity([
    { downloadId: 'pack-1', episodeNumbers: [1, 2] },
    { downloadId: 'ep-3', episodeNumber: 3 },
  ]).mode, 'mixed');
  assert.strictEqual(summarizeSeasonFillActivity([{ downloadId: 'opaque' }]).mode, 'unknown');
  assert.strictEqual(summarizeSeasonFillActivity([{ downloadId: 'flagged', fullSeason: true }]).mode, 'pack');
});
