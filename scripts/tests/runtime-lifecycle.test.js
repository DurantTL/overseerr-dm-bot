#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { createApp, listen, close } = require('../../src/app');
const { createRuntimeLifecycle, createDiscordReadyGuard } = require('../../src/runtime-lifecycle');

class FakeDiscordClient extends EventEmitter {
  constructor(login) {
    super();
    this.loginImpl = login;
    this.loginCalls = 0;
    this.destroyCalls = 0;
  }

  login(token) {
    this.loginCalls += 1;
    return this.loginImpl(token, this.loginCalls);
  }

  async destroy() {
    this.destroyCalls += 1;
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function request(port, path = '/') {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    }).on('error', reject);
  });
}

function fixture({ login = async () => 'token', startHttp = async () => ({ id: 'server' }), stopHttp = async () => {}, timers } = {}) {
  const client = new FakeDiscordClient(login);
  const logs = [];
  let workerStarts = 0;
  const lifecycle = createRuntimeLifecycle({
    client,
    token: 'discord-token',
    startHttp,
    stopHttp,
    startDiscordWorkers: async () => { workerStarts += 1; },
    log: { warn: message => logs.push(['warn', message]), error: message => logs.push(['error', message]) },
    ...(timers || {}),
  });
  return { client, lifecycle, logs, workerStarts: () => workerStarts };
}

test('HTTP binds and stays observable when Discord never becomes ready', async () => {
  const app = createApp();
  let server;
  const pendingLogin = new Promise(() => {});
  const { client, lifecycle, workerStarts } = fixture({
    login: () => pendingLogin,
    startHttp: async () => { server = await listen(app, 0); return server; },
    stopHttp: close,
  });
  app.get('/state', (_req, res) => res.json(lifecycle.snapshot()));

  await lifecycle.start();
  await lifecycle.start();
  const response = await request(server.address().port, '/state');
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(JSON.parse(response.body).http, 'ready');
  assert.strictEqual(JSON.parse(response.body).discord, 'connecting');
  assert.strictEqual(client.loginCalls, 1);
  assert.strictEqual(workerStarts(), 0);

  await lifecycle.stop();
  assert.strictEqual(client.destroyCalls, 1);
  assert.strictEqual(lifecycle.snapshot().http, 'stopped');
});

test('login rejection is handled with capped, observable exponential retry', async () => {
  const scheduled = [];
  let now = 1000;
  const timers = {
    now: () => now,
    retryInitialMs: 5000,
    retryMaxMs: 8000,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutFn: timer => { timer.cleared = true; },
  };
  const { client, lifecycle, logs } = fixture({ login: async () => { throw new Error('gateway refused token'); }, timers });
  await lifecycle.start();
  await flush();
  assert.strictEqual(lifecycle.snapshot().discord, 'retrying');
  assert.strictEqual(lifecycle.snapshot().lastDiscordError, 'gateway refused token');
  assert.strictEqual(scheduled[0].delay, 5000);
  assert.strictEqual(lifecycle.snapshot().nextDiscordRetryAt, new Date(6000).toISOString());

  now = 6000;
  scheduled[0].fn();
  await flush();
  assert.strictEqual(client.loginCalls, 2);
  assert.strictEqual(scheduled[1].delay, 8000);
  assert.ok(logs.some(([, message]) => message.includes('login attempt 2 failed')));
  client.emit('ready');
  await flush();
  assert.strictEqual(lifecycle.snapshot().discord, 'ready');
  assert.strictEqual(scheduled[1].cleared, true);
  await lifecycle.stop();
});

test('delayed ready and reconnect transitions update state without duplicate workers', async () => {
  const { client, lifecycle, workerStarts } = fixture();
  await lifecycle.start();
  await flush();
  assert.strictEqual(lifecycle.snapshot().discord, 'connecting');

  client.emit('ready');
  await flush();
  assert.strictEqual(lifecycle.snapshot().discord, 'ready');
  assert.strictEqual(workerStarts(), 1);

  client.emit('shardDisconnect', { reason: 'network reset' });
  assert.strictEqual(lifecycle.snapshot().discord, 'disconnected');
  client.emit('shardReconnecting');
  assert.strictEqual(lifecycle.snapshot().discord, 'connecting');
  client.emit('shardResume');
  await flush();
  client.emit('ready');
  await flush();
  assert.strictEqual(lifecycle.snapshot().discord, 'ready');
  assert.strictEqual(workerStarts(), 1);
  await lifecycle.stop();
});

test('shutdown during HTTP startup closes the late server and never starts Discord', async () => {
  let resolveStart;
  const lateServer = { id: 'late' };
  const closed = [];
  const { client, lifecycle } = fixture({
    startHttp: () => new Promise(resolve => { resolveStart = resolve; }),
    stopHttp: async server => { closed.push(server); },
  });
  const starting = lifecycle.start();
  const stopping = lifecycle.stop();
  resolveStart(lateServer);
  await Promise.all([starting, stopping]);
  assert.deepStrictEqual(closed, [lateServer]);
  assert.strictEqual(client.loginCalls, 0);
  assert.strictEqual(client.destroyCalls, 1);
  assert.deepStrictEqual({ http: lifecycle.snapshot().http, discord: lifecycle.snapshot().discord }, { http: 'stopped', discord: 'stopped' });
});

test('Discord-required middleware fails fast without invoking an action', () => {
  let called = false;
  const guard = createDiscordReadyGuard({ snapshot: () => ({ discord: 'retrying' }) });
  const response = {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  guard({}, response, () => { called = true; });
  assert.strictEqual(called, false);
  assert.strictEqual(response.statusCode, 503);
  assert.deepStrictEqual(response.payload, {
    ok: false,
    error: 'Discord is retrying; no changes were made. Wait for reconnect and try again.',
    retryable: true,
  });
});
