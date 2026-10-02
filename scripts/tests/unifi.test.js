#!/usr/bin/env node
// UniFi/UDR7 network data: health/client parsing, auth failure surfacing,
// and the no-credential hide behavior.
const { test } = require('node:test');
const assert = require('node:assert');

const { fetchUnifiNetwork, parseHealth, parseClients } = require('../../src/unifi');

const HEALTH = { meta: { rc: 'ok' }, data: [
  { subsystem: 'wan', up: true, wan_ip: '203.0.113.44', isp_name: 'Mediacom' },
  { subsystem: 'www', latency: 12.4, xput_down: 932.1, xput_up: 41.2 },
] };
const STA = { meta: { rc: 'ok' }, data: [
  { mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.50.122', hostname: 'durant-server', is_wired: true, 'wired-rx_bytes-r': 125000, 'wired-tx_bytes-r': 62500 },
  { mac: 'aa:bb:cc:dd:ee:02', ip: '192.168.50.50', hostname: 'caleb-iphone', is_wired: false, 'rx_bytes-r': 250000, 'tx_bytes-r': 12500 },
  { mac: 'aa:bb:cc:dd:ee:03', ip: '192.168.50.51', is_wired: false },
] };

test('unifi: parseHealth extracts WAN facts', () => {
  const w = parseHealth(HEALTH);
  assert.strictEqual(w.up, true);
  assert.strictEqual(w.ip, '203.0.113.44');
  assert.strictEqual(w.isp, 'Mediacom');
  assert.strictEqual(w.latencyMs, 12.4);
  assert.strictEqual(w.capacityDownMbps, 932.1);
  assert.strictEqual(w.capacityUpMbps, 41.2);
});

test('unifi: parseClients sums live rates and ranks talkers', () => {
  const c = parseClients(STA);
  assert.strictEqual(c.total, 3);
  assert.strictEqual(c.wired, 1);
  assert.strictEqual(c.wireless, 2);
  // (125000 + 250000 + 0) bytes/s * 8 / 1e6 = 3.0 Mbps down; 0.6 up
  assert.ok(Math.abs(c.downMbps - 3.0) < 1e-9);
  assert.ok(Math.abs(c.upMbps - 0.6) < 1e-9);
  assert.strictEqual(c.top[0].name, 'caleb-iphone');
  assert.strictEqual(c.top[2].name, 'aa:bb:cc:dd:ee:03');
});

test('unifi: fetchUnifiNetwork hides the group without credentials', async () => {
  const http = { get: async () => { throw new Error('must not be called'); } };
  assert.strictEqual(await fetchUnifiNetwork({ UNIFI_HOST: '192.168.50.1' }, http), null);
  assert.strictEqual(await fetchUnifiNetwork({ UNIFI_API_KEY: 'k' }, http), null);
});

test('unifi: fetchUnifiNetwork returns live data with an API key', async () => {
  const http = { get: async (url, opts) => {
    assert.strictEqual(opts.headers['X-API-KEY'], 'secret');
    assert.ok(url.startsWith('https://192.168.50.1/proxy/network/api/s/default/stat/'));
    return { data: url.endsWith('/stat/health') ? HEALTH : STA };
  } };
  const n = await fetchUnifiNetwork({ UNIFI_HOST: '192.168.50.1', UNIFI_API_KEY: 'secret' }, http);
  assert.ok(!n.error);
  assert.strictEqual(n.wan.isp, 'Mediacom');
  assert.strictEqual(n.clients.total, 3);
  assert.strictEqual(n.throughput.downMbps, n.clients.downMbps);
  assert.strictEqual(n.history.length, 1);
});

test('unifi: fetchUnifiNetwork surfaces auth rejection honestly', async () => {
  const http = { get: async () => { const e = new Error('Request failed with status code 401'); e.response = { status: 401 }; throw e; } };
  const n = await fetchUnifiNetwork({ UNIFI_HOST: '192.168.50.1', UNIFI_API_KEY: 'bad' }, http);
  assert.strictEqual(n.error, 'auth_rejected_check_key');
});

test('unifi: fetchUnifiNetwork surfaces network errors with the code', async () => {
  const http = { get: async () => { const e = new Error('connect'); e.code = 'ECONNREFUSED'; throw e; } };
  const n = await fetchUnifiNetwork({ UNIFI_HOST: '192.168.50.1', UNIFI_API_KEY: 'k' }, http);
  assert.strictEqual(n.error, 'ECONNREFUSED');
});
