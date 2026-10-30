#!/usr/bin/env node
// UniFi/UDR7 network data: health/client parsing, auth failure surfacing,
// and the no-credential hide behavior.
const { test } = require('node:test');
const assert = require('node:assert');

const { fetchUnifiNetwork, parseHealth, parseClients, hasNetworkData } = require('../../src/unifi');

const HEALTH = { meta: { rc: 'ok' }, data: [
  { subsystem: 'wan', up: true, wan_ip: '203.0.113.44', isp_name: 'Mediacom' },
  { subsystem: 'www', latency: 12.4, xput_down: 932.1, xput_up: 41.2 },
] };
const STA = { meta: { rc: 'ok' }, data: [
  { mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.50.122', hostname: 'durant-server', is_wired: true, 'wired-rx_bytes-r': 125000, 'wired-tx_bytes-r': 62500 },
  { mac: 'aa:bb:cc:dd:ee:02', ip: '192.168.50.50', hostname: 'alex-iphone', is_wired: false, 'rx_bytes-r': 250000, 'tx_bytes-r': 12500 },
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
  assert.strictEqual(c.top[0].name, 'alex-iphone');
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

test('unifi: hasNetworkData is true only when the console sent a real value', () => {
  assert.strictEqual(hasNetworkData(null), false);
  assert.strictEqual(hasNetworkData({ error: 'ECONNREFUSED' }), false, 'errors are shown, not treated as data');
  const empty = { wan: parseHealth({ data: [] }), clients: parseClients({ data: [] }) };
  assert.strictEqual(empty.wan.up, true, 'parseHealth is optimistic about an empty answer');
  assert.strictEqual(hasNetworkData(empty), false, 'so emptiness is judged by the values, not by up');
  assert.strictEqual(hasNetworkData({ wan: { latencyMs: 9 }, clients: { total: 0 } }), true);
  assert.strictEqual(hasNetworkData({ wan: {}, clients: { total: 3 } }), true);
});

const { failureReason, UNIFI_TIMEOUT_MS } = require('../../src/unifi');
const { log } = require('../../src/log');
const CFG = { UNIFI_HOST: '192.168.50.1', UNIFI_API_KEY: 'secret-key-value' };

test('unifi: every read is capped at 8 s overall (socket timeout plus an AbortSignal)', async () => {
  const seen = [];
  const http = { get: async (url, opts) => { seen.push(opts); return { data: url.endsWith('/stat/health') ? HEALTH : STA }; } };
  await fetchUnifiNetwork(CFG, http);
  assert.strictEqual(UNIFI_TIMEOUT_MS, 8000);
  assert.strictEqual(seen.length, 2);
  for (const opts of seen) {
    assert.strictEqual(opts.timeout, 8000);
    assert.ok(opts.signal instanceof AbortSignal, 'a total-request abort signal is passed');
  }
});

test('unifi: failures come back as plain, stable reasons (never the key)', async () => {
  const fail = make => ({ get: async () => { throw make(); } });
  const withStatus = s => () => Object.assign(new Error(`Request failed with status code ${s}`), { response: { status: s } });
  const withCode = c => () => Object.assign(new Error(c), { code: c });
  const cases = [
    [withStatus(401), 'auth_rejected_check_key'],
    [withStatus(403), 'auth_rejected_check_key'],
    [withStatus(500), 'http_500'],
    [withCode('ECONNABORTED'), 'timeout'],
    [() => Object.assign(new Error('canceled'), { code: 'ERR_CANCELED', name: 'CanceledError' }), 'timeout'],
    [withCode('ECONNREFUSED'), 'ECONNREFUSED'],
  ];
  for (const [make, reason] of cases) {
    const out = await fetchUnifiNetwork(CFG, fail(make));
    assert.deepStrictEqual(out, { error: reason });
    assert.ok(!JSON.stringify(out).includes('secret-key-value'));
  }
  // A sign-in page (HTML with a 200) is a failure, not "no data".
  const html = { get: async () => ({ data: '<html>login</html>' }) };
  assert.deepStrictEqual(await fetchUnifiNetwork(CFG, html), { error: 'unexpected_response_not_json' });
  assert.strictEqual(failureReason(new Error('timeout of 8000ms exceeded')), 'timeout');
});

test('unifi: logs a failure once per change of state, with the endpoint and status only', async () => {
  const lines = [];
  const orig = { warn: log.warn, info: log.info };
  log.warn = msg => lines.push(['warn', msg]);
  log.info = msg => lines.push(['info', msg]);
  try {
    const status500 = { get: async () => { throw Object.assign(new Error('x'), { response: { status: 500 } }); } };
    const ok = { get: async url => ({ data: url.endsWith('/stat/health') ? HEALTH : STA }) };
    await fetchUnifiNetwork(CFG, ok);
    lines.length = 0;
    await fetchUnifiNetwork(CFG, status500);
    await fetchUnifiNetwork(CFG, status500);
    await fetchUnifiNetwork(CFG, status500);
    await fetchUnifiNetwork(CFG, ok);
    await fetchUnifiNetwork(CFG, ok);
    assert.strictEqual(lines.length, 2, 'one line for the failure, one for the recovery');
    assert.deepStrictEqual(lines[0], ['warn', 'unifi: GET /api/s/default/stat/health failed: HTTP 500 (http_500)']);
    assert.match(lines[1][1], /^unifi: reads recovered \(was error:http_500\)$/);
    assert.ok(!lines.some(([, m]) => m.includes('secret-key-value')));
  } finally {
    Object.assign(log, orig);
  }
});
