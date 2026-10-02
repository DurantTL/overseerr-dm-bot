#!/usr/bin/env node
// Services board: NUT var parsing, service registry shape, UPS description,
// and the gatherServicesBoard aggregation against stubbed deps.
const { test } = require('node:test');
const assert = require('node:assert');

const { describeUps, nutConfigured } = require('../../src/nut');
const { GROUPS, SERVICES, gatherServicesBoard, portFromUrl } = require('../../src/services-board');
const { restartCapable } = require('../../src/docker-control');

test('nut: nutConfigured requires host and UPS name', () => {
  assert.strictEqual(nutConfigured({}), false);
  assert.strictEqual(nutConfigured({ NUT_HOST: 'h' }), false);
  assert.strictEqual(nutConfigured({ NUT_HOST: 'h', NUT_UPS_NAME: 'ups' }), true);
});

test('nut: describeUps normalizes NUT vars', () => {
  const d = describeUps({
    'ups.status': 'OL',
    'battery.charge': '100',
    'battery.runtime': '2520',
    'ups.load': '22',
    'device.model': 'CyberPower 1175VA',
  });
  assert.strictEqual(d.onBattery, false);
  assert.strictEqual(d.lowBattery, false);
  assert.strictEqual(d.batteryPercent, 100);
  assert.strictEqual(d.runtimeSeconds, 2520);
  assert.strictEqual(d.loadPercent, 22);
  assert.strictEqual(d.model, 'CyberPower 1175VA');
});

test('nut: describeUps detects on-battery and low-battery', () => {
  const d = describeUps({ 'ups.status': 'OB DISCHRG', 'battery.charge': '45' });
  assert.strictEqual(d.onBattery, true);
  assert.strictEqual(d.lowBattery, false);
  const d2 = describeUps({ 'ups.status': 'OB LB', 'battery.charge': '18' });
  assert.strictEqual(d2.onBattery, true);
  assert.strictEqual(d2.lowBattery, true);
});

test('services-board: registry has unique keys and valid groups', () => {
  const keys = SERVICES.map(s => s.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'duplicate service keys');
  for (const s of SERVICES) {
    assert.ok(GROUPS.includes(s.group), `${s.key} has unknown group ${s.group}`);
    assert.ok(s.name && s.icon, `${s.key} missing name/icon`);
  }
});

test('services-board: portFromUrl extracts ports', () => {
  assert.strictEqual(portFromUrl('http://host:7878', 80), 7878);
  assert.strictEqual(portFromUrl('https://host/', 80), 443);
  assert.strictEqual(portFromUrl('', 8080), 8080);
  assert.strictEqual(portFromUrl(null, null), null);
});

test('services-board: gatherServicesBoard maps health and skips unconfigured', async () => {
  const config = {
    PLEX_URL: 'http://plex:32400',
    OVERSEERR_URL: 'http://seerr:5055',
    SONARR_URL: 'http://sonarr:8989',
    DASHBOARD_LAN_HOST: '192.168.50.122',
    DASHBOARD_TAIL_HOST: '100.91.15.98',
  };
  const health = { plex: 'ok', overseerr: 'ok', sonarr: 'down', errors: { sonarr: 'connect refused' } };
  const board = await gatherServicesBoard({ config, health, queues: [], sessions: [], canRestart: false });
  assert.ok(board.ok === undefined); // no ok wrapper here; route adds it
  const byKey = Object.fromEntries(board.services.map(s => [s.key, s]));
  assert.strictEqual(byKey.plex.state, 'ok');
  assert.strictEqual(byKey.seerr.state, 'ok');
  assert.strictEqual(byKey.sonarr.state, 'down');
  assert.ok(byKey.sonarr.detail.includes('connect refused'));
  // Not configured and no health key -> no card (no dead cards).
  assert.ok(!byKey.grafana, 'grafana should be hidden without GRAFANA_URL');
  assert.ok(!byKey.filebrowser, 'filebrowser should be hidden without FILEBROWSER_URL');
  // Premiumize links out even without a self-hosted URL; the Director links to itself.
  assert.ok(byKey.premiumize, 'premiumize should show via external link');
  assert.ok(byKey.director, 'director should show via self link');
  assert.strictEqual(byKey.premiumize.external, 'https://www.premiumize.me');
  // Ports come from configured URLs.
  assert.strictEqual(byKey.seerr.port, 5055);
  assert.strictEqual(byKey.sonarr.port, 8989);
  // Smart-network hosts pass through.
  assert.strictEqual(board.netHosts.lan, '192.168.50.122');
  assert.strictEqual(board.netHosts.tail, '100.91.15.98');
  // No UPS/ZFS/Speedtest without config.
  assert.strictEqual(board.ups, null);
  assert.strictEqual(board.zfs, null);
  assert.strictEqual(board.speedtest, null);
});

