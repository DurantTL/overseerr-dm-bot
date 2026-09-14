#!/usr/bin/env node
// §182 durable play-promotion pin storage: upsert dedupe (at most one active pin per
// node/title), the active-vs-expired filter every reader must apply, and the bounded
// per-viewer active-pin cap.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_MODULE = require.resolve('../../src/db');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-play-pins-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  delete require.cache[DB_MODULE];
  const mod = require('../../src/db');
  mod.runMigrations();
  return { ...mod, dir };
}

function cleanup({ db, dir }) {
  db.close();
  delete process.env.DB_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('tier-play-pins: recordTierPlayPin upserts — at most one row per (node, mediaId)', () => {
  const h = freshDb();
  try {
    h.recordTierPlayPin('california', 'tmdb:1', 'user-a', 1000, 500);
    h.recordTierPlayPin('california', 'tmdb:1', 'user-b', 2000, 1500); // same title, different viewer/expiry re-promotes it
    const row = h.getTierPlayPin('california', 'tmdb:1');
    assert.strictEqual(row.viewerId, 'user-b', 'the upsert refreshed the viewer attribution');
    assert.strictEqual(row.expiresAt, 2000, 'and refreshed the expiry');
    const all = h.db.prepare('SELECT COUNT(*) AS n FROM tier_play_pins').get().n;
    assert.strictEqual(all, 1, 'still exactly one row — no duplicate pin for the same (node, title)');

    // A different node with the same media id is a distinct pin (per-node, not global).
    h.recordTierPlayPin('philippines-tier', 'tmdb:1', 'user-a', 1000, 500);
    assert.strictEqual(h.db.prepare('SELECT COUNT(*) AS n FROM tier_play_pins').get().n, 2);
  } finally { cleanup(h); }
});

test('tier-play-pins: listActiveTierPlayPins / pruneExpiredTierPlayPins filter on expiry', () => {
  const h = freshDb();
  try {
    h.recordTierPlayPin('california', 'tmdb:live', 'user-a', 5000, 1000); // expires 5000, created 1000
    h.recordTierPlayPin('california', 'tmdb:dead', 'user-a', 500, 100); // expires 500 — already in the past at now=1000
    const active = h.listActiveTierPlayPins('california', 1000);
    assert.deepStrictEqual(active.map(p => p.mediaId), ['tmdb:live'], 'only the still-active pin is returned');
    assert.strictEqual(h.listActiveTierPlayPins('california', 9999).length, 0, 'both expired by a later "now"');

    const removed = h.pruneExpiredTierPlayPins(1000);
    assert.strictEqual(removed, 1, 'exactly the one already-expired row was pruned');
    assert.ok(h.getTierPlayPin('california', 'tmdb:live'), 'the still-active pin survives the prune');
    assert.strictEqual(h.getTierPlayPin('california', 'tmdb:dead'), null);
  } finally { cleanup(h); }
});

test('tier-play-pins: countActiveTierPlayPinsForViewer — the bounded per-viewer cap input', () => {
  const h = freshDb();
  try {
    h.recordTierPlayPin('california', 'tmdb:1', 'user-a', 5000, 1000);
    h.recordTierPlayPin('california', 'tmdb:2', 'user-a', 5000, 1000);
    h.recordTierPlayPin('california', 'tmdb:3', 'user-b', 5000, 1000);
    assert.strictEqual(h.countActiveTierPlayPinsForViewer('california', 'user-a', 1000), 2);
    assert.strictEqual(h.countActiveTierPlayPinsForViewer('california', 'user-b', 1000), 1);
    assert.strictEqual(h.countActiveTierPlayPinsForViewer('california', 'user-c', 1000), 0);
    // One of user-a's pins expires: the count drops without any extra bookkeeping.
    assert.strictEqual(h.countActiveTierPlayPinsForViewer('california', 'user-a', 6000), 0);
  } finally { cleanup(h); }
});
