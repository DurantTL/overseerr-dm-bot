#!/usr/bin/env node
// src/stuck.js — pure stuck-download detection + per-season consolidation. No network: the
// helpers operate on normalized queue items (the shape src/arr.js#fetchArrQueues produces).
const { test } = require('node:test');
const assert = require('node:assert');
const { detectStuckItems, stuckGroupKey, groupStuckItems, isSeasonGroup } = require('../../src/stuck');

const MIN = 60000;
const tvSource = { label: 'sonarr', kind: 'tv' };
const movieSource = { label: 'radarr', kind: 'movie' };

// Normalized queue item factory (mirrors fetchArrQueues output).
function ep(queueId, seasonNumber, episodeNumber, over = {}) {
  return {
    source: tvSource, queueId, seriesId: 42, seriesTvdbId: 999,
    seriesTitle: 'Example Show', seasonNumber, episodeNumber,
    title: `Example Show S0${seasonNumber}E0${episodeNumber}`,
    size: 100, sizeleft: 100, status: 'downloading', trackedStatus: '', trackedState: 'downloading',
    messages: [], ...over,
  };
}
function movie(queueId, over = {}) {
  return {
    source: movieSource, queueId, movieTmdbId: 500, seriesId: null, seriesTitle: null,
    seasonNumber: null, episodeNumber: null, title: 'Some Movie',
    size: 100, sizeleft: 100, status: 'downloading', trackedStatus: '', trackedState: 'downloading',
    messages: [], ...over,
  };
}

test('stuck: stuckGroupKey collapses TV to series+season, movies keyed by queue id', () => {
  assert.strictEqual(stuckGroupKey(ep(1, 2, 5)), 'sonarr:s:42:2', 'tv episode keyed by series+season');
  assert.strictEqual(stuckGroupKey(ep(9, 2, 8)), 'sonarr:s:42:2', 'same season → same key regardless of queue id');
  assert.strictEqual(stuckGroupKey(ep(3, 3, 1)), 'sonarr:s:42:3', 'different season → different key');
  assert.strictEqual(stuckGroupKey(movie(7)), 'radarr:7', 'movie keyed by queue id');
  // TV item with no season (e.g. season pack, no episode attached) falls back to queue id.
  assert.strictEqual(stuckGroupKey(ep(4, null, null)), 'sonarr:4', 'seasonless tv item keyed by queue id');
  // seriesId missing → fall back to tvdb id so grouping still works.
  assert.strictEqual(stuckGroupKey(ep(5, 1, 1, { seriesId: null })), 'sonarr:s:999:1', 'falls back to tvdb id');
});

test('stuck: detectStuckItems per-item byte-movement, threshold, and pruning', () => {
  {
    const tracker = new Map();
    const items = [ep(1, 1, 1), ep(2, 1, 2)];
    // First sighting arms the clock — nothing stuck yet.
    let stuck = detectStuckItems(items, tracker, { stuckAfterMs: 45 * MIN, now: 0 });
    assert.strictEqual(stuck.length, 0, 'first sighting not flagged');
    // Same sizeleft within the window — still not stuck.
    stuck = detectStuckItems(items, tracker, { stuckAfterMs: 45 * MIN, now: 30 * MIN });
    assert.strictEqual(stuck.length, 0, 'frozen but within threshold not flagged');
    // Past the window with no byte movement — both flagged.
    stuck = detectStuckItems(items, tracker, { stuckAfterMs: 45 * MIN, now: 46 * MIN });
    assert.deepStrictEqual(stuck.map(s => s.item.queueId).sort(), [1, 2], 'both episodes flagged past threshold');
    assert.strictEqual(stuck[0].frozenMs, 46 * MIN, 'frozenMs measured from first sighting');
  }
  {
    // Byte movement resets the frozen clock.
    const tracker = new Map();
    detectStuckItems([ep(1, 1, 1, { sizeleft: 100 })], tracker, { stuckAfterMs: 45 * MIN, now: 0 });
    let stuck = detectStuckItems([ep(1, 1, 1, { sizeleft: 50 })], tracker, { stuckAfterMs: 45 * MIN, now: 50 * MIN });
    assert.strictEqual(stuck.length, 0, 'progress resets the window');
    stuck = detectStuckItems([ep(1, 1, 1, { sizeleft: 50 })], tracker, { stuckAfterMs: 45 * MIN, now: 50 * MIN + 46 * MIN });
    assert.strictEqual(stuck.length, 1, 'frozen again past new window flagged');
  }
  {
    // Healthy paused/queued item that shouldn't be moving and isn't flagged → not stuck.
    const tracker = new Map();
    const paused = ep(1, 1, 1, { status: 'paused', trackedState: 'paused' });
    detectStuckItems([paused], tracker, { stuckAfterMs: 45 * MIN, now: 0 });
    const stuck = detectStuckItems([paused], tracker, { stuckAfterMs: 45 * MIN, now: 46 * MIN });
    assert.strictEqual(stuck.length, 0, 'healthy non-moving item not flagged');
    // But an unhealthy (warning) item is flagged even if not "downloading".
    const tracker2 = new Map();
    const warn = ep(2, 1, 1, { status: 'warning', trackedState: '', messages: ['no files found'] });
    detectStuckItems([warn], tracker2, { stuckAfterMs: 45 * MIN, now: 0 });
    const stuck2 = detectStuckItems([warn], tracker2, { stuckAfterMs: 45 * MIN, now: 46 * MIN });
    assert.strictEqual(stuck2.length, 1, 'unhealthy item flagged regardless of movement state');
  }
  {
    // Tracker prunes entries for items that left the queue.
    const tracker = new Map();
    detectStuckItems([ep(1, 1, 1), ep(2, 1, 2)], tracker, { stuckAfterMs: 45 * MIN, now: 0 });
    assert.strictEqual(tracker.size, 2, 'both tracked');
    detectStuckItems([ep(1, 1, 1)], tracker, { stuckAfterMs: 45 * MIN, now: MIN });
    assert.strictEqual(tracker.size, 1, 'departed item pruned');
  }
});

test('stuck: groupStuckItems consolidates one group per season, movies separate', () => {
  const stuckItems = [
    { item: ep(1, 1, 1), frozenMs: 46 * MIN },
    { item: ep(2, 1, 2), frozenMs: 50 * MIN },
    { item: ep(3, 1, 3), frozenMs: 48 * MIN },
    { item: ep(4, 2, 1), frozenMs: 47 * MIN },
    { item: movie(9), frozenMs: 60 * MIN },
  ];
  const groups = groupStuckItems(stuckItems);
  assert.strictEqual(groups.size, 3, 'season 1, season 2, and the movie are three groups');
  const s1 = groups.get('sonarr:s:42:1');
  assert.strictEqual(s1.members.length, 3, 'three episodes consolidated into one season-1 group');
  assert.strictEqual(s1.maxFrozenMs, 50 * MIN, 'group carries the longest-frozen duration');
  assert.ok(isSeasonGroup(s1), 'season group recognized');
  assert.ok(!isSeasonGroup(groups.get('radarr:9')), 'movie group is not a season group');
  assert.strictEqual(groups.get('sonarr:s:42:2').members.length, 1, 'season 2 is its own group');
});
