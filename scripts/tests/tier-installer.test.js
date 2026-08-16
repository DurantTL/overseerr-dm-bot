#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

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
