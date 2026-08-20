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

test('setup Discord extension builds MagicDNS PH Plex URL from configured Tailscale address', () => {
  assert.equal(phPlexUrl(), 'http://ph-server.end-cobra.ts.net:32400');
});

test('setup Discord extension never gives Main users PH controls', () => {
  const main = setupStateForUser({ discord_id: '1', home_server: 'primary', plex_username: 'viewer', invited: 1 });
  const ids = componentIds(setupButtons(main));
  const quickIds = componentIds(quickActionButtons(main));
  assert.ok(!ids.some(v => String(v).includes('ph_device')));
  assert.ok(!ids.some(v => String(v).includes('ph-server.end-cobra.ts.net')));
  assert.ok(!quickIds.some(v => String(v).includes('ph_connection')));
  assert.ok(ids.some(v => String(v).includes('app.plex.tv')));
});

test('setup Discord extension gives PH users device-specific setup and PH Plex access', () => {
  const ph = setupStateForUser({ discord_id: '2', home_server: 'ph', plex_username: 'viewer', invited: 1 });
  const ids = componentIds(setupButtons(ph));
  const quickIds = componentIds(quickActionButtons(ph));
  assert.ok(ids.includes('setup:ph_device:phone'));
  assert.ok(ids.includes('setup:ph_device:appletv'));
  assert.ok(ids.includes('setup:ph_device:androidtv'));
  assert.ok(ids.includes('setup:ph_device:computer'));
  assert.ok(ids.some(v => String(v).includes('ph-server.end-cobra.ts.net:32400/web')));
  assert.ok(quickIds.includes('setup:ph_connection'));
});

test('device copy covers phone, Apple TV, Android/Google TV, and computer', () => {
  for (const device of ['phone', 'appletv', 'androidtv', 'computer']) {
    assert.ok(DEVICE_COPY[device], `${device} guide exists`);
    assert.ok(DEVICE_COPY[device].steps.length >= 4, `${device} guide has follow-through steps`);
    assert.match(DEVICE_COPY[device].steps.join(' '), /Tailscale/i, `${device} names Tailscale`);
  }
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
