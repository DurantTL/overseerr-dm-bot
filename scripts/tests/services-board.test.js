#!/usr/bin/env node
// Services board: NUT var parsing, service registry shape, UPS description,
// and the gatherServicesBoard aggregation against stubbed deps.
const { test } = require('node:test');
const assert = require('node:assert');

const { describeUps, nutConfigured } = require('../../src/nut');
const { GROUPS, SERVICES, gatherServicesBoard, portFromUrl, urlFormat, cardDownloads, timeleftSeconds } = require('../../src/services-board');
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
    friendly_name: 'Alex', player: 'Living Room TV', state: 'playing',
  }];
  const board = await gatherServicesBoard({ config: {}, health: {}, queues: [], sessions, canRestart: false });
  assert.strictEqual(board.nowPlaying.length, 1);
  assert.strictEqual(board.nowPlaying[0].title, 'Dune: Part Two');
  assert.strictEqual(board.nowPlaying[0].user, 'Alex');
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

test('services-board: an empty UniFi answer hides the Network group instead of drawing an empty shell', async () => {
  const http = { get: async () => ({ data: { data: [] } }) };
  const board = await gatherServicesBoard({
    config: { UNIFI_HOST: '192.168.50.1', UNIFI_API_KEY: 'k' },
    health: {}, queues: [], sessions: [], canRestart: false, http,
  });
  assert.strictEqual(board.network, null, 'no real values: nothing to show');
  assert.ok(!board.groups.includes('Network'));
});

test('services-board: an unreachable UniFi console still shows its error card', async () => {
  const http = { get: async () => { const err = new Error('connect ECONNREFUSED'); err.code = 'ECONNREFUSED'; throw err; } };
  const board = await gatherServicesBoard({
    config: { UNIFI_HOST: '192.168.50.1', UNIFI_API_KEY: 'k' },
    health: {}, queues: [], sessions: [], canRestart: false, http,
  });
  assert.ok(board.network && board.network.error, 'the error is kept so the card can say why');
  assert.ok(board.groups.includes('Network'));
});

test('services-board: services without a URL are listed as hidden with the missing variable, and move up once it is set', async () => {
  const base = { health: {}, queues: [], sessions: [], canRestart: false, http: { get: async () => ({ data: {} }) } };
  const secretUrl = 'https://user:hunter2@seedbox.example.test/rutorrent';
  const without = await gatherServicesBoard({ ...base, config: { RTORRENT_URL: secretUrl } });
  const plex = without.hidden.find(h => h.key === 'plex');
  assert.deepStrictEqual(plex, {
    key: 'plex', name: 'Plex', group: 'Media', icon: 'play', missing: 'PLEX_URL',
    format: 'http://<server LAN IP>:32400',
    note: "Plex uses host networking, so use the server's LAN IP. A container name won't resolve from the bot.",
  });
  assert.ok(!without.services.some(s => s.key === 'plex'), 'not drawn as a card');
  assert.ok(!without.hidden.some(h => h.key === 'director' || h.key === 'premiumize'), 'self and fixed external links are never hidden');
  assert.ok(!JSON.stringify(without.hidden).includes('hunter2'), 'hidden entries carry names only, never values');

  const withPlex = await gatherServicesBoard({ ...base, config: { PLEX_URL: 'http://192.0.2.10:32400' } });
  assert.ok(withPlex.services.some(s => s.key === 'plex'), 'Plex is a normal card once PLEX_URL is set');
  assert.ok(!withPlex.hidden.some(h => h.key === 'plex'), 'and leaves the hidden row');
});

test('services-board: website cards take their link from env and wait in the hidden row until it is set', async () => {
  const base = { health: {}, queues: [], sessions: [], canRestart: false, http: { get: async () => ({ data: {} }) } };
  const unset = await gatherServicesBoard({ ...base, config: {} });
  assert.deepStrictEqual(unset.hidden.filter(h => h.group === 'Websites').map(h => h.missing).sort(), ['BUSINESS_SITE_URL', 'PORTFOLIO_URL']);
  assert.ok(!unset.services.some(s => s.group === 'Websites'));

  const set = await gatherServicesBoard({ ...base, config: { PORTFOLIO_URL: 'https://portfolio.example.test', BUSINESS_SITE_URL: 'javascript:alert(1)' } });
  const portfolio = set.services.find(s => s.key === 'portfolio');
  assert.strictEqual(portfolio.external, 'https://portfolio.example.test', 'opened as-is');
  assert.strictEqual(portfolio.state, 'ok');
  assert.ok(!set.services.some(s => s.key === 'business-site'), 'a non-http value counts as unset');
});

test('services-board: the registry carries no site addresses for the Websites group', () => {
  for (const svc of SERVICES.filter(s => s.group === 'Websites')) {
    assert.ok(!svc.external, `${svc.key} reads its link from ${svc.externalKey}`);
    assert.ok(svc.externalKey);
  }
});

