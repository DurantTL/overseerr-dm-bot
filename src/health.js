'use strict';

const path = require('path');
const { redactOperatorText } = require('./operator-error');

const HEALTH_KEYS = Object.freeze([
  'discord',
  'sqlite',
  'backup',
  'plex',
  'plexFriends',
  'overseerr',
  'seerrRequests',
  'radarr',
  'radarr4k',
  'sonarr',
  'prowlarr',
  'byparr',
  'raidPath',
  'grabStaging',
  'tunnelDomain',
]);

const HEALTH_LABELS = Object.freeze({
  discord: 'discord',
  sqlite: 'sqlite',
  backup: 'backup',
  plex: 'plex.tv account',
  plexFriends: 'plex.tv friends',
  overseerr: 'seerr service',
  seerrRequests: 'seerr requests',
  radarr: 'radarr',
  radarr4k: 'radarr 4k',
  sonarr: 'sonarr',
  prowlarr: 'prowlarr',
  byparr: 'byparr liveness',
  raidPath: 'media mount',
  grabStaging: 'seedbox staging',
  tunnelDomain: 'tunnel domain',
});

function healthLabel(key) {
  return HEALTH_LABELS[key] || key;
}

function statusOverall({ health, automationDegraded = false, diskErrors = [], deploymentChecks = [] }) {
  return health.overall === 'ok'
    && !automationDegraded
    && diskErrors.length === 0
    && !deploymentChecks.some(line => line.startsWith('❌'))
    ? 'ok'
    : 'degraded';
}

// Axios often reduces a useful HTTP failure to ERR_BAD_REQUEST. Keep the bounded response
// reason when one exists, but never dump the whole response (which can carry sensitive data).
function healthErrorDetail(error) {
  const status = Number(error?.response?.status);
  const data = error?.response?.data;
  let detail = null;
  if (typeof data === 'string') detail = data.trim();
  else if (typeof data?.message === 'string') detail = data.message;
  else if (Array.isArray(data?.errors)) {
    detail = data.errors.map(item => item?.message || item?.detail || item?.code).filter(Boolean).join('; ');
  } else if (typeof data?.error === 'string') detail = data.error;
  const prefix = Number.isFinite(status) ? `HTTP ${status}` : null;
  const fallback = error?.code || error?.message || 'unknown error';
  return redactOperatorText([prefix, detail || fallback].filter(Boolean).join(' — ')).slice(0, 240);
}

