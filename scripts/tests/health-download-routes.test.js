#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerHealthAndDownloadRoutes } = require('../../src/routes/health-download');

function fakeDb() {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return { run: (...args) => { writes.push({ sql, args }); } };
    },
  };
}

async function start(overrides = {}) {
  const app = express();
  const db = overrides.db || fakeDb();
  const audits = [];
  registerHealthAndDownloadRoutes(app, {
    config: { DOWNLOAD_ROUTE_MAX_PER_MINUTE: 60, DOWNLOAD_LARGE_FILE_GB: 8 },
    gatherHealth: async () => ({ overall: 'ok' }),
    httpRateLimitKey: req => req.ip,
    cleanExpiredTokens() {},
    getDownloadRecordByRawToken: () => null,
    sha256: value => `hash:${value}`,
    resolveSafeMediaPath: value => value,
    notifyChannel() {},
    mimeFor: () => 'application/octet-stream',
    audit: (event, detail) => audits.push({ event, detail }),
    downloadLimiter: (_req, _res, next) => next(),
    ...overrides,
    db,
  });
  const server = await new Promise(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  return {
    db,
    audits,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('public health redacts errors and coalesces the cached result', async () => {
  let calls = 0;
  const http = await start({
    gatherHealth: async () => {
      calls += 1;
      return { overall: 'warn', errors: ['private host failed'], services: { discord: 'down' } };
    },
  });
  try {
    const first = await fetch(`${http.url}/health`);
    const second = await fetch(`${http.url}/health`);
    assert.strictEqual(first.status, 503);
    assert.deepStrictEqual(await first.json(), { overall: 'warn', services: { discord: 'down' } });
    assert.strictEqual(second.status, 503);
    assert.strictEqual(calls, 1);
  } finally {
    await http.close();
  }
});

test('download route preserves full and ranged response contracts and audit logging', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-route-'));
  const file = path.join(dir, 'clip.bin');
  fs.writeFileSync(file, 'abcdefghij');
  const record = {
    token_hash: 'stored-hash', discord_id: '123', title: 'Clip', file_path: file,
    expires_at: Date.now() + 60000, one_time_use: 0, used_at: null, revoked: 0,
  };
  const http = await start({ getDownloadRecordByRawToken: () => record });
  try {
    const full = await fetch(`${http.url}/download/good`);
    assert.strictEqual(full.status, 200);
    assert.strictEqual(await full.text(), 'abcdefghij');
    assert.strictEqual(full.headers.get('accept-ranges'), 'bytes');

    const range = await fetch(`${http.url}/download/good`, { headers: { range: 'bytes=2-5' } });
    assert.strictEqual(range.status, 206);
    assert.strictEqual(await range.text(), 'cdef');
    assert.strictEqual(range.headers.get('content-range'), 'bytes 2-5/10');

    const invalid = await fetch(`${http.url}/download/good`, { headers: { range: 'bytes=20-30' } });
    assert.strictEqual(invalid.status, 416);
    assert.strictEqual(invalid.headers.get('content-range'), 'bytes */10');
    assert.ok(http.audits.some(entry => entry.event === 'download_started'));
    assert.ok(http.audits.some(entry => entry.event === 'download_completed_or_failed'));
  } finally {
    await http.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('download route preserves token expiry, reuse, and missing-token responses', async () => {
  const cases = [
    { record: null, status: 404, body: 'Link not found or revoked.' },
    { record: { revoked: 1 }, status: 404, body: 'Link not found or revoked.' },
    { record: { revoked: 0, expires_at: Date.now() - 1 }, status: 410, body: 'This download link has expired.' },
    { record: { revoked: 0, expires_at: Date.now() + 60000, one_time_use: 1, used_at: Date.now() }, status: 410, body: 'This one-time link has already been used.' },
  ];
  for (const item of cases) {
    const http = await start({ getDownloadRecordByRawToken: () => item.record });
    try {
      const response = await fetch(`${http.url}/download/token`);
      assert.strictEqual(response.status, item.status);
      assert.strictEqual(await response.text(), item.body);
    } finally {
      await http.close();
    }
  }
});

test('download route rejects a file outside the configured media boundary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-route-'));
  const file = path.join(dir, 'outside.bin');
  fs.writeFileSync(file, 'secret');
  const http = await start({
    getDownloadRecordByRawToken: () => ({
      token_hash: 'stored-hash', discord_id: '123', title: 'Outside', file_path: file,
      expires_at: Date.now() + 60000, one_time_use: 0, used_at: null, revoked: 0,
    }),
    resolveSafeMediaPath: () => { throw new Error('outside root'); },
  });
  try {
    const response = await fetch(`${http.url}/download/token`);
    assert.strictEqual(response.status, 403);
    assert.strictEqual(await response.text(), 'Invalid file path.');
    assert.ok(http.db.writes.some(write => write.args.includes('invalid_path')));
  } finally {
    await http.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
