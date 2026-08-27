#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createBodyConcurrencyLimiter } = require('../../src/routes/body-concurrency-limit');

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('body concurrency limiter rejects excess work and releases the slot on finish', async () => {
  const app = express();
  const limiter = createBodyConcurrencyLimiter({ limit: 1, scope: 'test body' });
  let releaseFirst;
  const firstMayFinish = new Promise(resolve => { releaseFirst = resolve; });
  let markEntered;
  const firstEntered = new Promise(resolve => { markEntered = resolve; });
  app.post('/work', limiter, async (_req, res) => {
    markEntered();
    await firstMayFinish;
    res.json({ ok: true });
  });
  const server = await listen(app);
  const url = `http://127.0.0.1:${server.address().port}/work`;

  try {
    const first = fetch(url, { method: 'POST' });
    await firstEntered;
    const blocked = await fetch(url, { method: 'POST' });
    assert.strictEqual(blocked.status, 503);
    assert.strictEqual(blocked.headers.get('retry-after'), '1');
    assert.deepStrictEqual(await blocked.json(), { error: 'Too many concurrent test body requests' });

    releaseFirst();
    assert.strictEqual((await first).status, 200);
    assert.strictEqual((await fetch(url, { method: 'POST' })).status, 200);
  } finally {
    releaseFirst();
    await close(server);
  }
});

test('body concurrency limiter validates its configured limit', () => {
  for (const limit of [0, -1, NaN, 1.5]) {
    assert.throws(() => createBodyConcurrencyLimiter({ limit }), /positive integer/);
  }
});
