#!/usr/bin/env node
// validateConfig(): webhook secrets must be present whenever TUNNEL_DOMAIN makes the webhook
// routes internet-reachable, independent of whether live deletion is on (see issue #59).
const { test } = require('node:test');
const assert = require('node:assert');
const { CONFIG, validateConfig, configWarnings, isPlaceholderValue, parseIdentityList, omitPlaceholder, placeholderConfigWarnings } = require('../../src/config');

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