test('services-board: queue counts attach to arr cards', async () => {
  const config = { SONARR_URL: 'http://sonarr:8989', RADARR_URL: 'http://radarr:7878' };
  const queues = [
    { source: { label: 'sonarr' } },
    { source: { label: 'sonarr' } },
    { source: { label: 'radarr' } },
  ];
  const board = await gatherServicesBoard({ config, health: { sonarr: 'ok', radarr: 'ok' }, queues, sessions: [], canRestart: false });
  const byKey = Object.fromEntries(board.services.map(s => [s.key, s]));
  assert.strictEqual(byKey.sonarr.queue, 2);
  assert.strictEqual(byKey.radarr.queue, 1);
});

test('services-board: nowPlaying normalizes tautulli sessions', async () => {
  const sessions = [{
    title: 'Dune: Part Two', grandparent_title: 'Dune: Part Two',
    friendly_name: 'Caleb', player: 'Living Room TV', state: 'playing',
  }];
  const board = await gatherServicesBoard({ config: {}, health: {}, queues: [], sessions, canRestart: false });
  assert.strictEqual(board.nowPlaying.length, 1);
  assert.strictEqual(board.nowPlaying[0].title, 'Dune: Part Two');
  assert.strictEqual(board.nowPlaying[0].user, 'Caleb');
});

test('docker-control: restartCapable returns null when nothing configured', () => {
  const cap = restartCapable({ DOCKER_SOCKET: '', PORTAINER_URL: '', PORTAINER_API_KEY: '', PORTAINER_ENDPOINT_ID: '' });
  assert.strictEqual(cap, null);
});

test('docker-control: restartCapable prefers socket when accessible', () => {
  // /var/run/docker.sock almost certainly does not exist in test env; use a temp file.
  const fs = require('fs');
  const os = require('os');
  const p = require('path');
  const sock = p.join(os.tmpdir(), `fake-docker-${Date.now()}.sock`);
  fs.writeFileSync(sock, '');
  const cap = restartCapable({ DOCKER_SOCKET: sock });
  assert.ok(cap && cap.via === 'socket');
  fs.unlinkSync(sock);
});

test('services-board: fetchSpeedtest parses legacy shape as Mbps', async () => {
  const { fetchSpeedtest } = require('../../src/services-board');
  const http = { get: async () => ({ data: { message: 'ok', data: {
    id: 1, ping: 4.912, download: 932.69, upload: 932.39, failed: false,
    created_at: '2026-10-01T18:33:02',
  } } }) };
  const r = await fetchSpeedtest({ SPEEDTEST_URL: 'http://x/api/speedtest/latest' }, http);
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.downloadMbps, 932.69);
  assert.strictEqual(r.uploadMbps, 932.39);
  assert.strictEqual(r.pingMs, 4.912);
  assert.strictEqual(r.ranAt, '2026-10-01T18:33:02');
});

test('services-board: fetchSpeedtest converts v1 download_bits to Mbps', async () => {
  const { fetchSpeedtest } = require('../../src/services-board');
  const http = { get: async () => ({ data: { data: {
    download_bits: 1338167752, upload_bits: 927076552, ping: 7.448, status: 'completed',
  } } }) };
  const r = await fetchSpeedtest({ SPEEDTEST_URL: 'http://x/api/v1/results/latest' }, http);
  assert.ok(Math.abs(r.downloadMbps - 1338.167752) < 1e-6);
  assert.ok(Math.abs(r.uploadMbps - 927.076552) < 1e-6);
});

