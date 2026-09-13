#!/usr/bin/env node
// #182/#183 tier_node_policies: the DB-backed, unit-aware replacement for the out-of-band
// persistent ignore overlay (manual_exclusion / permanent_pin / temporary_play_pin).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-policies-db-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/db')];
  try {
    const db = require('../../src/db');
    db.runMigrations();
    return fn(db);
  } finally {
    delete process.env.DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('tier-node-policies: migration reaches v2 and creates the table', () => {
  withDb(db => {
    assert.strictEqual(db.schemaVersion(), db.SCHEMA_VERSION);
    assert.ok(db.SCHEMA_VERSION >= 2);
  });
});

test('tier-node-policies: set/list/remove round-trip, scoped per node', () => {
  withDb(db => {
    db.setTierNodePolicy('california', 'tvdb:1', 'season:1', 'temporary_play_pin', { expiresAt: 2000, source: 'play:abc' });
    db.setTierNodePolicy('california', 'tmdb:2', 'series', 'permanent_pin', {});
    db.setTierNodePolicy('philippines-server', 'tvdb:1', 'season:1', 'manual_exclusion', {});

    const ca = db.listTierNodePolicies('california', 1000);
    assert.strictEqual(ca.length, 2);
    assert.ok(ca.some(p => p.mediaId === 'tvdb:1' && p.unit === 'season:1' && p.policy === 'temporary_play_pin' && p.expiresAt === 2000));
    assert.ok(ca.some(p => p.mediaId === 'tmdb:2' && p.policy === 'permanent_pin' && p.expiresAt === null));

    const ph = db.listTierNodePolicies('philippines-server', 1000);
    assert.strictEqual(ph.length, 1, 'policies are scoped per node');

    assert.strictEqual(db.removeTierNodePolicy('california', 'tmdb:2', 'series', 'permanent_pin'), true);
    assert.strictEqual(db.listTierNodePolicies('california', 1000).length, 1);
    assert.strictEqual(db.removeTierNodePolicy('california', 'tmdb:2', 'series', 'permanent_pin'), false, 'removing twice is a no-op, not an error');
  });
});

test('tier-node-policies: expiry is judged against the caller-supplied `now`, not wall-clock', () => {
  withDb(db => {
    db.setTierNodePolicy('california', 'tvdb:9', 'season:2', 'temporary_play_pin', { expiresAt: 5000 });
    assert.strictEqual(db.listTierNodePolicies('california', 4999).length, 1, 'not yet expired');
    assert.strictEqual(db.listTierNodePolicies('california', 5000).length, 0, 'expires_at is exclusive — expired at exactly its own timestamp');
    assert.strictEqual(db.listTierNodePolicies('california', 6000).length, 0, 'expired');
  });
});

test('tier-node-policies: a null expires_at (permanent_pin/manual_exclusion) never expires', () => {
  withDb(db => {
    db.setTierNodePolicy('california', 'tmdb:5', 'series', 'permanent_pin', {});
    assert.strictEqual(db.listTierNodePolicies('california', Number.MAX_SAFE_INTEGER).length, 1);
  });
});

test('tier-node-policies: re-recording the same (node, mediaId, unit, policy) extends it instead of erroring', () => {
  withDb(db => {
    db.setTierNodePolicy('california', 'tvdb:1', 'season:1', 'temporary_play_pin', { expiresAt: 1000, source: 'play:abc' });
    db.setTierNodePolicy('california', 'tvdb:1', 'season:1', 'temporary_play_pin', { expiresAt: 2000, source: 'play:def' });
    const rows = db.listTierNodePolicies('california', 0);
    assert.strictEqual(rows.length, 1, 'upsert, not a duplicate row');
    assert.strictEqual(rows[0].expiresAt, 2000);
    assert.strictEqual(rows[0].source, 'play:def');
  });
});

test('tier-node-policies: different units on the same title are independent rows (season pin + whole-series exclusion coexist)', () => {
  withDb(db => {
    db.setTierNodePolicy('california', 'tvdb:1', 'series', 'manual_exclusion', {});
    db.setTierNodePolicy('california', 'tvdb:1', 'season:3', 'temporary_play_pin', { expiresAt: 9999999999999 });
    const rows = db.listTierNodePolicies('california', 0);
    assert.strictEqual(rows.length, 2);
  });
});

test('tier-node-policies: pruneExpiredTierNodePolicies deletes only expired rows', () => {
  withDb(db => {
    db.setTierNodePolicy('california', 'tvdb:1', 'season:1', 'temporary_play_pin', { expiresAt: 1000 });
    db.setTierNodePolicy('california', 'tmdb:2', 'series', 'permanent_pin', {});
    assert.strictEqual(db.pruneExpiredTierNodePolicies(5000), 1);
    const rows = db.listTierNodePolicies('california', Number.MAX_SAFE_INTEGER);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].mediaId, 'tmdb:2');
  });
});

test('tier-node-policies: an invalid policy value is rejected by the schema CHECK constraint', () => {
  withDb(db => {
    assert.throws(() => db.setTierNodePolicy('california', 'tvdb:1', 'series', 'not_a_real_policy', {}), /CHECK constraint failed/);
  });
});
