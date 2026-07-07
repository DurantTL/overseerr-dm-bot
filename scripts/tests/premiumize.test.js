#!/usr/bin/env node
// src/premiumize.js — imported directly (no source extraction): stuck detection is pure, and
// the API helpers run against a mock server via the PREMIUMIZE_API_URL override.
const assert = require('assert');
const express = require('express');

(async () => {
  // Mock must be up before require so PM_API_BASE picks up the override.
  const app = express();
  const state = { deleted: [], retried: [], clearedFinished: 0, badKey: false };
  app.get('/api/transfer/list', (req, res) => {
    if (state.badKey) return res.json({ status: 'error', message: 'customer not found' });
    res.json({ status: 'success', transfers: [{ id: 'a1', name: 'Movie', status: 'running', progress: 0.5 }] });
  });
  app.get('/api/transfer/delete', (req, res) => { state.deleted.push(req.query.id); res.json({ status: 'success' }); });
  app.get('/api/transfer/retry', (req, res) => { state.retried.push(req.query.id); res.json({ status: 'success' }); });
  app.get('/api/transfer/clearfinished', (req, res) => { state.clearedFinished++; res.json({ status: 'success' }); });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  process.env.PREMIUMIZE_API_URL = `http://127.0.0.1:${server.address().port}/api`;
  process.env.PREMIUMIZE_API_KEY = 'test-key';

  const { listTransfers, deleteTransfer, retryTransfer, clearFinished, findStuckTransfers, isStuckCandidate } = require('../../src/premiumize');

  // --- API helpers against the mock ---
  const transfers = await listTransfers();
  assert.strictEqual(transfers[0].id, 'a1', 'listTransfers unwraps the transfers array');
  await deleteTransfer('a1');
  await retryTransfer('b2');
  await clearFinished();
  assert.deepStrictEqual(state.deleted, ['a1'], 'delete passes the id');
  assert.deepStrictEqual(state.retried, ['b2'], 'retry passes the id');
  assert.strictEqual(state.clearedFinished, 1, 'clearfinished called');

  // Error envelope (HTTP 200 + status:"error") must throw, not return empty data.
  state.badKey = true;
  await assert.rejects(() => listTransfers(), /customer not found/, 'error envelope throws its message');
  state.badKey = false;
  server.close();

  // --- findStuckTransfers: pure logic ---
  const MIN = 60000;
  const opts = t => ({ stuckAfterMs: 45 * MIN, now: t });
  const tracker = new Map();

  // error status flags immediately, regardless of tracker state
  let stuck = findStuckTransfers([{ id: 'e1', status: 'error', progress: 0 }], tracker, opts(0));
  assert.deepStrictEqual(stuck.map(t => t.id), ['e1'], 'error status flagged immediately');

  // 0% running transfer: first sighting arms the tracker, not stuck yet
  stuck = findStuckTransfers([{ id: 'r1', status: 'running', progress: 0 }], tracker, opts(0));
  assert.strictEqual(stuck.length, 0, 'first sighting not flagged');
  // still 0% within the window: not stuck
  stuck = findStuckTransfers([{ id: 'r1', status: 'running', progress: 0 }], tracker, opts(30 * MIN));
  assert.strictEqual(stuck.length, 0, '0% but within threshold not flagged');
  // still 0% past the window: stuck (the "0% forever" case)
  stuck = findStuckTransfers([{ id: 'r1', status: 'running', progress: 0 }], tracker, opts(46 * MIN));
  assert.deepStrictEqual(stuck.map(t => t.id), ['r1'], '0% past threshold flagged');

  // progress moved: window resets, not stuck
  stuck = findStuckTransfers([{ id: 'r1', status: 'running', progress: 0.1 }], tracker, opts(50 * MIN));
  assert.strictEqual(stuck.length, 0, 'progress resets the stuck window');
  stuck = findStuckTransfers([{ id: 'r1', status: 'running', progress: 0.1 }], tracker, opts(50 * MIN + 44 * MIN));
  assert.strictEqual(stuck.length, 0, 'frozen again but within new window');
  stuck = findStuckTransfers([{ id: 'r1', status: 'running', progress: 0.1 }], tracker, opts(50 * MIN + 46 * MIN));
  assert.deepStrictEqual(stuck.map(t => t.id), ['r1'], 'frozen mid-progress past threshold flagged');

  // finished/seeding never count; tracker prunes entries that left the list
  stuck = findStuckTransfers([{ id: 'f1', status: 'finished', progress: 1 }], tracker, opts(999 * MIN));
  assert.strictEqual(stuck.length, 0, 'finished never stuck');
  assert.strictEqual(tracker.size, 0, 'tracker pruned for departed/inactive transfers');
  assert.strictEqual(isStuckCandidate({ status: 'seeding' }), false, 'seeding not a candidate');
  assert.strictEqual(isStuckCandidate({ status: 'waiting' }), true, 'waiting is a candidate');

  console.log('ok - premiumize');
})().catch(err => { console.error('FAILED premiumize:', err.message); process.exit(1); });
