#!/usr/bin/env node
// validateConfig(): webhook secrets must be present whenever TUNNEL_DOMAIN makes the webhook
// routes internet-reachable, independent of whether live deletion is on (see issue #59).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const runtimeSettings = require('../../src/runtime-settings');
const { renderSettingsGroup } = require('../../src/dashboard-render');
const { CONFIG, validateConfig, startConfigErrorServer, configWarnings, resolveFileEnv, isPlaceholderValue, parseIdentityList, omitPlaceholder, placeholderConfigWarnings } = require('../../src/config');

const SECRET_CONFIG_KEYS = [
  'DISCORD_BOT_TOKEN', 'OVERSEERR_API_KEY', 'WEBHOOK_SECRET', 'PLEX_TOKEN', 'PLEX_PASSWORD',
  'RADARR_API_KEY', 'RADARR_4K_API_KEY', 'SONARR_API_KEY', 'PROWLARR_API_KEY', 'TAUTULLI_API_KEY',
  'PREMIUMIZE_API_KEY', 'RTORRENT_URL', 'TAUTULLI_WEBHOOK_SECRET', 'DASHBOARD_ADMIN_PASSWORD',
  'DASHBOARD_ADMIN_TOKEN', 'SESSION_SECRET', 'TIER_NODES_SEED',
];

test('config: automatic season-pack rejection overrides default off', () => {
  assert.strictEqual(CONFIG.SEASON_PACK_FORCE_GRAB, false);
});

test('config: episode fallback defaults are enabled and explicitly bounded', () => {
  assert.strictEqual(CONFIG.SEASON_PACK_EPISODE_FALLBACK, true);
  assert.strictEqual(CONFIG.SEASON_PACK_EPISODE_BATCH_SIZE, 25);
  assert.strictEqual(CONFIG.SEASON_PACK_EPISODE_MAX_PER_RUN, 50);
  assert.strictEqual(CONFIG.SEASON_PACK_EPISODE_RETRY_MINUTES, 180);
});

