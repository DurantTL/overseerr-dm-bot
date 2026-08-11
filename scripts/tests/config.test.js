#!/usr/bin/env node
// validateConfig(): webhook secrets must be present whenever TUNNEL_DOMAIN makes the webhook
// routes internet-reachable, independent of whether live deletion is on (see issue #59).
const { test } = require('node:test');
const assert = require('node:assert');
const { CONFIG, validateConfig, configWarnings, isPlaceholder, placeholderMarker } = require('../../src/config');

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

// Issue #122: several .env.example placeholders don't fail — they quietly change routing or fire
// alerts against a domain that doesn't exist. isPlaceholder()/placeholderMarker() detect exactly
// the shapes those examples take, without rejecting a real value that just looks generic.
test('config: isPlaceholder recognizes each known marker but not a real-looking value for it', () => {
  assert.ok(isPlaceholder('CHANGEME'), 'CHANGEME literal');
  assert.ok(!isPlaceholder('avistaz'), 'an unrelated real tag is not a placeholder');

  assert.ok(isPlaceholder('https://your-ph-tunnel/identity'), '"your-" prefixed segment');
  assert.ok(!isPlaceholder('https://ph-tunnel.realdomain.net/identity'), 'a real tunnel URL');

  assert.ok(isPlaceholder('philippines-plex-name-or-machine-id'), '"-name-or-machine-id" suffix');
  assert.ok(!isPlaceholder('philippines-cache-01'), 'a real PH server identity');

  assert.ok(isPlaceholder('phbox:/path-on-5tb-external-drive'), '"path-on-" marker');
  assert.ok(!isPlaceholder('phbox:/cache'), 'a real rclone remote path');

  assert.ok(isPlaceholder('https://ph.example.com/identity'), '"example.com" marker');
  assert.ok(!isPlaceholder('https://ph-tunnel.mydomain.io/identity'), 'a real, unrelated domain');

  assert.ok(isPlaceholder('<your-server-name>'), 'angle-bracket wrapped placeholder');
  assert.ok(!isPlaceholder('main-server-1'), 'a genuinely generic-looking real server name is never rejected');

  assert.strictEqual(isPlaceholder(''), false, 'blank is unset, not a placeholder');
  assert.strictEqual(isPlaceholder(undefined), false, 'undefined is unset, not a placeholder');
  assert.strictEqual(placeholderMarker('CHANGEME'), 'CHANGEME', 'placeholderMarker names the marker that matched');
  assert.strictEqual(placeholderMarker('main-server-1'), null, 'placeholderMarker returns null for a real-looking value');
});

test('config: validateConfig treats a placeholder-only edge identity list as unset', () => {
  Object.assign(CONFIG, {
    DISCORD_BOT_TOKEN: 't', DISCORD_CLIENT_ID: 'c', DISCORD_GUILD_ID: 'g',
    ADMIN_CHANNEL_ID: 'a', ADMIN_USER_ID: 'u',
    OVERSEERR_URL: 'http://seerr:5055', OVERSEERR_API_KEY: 'k',
    PLEX_TOKEN: 'p', PLEX_USERNAME: '', PLEX_PASSWORD: '',
    TUNNEL_DOMAIN: 'files.example.com', RAID_PATH: '/mnt/raid',
    WEBHOOK_SECRET: 's3cret', TAUTULLI_WEBHOOK_SECRET: 'tautulli-secret',
    DASHBOARD_ENABLED: false, DASHBOARD_ADMIN_PASSWORD: '', DASHBOARD_ADMIN_TOKEN: '',
    ENABLE_DELETION: true, DELETION_DRY_RUN: false,
    PH_SERVER_NAMES: ['philippines-plex-name-or-machine-id'], CA_EDGE_SERVER_NAMES: [], PRIMARY_SERVER_NAMES: [],
  });
  assert.doesNotThrow(() => validateConfig(), 'a placeholder-only PH_SERVER_NAMES never arms the PRIMARY_SERVER_NAMES requirement');

  CONFIG.PH_SERVER_NAMES = ['philippines-plex-name-or-machine-id', 'real-ph-box'];
  assert.throws(() => validateConfig(), /requires PRIMARY_SERVER_NAMES/, 'a real entry alongside a placeholder still requires PRIMARY_SERVER_NAMES');

  CONFIG.PH_SERVER_NAMES = [];
});

