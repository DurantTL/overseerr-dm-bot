#!/usr/bin/env node
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `durant-setup-extension-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.TAILSCALE_SERVER_ADDRESS = 'ph-server.example.ts.net';

const { runMigrations, db } = require('../../src/db');
runMigrations();
const { setupStateForUser } = require('../../src/setup');
const {
  createSetupExtensionFeature,
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

const log = { warn() {}, error() {}, ok() {}, info() {} };

function makeFeature(overrides = {}) {
  return createSetupExtensionFeature({
    getUserByDiscordId: () => null,
    getTrustScore: () => 0,
    audit: () => {},
    db,
    inviteUserToPlex: async () => ({ status: 'invited' }),
    fetchUserQuota: async () => null,
    log,
    ...overrides,
  });
}

function mockInteraction({ commandName = null, customId = null } = {}) {
  const calls = { replies: [], followUps: [] };
  return {
    calls,
    user: { id: 'regular-user', tag: 'tester#1' },
    commandName,
    customId,
    replied: false,
    deferred: false,
    fields: { getTextInputValue: () => '' },
    isChatInputCommand() { return commandName !== null; },
    isButton() { return customId !== null; },
    isModalSubmit() { return customId === 'setup:plex_username_modal'; },
    isStringSelectMenu() { return false; },
    async reply(payload) { calls.replies.push(payload); return payload; },
    async followUp(payload) { calls.followUps.push(payload); return payload; },
  };
}

test('feature requires its dependencies', () => {
  assert.throws(() => createSetupExtensionFeature({}), TypeError);
  assert.throws(() => createSetupExtensionFeature({ getUserByDiscordId: () => null }), TypeError);
});

test('setup Discord extension builds MagicDNS PH Plex URL from configured Tailscale address', () => {
  assert.equal(phPlexUrl(), 'http://ph-server.example.ts.net:32400');
});

test('setup Discord extension never gives Main users PH controls', () => {
  const main = setupStateForUser({ discord_id: '1', home_server: 'primary', plex_username: 'viewer', invited: 1 });
  const ids = componentIds(setupButtons(main));
  const quickIds = componentIds(quickActionButtons(main));
  assert.ok(!ids.some(v => String(v).includes('ph_device')));
  assert.equal(hasUrl(setupButtons(main), { hostname: 'ph-server.example.ts.net', port: '32400' }), false);
  assert.ok(!quickIds.some(v => String(v).includes('ph_connection')));
  assert.equal(hasUrl(setupButtons(main), { hostname: 'app.plex.tv' }), true);
});

test('recorded email-first Plex invite still exposes username verify/re-send', () => {
  const main = setupStateForUser({ discord_id: '9', home_server: 'primary', plex_username: 'viewername', invited: 1, overseerr_created: 1 });
  const ids = componentIds(setupButtons(main));
  assert.ok(ids.some(v => v === 'setup:plex_invite_username'));
});

test('setup Discord extension gives PH users device-specific setup and PH Plex access', () => {
  const ph = setupStateForUser({ discord_id: '7', home_server: 'ph', plex_username: 'phviewer', invited: 1 });
  const ids = componentIds(setupButtons(ph));
  assert.ok(ids.some(v => String(v).includes('ph_device')));
  assert.equal(hasUrl(setupButtons(ph), { hostname: 'ph-server.example.ts.net', port: '32400' }), true);
});

test('device copy covers phone, Apple TV, Android/Google TV, and computer with platform-appropriate Tailscale guidance', () => {
  for (const key of ['phone', 'appletv', 'androidtv', 'computer']) {
    const copy = DEVICE_COPY[key];
    assert.ok(copy && copy.title && Array.isArray(copy.steps) && copy.steps.length >= 3, `${key} has guided copy`);
    assert.match(copy.steps.join('\n'), /Tailscale/);
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

test('interaction ownership defers Request Media wizard buttons to the request UI', () => {
  const button = customId => ({ isChatInputCommand: () => false, isButton: () => true, isModalSubmit: () => false, customId });
  // The request UI gets first refusal in index.js's chain, so the extension's catch-all
  // must not claim its buttons even though they carry the setup: prefix.
  assert.equal(isOwnedInteraction(button('setup:quick:request')), false);
  assert.equal(isOwnedInteraction(button('setup:quick:help')), true);
});

test('handleInteraction routes /me to the profile card', async () => {
  const feature = makeFeature();
  const interaction = mockInteraction({ commandName: 'me' });
  assert.equal(await feature.handleInteraction(interaction), true);
  const reply = interaction.calls.replies[0];
  assert.match(reply.embeds[0].toJSON().title, /Not Linked Yet/);
  assert.equal(reply.ephemeral, true);
});

test('handleInteraction refuses a Plex username save without an account record', async () => {
  const feature = makeFeature();
  const interaction = mockInteraction({ customId: 'setup:plex_username_modal' });
  assert.equal(await feature.handleInteraction(interaction), true);
  assert.match(interaction.calls.replies[0].content, /cannot save a Plex username/);
});

test('handleInteraction routes setup:quick:help to the quick command', async () => {
  const feature = makeFeature();
  const interaction = mockInteraction({ customId: 'setup:quick:help' });
  assert.equal(await feature.handleInteraction(interaction), true);
  assert.match(interaction.calls.replies[0].content, /open \*\*\/help\*\*/);
});

test('handleInteraction does not claim Request Media wizard buttons', async () => {
  const feature = makeFeature();
  const interaction = mockInteraction({ customId: 'setup:quick:request' });
  assert.equal(await feature.handleInteraction(interaction), false);
  assert.equal(interaction.calls.replies.length, 0);
});

test('handleInteraction ignores interactions it does not own', async () => {
  const feature = makeFeature();
  const interaction = mockInteraction({ customId: 'media:refresh' });
  assert.equal(await feature.handleInteraction(interaction), false);
  assert.equal(interaction.calls.replies.length, 0);
});
