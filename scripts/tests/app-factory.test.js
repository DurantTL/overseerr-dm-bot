#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApp, listen, close } = require('../../src/app');

// Real HTTP requests against an ephemeral port (server.address().port from a :0 bind), matching
// the boundary these routes actually run behind — no Discord login or external services needed.
function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } : headers,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('createApp disables x-powered-by', async () => {
  const app = createApp();
  app.get('/probe', (_req, res) => res.json({ ok: true }));
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, { path: '/probe' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['x-powered-by'], undefined);
  } finally {
    await close(server);
  }
});

test('createApp parses JSON bodies for ordinary routes', async () => {
  const app = createApp();
  app.post('/echo', (req, res) => res.json({ received: req.body }));
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, { method: 'POST', path: '/echo', body: { hello: 'world' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { received: { hello: 'world' } });
  } finally {
    await close(server);
  }
});

test('createApp skips the global JSON parser for configured path prefixes', async () => {
  const app = createApp({ skipJsonPaths: ['/agent/'] });
  app.post('/agent/report/:node', (req, res) => res.json({ bodyParsed: req.body !== undefined }));
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, { method: 'POST', path: '/agent/report/node1', body: { inventory: [] } });
    assert.strictEqual(res.statusCode, 200);
    // The route never attached its own parser here, so req.body stays undefined — proving the
    // global parser really skipped this path rather than merely using a different limit.
    assert.deepStrictEqual(JSON.parse(res.body), { bodyParsed: false });
  } finally {
    await close(server);
  }
});

test('createApp rejects an oversized body against the configured JSON limit', async () => {
  const app = createApp({ jsonLimit: '10b' });
  app.post('/echo', (req, res) => res.json({ received: req.body }));
  app.use((err, _req, res, _next) => res.status(413).json({ error: 'too large' }));
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, { method: 'POST', path: '/echo', body: { hello: 'this payload is well over ten bytes' } });
    assert.strictEqual(res.statusCode, 413);
  } finally {
    await close(server);
  }
});

test('createApp trust proxy setting controls whether req.ip honors X-Forwarded-For', async () => {
  const trusted = createApp({ trustProxy: true });
  trusted.get('/ip', (req, res) => res.json({ ip: req.ip }));
  const trustedServer = await listen(trusted, 0);

  const untrusted = createApp({ trustProxy: false });
  untrusted.get('/ip', (req, res) => res.json({ ip: req.ip }));
  const untrustedServer = await listen(untrusted, 0);

  try {
    const trustedRes = await request(trustedServer.address().port, { path: '/ip', headers: { 'x-forwarded-for': '203.0.113.5' } });
    assert.strictEqual(JSON.parse(trustedRes.body).ip, '203.0.113.5');

    const untrustedRes = await request(untrustedServer.address().port, { path: '/ip', headers: { 'x-forwarded-for': '203.0.113.5' } });
    assert.notStrictEqual(JSON.parse(untrustedRes.body).ip, '203.0.113.5');
  } finally {
    await close(trustedServer);
    await close(untrustedServer);
  }
});
