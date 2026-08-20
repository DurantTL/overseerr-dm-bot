#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EmbedBuilder } = require('discord.js');
const { isOnboardingPayload, withSetupButton } = require('../../src/setup-dm-bridge');

test('setup DM bridge: recognizes only known onboarding titles', () => {
  const welcome = { embeds: [new EmbedBuilder().setTitle('👋 Welcome to Durant Media Server!')] };
  const done = { embeds: [new EmbedBuilder().setTitle('🎉 You\'re In!')] };
  const unrelated = { embeds: [new EmbedBuilder().setTitle('🎬 Request Approved')] };
  assert.equal(isOnboardingPayload(welcome), true);
  assert.equal(isOnboardingPayload(done), true);
  assert.equal(isOnboardingPayload(unrelated), false);
});

test('setup DM bridge: appends one setup button and preserves existing rows', () => {
  const payload = {
    embeds: [new EmbedBuilder().setTitle('🎉 You\'re In!')],
    components: [],
  };
  const first = withSetupButton(payload);
  assert.equal(first.components.length, 1);
  const id = first.components[0].components[0].data.custom_id;
  assert.equal(id, 'setup:open');
  const second = withSetupButton(first);
  assert.equal(second.components.length, 1, 'does not duplicate the setup row');
});

test('setup DM bridge: leaves non-onboarding payloads untouched', () => {
  const payload = { embeds: [new EmbedBuilder().setTitle('Download Ready')], components: [] };
  assert.strictEqual(withSetupButton(payload), payload);
});