function requireDirectory(fs, directory, mode, label) {
  const stat = fs.statSync(directory);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory`);
  fs.accessSync(directory, mode);
}

function createHealthChecker({ config, client, db, fs, axios, audit, getSetting, backupState, getPlexToken, plexApiGet }) {
  return async function gatherHealth() {
    const checks = { overall: 'ok', timestamp: new Date().toISOString(), errors: {} };
    checks.discord = client.isReady() ? 'ok' : 'down';
    try {
      db.prepare('SELECT 1').get();
      checks.sqlite = 'ok';
    } catch (error) {
      checks.sqlite = 'down';
      checks.errors.sqlite = healthErrorDetail(error);
    }

    const backup = backupState(getSetting('backup_last_success'), config.BACKUP_INTERVAL_HOURS);
    checks.backup = backup.status;
    checks.backupLastSuccessfulAt = backup.lastSuccessfulAt;
    checks.backupAgeMs = backup.ageMs;

    try {
      requireDirectory(fs, config.RAID_PATH, fs.constants.R_OK | fs.constants.X_OK, 'media mount');
      checks.raidPath = 'ok';
    } catch (error) {
      checks.raidPath = 'down';
      checks.errors.raidPath = healthErrorDetail(error);
    }

    if (!config.GRAB_STAGING_PATH) {
      checks.grabStaging = 'skipped';
    } else {
      try {
        const mode = fs.constants.W_OK | fs.constants.X_OK;
        requireDirectory(fs, config.GRAB_STAGING_PATH, mode, 'seedbox staging root');
        const incoming = path.join(config.GRAB_STAGING_PATH, '.incoming');
        if (fs.existsSync(incoming)) requireDirectory(fs, incoming, mode, 'seedbox staging .incoming');
        checks.grabStaging = 'ok';
      } catch (error) {
        checks.grabStaging = 'down';
        checks.errors.grabStaging = healthErrorDetail(error);
      }
    }
    checks.tunnelDomain = config.TUNNEL_DOMAIN ? 'configured' : 'missing';

    async function apiCheck(name, fn) {
      try {
        const out = await fn();
        checks[name] = out === 'skipped' ? 'skipped' : 'ok';
      } catch (error) {
        checks[name] = 'down';
        checks.errors[name] = healthErrorDetail(error);
        audit('external_api_error', { provider: name, error: error.message });
      }
    }

    let plexTokenPromise;
    const plexToken = () => {
      plexTokenPromise ||= getPlexToken();
      return plexTokenPromise;
    };
    const seerrHeaders = { 'X-Api-Key': config.OVERSEERR_API_KEY };
    await Promise.all([
      apiCheck('plex', async () => plexApiGet('/api/v2/user', await plexToken())),
      // /api/v2/friends was deprecated (HTTP 410 Gone) — /api/users is the legacy endpoint
      // plex.tv still serves for this same list (see src/plex.js's fetchPlexFriends).
      apiCheck('plexFriends', async () => plexApiGet('/api/users', await plexToken())),
      apiCheck('overseerr', async () => axios.get(`${config.OVERSEERR_URL}/api/v1/status`, { headers: seerrHeaders, timeout: 5000 })),
      apiCheck('seerrRequests', async () => axios.get(`${config.OVERSEERR_URL}/api/v1/request`, { params: { take: 1, skip: 0 }, headers: seerrHeaders, timeout: 5000 })),
      apiCheck('radarr', async () => {
        if (!config.RADARR_URL) return 'skipped';
        return axios.get(`${config.RADARR_URL}/api/v3/system/status`, { params: { apikey: config.RADARR_API_KEY }, timeout: 5000 });
      }),
      apiCheck('radarr4k', async () => {
        if (!config.RADARR_4K_URL) return 'skipped';
        return axios.get(`${config.RADARR_4K_URL}/api/v3/system/status`, { params: { apikey: config.RADARR_4K_API_KEY }, timeout: 5000 });
      }),
      apiCheck('sonarr', async () => {
        if (!config.SONARR_URL) return 'skipped';
        return axios.get(`${config.SONARR_URL}/api/v3/system/status`, { params: { apikey: config.SONARR_API_KEY }, timeout: 5000 });
      }),
      apiCheck('prowlarr', async () => {
        if (!config.PROWLARR_URL) return 'skipped';
        return axios.get(`${config.PROWLARR_URL}/api/v1/system/status`, { headers: { 'X-Api-Key': config.PROWLARR_API_KEY }, timeout: 5000 });
      }),
      // Byparr /health launches a browser and visits Google. That is a useful deep diagnostic,
      // but too slow and externally dependent for liveness (healthy runs can exceed five seconds).
      apiCheck('byparr', async () => {
        if (!config.BYPARR_URL) return 'skipped';
        return axios.get(`${config.BYPARR_URL}/openapi.json`, { timeout: 5000 });
      }),
    ]);

    const ignored = new Set(['overall', 'timestamp', 'tunnelDomain', 'errors', 'backupLastSuccessfulAt', 'backupAgeMs']);
    const healthy = new Set(['ok', 'configured', 'skipped', 'disabled']);
    checks.overall = Object.entries(checks).some(([key, value]) => !ignored.has(key) && !healthy.has(value)) ? 'degraded' : 'ok';
    return checks;
  };
}

module.exports = { HEALTH_KEYS, HEALTH_LABELS, healthLabel, healthErrorDetail, statusOverall, createHealthChecker };
