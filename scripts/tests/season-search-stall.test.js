#!/usr/bin/env node
// recordSeasonSearch's stall counter is the signal the season-pack sweep uses to notice a season
// stuck on dead public releases (missing count never shrinks) and auto-tag it for AvistaZ.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_MODULE = require.resolve('../../src/db');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'season-search-stall-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  delete require.cache[DB_MODULE];
  return { ...require('../../src/db'), dir };
}

function cleanup({ db, dir }) {
  db.close();
  delete process.env.DB_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('recordSeasonSearch: stall count climbs while the missing count holds or grows, resets on progress', () => {
  const handle = freshDb();
  const { runMigrations, recordSeasonSearch } = handle;
  try {
    runMigrations();
    assert.strictEqual(recordSeasonSearch({ seriesId: 1, seasonNumber: 1, seriesTitle: 'Revenge', missing: 18 }), 0, 'first search on record has nothing to compare against');
    assert.strictEqual(recordSeasonSearch({ seriesId: 1, seasonNumber: 1, seriesTitle: 'Revenge', missing: 18 }), 1, 'same missing count = one stalled sweep');
    assert.strictEqual(recordSeasonSearch({ seriesId: 1, seasonNumber: 1, seriesTitle: 'Revenge', missing: 19 }), 2, 'missing count going up still counts as stalled');
    assert.strictEqual(recordSeasonSearch({ seriesId: 1, seasonNumber: 1, seriesTitle: 'Revenge', missing: 10 }), 0, 'a real drop in the missing count resets the streak');
    assert.strictEqual(recordSeasonSearch({ seriesId: 1, seasonNumber: 1, seriesTitle: 'Revenge', missing: 10 }), 1, 'streak resumes counting from the new baseline');
  } finally {
    cleanup(handle);
  }
});

test('recordSeasonSearch: stall counts are tracked independently per series and season', () => {
  const handle = freshDb();
  const { runMigrations, recordSeasonSearch } = handle;
  try {
    runMigrations();
    recordSeasonSearch({ seriesId: 1, seasonNumber: 1, seriesTitle: 'Revenge', missing: 5 });
    recordSeasonSearch({ seriesId: 1, seasonNumber: 1, seriesTitle: 'Revenge', missing: 5 });
    assert.strictEqual(recordSeasonSearch({ seriesId: 1, seasonNumber: 2, seriesTitle: 'Revenge', missing: 5 }), 0, 'a different season starts its own streak');
    assert.strictEqual(recordSeasonSearch({ seriesId: 2, seasonNumber: 1, seriesTitle: 'Other Show', missing: 5 }), 0, 'a different series starts its own streak');
  } finally {
    cleanup(handle);
  }
});
