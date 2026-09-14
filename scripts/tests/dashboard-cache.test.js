#!/usr/bin/env node
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createTtlCache } = require('../../src/dashboard-cache');

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('dashboard-cache: a fresh key is fetched once and served from cache within its TTL', async () => {
  let calls = 0;
  const cache = createTtlCache();
  const load = () => { calls += 1; return Promise.resolve(`v${calls}`); };

  const first = await cache.get('k', 60000, load);
  assert.strictEqual(first.value, 'v1');
  assert.strictEqual(first.fromCache, false);

  const second = await cache.get('k', 60000, load);
  assert.strictEqual(second.value, 'v1', 'served from cache, not refetched');
  assert.strictEqual(second.fromCache, true);
  assert.strictEqual(calls, 1);
});

test('dashboard-cache: concurrent reads of the same key coalesce into one in-flight call', async () => {
  let calls = 0;
  const gate = deferred();
  const cache = createTtlCache();
  const load = () => { calls += 1; return gate.promise; };

  const a = cache.get('k', 60000, load);
  const b = cache.get('k', 60000, load);
  // Both requests started before the loader resolved — a naive implementation would call load()
  // twice, doubling the exact upstream traffic this cache exists to bound.
  gate.resolve('shared-value');
  const [ra, rb] = await Promise.all([a, b]);
  assert.strictEqual(calls, 1);
  assert.strictEqual(ra.value, 'shared-value');
  assert.strictEqual(rb.value, 'shared-value');
});

test('dashboard-cache: an expired TTL triggers exactly one refetch', async () => {
  let calls = 0;
  let clock = 1000;
  const cache = createTtlCache(() => clock);
  const load = () => { calls += 1; return Promise.resolve(`v${calls}`); };

  await cache.get('k', 1000, load);
  clock += 500;
  assert.strictEqual((await cache.get('k', 1000, load)).value, 'v1', 'still within TTL');
  clock += 600;
  assert.strictEqual((await cache.get('k', 1000, load)).value, 'v2', 'TTL elapsed: refetched');
  assert.strictEqual(calls, 2);
});

test('dashboard-cache: a failed refresh falls back to the last good value, marked stale', async () => {
  let clock = 0;
  const cache = createTtlCache(() => clock);
  await cache.get('k', 100, () => Promise.resolve('good'));
  clock += 200;
  const result = await cache.get('k', 100, () => Promise.reject(new Error('upstream down')));
  assert.strictEqual(result.value, 'good');
  assert.strictEqual(result.stale, true);

  // The stale value keeps serving until a fetch actually succeeds again.
  clock += 200;
  const stillStale = await cache.get('k', 100, () => Promise.reject(new Error('still down')));
  assert.strictEqual(stillStale.value, 'good');
  assert.strictEqual(stillStale.stale, true);

  clock += 200;
  const recovered = await cache.get('k', 100, () => Promise.resolve('fresh-again'));
  assert.strictEqual(recovered.value, 'fresh-again');
  assert.strictEqual(recovered.stale, false);
});

test('dashboard-cache: a key with no prior value rethrows on failure instead of hiding it', async () => {
  const cache = createTtlCache();
  await assert.rejects(() => cache.get('k', 1000, () => Promise.reject(new Error('boom'))), /boom/);
});

test('dashboard-cache: invalidate forces the next read to refetch', async () => {
  let calls = 0;
  const cache = createTtlCache();
  const load = () => { calls += 1; return Promise.resolve(`v${calls}`); };
  await cache.get('k', 60000, load);
  cache.invalidate('k');
  const result = await cache.get('k', 60000, load);
  assert.strictEqual(result.value, 'v2');
  assert.strictEqual(calls, 2);
});

test('dashboard-cache: invalidate with no key clears every entry', async () => {
  let calls = 0;
  const cache = createTtlCache();
  const load = () => { calls += 1; return Promise.resolve(calls); };
  await cache.get('a', 60000, load);
  await cache.get('b', 60000, load);
  cache.invalidate();
  await cache.get('a', 60000, load);
  await cache.get('b', 60000, load);
  assert.strictEqual(calls, 4);
});

test('dashboard-cache: different keys never share state', async () => {
  const cache = createTtlCache();
  const a = await cache.get('a', 60000, () => Promise.resolve('A'));
  const b = await cache.get('b', 60000, () => Promise.resolve('B'));
  assert.strictEqual(a.value, 'A');
  assert.strictEqual(b.value, 'B');
});