test('services-board: fetchSpeedtest surfaces failures as error objects, never silent null', async () => {
  const { fetchSpeedtest } = require('../../src/services-board');
  const netFail = { get: async () => { const e = new Error('getaddrinfo ENOTFOUND speedtest-tracker'); e.code = 'ENOTFOUND'; throw e; } };
  const r = await fetchSpeedtest({ SPEEDTEST_URL: 'http://speedtest-tracker/api/speedtest/latest' }, netFail);
  assert.strictEqual(r.error, 'ENOTFOUND');
  assert.strictEqual(r.downloadMbps, undefined);
  // A failed latest result is reported, not rendered as values.
  const failedRes = { get: async () => ({ data: { data: { failed: true, created_at: '2026-10-01' } } }) };
  const r2 = await fetchSpeedtest({ SPEEDTEST_URL: 'http://x/' }, failedRes);
  assert.strictEqual(r2.error, 'last_result_failed');
  // An empty result is reported, not rendered as zeros.
  const emptyRes = { get: async () => ({ data: { data: {} } }) };
  const r3 = await fetchSpeedtest({ SPEEDTEST_URL: 'http://x/' }, emptyRes);
  assert.strictEqual(r3.error, 'empty_result');
  // No URL configured: hide the card entirely (no dead cards).
  assert.strictEqual(await fetchSpeedtest({}, netFail), null);
});

test('services-board: gatherServicesBoard keeps System Health group when speedtest errors', async () => {
  const http = { get: async () => { const e = new Error('connect refused'); e.code = 'ECONNREFUSED'; throw e; } };
  const board = await gatherServicesBoard({
    config: { SPEEDTEST_URL: 'http://speedtest-tracker/api/speedtest/latest', ZFS_HEALTH_URL: 'http://x:9911/health' },
    health: {}, queues: [], sessions: [], canRestart: false, http,
  });
  assert.ok(board.groups.includes('System Health'), 'System Health group should render with error cards');
  assert.strictEqual(board.speedtest.error, 'ECONNREFUSED');
  assert.strictEqual(board.zfs.error, 'ECONNREFUSED');
});

test('services-board: gatherServicesBoard adds Network group from UDR7', async () => {
  const HEALTH = { data: [{ subsystem: 'wan', up: true, wan_ip: '203.0.113.44', isp_name: 'Mediacom' }, { subsystem: 'www', latency: 9 }] };
  const STA = { data: [{ mac: 'aa:1', hostname: 'box', is_wired: true, 'rx_bytes-r': 1000, 'tx_bytes-r': 500 }] };
  const http = { get: async (url) => ({ data: url.endsWith('/stat/health') ? HEALTH : STA }) };
  const board = await gatherServicesBoard({
    config: { UNIFI_HOST: '192.168.50.1', UNIFI_API_KEY: 'k' },
    health: {}, queues: [], sessions: [], canRestart: false, http,
  });
  assert.ok(board.groups.includes('Network'), 'Network group should render with UDR7 data');
  assert.strictEqual(board.network.wan.isp, 'Mediacom');
  assert.strictEqual(board.network.clients.total, 1);
});

test('services-board: fetchZfsHealth passes through pool space when the endpoint serves it', async () => {
  const { fetchZfsHealth } = require('../../src/services-board');
  const http = { get: async () => ({ data: {
    pool: 'raid', health: 'ONLINE', last_scrub: '2026-09-01', issue_count: 0,
    used_bytes: 5400000000000, avail_bytes: 2600000000000,
  } }) };
  const z = await fetchZfsHealth({ ZFS_HEALTH_URL: 'http://x:9911/health' }, http);
  assert.strictEqual(z.pool, 'raid');
  assert.ok(z.space, 'space should be present');
  assert.strictEqual(z.space.usedBytes, 5400000000000);
  assert.strictEqual(z.space.totalBytes, 8000000000000);
  assert.strictEqual(z.space.usedPct, 68);
  // No space fields: no bar, never a fabricated percentage.
  const http2 = { get: async () => ({ data: { pool: 'raid', health: 'ONLINE' } }) };
  const z2 = await fetchZfsHealth({ ZFS_HEALTH_URL: 'http://x:9911/health' }, http2);
  assert.strictEqual(z2.space, null);
});

