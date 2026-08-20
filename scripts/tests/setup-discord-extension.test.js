#!/usr/bin/env node
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `durant-setup-extension-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.TAILSCALE_SERVER_ADDRESS = 'ph-server.end-cobra.ts.net';

const { runMigrations, db } = require('../../src/db');
runMigrations();
const { setupStateForUser } = require('../../src/setup');
const {
  phPlexUrl,
  setupButtons,
  quickActionButtons,
  DEVICE_COPY,
  isOwnedInteraction,
} = require('../../src/setup-discord-extension');

after(() => {
  try { db.close(); } catch (_e) {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch (_e) {}
  }
});

function components(rows) {
  return rows.flatMap(row => row.toJSON().components || []);
}

function componentIds(rows) {
  return components(rows).map(c => c.custom_id || c.url).filter(Boolean);
}

function componentLabels(rows) {
  return components(rows).map(c => c.label).filter(Boolean);
}

function hasUrl(rows, { hostname, port = '', pathname = null }) {
  return componentIds(rows).some(value => {
    try {
      const parsed = new URL(String(value));
      return parsed.hostname === hostname
        && parsed.port === String(port)
        && (pathname == null || parsed.pathname === pathname);
    } catch (_err) {
      return false;
    }
  });
}

test('setup Discord extension builds MagicDNS PH Plex URL from configured Tailscale address', () => {
  assert.equal(phPlexUrl(), 'http://ph-server.end-cobra.ts.net:32400');
});

test('setup Discord extension never gives Main users PH controls', () => {
  const main = setupStateForUser({ discord_id: '1', home_server: 'primary', plex_username: 'viewer', invited: 1 });
  const ids = componentIds(setupButtons(main));
  const quickIds = componentIds(quickActionButtons(main));
  assert.ok(!ids.some(v => String(v).includes('ph_device')));
  assert.equal(hasUrl(setupButtons(main), { hostname: 'ph-server.end-cobra.ts.net', port: '32400' }), false);
  assert.ok(!quickIds.some(v => String(v).includes('ph_connection')));
  assert.equal(hasUrl(setupButtons(main), { hostname: 'app.plex.tv' }), true);
});

test('recorded email-first Plex invite still exposes username verify/re-send', () => {
  const main = setupStateForUser({ discord_id: '9', home_server: 'primary', plex_username: 'viewername', invited: 1, overseerr_created: 1 });
  const rows = setupButtons(main);
  assert.ok(componentIds(rows).includes('setup:plex_invite_username'));
  assert.ok(componentLabels(rows).some(label => /Verify \/ Re-send to Username/.test(label)));
});

test('setup Discord extension gives PH users device-specific setup and PH Plex access', () => {
  const ph = setupStateForUser({ discord_id: '2', home_server: 'ph', plex_username: 'viewer', invited: 1 });
  const rows = setupButtons(ph);
  const ids = componentIds(rows);
  const quickIds = componentIds(quickActionButtons(ph));
  assert.ok(ids.includes('setup:ph_device:phone'));
  assert.ok(ids.includes('setup:ph_device:appletv'));
  assert.ok(ids.includes('setup:ph_device:androidtv'));
  assert.ok(ids.includes('setup:ph_device:computer'));
  assert.equal(hasUrl(rows, { hostname: 'ph-server.end-cobra.ts.net', port: '32400', pathname: '/web' }), true);
  assert.ok(quickIds.includes('setup:ph_connection'));
});

test('device copy covers phone, Apple TV, Android/Google TV, and computer with platform-appropriate Tailscale guidance', () => {
  for (const device of ['phone', 'appletv', 'androidtv', 'computer']) {
    assert.ok(DEVICE_COPY[device], `${device} guide exists`);
    assert.ok(DEVICE_COPY[device].steps.length >= 4, `${device} guide has follow-through steps`);
    assert.match(DEVICE_COPY[device].steps.join(' '), /Tailscale/i, `${device} names Tailscale`);
  }
  assert.match(DEVICE_COPY.phone.steps.join(' '), /sign-in|sign in|invite/i);
  assert.doesNotMatch(DEVICE_COPY.phone.steps.join(' '), /one-time connection key/i);
  assert.match(DEVICE_COPY.appletv.steps.join(' '), /auth key/i);
  assert.match(DEVICE_COPY.androidtv.steps.join(' '), /QR code|generated code/i);
});

test('interaction ownership is narrow: setup/me and setup-prefixed UI only', () => {
  const command = name => ({ isChatInputCommand: () => true, isButton: () => false, isModalSubmit: () => false, commandName: name });
  const button = customId => ({ isChatInputCommand: () => false, isButton: () => true, isModalSubmit: () => false, customId });
  const modal = customId => ({ isChatInputCommand: () => false, isButton: () => false, isModalSubmit: () => true, customId });

  assert.equal(isOwnedInteraction(command('setup')), true);
  assert.equal(isOwnedInteraction(command('me')), true);
  assert.equal(isOwnedInteraction(command('request')), false);
  assert.equal(isOwnedInteraction(button('setup:ph_device:phone')), true);
  assert.equal(isOwnedInteraction(button('setup:request_key:phone')), true);
  assert.equal(isOwnedInteraction(button('request_approve:abc')), false);
  assert.equal(isOwnedInteraction(modal('setup:plex_username_modal')), true);
  assert.equal(isOwnedInteraction(modal('stage_bulk_modal')), false);
});
