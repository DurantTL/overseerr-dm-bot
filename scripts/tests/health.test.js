'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  HEALTH_KEYS,
  healthLabel,
  healthErrorDetail,
  statusOverall,
  createHealthChecker,
} = require('../../src/health');
const {
  fetchRequestInventoryWithRetry,
  requestReconcileStage,
} = require('../../src/request-reconcile');
const { loadSandbox } = require('./extract');

function baseConfig(overrides = {}) {
  return {
    BACKUP_INTERVAL_HOURS: 0,
    RAID_PATH: '/media',
    GRAB_STAGING_PATH: '/seedbox-staging',
    TUNNEL_DOMAIN: 'media.example.test',
    OVERSEERR_URL: 'http://seerr:5055',
    OVERSEERR_API_KEY: 'seerr-key',
    RADARR_URL: 'http://radarr:7878',
    RADARR_API_KEY: 'radarr-key',
    RADARR_4K_URL: '',
    RADARR_4K_API_KEY: '',
    SONARR_URL: 'http://sonarr:8989',
    SONARR_API_KEY: 'sonarr-key',
    PROWLARR_URL: 'http://prowlarr:9696',
    PROWLARR_API_KEY: 'prowlarr-key',
    BYPARR_URL: 'http://byparr:8191',
    ...overrides,
  };
}

