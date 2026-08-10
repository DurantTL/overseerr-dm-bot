#!/usr/bin/env node
// validateConfig(): webhook secrets must be present whenever TUNNEL_DOMAIN makes the webhook
// routes internet-reachable, independent of whether live deletion is on (see issue #59).
const { test } = require('node:test');
const assert = require('node:assert');
const { CONFIG, validateConfig } = require('../../src/config');

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
