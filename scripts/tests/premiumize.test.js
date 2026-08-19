#!/usr/bin/env node
// src/premiumize.js — imported directly (no source extraction): stuck detection is pure, and
// the API helpers run against a mock server via the PREMIUMIZE_API_URL override.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

test('premiumize: API helpers against a mock server, plus pure stuck-transfer detection', async () => {
  // Mock must be up before require so PM_API_BASE picks up the override.
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const state = { deleted: [], retried: [], clearedFinished: 0, badKey: false };
  app.get('/api/transfer/list', (req, res) => {
    if (state.badKey) return res.json({ status: 'error', message: 'customer not found' });
    res.json({ status: 'success', transfers: [{ id: 'a1', name: 'Movie', status: 'running', progress: 0.5 }] });
  });
  // Mutating endpoints are POST-only (as documented) — a GET here 404s, so a regression back
  // to GET fails the test.
  app.post('/api/transfer/delete', (req, res) => { state.deleted.push(req.body.id); res.json({ status: 'success' }); });
  app.post('/api/transfer/retry', (req, res) => { state.retried.push(req.body.id); res.json({ status: 'success' }); });
  app.post('/api/transfer/clearfinished', (req, res) => { state.clearedFinished++; res.json({ status: 'success' }); });
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
});

test('premiumize: isDeadTransfer / planStuckTransferActions', () => {
  const { isDeadTransfer, planStuckTransferActions } = require('../../src/premiumize');

  // The exact shape reported for the public-indexer grabs that motivated auto-clear: 0%,
  // "running", no cached source.
  const dead = { id: '1', status: 'running', progress: 0, message: '0.00 KB/s from 0 peer, 0 Bytes of 0 Bytes, unknown left' };
  assert.strictEqual(isDeadTransfer(dead), true, 'a 0%/no-source transfer is dead');
  assert.strictEqual(isDeadTransfer({ ...dead, status: 'error', message: 'some tracker error' }), true, 'an error status is dead regardless of message');
  assert.strictEqual(isDeadTransfer({ id: '2', status: 'running', progress: 0.5, message: 'downloading' }), false, 'real progress is never dead');
  assert.strictEqual(isDeadTransfer({ id: '3', status: 'running', progress: 0, message: 'downloading from 3 peers' }), false, 'a message with no dead-source language is not assumed dead');
  assert.strictEqual(isDeadTransfer({ ...dead, progress: 0.02 }, { maxProgress: 0.01 }), false, 'maxProgress is honored — a transfer past the ceiling is not dead even with a no-source message');

  const stuck = [
    { id: '1', name: 'Dead One', status: 'running', progress: 0, message: '0.00 KB/s from 0 peer, 0 Bytes of 0 Bytes, unknown left' },
    { id: '2', name: 'Dead Two', status: 'error', progress: 0, message: 'boom' },
    { id: '3', name: 'Slow', status: 'running', progress: 0.2, message: 'downloading' },
    { id: '4', name: 'Ignored Dead', status: 'error', progress: 0, message: 'boom' },
  ];

  // autoDelete off: nothing is deleted, everything not ignored/cooled-down alerts.
  let plan = planStuckTransferActions(stuck, { autoDelete: false, now: 1000 });
  assert.deepStrictEqual(plan.deletes.map(t => t.id), []);
  assert.deepStrictEqual(plan.alerts.map(t => t.id), ['1', '2', '3', '4']);

  // autoDelete on, retryBeforeClear on (the default): a dead transfer seen for the first time is
  // retried rather than deleted outright — Premiumize's own retry gets one more shot at seeding
  // before the bot gives up on it. The slow one still alerts; ignored ids are excluded from every
  // list (deletion/retry never respect the alert cooldown, but both respect ignore).
  plan = planStuckTransferActions(stuck, {
    autoDelete: true, ignored: new Set(['4']), now: 1000,
  });
  assert.deepStrictEqual(plan.deletes, []);
  assert.deepStrictEqual(plan.retries.map(t => t.id).sort(), ['1', '2']);
  assert.deepStrictEqual(plan.alerts.map(t => t.id), ['3']);
  assert.strictEqual(plan.suppressed, 1, 'the ignored id is counted as suppressed');

  // Once an id has already been retried on a previous sweep and is still dead, it's deleted —
  // no third chance.
  plan = planStuckTransferActions(stuck, {
    autoDelete: true, ignored: new Set(['4']), retried: new Set(['1', '2']), now: 1000,
  });
  assert.deepStrictEqual(plan.deletes.map(t => t.id).sort(), ['1', '2']);
  assert.deepStrictEqual(plan.retries, []);

  // retryBeforeClear: false restores the old immediate-delete behavior for anyone who'd rather
  // not wait the extra sweep.
  plan = planStuckTransferActions(stuck, {
    autoDelete: true, ignored: new Set(['4']), retryBeforeClear: false, now: 1000,
  });
  assert.deepStrictEqual(plan.deletes.map(t => t.id).sort(), ['1', '2']);
  assert.deepStrictEqual(plan.retries, []);

  // Cooldown suppresses a re-alert on the slow transfer without touching retry/deletion of the
  // dead ones (already-retried '1'/'2'/'4' go straight to delete; the alert cooldown is a
  // separate mechanism entirely).
  plan = planStuckTransferActions(stuck, {
    autoDelete: true, retried: new Set(['1', '2', '4']), alertedAt: new Map([['3', 900]]), cooldownMs: 200, now: 1000,
  });
  assert.deepStrictEqual(plan.deletes.map(t => t.id).sort(), ['1', '2', '4']);
  assert.deepStrictEqual(plan.alerts, []);
  assert.strictEqual(plan.suppressed, 1);

  // A large batch (the reported "30 dead Revenge transfers" case): every dead one gets retried
  // the first time around, nothing needs 30 individual alerts.
  const big = Array.from({ length: 30 }, (_, i) => ({
    id: String(i), name: `Revenge S0${i}`, status: 'running', progress: 0,
    message: '0.00 KB/s from 0 peer, 0 Bytes of 0 Bytes, unknown left',
  }));
  plan = planStuckTransferActions(big, { autoDelete: true, now: 1000 });
  assert.strictEqual(plan.retries.length, 30);
  assert.strictEqual(plan.deletes.length, 0);
  assert.strictEqual(plan.alerts.length, 0);

  // Still dead on the sweep after that retry: all 30 finally get deleted.
  plan = planStuckTransferActions(big, { autoDelete: true, retried: new Set(big.map(t => t.id)), now: 1000 });
  assert.strictEqual(plan.deletes.length, 30);
  assert.strictEqual(plan.retries.length, 0);
});
