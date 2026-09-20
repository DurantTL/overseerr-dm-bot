#!/usr/bin/env node
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `durant-device-state-${process.pid}.db`);
process.env.DB_PATH = dbPath;

const { runMigrations, getUserByDiscordId, getSetting, setSetting, deleteSetting } = require('../../src/db');
runMigrations();

const {
  createSetupDeviceStateFeature,
  owns,
  DEVICES,
  stateKey,
  tailscaleShareUrl,
} = require('../../src/setup-device-state');

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch (_e) {}
  }
});

const calls = { audited: [], errors: [] };
function makeFeature(overrides = {}) {
  return createSetupDeviceStateFeature({
    getUserByDiscordId,
    getSetting,
    setSetting,
    deleteSetting,
    audit: (...a) => { calls.audited.push(a); },
    log: { warn() {}, error: (...a) => { calls.errors.push(a); } },
    ...overrides,
  });
}

function mockInteraction({ commandName = null, customId = null } = {}) {
  const calls = { replies: [], followUps: [] };
  return {
    calls,
    user: { id: '999999999999999999' },
    commandName,
    customId,
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
  assert.throws(() => createSetupDeviceStateFeature({}), TypeError);
  assert.throws(() => createSetupDeviceStateFeature({ getUserByDiscordId }), TypeError);
});

test('PH device confirmations are stored independently per device', () => {
  const feature = makeFeature();
  const userId = '111111111111111111';
  for (const device of DEVICES) deleteSetting(stateKey(userId, device));
  assert.equal(feature.anyDeviceConfirmed(userId), false);

  setSetting(stateKey(userId, 'phone'), '1700000000000');
  const statuses = feature.deviceConfirmations(userId);
  assert.equal(statuses.phone, 1700000000000);
  assert.equal(statuses.appletv, null);
  assert.equal(feature.anyDeviceConfirmed(userId), true);
});

test('Main setup payload never gains PH device status', () => {
  const feature = makeFeature();
  const payload = feature.personalizedSetupPayload({
    discord_id: '222222222222222222',
    email: 'main@example.com',
    plex_username: 'mainuser',
    invited: 1,
    overseerr_created: 1,
    home_server: 'primary',
  });
  const json = payload.embeds[0].toJSON();
  assert.ok(!json.fields?.some(f => f.name === 'PH devices'));
});

test('PH setup payload shows saved device confirmation status', () => {
  const feature = makeFeature();
  const userId = '333333333333333333';
  setSetting(stateKey(userId, 'computer'), String(Date.now()));
  const payload = feature.personalizedSetupPayload({
    discord_id: userId,
    email: 'ph@example.com',
    plex_username: 'phuser',
    invited: 1,
    overseerr_created: 1,
    home_server: 'ph',
  });
  const json = payload.embeds[0].toJSON();
  const field = json.fields.find(f => f.name === 'PH devices');
  assert.ok(field);
  assert.match(field.value, /Computer.*confirmed/);
  assert.match(field.value, /Phone \/ Tablet.*not confirmed/);
  assert.equal(feature.deviceConfirmation(userId, 'computer') > 0, true);
});

test('PH machine-share URL only accepts HTTPS links', () => {
  const before = process.env.TAILSCALE_PH_SHARE_URL;
  try {
    process.env.TAILSCALE_PH_SHARE_URL = 'https://login.tailscale.com/admin/machines/example/share';
    assert.equal(tailscaleShareUrl(), 'https://login.tailscale.com/admin/machines/example/share');
    process.env.TAILSCALE_PH_SHARE_URL = 'javascript:alert(1)';
    assert.equal(tailscaleShareUrl(), '');
  } finally {
    if (before === undefined) delete process.env.TAILSCALE_PH_SHARE_URL;
    else process.env.TAILSCALE_PH_SHARE_URL = before;
  }
});