test('config: every credential accepts _FILE and trims one trailing newline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-secret-'));
  try {
    const file = path.join(dir, 'secret');
    fs.writeFileSync(file, '  value  \r\n', 'utf8');
    const env = Object.fromEntries(SECRET_CONFIG_KEYS.map(key => [`${key}_FILE`, file]));
    const resolved = resolveFileEnv(env);
    for (const key of SECRET_CONFIG_KEYS) assert.strictEqual(resolved[key], '  value  ', `${key} reads its file`);

    fs.writeFileSync(file, 'value\n\n', 'utf8');
    assert.strictEqual(resolveFileEnv({ WEBHOOK_SECRET_FILE: file }).WEBHOOK_SECRET, 'value\n', 'only one newline is trimmed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config: _FILE conflicts and unreadable files fail with the key name', () => {
  assert.strictEqual(resolveFileEnv({ UNRELATED_FILE: '/missing' }).LOG_LEVEL, undefined, 'unrelated process _FILE values are ignored');
  assert.throws(
    () => resolveFileEnv({ OVERSEERR_API_KEY: 'direct', OVERSEERR_API_KEY_FILE: '/unused' }).OVERSEERR_API_KEY,
    /OVERSEERR_API_KEY and OVERSEERR_API_KEY_FILE are both set/,
  );
  assert.throws(
    () => resolveFileEnv({ WEBHOOK_SECRET_FILE: '/missing/config-secret' }).WEBHOOK_SECRET,
    /could not read WEBHOOK_SECRET_FILE for WEBHOOK_SECRET/,
  );
});

test('config: secret values stay out of warnings, dashboard settings, and audit metadata', () => {
  const previous = Object.fromEntries(SECRET_CONFIG_KEYS.map(key => [key, CONFIG[key]]));
  const sentinel = 'secret-value-that-must-not-render';
  try {
    for (const key of SECRET_CONFIG_KEYS) CONFIG[key] = sentinel;
    assert.ok(!JSON.stringify(configWarnings()).includes(sentinel));
    const store = { get: () => null, set: () => {}, del: () => {} };
    const html = runtimeSettings.describeRuntimeSettings({ config: CONFIG, env: {}, store }).map(renderSettingsGroup).join('');
    assert.ok(!html.includes(sentinel));

    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
    const auditCalls = [...source.matchAll(/\baudit\(([\s\S]*?)\);/g)].map(match => match[0]).join('\n');
    for (const key of SECRET_CONFIG_KEYS) assert.ok(!auditCalls.includes(`CONFIG.${key}`), `${key} is not written to audit metadata`);
  } finally {
    Object.assign(CONFIG, previous);
  }
});

test('config: validateConfig requires webhook secrets whenever TUNNEL_DOMAIN is set', () => {
  // A minimal, otherwise-valid baseline so only the field under test trips validateConfig().
  Object.assign(CONFIG, {
    DISCORD_BOT_TOKEN: 't', DISCORD_CLIENT_ID: 'c', DISCORD_GUILD_ID: 'g',
    ADMIN_CHANNEL_ID: 'a', ADMIN_USER_ID: 'u',
    OVERSEERR_URL: 'http://seerr:5055', OVERSEERR_API_KEY: 'k',
    PLEX_TOKEN: 'p', PLEX_USERNAME: '', PLEX_PASSWORD: '',
    TUNNEL_DOMAIN: 'files.example.com', RAID_PATH: '/mnt/raid',
    WEBHOOK_SECRET: 's3cret', TAUTULLI_WEBHOOK_SECRET: 'tautulli-secret',
    DASHBOARD_ENABLED: false, DASHBOARD_ADMIN_PASSWORD: '', DASHBOARD_ADMIN_TOKEN: '',
    ENABLE_DELETION: false, DELETION_DRY_RUN: true,
    PH_SERVER_NAMES: [], CA_EDGE_SERVER_NAMES: [], PRIMARY_SERVER_NAMES: [],
  });

  assert.doesNotThrow(() => validateConfig(), 'both webhook secrets set: passes');

  CONFIG.WEBHOOK_SECRET = '';
  assert.throws(() => validateConfig(), /WEBHOOK_SECRET is required/, 'blank WEBHOOK_SECRET with TUNNEL_DOMAIN set is fatal, deletion or not');
  CONFIG.WEBHOOK_SECRET = 's3cret';

  CONFIG.TAUTULLI_WEBHOOK_SECRET = '';
  assert.throws(() => validateConfig(), /TAUTULLI_WEBHOOK_SECRET is required/, 'blank TAUTULLI_WEBHOOK_SECRET with TUNNEL_DOMAIN set is fatal, deletion or not');
  CONFIG.TAUTULLI_WEBHOOK_SECRET = 'tautulli-secret';

  assert.doesNotThrow(() => validateConfig(), 'restored to a safe config: passes again');
});

test('config: validateConfig requires SESSION_SECRET whenever DASHBOARD_ENABLED is true', () => {
  // A minimal, otherwise-valid baseline so only the field under test trips validateConfig().
  Object.assign(CONFIG, {
    DISCORD_BOT_TOKEN: 't', DISCORD_CLIENT_ID: 'c', DISCORD_GUILD_ID: 'g',
    ADMIN_CHANNEL_ID: 'a', ADMIN_USER_ID: 'u',
    OVERSEERR_URL: 'http://seerr:5055', OVERSEERR_API_KEY: 'k',
    PLEX_TOKEN: 'p', PLEX_USERNAME: '', PLEX_PASSWORD: '',
    TUNNEL_DOMAIN: 'files.example.com', RAID_PATH: '/mnt/raid',
    WEBHOOK_SECRET: 's3cret', TAUTULLI_WEBHOOK_SECRET: 'tautulli-secret',
    DASHBOARD_ENABLED: true, DASHBOARD_ADMIN_PASSWORD: 'p4ssword', DASHBOARD_ADMIN_TOKEN: '',
    SESSION_SECRET: '',
    ENABLE_DELETION: false, DELETION_DRY_RUN: true,
    PH_SERVER_NAMES: [], CA_EDGE_SERVER_NAMES: [], PRIMARY_SERVER_NAMES: [],
  });

  assert.throws(() => validateConfig(), /DASHBOARD_ENABLED=true requires SESSION_SECRET/, 'dashboard enabled without SESSION_SECRET is fatal');

  CONFIG.SESSION_SECRET = 'a-random-secret';
  assert.doesNotThrow(() => validateConfig(), 'dashboard enabled with SESSION_SECRET set: passes');

  CONFIG.DASHBOARD_ENABLED = false;
  CONFIG.SESSION_SECRET = '';
  assert.doesNotThrow(() => validateConfig(), 'dashboard disabled: SESSION_SECRET is not required');
});

test('config: configWarnings flags a short SESSION_SECRET', () => {
  const previous = { DASHBOARD_ENABLED: CONFIG.DASHBOARD_ENABLED, SESSION_SECRET: CONFIG.SESSION_SECRET };
  try {
    CONFIG.DASHBOARD_ENABLED = true;
    CONFIG.SESSION_SECRET = 'short';
    assert.ok(configWarnings().some(w => w.includes('SESSION_SECRET') && w.includes('32 characters')), 'short SESSION_SECRET warns');

    CONFIG.SESSION_SECRET = 'a'.repeat(32);
    assert.ok(!configWarnings().some(w => w.includes('SESSION_SECRET')), 'a 32-char SESSION_SECRET does not warn');
  } finally {
    Object.assign(CONFIG, previous);
  }
});

test('config: known example placeholders are detected only at value boundaries', () => {
  for (const value of [
    'CHANGEME', '<node-tailscale-ip>', 'https://your-ph-tunnel/identity',
    'philippines-plex-name-or-machine-id', 'main-server-1',
    'phbox:/path-on-5tb-external-drive', 'https://files.example.com/download',
  ]) {
    assert.strictEqual(isPlaceholderValue(value), true, `${value} is a placeholder`);
  }
  for (const value of ['ph-prod', 'my-changeme-server', 'main-server-10', 'yourself-host', 'files.example.com.au', 'https://notexample.com/identity']) {
    assert.strictEqual(isPlaceholderValue(value), false, `${value} is a real-looking value`);
  }
});

test('config: routing placeholders are treated as unset', () => {
  assert.deepStrictEqual(parseIdentityList('philippines-plex-name-or-machine-id,ph-prod'), ['ph-prod'], 'PH placeholder is removed but a real identity remains');
  assert.deepStrictEqual(parseIdentityList('california-plex-name-or-machine-id,ca-prod'), ['ca-prod'], 'CA placeholder is removed but a real identity remains');
  assert.deepStrictEqual(parseIdentityList('main-server-1,durant-main'), ['durant-main'], 'primary placeholder is removed but a real identity remains');
  assert.strictEqual(omitPlaceholder('https://your-ph-tunnel/identity'), '', 'placeholder tunnel URL disables the watchdog');
  assert.strictEqual(omitPlaceholder('https://ph.example.net/identity'), 'https://ph.example.net/identity', 'real tunnel URL is preserved');
});

test('config: each placeholder key produces one warning with its consequence', () => {
  const config = {
    PH_SERVER_NAMES: [], CA_EDGE_SERVER_NAMES: [], PRIMARY_SERVER_NAMES: [],
    PH_TUNNEL_HEALTH_URL: '', STAGE_RCLONE_REMOTE: 'phbox:/path-on-5tb-external-drive',
  };
  const env = {
    PH_SERVER_NAMES: 'philippines-plex-name-or-machine-id',
    CA_EDGE_SERVER_NAMES: 'california-plex-name-or-machine-id',
    PRIMARY_SERVER_NAMES: 'main-server-1',
    PH_TUNNEL_HEALTH_URL: 'https://your-ph-tunnel/identity',
    STAGE_RCLONE_REMOTE: 'phbox:/path-on-5tb-external-drive',
  };
  const warnings = placeholderConfigWarnings(config, env);
  for (const key of Object.keys(env)) {
    assert.strictEqual(warnings.filter(warning => warning.includes(key)).length, 1, `${key} warns exactly once`);
  }
  assert.match(warnings.find(warning => warning.includes('PH_SERVER_NAMES')), /ignored.*strict webhook identity routing/, 'identity warning explains routing consequence');
  assert.match(warnings.find(warning => warning.includes('PH_TUNNEL_HEALTH_URL')), /watchdog stays disabled.*false outage alerts/, 'tunnel warning explains alert consequence');
});

test('config: a placeholder PH identity does not also produce the generic missing warning', () => {
  CONFIG.STAGING_ENABLED = true;
  CONFIG.PH_SERVER_NAMES = [];
  CONFIG.PLACEHOLDER_WARNINGS = ['`PH_SERVER_NAMES` contains an example placeholder; it was ignored.'];
  const warnings = configWarnings();
  assert.strictEqual(warnings.filter(warning => warning.includes('PH_SERVER_NAMES')).length, 1);
  CONFIG.STAGING_ENABLED = false;
  CONFIG.PLACEHOLDER_WARNINGS = [];
});

test('config: validation failure stays reachable through health', async () => {
  const previous = { ...CONFIG };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-error-'));
  const fatalPath = path.join(dir, 'last-fatal.txt');
  let server;
  try {
    Object.assign(CONFIG, {
      DISCORD_BOT_TOKEN: '', DISCORD_CLIENT_ID: 'c', DISCORD_GUILD_ID: 'g',
      ADMIN_CHANNEL_ID: 'a', ADMIN_USER_ID: 'u',
      OVERSEERR_URL: 'http://seerr:5055', OVERSEERR_API_KEY: 'k',
      PLEX_TOKEN: 'p', PLEX_USERNAME: '', PLEX_PASSWORD: '',
      TUNNEL_DOMAIN: 'files.example.com', RAID_PATH: '/mnt/raid',
      WEBHOOK_SECRET: 's3cret', TAUTULLI_WEBHOOK_SECRET: 'tautulli-secret',
      DASHBOARD_ENABLED: false, ENABLE_DELETION: false, DELETION_DRY_RUN: true,
      PH_SERVER_NAMES: [], CA_EDGE_SERVER_NAMES: [], PRIMARY_SERVER_NAMES: [], PORT: 0,
    });
    let validationError;
    try { validateConfig(); } catch (err) { validationError = err; }
    assert.match(validationError.message, /DISCORD_BOT_TOKEN/);

    server = startConfigErrorServer(validationError, fatalPath);
    if (!server.listening) await once(server, 'listening');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.strictEqual(response.status, 503);
    assert.deepStrictEqual(await response.json(), { overall: 'config_error', error: validationError.message });
    assert.match(fs.readFileSync(fatalPath, 'utf8'), /DISCORD_BOT_TOKEN/);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    Object.assign(CONFIG, previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