function fakeFs({ failIncoming = false } = {}) {
  return {
    constants: { R_OK: 4, W_OK: 2, X_OK: 1 },
    statSync: () => ({ isDirectory: () => true }),
    existsSync: target => target.endsWith('/.incoming'),
    accessSync: target => {
      if (failIncoming && target.endsWith('/.incoming')) {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
    },
  };
}

function checkerBed({ config = baseConfig(), fs = fakeFs(), plexApiGet, axiosGet } = {}) {
  const calls = [];
  const audits = [];
  const gatherHealth = createHealthChecker({
    config,
    client: { isReady: () => true },
    db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
    fs,
    axios: { get: async (url, options) => {
      calls.push({ url, options });
      if (axiosGet) return axiosGet(url, options);
      return { status: 200, data: {} };
    } },
    audit: (...args) => audits.push(args),
    getSetting: () => null,
    backupState: () => ({ status: 'disabled', lastSuccessfulAt: null, ageMs: null }),
    getPlexToken: async () => 'plex-token',
    plexApiGet: plexApiGet || (async path => { calls.push({ plexPath: path }); return {}; }),
  });
  return { gatherHealth, calls, audits };
}

test('health: checks liveness endpoints and names feature-specific capabilities', async () => {
  const bed = checkerBed();
  const health = await bed.gatherHealth();

  assert.strictEqual(health.overall, 'ok');
  assert.strictEqual(health.plex, 'ok');
  assert.strictEqual(health.plexFriends, 'ok');
  assert.strictEqual(health.seerrRequests, 'ok');
  assert.strictEqual(health.grabStaging, 'ok');
  assert.ok(HEALTH_KEYS.includes('grabStaging'));
  assert.strictEqual(healthLabel('plex'), 'plex.tv account');
  assert.strictEqual(healthLabel('plexFriends'), 'plex.tv friends');
  assert.deepStrictEqual(bed.calls.filter(call => call.plexPath).map(call => call.plexPath).sort(), ['/api/users', '/api/v2/user']);
  assert.ok(bed.calls.some(call => call.url === 'http://byparr:8191/openapi.json'));
  assert.ok(!bed.calls.some(call => call.url === 'http://byparr:8191/health'));
  assert.ok(bed.calls.some(call => call.url === 'http://seerr:5055/api/v1/request' && call.options.params.take === 1));
});

test('health: a Plex friends failure does not claim the Plex account is down', async () => {
  const error = new Error('Request failed with status code 400');
  error.code = 'ERR_BAD_REQUEST';
  error.response = { status: 400, data: { errors: [{ message: 'token cannot list friends' }] } };
  const bed = checkerBed({ plexApiGet: async path => {
    if (path === '/api/users') throw error;
    return { id: 1 };
  } });

  const health = await bed.gatherHealth();
  assert.strictEqual(health.plex, 'ok');
  assert.strictEqual(health.plexFriends, 'down');
  assert.strictEqual(health.overall, 'degraded');
  assert.strictEqual(health.errors.plexFriends, 'HTTP 400 — token cannot list friends');
});

test('health: seedbox staging checks the existing .incoming directory for write access', async () => {
  const health = await checkerBed({ fs: fakeFs({ failIncoming: true }) }).gatherHealth();
  assert.strictEqual(health.grabStaging, 'down');
  assert.strictEqual(health.errors.grabStaging, 'EACCES');
  assert.strictEqual(health.overall, 'degraded');
});

test('health: optional services are skipped and error details stay bounded', async () => {
  const health = await checkerBed({ config: baseConfig({ RADARR_4K_URL: '', BYPARR_URL: '', GRAB_STAGING_PATH: '' }) }).gatherHealth();
  assert.strictEqual(health.radarr4k, 'skipped');
  assert.strictEqual(health.byparr, 'skipped');
  assert.strictEqual(health.grabStaging, 'skipped');
  assert.strictEqual(healthErrorDetail({ response: { status: 503, data: 'x'.repeat(400) } }).length, 240);
  assert.doesNotMatch(healthErrorDetail(new Error('token=secret-value failed')), /secret-value/);
});

test('status overall: failures degrade, informational config warnings are not inputs', () => {
  const healthy = { overall: 'ok' };
  assert.strictEqual(statusOverall({ health: healthy }), 'ok');
  assert.strictEqual(statusOverall({ health: healthy, automationDegraded: true }), 'degraded');
  assert.strictEqual(statusOverall({ health: healthy, diskErrors: [['sonarr', 'timeout']] }), 'degraded');
  assert.strictEqual(statusOverall({ health: healthy, deploymentChecks: ['❌ mount missing'] }), 'degraded');
});

test('request reconciliation: retries transient inventory failures only', async () => {
  let calls = 0;
  let sleeps = 0;
  const rows = await fetchRequestInventoryWithRetry(async () => {
    calls++;
    if (calls < 3) {
      const error = new Error('refused');
      error.code = 'ECONNREFUSED';
      throw error;
    }
    return [{ id: 1 }];
  }, { delayMs: 1, sleep: async () => { sleeps++; } });
  assert.deepStrictEqual(rows, [{ id: 1 }]);
  assert.strictEqual(calls, 3);
  assert.strictEqual(sleeps, 2);

  calls = 0;
  const badRequest = new Error('bad request');
  badRequest.response = { status: 400 };
  await assert.rejects(fetchRequestInventoryWithRetry(async () => { calls++; throw badRequest; }, { sleep: async () => {} }), /bad request/);
  assert.strictEqual(calls, 1);
});

test('request reconciliation: stored failures identify the failing stage', async () => {
  const error = new Error('connect failed');
  error.code = 'ECONNREFUSED';
  await assert.rejects(requestReconcileStage('Seerr request inventory', async () => { throw error; }), /Seerr request inventory: ECONNREFUSED/);
});

test('disk-space report: preserves partial failures and explains allowlist filtering', async () => {
  const auditRows = [];
  const bed = loadSandbox(['fetchDiskSpaceReport', 'fetchDiskSpace'], {
    CONFIG: { DISK_SPACE_PATHS: ['/wanted'] },
    arrSources: () => [
      { label: 'radarr', url: 'http://radarr', key: 'r' },
      { label: 'sonarr', url: 'http://sonarr', key: 's' },
    ],
    axios: { get: async url => {
      if (url.includes('sonarr')) {
        const error = new Error('timeout');
        error.code = 'ETIMEDOUT';
        throw error;
      }
      return { data: [{ path: '/other', totalSpace: 100 * 1024 ** 3, freeSpace: 50 * 1024 ** 3 }] };
    } },
    audit: (...args) => auditRows.push(args),
    healthErrorDetail,
  });

  const report = await bed.run('fetchDiskSpaceReport()');
  assert.strictEqual(report.sourceCount, 2);
  assert.strictEqual(report.reportedCount, 1);
  assert.strictEqual(report.disks.length, 0);
  assert.strictEqual(report.errors.sonarr, 'ETIMEDOUT');
  assert.strictEqual(auditRows.length, 1);
  assert.deepStrictEqual([...(await bed.run('fetchDiskSpace()'))], []);
});