test('services-board: fetchSsdTemp picks the NVMe sensor from Prometheus', async () => {
  const { fetchSsdTemp } = require('../../src/services-board');
  const byQuery = {
    node_drive_temp_celsius: [],
    node_hwmon_temp_celsius: [
      { metric: { chip: 'k10temp', sensor: 'Tctl', instance: 'x:9100' }, value: [1, '45.5'] },
      { metric: { chip: 'nvme', sensor: 'Composite', instance: 'x:9100' }, value: [1, '34.2'] },
      { metric: { chip: 'nvme', sensor: 'Sensor 1', instance: 'x:9100' }, value: [1, '31.0'] },
    ],
  };
  const http = {
    get: async (url, opts) => {
      assert.ok(url.endsWith('/api/v1/query'), 'hits the Prometheus query API');
      assert.ok(opts.params.query in byQuery, 'queries a known metric');
      return { data: { status: 'success', data: { resultType: 'vector', result: byQuery[opts.params.query] } } };
    },
  };
  const r = await fetchSsdTemp({ PROMETHEUS_URL: 'http://prom:9090' }, http);
  assert.strictEqual(r.tempC, 34.2);
  assert.strictEqual(r.sensor, 'Composite');
  // No URL: hidden. No SSD sensor: honest error, never a guess.
  assert.strictEqual(await fetchSsdTemp({}, http), null);
  const none = await fetchSsdTemp({ PROMETHEUS_URL: 'http://prom:9090' },
    { get: async () => ({ data: { data: { result: [] } } }) });
  assert.strictEqual(none.error, 'no_ssd_sensor');
});

test('services-board: fetchSsdTemp prefers the SSD from the SMART textfile metric', async () => {
  const { fetchSsdTemp } = require('../../src/services-board');
  const byQuery = {
    node_drive_temp_celsius: [
      { metric: { device: '/dev/sda', model: 'WDC_WD40EFRX', instance: 'x:9100' }, value: [1, '37'] },
      { metric: { device: '/dev/sdd', model: 'Samsung_SSD_840', instance: 'x:9100' }, value: [1, '28'] },
    ],
    node_hwmon_temp_celsius: [
      { metric: { chip: 'nvme', sensor: 'Composite', instance: 'x:9100' }, value: [1, '34.2'] },
    ],
  };
  const http = {
    get: async (url, opts) => ({
      data: { status: 'success', data: { resultType: 'vector', result: byQuery[opts.params.query] || [] } },
    }),
  };
  const r = await fetchSsdTemp({ PROMETHEUS_URL: 'http://prom:9090' }, http);
  assert.strictEqual(r.tempC, 28);
  assert.strictEqual(r.sensor, 'Samsung_SSD_840');
  // HDD-only textfile data must not land on the System SSD card: falls back
  // to hwmon rather than showing a spinning disk's temp as the SSD.
  const hddOnly = {
    get: async (url, opts) => ({
      data: { status: 'success', data: { resultType: 'vector', result:
        opts.params.query === 'node_drive_temp_celsius'
          ? [{ metric: { device: '/dev/sda', model: 'WDC_WD40EFRX' }, value: [1, '37'] }]
          : byQuery.node_hwmon_temp_celsius } },
    }),
  };
  const r2 = await fetchSsdTemp({ PROMETHEUS_URL: 'http://prom:9090' }, hddOnly);
  assert.strictEqual(r2.tempC, 34.2);
  assert.strictEqual(r2.sensor, 'Composite');
});
