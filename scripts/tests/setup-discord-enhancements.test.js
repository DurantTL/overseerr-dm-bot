#!/usr/bin/env node
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `durant-setup-enhancements-${process.pid}.db`);
process.env.DB_PATH = dbPath;

const { runMigrations, getUserByDiscordId, getSetting, setSetting, deleteSetting, db } = require('../../src/db');
runMigrations();
const { stateKey, createSetupDeviceStateFeature } = require('../../src/setup-device-state');
const { createSetupEnhancementsFeature, owns } = require('../../src/setup-discord-enhancements');

after(() => {
  try { db.close(); } catch (_e) {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch (_e) {}
  }
});

const log = { warn() {}, error() {}, ok() {}, info() {} };

function makeFeature(overrides = {}) {
  const deviceState = createSetupDeviceStateFeature({
    getUserByDiscordId, getSetting, setSetting, deleteSetting,
    audit: () => {}, log,
  });
  return createSetupEnhancementsFeature({
    getUserByDiscordId,
    audit: () => {},
    db,
    getPlexToken: () => null,
    fetchPlexFriends: async () => ({ friends: [] }),
    inviteUserToPlex: async () => ({ status: 'invited' }),
    createViewerAuthKey: async () => ({ ok: true }),
    tailscaleApiConfigured: () => false,
    provisionConfig: async () => ({ tailscale: { apiConfigured: false } }),
    deviceConfirmations: deviceState.deviceConfirmations,
    anyDeviceConfirmed: deviceState.anyDeviceConfirmed,
    log,
    ...overrides,
  });
}

function mockInteraction({ commandName = null, customId = null, admin = false, options = {} } = {}) {
  const calls = { replies: [], followUps: [] };
  return {
    calls,
    user: { id: admin ? 'admin-user' : 'regular-user', tag: 'tester#1' },
    memberPermissions: { has: () => admin },
    commandName,
    customId,
    options,
    replied: false,
    deferred: false,
    isChatInputCommand() { return commandName !== null; },
    isButton() { return customId !== null; },
    isModalSubmit() { return false; },
    isStringSelectMenu() { return false; },
    async reply(payload) { calls.replies.push(payload); return payload; },
    async followUp(payload) { calls.followUps.push(payload); return payload; },
  };
}

test('feature requires its dependencies', () => {
  assert.throws(() => createSetupEnhancementsFeature({}), TypeError);
  assert.throws(() => createSetupEnhancementsFeature({ getUserByDiscordId }), TypeError);
});

test('admin resend payload includes saved PH device state', () => {
  const feature = makeFeature();
  const discordId = '444444444444444444';
  setSetting(stateKey(discordId, 'appletv'), '1700000000000');
  const payload = feature.setupPayloadForUser({
    discord_id: discordId,
    email: 'ph@example.com',
    plex_username: 'phviewer',
    invited: 1,
    overseerr_created: 1,
    home_server: 'ph',
  }, { dm: true });

  const json = payload.embeds[0].toJSON();
  const devices = json.fields.find(field => field.name === 'PH devices');
  assert.ok(devices, 'PH resend includes device summary');
  assert.match(devices.value, /Apple TV.*confirmed/);
  assert.match(devices.value, /Phone \/ Tablet.*not confirmed/);
  assert.equal(Object.hasOwn(payload, 'ephemeral'), false, 'DM payload does not carry interaction-only ephemeral metadata');
});

test('admin resend payload for Main never includes PH state', () => {
  const feature = makeFeature();
  const payload = feature.setupPayloadForUser({
    discord_id: '555555555555555555',
    email: 'main@example.com',
    plex_username: 'mainviewer',
    invited: 1,
    overseerr_created: 1,
    home_server: 'primary',
  }, { dm: true });

  const json = payload.embeds[0].toJSON();
  assert.ok(!json.fields.some(field => field.name === 'PH devices'));
  assert.equal(JSON.stringify(payload.components).includes('ph_connection'), false);
});

test('owns() claims /send-setup and the invite/key/tailnet buttons, nothing else', () => {
  assert.equal(owns(mockInteraction({ commandName: 'send-setup' })), true);
  assert.equal(owns(mockInteraction({ commandName: 'setup' })), false);
  for (const id of ['setup:plex_invite_username', 'setup:request_key:phone', 'setup:request_key:computer', 'setup:admin_tailnet_help:phone']) {
    assert.equal(owns(mockInteraction({ customId: id })), true, id);
  }
  assert.equal(owns(mockInteraction({ customId: 'setup:open' })), false, 'setup:open belongs to the device-state feature');
  assert.equal(owns(mockInteraction({ customId: 'setup:ph_connection' })), false, 'PH connection belongs to the device-state feature');
  assert.equal(owns(mockInteraction({ customId: 'media:refresh' })), false);
});

test('handleInteraction refuses /send-setup for non-admins', async () => {
  const feature = makeFeature();
  const interaction = mockInteraction({ commandName: 'send-setup', admin: false });
  assert.equal(await feature.handleInteraction(interaction), true);
  assert.match(interaction.calls.replies[0].content, /Administrator permission is required/);
});

test('handleInteraction reports a missing target for /send-setup', async () => {
  const feature = makeFeature({ getUserByDiscordId: () => null });
  const interaction = mockInteraction({
    commandName: 'send-setup',
    admin: true,
    options: { getUser: () => ({ id: 'target-user', username: 'target' }) },
  });
  assert.equal(await feature.handleInteraction(interaction), true);
  assert.match(interaction.calls.replies[0].content, /does not have a Durant Media Server user record/);
});

test('handleInteraction routes setup:plex_invite_username to username verification', async () => {
  const feature = makeFeature({ getUserByDiscordId: () => null });
  const interaction = mockInteraction({ customId: 'setup:plex_invite_username' });
  assert.equal(await feature.handleInteraction(interaction), true);
  assert.match(interaction.calls.replies[0].content, /enter your Plex username first/);
});

test('handleInteraction routes setup:request_key to key provisioning', async () => {
  const feature = makeFeature({ getUserByDiscordId: () => null });
  const interaction = mockInteraction({ customId: 'setup:request_key:phone' });
  assert.equal(await feature.handleInteraction(interaction), true);
  assert.match(interaction.calls.replies[0].content, /No PH connection setup is needed/);
});

test('handleInteraction routes setup:admin_tailnet_help to admin notification', async () => {
  const feature = makeFeature({ getUserByDiscordId: () => ({ discord_id: 'u', home_server: 'ph' }) });
  const interaction = mockInteraction({ customId: 'setup:admin_tailnet_help:phone' });
  assert.equal(await feature.handleInteraction(interaction), true);
  assert.match(interaction.calls.replies[0].content, /could not notify the admin channel/);
});

test('handleInteraction ignores interactions owned by other features', async () => {
  const feature = makeFeature();
  const interaction = mockInteraction({ customId: 'setup:open' });
  assert.equal(await feature.handleInteraction(interaction), false);
  assert.equal(interaction.calls.replies.length, 0);
});
