#!/usr/bin/env node
'use strict';
// F14 bulk Quick Actions (src/bulk-actions.js): the plan lists exactly what a bulk action would
// touch, seeding torrents and not-yet-imported queue entries are left alone, the list key pins the
// list, and one failing item never stops the rest.
const { test } = require('node:test');
const assert = require('node:assert');

const bulk = require('../../src/bulk-actions');

const H = n => String(n).repeat(40);
const torrents = [
  { hash: H('a'), name: 'Downloading.Show.S01', complete: false, label: 'sonarr', sizeBytes: 100, doneBytes: 40 },
  { hash: H('b'), name: 'Seeding.Movie', complete: true, label: 'radarr', sizeBytes: 100, doneBytes: 100 },
];
const source = { label: 'Sonarr', url: 'http://sonarr', key: 'k' };
const queue = [
  { source, queueId: 1, title: 'Show S01E01', status: 'completed', trackedState: 'imported' },
  { source, queueId: 2, title: 'Show S01E02', status: 'completed', trackedState: 'importPending' },
  { source, queueId: 3, title: 'Show S01E03', status: 'downloading', trackedState: 'downloading' },
];

test('pause/resume plan only downloading torrents; seeding ones are listed as left alone', () => {
  const plan = bulk.plan('pause-downloads', { torrents });
  assert.deepStrictEqual(plan.items.map(i => i.ref), [H('a')]);
  assert.strictEqual(plan.items[0].detail, '40% · sonarr');
  assert.deepStrictEqual(plan.skipped, [{ label: '1 seeding torrent', reason: 'complete, left alone' }]);
});

test('clear-imported plans only imported entries and never sends the *arr key to the browser', () => {
  const plan = bulk.plan('clear-imported', { queue });
  assert.deepStrictEqual(plan.items.map(i => i.ref.queueId), [1]);
  assert.deepStrictEqual(plan.skipped, [{ label: 'Show S01E02', reason: 'completed, importPending' }]);
  const shown = JSON.stringify(bulk.publicPlan(plan));
  assert.ok(!shown.includes('"key"') && !shown.includes('http://sonarr'));
});

test('approve-pending lists every pending request by nonce', () => {
  const plan = bulk.plan('approve-pending', { pending: [{ nonce: 'aaaaaaaa', label: 'Dune', mediaType: 'movie', is4k: true }] });
  assert.deepStrictEqual(plan.items, [{ id: 'req:aaaaaaaa', label: 'Dune', detail: 'Movie · 4K', ref: 'aaaaaaaa' }]);
});

test('list key is stable for the same list, changes when the list does, and the plan is capped', () => {
  const a = bulk.plan('pause-downloads', { torrents });
  const b = bulk.plan('pause-downloads', { torrents: [...torrents].reverse() });
  const c = bulk.plan('pause-downloads', { torrents: [...torrents, { hash: H('c'), name: 'x', complete: false }] });
  assert.strictEqual(a.listKey, b.listKey);
  assert.notStrictEqual(a.listKey, c.listKey);
  assert.notStrictEqual(a.listKey, bulk.plan('resume-downloads', { torrents }).listKey);
  const many = Array.from({ length: bulk.MAX_ITEMS + 5 }, (_, i) => ({ hash: i.toString(16).padStart(40, '0'), name: `t${i}`, complete: false }));
  const capped = bulk.plan('pause-downloads', { torrents: many });
  assert.strictEqual(capped.items.length, bulk.MAX_ITEMS);
  assert.strictEqual(capped.truncated, 5);
});

test('unknown kinds are rejected', () => {
  assert.throws(() => bulk.plan('delete-everything', {}), /Unknown bulk action/);
  assert.throws(() => bulk.plan('__proto__', {}), /Unknown bulk action/);
});

test('run keeps going past a failure and reports each one', async () => {
  const plan = bulk.plan('pause-downloads', { torrents: [...torrents, { hash: H('c'), name: 'Other', complete: false }] });
  const seen = [];
  const result = await bulk.run(plan, async (_kind, item) => {
    seen.push(item.ref);
    if (item.ref === H('a')) throw new Error('rTorrent said no');
    return { ok: true };
  });
  assert.strictEqual(seen.length, 2);
  assert.deepStrictEqual(result, { attempted: 2, succeeded: 1, failed: [{ label: 'Downloading.Show.S01', error: 'rTorrent said no' }] });
});
