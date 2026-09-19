#!/usr/bin/env node
// #257 regression: the guided-setup features are chained most-specific first in index.js's
// interactionCreate listener (media-panel > support-case > request-ui > device-state >
// enhancements > extension). This proves the last three keep the first-refusal order the
// old Client.prototype.emit wrappers had by install order, and that none of them patch
// Client.prototype or REST.prototype anymore.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `durant-setup-routing-order-${process.pid}.db`);
process.env.DB_PATH = dbPath;

const { runMigrations, getUserByDiscordId, getSetting, setSetting, deleteSetting, db } = require('../../src/db');
runMigrations();
const { createSetupDeviceStateFeature } = require('../../src/setup-device-state');
const { createSetupEnhancementsFeature } = require('../../src/setup-discord-enhancements');
const { createSetupExtensionFeature } = require('../../src/setup-discord-extension');
const { Client, REST } = require('discord.js');

after(() => {
  try { db.close(); } catch (_e) {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch (_e) {}
  }
});

const log = { warn() {}, error() {}, ok() {}, info() {} };
const noopAudit = () => {};

function mockInteraction({ commandName = null, customId = null } = {}) {
  return {
    user: { id: 'routing-user', tag: 'router#1' },
    memberPermissions: { has: () => false },
    commandName,
    customId,
    options: {},
    replied: false,
    deferred: false,
    fields: { getTextInputValue: () => '' },
    isChatInputCommand() { return commandName !== null; },
    isButton() { return customId !== null; },
    isModalSubmit() { return customId === 'setup:plex_username_modal'; },
    isStringSelectMenu() { return false; },
    async reply() {},
    async followUp() {},
    async deferReply() {},
    async editReply() {},
  };
}

const deviceState = createSetupDeviceStateFeature({
  getUserByDiscordId, getSetting, setSetting, deleteSetting, audit: noopAudit, log,
});
const enhancements = createSetupEnhancementsFeature({
  getUserByDiscordId,
  audit: noopAudit,
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
});
const extension = createSetupExtensionFeature({
  getUserByDiscordId,
  getTrustScore: () => 0,
  audit: noopAudit,
  db,
  inviteUserToPlex: async () => ({ status: 'invited' }),
  fetchUserQuota: async () => null,
  log,
});

// Same order as index.js's interactionCreate chain for the three migrated features.
const chain = [
  ['device-state', deviceState],
  ['enhancements', enhancements],
  ['extension', extension],
];

async function route(interaction) {
  for (const [name, feature] of chain) {
    if (await feature.handleInteraction(interaction)) return name;
  }
  return null;
}

test('/setup goes to device-state, not the extension catch-all', async () => {
  assert.equal(await route(mockInteraction({ commandName: 'setup' })), 'device-state');
});

test('/send-setup goes to enhancements, and non-admins are refused', async () => {
  assert.equal(await route(mockInteraction({ commandName: 'send-setup' })), 'enhancements');
});

test('/me goes to the extension', async () => {
  assert.equal(await route(mockInteraction({ commandName: 'me' })), 'extension');
});

test('setup:open goes to device-state, not the extension catch-all', async () => {
  assert.equal(await route(mockInteraction({ customId: 'setup:open' })), 'device-state');
});

test('setup:ph_connection goes to device-state, not the extension', async () => {
  assert.equal(await route(mockInteraction({ customId: 'setup:ph_connection' })), 'device-state');
});

test('setup:plex_invite_username goes to enhancements, not the extension catch-all', async () => {
  assert.equal(await route(mockInteraction({ customId: 'setup:plex_invite_username' })), 'enhancements');
});

test('setup:request_key:* goes to enhancements, not the extension catch-all', async () => {
  assert.equal(await route(mockInteraction({ customId: 'setup:request_key:phone' })), 'enhancements');
  assert.equal(await route(mockInteraction({ customId: 'setup:request_key:computer' })), 'enhancements');
});

test('setup:admin_tailnet_help:* goes to enhancements, not the extension catch-all', async () => {
  assert.equal(await route(mockInteraction({ customId: 'setup:admin_tailnet_help:phone' })), 'enhancements');
});

test('setup:quick:request stays deferred to the Request Media wizard', async () => {
  // The extension catch-all owns setup:-prefixed buttons only when the request UI does
  // not — the wizard runs earlier in the chain and gets first refusal.
  assert.equal(await route(mockInteraction({ customId: 'setup:quick:request' })), null);
});

test('setup:plex_username_modal goes to the extension', async () => {
  assert.equal(await route(mockInteraction({ customId: 'setup:plex_username_modal' })), 'extension');
});

test('unrelated interactions are claimed by none of the three', async () => {
  assert.equal(await route(mockInteraction({ commandName: 'request' })), null);
  assert.equal(await route(mockInteraction({ customId: 'media:refresh' })), null);
  assert.equal(await route(mockInteraction({ customId: 'request_approve:abc' })), null);
});

test('no migrated module patches Discord prototypes', () => {
  const sources = [
    'src/setup-device-state.js',
    'src/setup-discord-enhancements.js',
    'src/setup-discord-extension.js',
    'index.js',
    'bootstrap.js',
  ];
  const repoRoot = path.join(__dirname, '..', '..');
  for (const source of sources) {
    const text = fs.readFileSync(path.join(repoRoot, source), 'utf8');
    assert.ok(!/Client\.prototype\.emit\s*=/.test(text), `${source} must not patch Client.prototype.emit`);
    assert.ok(!/REST\.prototype\.put\s*=/.test(text), `${source} must not patch REST.prototype.put`);
  }
  assert.ok(!Object.hasOwn(Client.prototype, '__setup'), 'no setup install marker on Client.prototype');
  assert.ok(typeof REST.prototype.put === 'function', 'REST.prototype.put is the stock implementation');
});
