#!/usr/bin/env node
// Covers the admission-control gap from #176: POST /agent/report/:node had no explicit limiter,
// so a malfunctioning or compromised node token could force unbounded 25 MB JSON parses. The
// limiter must key per node (not per IP, since an agent's egress address can legitimately roam)
// and must run ahead of any body parsing.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bodyParser = require('body-parser');
const { createTierAgentReportLimiter } = require('../../src/routes/tier-agent-report-limit');

async function serverWith(limit) {
  const app = express();
  app.post('/agent/report/:node',
    createTierAgentReportLimiter({ limit, windowMs: 60000 }),
    bodyParser.json({ limit: '1mb' }),
    (req, res) => res.json({ ok: true, node: req.params.node }));
  const server = await new Promise(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  return {
    server,
    urlFor: node => `http://127.0.0.1:${server.address().port}/agent/report/${node}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('tier agent report limiter blocks a node past its per-minute budget', async () => {
  const http = await serverWith(2);
  const post = node => fetch(http.urlFor(node), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ heartbeat: true }),
  });

  assert.strictEqual((await post('california')).status, 200);
  assert.strictEqual((await post('california')).status, 200);
  const blocked = await post('california');
  assert.strictEqual(blocked.status, 429);
  assert.deepStrictEqual(await blocked.json(), { error: 'Too many reports for this node' });

  await http.close();
});

test('tier agent report limiter tracks each node independently', async () => {
  const http = await serverWith(1);
  const post = node => fetch(http.urlFor(node), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ heartbeat: true }),
  });

  assert.strictEqual((await post('california')).status, 200);
  assert.strictEqual((await post('california')).status, 429, 'california is now over budget');
  assert.strictEqual((await post('philippines')).status, 200, 'a different node has its own budget');

  await http.close();
});

test('tier agent report limiter rejects before the body parser runs', async () => {
  const http = await serverWith(1);
  await fetch(http.urlFor('california'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ heartbeat: true }),
  });
  const res = await fetch(http.urlFor('california'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not valid json',
  });
  assert.strictEqual(res.status, 429, 'malformed body never reaches the parser once the limit is exhausted');
  await http.close();
});
