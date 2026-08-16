#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const installer = fs.readFileSync(path.join(__dirname, '..', '..', 'agent', 'install.sh.tmpl'), 'utf8');

test('tier installer: native multi-folder config does not require legacy single-folder variables', () => {
  assert.match(installer, /TIER_FOLDER_ROOT-or-TIER_FOLDERS/);
  assert.match(installer, /SYNCTHING_FOLDER_ID-or-TIER_FOLDERS/);
  assert.doesNotMatch(installer, /for var in[^\n]*TIER_FOLDER_ROOT/);
  assert.match(installer, /JSON\.parse\(raw\)/, 'JSON folder arrays are validated before installation');
});

test('tier installer: persists one TIER_FOLDERS value and grants every root write access', () => {
  assert.strictEqual((installer.match(/TIER_FOLDERS=\$\{JSON\.stringify/g) || []).length, 1, 'multi-folder env is written once with systemd-safe quoting');
  assert.match(installer, /ReadWritePaths=\$\{JSON\.stringify\(folder\.root\)\}/);
  assert.match(installer, /FOLDER_UNIT_LINES/);
});

test('tier installer: provisions and then verifies Node.js when 18+ is unavailable', () => {
  assert.match(installer, /NODE_MAJOR=\$\(node_major\)/);
  assert.match(installer, /if \[ "\$NODE_MAJOR" -lt 18 \]; then\s+install_node/);
  assert.match(installer, /https:\/\/deb\.nodesource\.com\/setup_22\.x/);
  assert.match(installer, /https:\/\/rpm\.nodesource\.com\/setup_22\.x/);
  assert.match(installer, /apt-get install -y nodejs/);
  assert.match(installer, /dnf install -y nodejs/);
  assert.match(installer, /yum install -y nodejs/);
  assert.match(installer, /Node\.js installation completed but node \$NODE_MAJOR was found/);
  assert.doesNotMatch(installer, /node not found —/);
});

test('tier installer: missing folder errors are actionable and omit a Node stack trace', () => {
  const script = installer.match(/FOLDER_UNIT_LINES=\$\(node -e '\n([\s\S]*?)\n'\) \|\|/)[1];
  const missingPath = path.join(__dirname, 'definitely-not-a-tier-folder');
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TIER_FOLDERS: JSON.stringify([{ id: '4k', path: missingPath }]) },
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, new RegExp(`configured folder path does not exist: ${missingPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.stderr, /Linux paths are case-sensitive/);
  assert.doesNotMatch(result.stderr, /at Object\.statSync|node:fs:/);
});

test('tier installer: syntax-check staging file retains a JavaScript extension', () => {
  assert.match(installer, /AGENT_TMP="\$INSTALL_DIR\/agent\.new\.js"/);
  assert.match(installer, /node --check "\$AGENT_TMP"/);
  assert.doesNotMatch(installer, /AGENT_TMP=.*agent\.js\.new/);
});