test('services-board: config-gap value formats are templates built from the registry, never real addresses', () => {
  const byKey = Object.fromEntries(SERVICES.map(svc => [svc.key, svc]));
  assert.strictEqual(urlFormat(byKey.grafana), 'http://<host>:3000');
  assert.strictEqual(urlFormat(byKey.syncthing), 'http://<host>:8384');
  assert.strictEqual(urlFormat(byKey.recyclarr), 'http://<host>:<port>', 'no default port: both placeholders');
  assert.strictEqual(urlFormat(byKey.portfolio), 'https://<site address>');
  for (const svc of SERVICES.filter(x => x.urlKey || x.externalKey)) {
    assert.match(urlFormat(svc), /<[^>]+>/, `${svc.key}: a template with a placeholder, not a real value`);
  }
});

test('services-board: timeleftSeconds reads the *arr HH:MM:SS and D.HH:MM:SS forms', () => {
  assert.strictEqual(timeleftSeconds('00:18:05'), 1085);
  assert.strictEqual(timeleftSeconds('1.02:00:00'), 93600);
  assert.strictEqual(timeleftSeconds(null), null);
  assert.strictEqual(timeleftSeconds('soon'), null);
});

test('services-board: cardDownloads ranks downloading first, keeps ETA only while downloading, caps at three', () => {
  const GB = 1024 ** 3;
  const rows = cardDownloads([
    { title: 'Queued Show S01E01', size: 2 * GB, sizeleft: 2 * GB, timeleft: null, status: 'queued' },
    { title: 'Slow Horses S05E04', size: 3 * GB, sizeleft: 1.14 * GB, timeleft: '00:18:00', status: 'downloading' },
    { title: 'Andor S02E09', size: 3 * GB, sizeleft: 2.3 * GB, timeleft: '00:41:00', status: 'downloading' },
    { title: 'Broken Release', size: 1 * GB, sizeleft: 0.5 * GB, timeleft: '00:05:00', status: 'warning' },
    { title: 'No size yet', size: 0, sizeleft: 0, status: 'queued' },
  ]);
  assert.deepStrictEqual(rows.map(r => r.title), ['Slow Horses S05E04', 'Andor S02E09', 'Broken Release'], 'a download that needs a look outranks a queued one; the 4th is cut');
  assert.strictEqual(rows[0].pct, 62);
  assert.strictEqual(rows[0].eta, 1080);
  assert.strictEqual(rows[2].state, 'warning');
  assert.strictEqual(rows[2].eta, null, 'no time left for something that is not downloading');
  const warned = cardDownloads([{ title: 'Broken Release', size: 10, sizeleft: 5, timeleft: '00:05:00', status: 'warning' }]);
  assert.strictEqual(warned[0].state, 'warning');
  assert.strictEqual(warned[0].eta, null);
});

test('services-board: download rows attach to the card whose queue label matches', async () => {
  const q = (label, title) => ({ source: { label }, title, size: 100, sizeleft: 25, timeleft: '00:01:00', status: 'downloading' });
  const board = await gatherServicesBoard({
    config: { SONARR_URL: 'http://sonarr:8989', RADARR_URL: 'http://radarr:7878' },
    health: { sonarr: 'ok', radarr: 'ok' },
    queues: [q('sonarr', 'Show S01E01'), q('sonarr', 'Show S01E02'), q('radarr-4k', 'Film (2024)')],
    sessions: [], canRestart: false, http: { get: async () => ({ data: {} }) },
  });
  const sonarr = board.services.find(s => s.key === 'sonarr');
  assert.strictEqual(sonarr.queue, 2);
  assert.deepStrictEqual(sonarr.downloads.map(d => [d.title, d.pct, d.eta]), [['Show S01E01', 75, 60], ['Show S01E02', 75, 60]]);
  assert.ok(!board.services.find(s => s.key === 'radarr').downloads, 'no downloads on a card with an empty queue');
});

test('services-board: cards carry Docker restart count and last start for their container', async () => {
  const board = await gatherServicesBoard({
    config: { RADARR_URL: 'http://radarr:7878', TAUTULLI_URL: 'http://tautulli:8181' },
    health: { radarr: 'ok', tautulli: 'ok' }, queues: [], sessions: [], canRestart: true,
    http: { get: async () => ({ data: {} }) },
    containers: { radarr: { restartCount: 4, startedAt: '2026-10-28T12:02:00Z', status: 'running', image: 'radarr:5' } },
  });
  const radarr = board.services.find(s => s.key === 'radarr');
  assert.strictEqual(radarr.restarts, 4);
  assert.strictEqual(radarr.startedAt, '2026-10-28T12:02:00Z');
  assert.ok(!('restarts' in board.services.find(s => s.key === 'tautulli')), 'no container, no facts');
});
