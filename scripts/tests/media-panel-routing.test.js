#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createMediaPanelFeature, mediaPanelCommand } = require('../../src/media-panel');

function feature(overrides = {}) {
  const calls = { forwarded: [], audits: [] };
  const instance = createMediaPanelFeature({
    config: { ADMIN_USER_ID: 'admin', ADMIN_CHANNEL_ID: 'admin-channel' },
    getUserByDiscordId: () => ({ discord_id: 'member' }),
    getSetting: () => null,
    setSetting: () => {},
    audit: (...args) => calls.audits.push(args),
    requestModal: () => ({ kind: 'request-modal' }),
    log: { warn: () => {}, error: () => {} },
    forwardSlashCommand: async interaction => calls.forwarded.push(interaction.commandName),
    supportCases: {
      createCase: () => ({ case: { id: 1, reference_id: 'CASE-TEST', notify_status: 'pending' }, duplicate: false }),
      recordNotifyResult: () => {},
    },
    ...overrides,
  });
  return { instance, calls };
}

function button(customId, overrides = {}) {
  return {
    customId,
    user: { id: 'member' },
    isChatInputCommand: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    showModal: async () => {},
    reply: async () => {},
    ...overrides,
  };
}

test('exports /media-panel for ordinary command registration', () => {
  const command = mediaPanelCommand.toJSON();
  assert.equal(command.name, 'media-panel');
  assert.ok(command.default_member_permissions, 'installer command remains admin-only');
});

test('explicit handler ignores interactions it does not own', async () => {
  const { instance, calls } = feature();
  const handled = await instance.handleInteraction(button('unrelated:button'));
  assert.equal(handled, false);
  assert.deepEqual(calls.forwarded, []);
});

test('media buttons are handled once and forward through the injected slash handler', async () => {
  const { instance, calls } = feature();
  const handled = await instance.handleInteraction(button('media:myrequests'));
  assert.equal(handled, true);
  assert.deepEqual(calls.forwarded, ['myrequests']);
});

test('request button uses injected account lookup and modal factory', async () => {
  let shown = null;
  const { instance } = feature();
  const handled = await instance.handleInteraction(button('media:request', {
    showModal: async modal => { shown = modal; },
  }));
  assert.equal(handled, true);
  assert.deepEqual(shown, { kind: 'request-modal' });
});

test('my cases button forwards through the injected slash handler', async () => {
  const { instance, calls } = feature();
  const handled = await instance.handleInteraction(button('media:mycases'));
  assert.equal(handled, true);
  assert.deepEqual(calls.forwarded, ['mycases']);
});

test('remove/report/support modal submits create a durable case via injected supportCases', async () => {
  const created = [];
  const { instance } = feature({
    supportCases: {
      createCase: args => {
        created.push(args);
        return { case: { id: 7, reference_id: 'CASE-ABC123', notify_status: 'pending' }, duplicate: false };
      },
      recordNotifyResult: () => {},
    },
  });
  let replied = null;
  const modal = {
    customId: 'media:report_modal',
    user: { id: 'member' },
    channelId: 'chan',
    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => true,
    fields: { getTextInputValue: key => (key === 'title' ? 'Some Show' : 'It buffers constantly') },
    client: { channels: { fetch: async () => null } },
    deferReply: async () => {},
    editReply: async content => { replied = content; },
  };
  const handled = await instance.handleInteraction(modal);
  assert.equal(handled, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].category, 'report');
  assert.equal(created[0].mediaTitle, 'Some Show');
  assert.equal(created[0].details, 'It buffers constantly');
  assert.match(replied, /CASE-ABC123/);
});

test('media panel no longer intercepts Discord prototypes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/media-panel.js'), 'utf8');
  assert.doesNotMatch(source, /Client\.prototype\.emit|REST\.prototype\.put/);
  assert.doesNotMatch(source, /\bClient\b|\bREST\b/);
});
