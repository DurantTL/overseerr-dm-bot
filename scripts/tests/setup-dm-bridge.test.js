#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
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

test('setup DM bridge: nothing patches Discord prototypes any more (#257)', () => {
  const root = path.join(__dirname, '..', '..');
  const bridge = fs.readFileSync(path.join(root, 'src', 'setup-dm-bridge.js'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(root, 'bootstrap.js'), 'utf8');
  assert.doesNotMatch(bridge, /\.prototype\b/, 'the bridge no longer wraps send/reply');
  assert.doesNotMatch(bootstrap, /installSetupDmBridge/);
  for (const file of fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    assert.doesNotMatch(src, /\.prototype\.(emit|put|send|reply)\s*=/, `${file} must not patch Discord prototypes`);
  }
});

test('setup DM bridge: every onboarding send in index.js adds the button explicitly', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
  // Each place that builds an onboarding embed must send it through withSetupButton, either
  // directly or via dmUser (which applies it to every payload).
  const titles = [...index.matchAll(/setTitle\(([^)]*(?:Welcome to Durant Media Server|You\\'re In!)[^)]*)\)/g)];
  assert.ok(titles.length >= 4, `found ${titles.length} onboarding titles`);
  for (const m of titles) {
    const before = index.slice(Math.max(0, m.index - 160), m.index);
    assert.match(before, /(send|reply)\(withSetupButton\(\{ embeds: \[brandedEmbed\([^)]*\)\s*\.$|dmUser\([^,]+, \{ embeds: \[brandedEmbed\([^)]*\)\s*\.$/, `onboarding send near: ${m[1]}`);
  }
  assert.match(index, /await user\.send\(withSetupButton\(payload\)\);/, 'dmUser applies the button');
});
