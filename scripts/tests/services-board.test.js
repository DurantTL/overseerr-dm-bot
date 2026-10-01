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