test('config: configWarnings names the key and neutralizes each load-bearing placeholder', () => {
  const safeBaseline = {
    LOG_LEVEL: 'info', LOG_FORMAT: 'text',
    ENABLE_DELETION: false, DELETION_DRY_RUN: true,
    DASHBOARD_ENABLED: false, DASHBOARD_ADMIN_PASSWORD: '', DASHBOARD_ADMIN_TOKEN: '',
    DISCORD_CLIENT_ID: '123456789012345678', DISCORD_GUILD_ID: '123456789012345678',
    ADMIN_CHANNEL_ID: '123456789012345678', ADMIN_USER_ID: '123456789012345678',
    REQUESTS_CHANNEL_ID: '', SYSTEM_ALERTS_CHANNEL_ID: '', DOWNLOADS_CHANNEL_ID: '',
    PLAYBACK_CHANNEL_ID: '', CLEANUP_CHANNEL_ID: '', AUDIT_CHANNEL_ID: '', DEPLOY_CHANNEL_ID: '',
    WHATS_NEW_CHANNEL_ID: '', PLEX_MEMBER_ROLE_ID: '',
    PLAYBACK_CHECK_MINUTES: 5, TAUTULLI_URL: '', TAUTULLI_API_KEY: '',
    ESCALATION_ENABLED: false, RADARR_URL: '', SONARR_URL: '',
    RTORRENT_URL: '', RTORRENT_ADOPT_ENABLED: false, PROWLARR_URL: '', GRAB_RCLONE_REMOTE: '', GRAB_STAGING_PATH: '',
    GRAB_MODE: 'approve',
    STAGING_ENABLED: false, STAGE_RCLONE_REMOTE: '',
    PH_SERVER_NAMES: [], CA_EDGE_SERVER_NAMES: [], PRIMARY_SERVER_NAMES: [],
    PH_TUNNEL_HEALTH_URL: '',
  };
  Object.assign(CONFIG, safeBaseline);
  assert.strictEqual(configWarnings().length, 0, 'safe baseline: no warnings');

  CONFIG.PH_SERVER_NAMES = ['philippines-plex-name-or-machine-id'];
  let warnings = configWarnings();
  assert.ok(warnings.some(w => w.includes('PH_SERVER_NAMES') && w.includes('philippines-plex-name-or-machine-id')), `PH_SERVER_NAMES placeholder named, got: ${JSON.stringify(warnings)}`);
  assert.ok(!warnings.some(w => w.includes('fail-safe') && !w.includes('PH_SERVER_NAMES')), 'the routing fail-safe warning does not also fire for a placeholder-only list');
  CONFIG.PH_SERVER_NAMES = [];

  CONFIG.CA_EDGE_SERVER_NAMES = ['<your-server-name>'];
  warnings = configWarnings();
  assert.ok(warnings.some(w => w.includes('CA_EDGE_SERVER_NAMES')), `CA_EDGE_SERVER_NAMES placeholder named, got: ${JSON.stringify(warnings)}`);
  CONFIG.CA_EDGE_SERVER_NAMES = [];

  CONFIG.PRIMARY_SERVER_NAMES = ['CHANGEME'];
  warnings = configWarnings();
  assert.ok(warnings.some(w => w.includes('PRIMARY_SERVER_NAMES')), `PRIMARY_SERVER_NAMES placeholder named, got: ${JSON.stringify(warnings)}`);
  CONFIG.PRIMARY_SERVER_NAMES = [];

  CONFIG.PH_TUNNEL_HEALTH_URL = 'https://your-ph-tunnel/identity';
  warnings = configWarnings();
  assert.ok(warnings.some(w => w.includes('PH_TUNNEL_HEALTH_URL') && /watchdog is disabled/.test(w)), `PH_TUNNEL_HEALTH_URL placeholder flagged and disabled, got: ${JSON.stringify(warnings)}`);
  CONFIG.PH_TUNNEL_HEALTH_URL = '';

  CONFIG.STAGE_RCLONE_REMOTE = 'phbox:/path-on-5tb-external-drive';
  warnings = configWarnings();
  assert.ok(warnings.some(w => w.includes('STAGE_RCLONE_REMOTE')), `STAGE_RCLONE_REMOTE placeholder named, got: ${JSON.stringify(warnings)}`);
  CONFIG.STAGE_RCLONE_REMOTE = '';

  assert.strictEqual(configWarnings().length, 0, 'restored to the safe baseline: no warnings');
});
