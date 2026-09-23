#!/usr/bin/env node
// Regression tests for tierInstallCommand (src/dashboard-render.js).
// Sep 22, 2026: the monitor-only branch emitted `export TIER_AGENT_TOKEN="$TIER_AGENT_TOKEN"`
// — a self-referencing export with no token value — so every monitor-only installer
// download 401'd. The full-node branch only worked by accident (its export line was correct
// and the shell expanded the buggy references). These tests pin the token interpolation.
const { test } = require('node:test');
const assert = require('node:assert');
const { tierInstallCommand } = require('../../src/dashboard-render');

const TOKEN = 'deadbeef'.repeat(8); // 64-hex-shaped, like setTierAgentToken returns

test('tierInstallCommand: monitor-only export line carries the real token', () => {
  const out = tierInstallCommand({
    botUrl: 'https://example.com', node: 'southcentral',
    token: TOKEN, monitorOnly: true, monitorPath: '/mnt/storage',
  });
  const lines = out.split('\n');
  assert.strictEqual(lines[0], `export TIER_AGENT_TOKEN='${TOKEN}'`);
  assert.ok(!lines[0].includes('$TIER_AGENT_TOKEN'), 'export must not self-reference');
});

test('tierInstallCommand: monitor-only env line carries the real token', () => {
  const out = tierInstallCommand({
    botUrl: 'https://example.com', node: 'southcentral',
    token: TOKEN, monitorOnly: true, monitorPath: '/mnt/storage',
  });
  const envLine = out.split('\n').find(l => l.includes('sudo -E env'));
  assert.match(envLine, new RegExp(`TIER_AGENT_TOKEN='${TOKEN}'`));
  assert.match(envLine, /TIER_MONITOR_ONLY=1/);
  assert.match(envLine, /TIER_FOLDER_ROOT='\/mnt\/storage'/);
});

test('tierInstallCommand: monitor-only output has no empty-token self references', () => {
  const out = tierInstallCommand({
    botUrl: 'https://example.com', node: 'southcentral',
    token: TOKEN, monitorOnly: true, monitorPath: '/mnt/storage',
  });
  // The curl header legitimately references the variable; the *assignments* must not.
  assert.doesNotMatch(out, /TIER_AGENT_TOKEN="\$TIER_AGENT_TOKEN"/);
  assert.doesNotMatch(out, /TIER_AGENT_TOKEN='\$TIER_AGENT_TOKEN'/);
});

test('tierInstallCommand: full-node branch interpolates the token in every assignment', () => {
  const out = tierInstallCommand({
    botUrl: 'https://example.com', node: 'california', token: TOKEN,
    folders: [{ id: 'movies', path: '/mnt/media/movies' }], syncthingApiKey: 'key',
  });
  assert.doesNotMatch(out, /TIER_AGENT_TOKEN="\$TIER_AGENT_TOKEN"/);
  assert.doesNotMatch(out, /TIER_AGENT_TOKEN='\$TIER_AGENT_TOKEN'/);
  assert.ok(out.includes(TOKEN), 'token value appears in the generated command');
});