test('owns() claims /setup and the PH device buttons, nothing else', () => {
  assert.equal(owns(mockInteraction({ commandName: 'setup' })), true);
  assert.equal(owns(mockInteraction({ commandName: 'request' })), false);
  for (const id of ['setup:open', 'setup:ph_connection', 'setup:ph_device:phone', 'setup:ph_confirm:appletv', 'setup:ph_unconfirm:computer']) {
    assert.equal(owns(mockInteraction({ customId: id })), true, id);
  }
  assert.equal(owns(mockInteraction({ customId: 'setup:plex_invite_username' })), false);
  assert.equal(owns(mockInteraction({ customId: 'media:refresh' })), false);
});

test('handleInteraction routes /setup to the setup screen', async () => {
  const feature = makeFeature({ getUserByDiscordId: () => null });
  const interaction = mockInteraction({ commandName: 'setup' });
  assert.equal(await feature.handleInteraction(interaction), true);
  assert.equal(interaction.calls.replies.length, 1);
  assert.match(interaction.calls.replies[0].embeds[0].toJSON().title, /Setup/);
});

test('handleInteraction routes setup:open to the setup screen', async () => {
  const feature = makeFeature({ getUserByDiscordId: () => null });
  const interaction = mockInteraction({ customId: 'setup:open' });
  assert.equal(await feature.handleInteraction(interaction), true);
  assert.equal(interaction.calls.replies.length, 1);
});

test('handleInteraction routes setup:ph_connection for a PH user', async () => {
  const feature = makeFeature({ getUserByDiscordId: () => ({ discord_id: 'u', home_server: 'ph' }) });
  const interaction = mockInteraction({ customId: 'setup:ph_connection' });
  assert.equal(await feature.handleInteraction(interaction), true);
  assert.match(interaction.calls.replies[0].embeds[0].toJSON().title, /PH Server Connection/);
});

test('handleInteraction refuses PH dashboard for Main users', async () => {
  const feature = makeFeature({ getUserByDiscordId: () => ({ discord_id: 'u', home_server: 'primary' }) });
  const interaction = mockInteraction({ customId: 'setup:ph_connection' });
  assert.equal(await feature.handleInteraction(interaction), true);
  assert.match(interaction.calls.replies[0].content, /Main server/);
});

test('handleInteraction confirms and resets a PH device', async () => {
  const userId = '777777777777777777';
  deleteSetting(stateKey(userId, 'phone'));
  const feature = makeFeature({ getUserByDiscordId: () => ({ discord_id: userId, home_server: 'ph' }) });

  const confirm = mockInteraction({ customId: 'setup:ph_confirm:phone' });
  confirm.user.id = userId;
  assert.equal(await feature.handleInteraction(confirm), true);
  assert.match(confirm.calls.replies[0].embeds[0].toJSON().title, /Device Setup Saved/);
  assert.ok(feature.deviceConfirmation(userId, 'phone') > 0);
  assert.ok(calls.audited.some(a => a[0] === 'ph_device_setup_confirmed'));

  const reset = mockInteraction({ customId: 'setup:ph_unconfirm:phone' });
  reset.user.id = userId;
  assert.equal(await feature.handleInteraction(reset), true);
  assert.equal(feature.deviceConfirmation(userId, 'phone'), null);
  assert.ok(calls.audited.some(a => a[0] === 'ph_device_setup_reset'));
  deleteSetting(stateKey(userId, 'phone'));
});

test('handleInteraction ignores interactions it does not own', async () => {
  const feature = makeFeature();
  const interaction = mockInteraction({ customId: 'media:refresh' });
  assert.equal(await feature.handleInteraction(interaction), false);
  assert.equal(interaction.calls.replies.length, 0);
});

test('handleInteraction replies ephemerally on handler errors', async () => {
  const feature = makeFeature({
    getUserByDiscordId: () => { throw new Error('db exploded'); },
  });
  const interaction = mockInteraction({ commandName: 'setup' });
  assert.equal(await feature.handleInteraction(interaction), true);
  assert.equal(calls.errors.length > 0, true);
  assert.match(interaction.calls.replies[0].content, /unexpected error/);
});
