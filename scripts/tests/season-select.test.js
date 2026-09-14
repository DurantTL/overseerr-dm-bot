#!/usr/bin/env node
// Pure season-selection helpers shared by the /request slash command and the mobile request
// wizard (#255) — parsing, formatting, storage-key identity, and narrowing against what Seerr
// already has covered.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  ALL_SEASONS,
  parseSeasonSelection,
  formatSeasonsLabel,
  seasonsToStorageKey,
  seasonsFromStorageKey,
  seasonsEqual,
  splitCoveredSeasons,
  isCoveredStatus,
} = require('../../src/season-select');

test('season-select: parseSeasonSelection accepts all/empty, numbers, lists, and ranges', () => {
  assert.deepStrictEqual(parseSeasonSelection(''), { ok: true, seasons: ALL_SEASONS });
  assert.deepStrictEqual(parseSeasonSelection(undefined), { ok: true, seasons: ALL_SEASONS });
  assert.deepStrictEqual(parseSeasonSelection('all'), { ok: true, seasons: ALL_SEASONS });
  assert.deepStrictEqual(parseSeasonSelection('ALL Seasons'), { ok: true, seasons: ALL_SEASONS });
  assert.deepStrictEqual(parseSeasonSelection('3'), { ok: true, seasons: [3] });
  assert.deepStrictEqual(parseSeasonSelection('1,3,5'), { ok: true, seasons: [1, 3, 5] });
  assert.deepStrictEqual(parseSeasonSelection(' 5 , 1 , 3 '), { ok: true, seasons: [1, 3, 5] });
  assert.deepStrictEqual(parseSeasonSelection('1,1,2'), { ok: true, seasons: [1, 2] }, 'duplicates collapse');
  assert.deepStrictEqual(parseSeasonSelection('1-3'), { ok: true, seasons: [1, 2, 3] });
  assert.deepStrictEqual(parseSeasonSelection('5-3'), { ok: true, seasons: [3, 4, 5] }, 'reversed range is normalized');
  assert.deepStrictEqual(parseSeasonSelection('1-3,7'), { ok: true, seasons: [1, 2, 3, 7] });

  assert.strictEqual(parseSeasonSelection('0').ok, false, 'season 0 is invalid');
  assert.strictEqual(parseSeasonSelection('-2').ok, false);
  assert.strictEqual(parseSeasonSelection('two').ok, false);
  assert.strictEqual(parseSeasonSelection('1-500').ok, false, 'absurd range rejected');
});

test('season-select: formatSeasonsLabel', () => {
  assert.strictEqual(formatSeasonsLabel(ALL_SEASONS), 'all seasons');
  assert.strictEqual(formatSeasonsLabel(null), 'all seasons');
  assert.strictEqual(formatSeasonsLabel([2]), 'season 2');
  assert.strictEqual(formatSeasonsLabel([1, 2, 5]), 'seasons 1, 2, 5');
  assert.strictEqual(formatSeasonsLabel([5, 1, 2]), 'seasons 1, 2, 5', 'sorted regardless of input order');
});

test('season-select: storage key round-trips and movies never carry a selection', () => {
  assert.strictEqual(seasonsToStorageKey('movie', [1, 2]), null, 'movies never store a season selection');
  assert.strictEqual(seasonsToStorageKey('movie', ALL_SEASONS), null);
  assert.strictEqual(seasonsToStorageKey('tv', ALL_SEASONS), 'all');
  assert.strictEqual(seasonsToStorageKey('tv', null), 'all');
  assert.strictEqual(seasonsToStorageKey('tv', [3, 1, 1, 2]), '[1,2,3]', 'sorted, de-duplicated JSON');

  assert.strictEqual(seasonsFromStorageKey(null), null);
  assert.strictEqual(seasonsFromStorageKey('all'), ALL_SEASONS);
  assert.deepStrictEqual(seasonsFromStorageKey('[1,2,3]'), [1, 2, 3]);
  assert.strictEqual(seasonsFromStorageKey('not json'), null, 'malformed storage never throws');

  assert.ok(seasonsEqual(ALL_SEASONS, null));
  assert.ok(seasonsEqual([1, 2], [2, 1]));
  assert.ok(!seasonsEqual([1], [1, 2]));
  assert.ok(!seasonsEqual(ALL_SEASONS, [1]));
});

test('season-select: splitCoveredSeasons narrows a selection against what Seerr already has', () => {
  // All-seasons selection is never narrowed to a submit list (Seerr's own 'all' picks up only
  // what is missing) but still reports what is already covered, for messaging.
  const allCase = splitCoveredSeasons({ requested: ALL_SEASONS, eligible: [1, 2, 3], covered: [1] });
  assert.strictEqual(allCase.toSubmit, ALL_SEASONS);
  assert.deepStrictEqual(allCase.alreadyCovered, [1]);
  assert.deepStrictEqual(allCase.invalid, []);

  // Explicit selection: covered seasons are dropped from what gets submitted, and seasons the
  // show doesn't actually have are flagged invalid rather than silently sent to Seerr.
  const explicit = splitCoveredSeasons({ requested: [1, 2, 9], eligible: [1, 2, 3], covered: [1] });
  assert.deepStrictEqual(explicit.toSubmit, [2]);
  assert.deepStrictEqual(explicit.alreadyCovered, [1]);
  assert.deepStrictEqual(explicit.invalid, [9]);

  // Fully covered explicit selection → nothing left to submit.
  const fullyCovered = splitCoveredSeasons({ requested: [1], eligible: [1, 2], covered: [1] });
  assert.deepStrictEqual(fullyCovered.toSubmit, []);
  assert.deepStrictEqual(fullyCovered.alreadyCovered, [1]);

  // Fail open: an empty `eligible` (Seerr lookup failed) trusts the caller's own selection
  // instead of rejecting everything as invalid.
  const failOpen = splitCoveredSeasons({ requested: [4, 5], eligible: [], covered: [] });
  assert.deepStrictEqual(failOpen.toSubmit, [4, 5]);
  assert.deepStrictEqual(failOpen.invalid, []);
});

test('season-select: isCoveredStatus matches Seerr\'s pending..available range', () => {
  assert.strictEqual(isCoveredStatus(1), false, 'UNKNOWN');
  assert.strictEqual(isCoveredStatus(2), true, 'PENDING');
  assert.strictEqual(isCoveredStatus(3), true, 'PROCESSING');
  assert.strictEqual(isCoveredStatus(4), true, 'PARTIALLY_AVAILABLE');
  assert.strictEqual(isCoveredStatus(5), true, 'AVAILABLE');
  assert.strictEqual(isCoveredStatus(6), false, 'DELETED (Jellyseerr) is requestable again');
});
