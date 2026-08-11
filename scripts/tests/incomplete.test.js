#!/usr/bin/env node
// Gap analysis for requested titles: what has aired but isn't on disk, and what's being done.
const { test } = require('node:test');
const assert = require('node:assert');
const { isAiredMissing, isUpcoming, seasonGaps, summarizeSeriesGaps, describeGaps, describeActivity, rankIncomplete } = require('../../src/incomplete');

const NOW = Date.UTC(2026, 0, 15);
const DAY = 86400000;
const ep = (season, number, over = {}) => ({
  seasonNumber: season, episodeNumber: number, monitored: true, hasFile: false,
  airDateUtc: new Date(NOW - 30 * DAY).toISOString(), ...over,
});

test('incomplete: only aired, monitored, file-less episodes of real seasons count as gaps', () => {
  assert.strictEqual(isAiredMissing(ep(1, 1), NOW), true, 'plain missing episode');
  assert.strictEqual(isAiredMissing(ep(1, 1, { hasFile: true }), NOW), false, 'already downloaded');
  assert.strictEqual(isAiredMissing(ep(1, 1, { monitored: false }), NOW), false, 'unmonitored');
  assert.strictEqual(isAiredMissing(ep(0, 1), NOW), false, 'specials never count');
  assert.strictEqual(isAiredMissing(ep(1, 1, { airDateUtc: new Date(NOW + DAY).toISOString() }), NOW), false, 'not aired yet');
  assert.strictEqual(isAiredMissing(ep(1, 1, { airDateUtc: null, airDate: null }), NOW), false, 'no air date at all');
  assert.strictEqual(isUpcoming(ep(1, 1, { airDateUtc: new Date(NOW + DAY).toISOString() }), NOW), true, 'future episode is upcoming');
});

test('incomplete: season breakdown counts against what has aired, not the full season', () => {
  // Season 2 is mid-flight: 4 aired (2 missing), 4 still to come. The gap is 2 of 4, not 2 of 8.
  const episodes = [
    ep(1, 1, { hasFile: true }), ep(1, 2), ep(1, 3),
    ep(2, 1, { hasFile: true }), ep(2, 2, { hasFile: true }), ep(2, 3), ep(2, 4),
    ep(2, 5, { airDateUtc: new Date(NOW + DAY).toISOString() }),
    ep(2, 6, { airDateUtc: new Date(NOW + 8 * DAY).toISOString() }),
  ];
  const gaps = seasonGaps(episodes, NOW);
  assert.deepStrictEqual(gaps.map(g => [g.season, g.missing, g.aired]), [[1, 2, 3], [2, 2, 4]]);
  assert.strictEqual(gaps[1].upcoming, 2, 'unaired episodes tracked separately, not as gaps');
});

test('incomplete: a season with nothing at all is reported as fully missing', () => {
  const summary = summarizeSeriesGaps({ series: { id: 7, tvdbId: 99, title: 'Winter Sonata' }, episodes: [ep(1, 1), ep(1, 2), ep(1, 3)], now: NOW });
  assert.strictEqual(summary.airedMissing, 3);
  assert.strictEqual(summary.airedTotal, 3);
  assert.strictEqual(summary.pct, 0, 'nothing on disk → 0%');
  assert.strictEqual(describeGaps(summary), 'S01 all 3');
});

test('incomplete: the percentage reflects what aired, so a complete series reads 100%', () => {
  const episodes = [ep(1, 1, { hasFile: true }), ep(1, 2, { hasFile: true }), ep(1, 3, { airDateUtc: new Date(NOW + DAY).toISOString() })];
  const summary = summarizeSeriesGaps({ series: { id: 1, title: 'All Caught Up' }, episodes, now: NOW });
  assert.strictEqual(summary.airedMissing, 0);
  assert.strictEqual(summary.pct, 100, 'an unaired episode does not drag the number down');
  assert.strictEqual(describeGaps(summary), '', 'nothing to describe');
});

test('incomplete: gap description stays short and says how many seasons it hid', () => {
  const episodes = [];
  for (let season = 1; season <= 6; season++) episodes.push(ep(season, 1), ep(season, 2));
  const summary = summarizeSeriesGaps({ series: { title: 'Long Runner' }, episodes, now: NOW });
  const text = describeGaps(summary);
  assert.ok(text.startsWith('S01 all 2 · S02 all 2'), `starts with the earliest seasons, got: ${text}`);
  assert.ok(text.endsWith('+2 more seasons'), `summarizes the tail, got: ${text}`);
});

test('incomplete: activity prefers a real download over a mere watch', () => {
  const ctx = {
    queue: [{ tvdbId: 99, title: 'Winter Sonata' }],
    escalations: [{ tvdb_id: 99, title: 'Winter Sonata', state: 'watching' }],
  };
  assert.deepStrictEqual(describeActivity(ctx, { tvdbId: 99, title: 'Winter Sonata' }),
    { state: 'ok', note: '1 item in the download queue' });

  const watchOnly = { escalations: [{ tvdb_id: 99, title: 'Winter Sonata', state: 'watching' }] };
  assert.strictEqual(describeActivity(watchOnly, { tvdbId: 99, title: 'Winter Sonata' }).state, 'warn');

  const recovery = { recoveryRows: [{ tvdb_id: 99, series_title: 'Winter Sonata', public_searched_at: 1 }, { tvdb_id: 99, series_title: 'Winter Sonata' }] };
  const desc = describeActivity(recovery, { tvdbId: 99, title: 'Winter Sonata' });
  assert.strictEqual(desc.state, 'warn');
  assert.match(desc.note, /2 episodes, 1 already searched/);

  assert.deepStrictEqual(describeActivity({}, { tvdbId: 99, title: 'Winter Sonata' }),
    { state: 'down', note: 'nothing in flight' }, 'the important case: nothing is happening');
});

test('incomplete: a warning in the queue is surfaced rather than reported as healthy', () => {
  const ctx = { queue: [{ tvdbId: 5, title: 'Stalled Show', trackedDownloadState: 'warning' }] };
  assert.strictEqual(describeActivity(ctx, { tvdbId: 5, title: 'Stalled Show' }).state, 'warn');
});

test('incomplete: short titles never match by substring', () => {
  // A two-character title would otherwise match half the queue.
  const ctx = { queue: [{ title: 'Completely Unrelated' }] };
  assert.strictEqual(describeActivity(ctx, { title: 'Up' }).state, 'down', 'no accidental substring hit');
});

test('incomplete: ranking puts stalled and large gaps first', () => {
  const rows = [
    { title: 'Downloading Now', state: 'ok', missing: 20 },
    { title: 'Small Gap', state: 'down', missing: 1 },
    { title: 'Big Gap', state: 'down', missing: 12 },
    { title: 'Being Watched', state: 'warn', missing: 5 },
  ];
  assert.deepStrictEqual(rankIncomplete(rows).map(r => r.title),
    ['Big Gap', 'Small Gap', 'Being Watched', 'Downloading Now']);
});
