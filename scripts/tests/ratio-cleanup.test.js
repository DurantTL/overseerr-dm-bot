#!/usr/bin/env node
// rTorrent ratio-based cleanup: the pure removal verdict (src/ratio-cleanup.js) and its
// backing db.js watch-table helpers.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { decideRatioRemoval } = require('../../src/ratio-cleanup');
const DB_MODULE = require.resolve('../../src/db');

const DAY = 86400000;
const torrent = ratioPermille => ({ hash: 'ABC123', name: 'Some.Release', ratioPermille });

test('ratio-cleanup: below the minimum is left alone', () => {
  const verdict = decideRatioRemoval({ torrent: torrent(200), watch: null, minRatioPermille: 500, stallDays: 7, forceRatioPermille: 2000 });
  assert.strictEqual(verdict.action, 'none');
});

test('ratio-cleanup: crossing the minimum starts the watch, does not remove yet', () => {
  const now = Date.now();
  const verdict = decideRatioRemoval({ torrent: torrent(500), watch: null, now, minRatioPermille: 500, stallDays: 7, forceRatioPermille: 2000 });
  assert.strictEqual(verdict.action, 'watch');
  assert.strictEqual(verdict.ratio, 500);
  assert.strictEqual(verdict.changedAt, now);
});

test('ratio-cleanup: a ratio still climbing keeps restarting the clock, never removed', () => {
  const now = Date.now();
  // Watched 8 days ago at a lower ratio — the ratio has since moved, so it is still "active"
  // rather than stalled, however long ago the watch row was written.
  const watch = { ratio_permille: 600, ratio_changed_at: now - 8 * DAY };
  const verdict = decideRatioRemoval({ torrent: torrent(700), watch, now, minRatioPermille: 500, stallDays: 7, forceRatioPermille: 2000 });
  assert.strictEqual(verdict.action, 'watch', 'ratio moved since last watch — restart the clock');
  assert.strictEqual(verdict.ratio, 700);
});

test('ratio-cleanup: unchanged ratio short of the stall window is left alone', () => {
  const now = Date.now();
  const watch = { ratio_permille: 600, ratio_changed_at: now - 3 * DAY };
  const verdict = decideRatioRemoval({ torrent: torrent(600), watch, now, minRatioPermille: 500, stallDays: 7, forceRatioPermille: 2000 });
  assert.strictEqual(verdict.action, 'none');
});

test('ratio-cleanup: unchanged ratio past the stall window is removed', () => {
  const now = Date.now();
  const watch = { ratio_permille: 600, ratio_changed_at: now - 7 * DAY - 1000 };
  const verdict = decideRatioRemoval({ torrent: torrent(600), watch, now, minRatioPermille: 500, stallDays: 7, forceRatioPermille: 2000 });
  assert.strictEqual(verdict.action, 'remove');
  assert.strictEqual(verdict.reason, 'stalled');
  assert.strictEqual(verdict.ratio, 600);
});

test('ratio-cleanup: ratio at/above the force threshold removes immediately, no watch needed', () => {
  const verdict = decideRatioRemoval({ torrent: torrent(2000), watch: null, minRatioPermille: 500, stallDays: 7, forceRatioPermille: 2000 });
  assert.strictEqual(verdict.action, 'remove');
  assert.strictEqual(verdict.reason, 'force');
});

test('ratio-cleanup: force threshold wins even over a fresh (not yet stalled) watch', () => {
  const now = Date.now();
  const watch = { ratio_permille: 1900, ratio_changed_at: now - 1000 };
  const verdict = decideRatioRemoval({ torrent: torrent(2500), watch, now, minRatioPermille: 500, stallDays: 7, forceRatioPermille: 2000 });
  assert.strictEqual(verdict.action, 'remove');
  assert.strictEqual(verdict.reason, 'force');
});

test('ratio-cleanup: force threshold of 0 disables that trigger', () => {
  const verdict = decideRatioRemoval({ torrent: torrent(9999), watch: null, minRatioPermille: 500, stallDays: 7, forceRatioPermille: 0 });
  assert.notStrictEqual(verdict.action, 'remove');
});

test('ratio-cleanup: a ratio that drops back under the minimum clears an existing watch', () => {
  const now = Date.now();
  const watch = { ratio_permille: 600, ratio_changed_at: now - 8 * DAY };
  const verdict = decideRatioRemoval({ torrent: torrent(100), watch, now, minRatioPermille: 500, stallDays: 7, forceRatioPermille: 2000 });
  assert.strictEqual(verdict.action, 'clear', 're-grab/reseed should reset the stall clock, not inherit a stale one');
});

test('ratio-cleanup: minimum of 0 disables the stall trigger without a watch to clear', () => {
  const verdict = decideRatioRemoval({ torrent: torrent(50), watch: null, minRatioPermille: 0, stallDays: 7, forceRatioPermille: 2000 });
  assert.strictEqual(verdict.action, 'none');
});

test('ratio-cleanup: db helpers round-trip a watch row and prune stale hashes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-cleanup-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  delete require.cache[DB_MODULE];
  const { db, runMigrations, getRatioWatch, upsertRatioWatch, deleteRatioWatch, pruneRatioWatch } = require('../../src/db');
  try {
    runMigrations();
    assert.strictEqual(getRatioWatch('deadbeef'), null, 'nothing stored yet');
    upsertRatioWatch('deadbeef', 600, 1000);
    assert.deepStrictEqual(getRatioWatch('DEADBEEF'), { ratio_permille: 600, ratio_changed_at: 1000 }, 'case-insensitive lookup');

    upsertRatioWatch('deadbeef', 700, 2000);
    assert.deepStrictEqual(getRatioWatch('deadbeef'), { ratio_permille: 700, ratio_changed_at: 2000 }, 'upsert overwrites in place');

    upsertRatioWatch('cafebabe', 500, 500);
    assert.strictEqual(pruneRatioWatch(['DEADBEEF']), 1, 'drops the hash rTorrent no longer has');
    assert.strictEqual(getRatioWatch('cafebabe'), null);
    assert.notStrictEqual(getRatioWatch('deadbeef'), null, 'the still-present hash survives pruning');

    deleteRatioWatch('deadbeef');
    assert.strictEqual(getRatioWatch('deadbeef'), null);
  } finally {
    db.close();
    delete process.env.DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
