#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
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

test('tier installer: provisions and then verifies the Node.js 24 contract', () => {
  assert.match(installer, /NODE_MAJOR=\$\(node_major\)/);
  assert.match(installer, /if \[ "\$NODE_MAJOR" -lt 24 \]; then\s+install_node/);
  assert.match(installer, /https:\/\/deb\.nodesource\.com\/setup_24\.x/);
  assert.match(installer, /https:\/\/rpm\.nodesource\.com\/setup_24\.x/);
  assert.match(installer, /apt-get install -y nodejs/);
  assert.match(installer, /dnf install -y nodejs/);
  assert.match(installer, /yum install -y nodejs/);
  assert.match(installer, /Node\.js 24 is required but node \$NODE_MAJOR was found/);
  assert.doesNotMatch(installer, /node not found —/);
});

test('tier installer: missing folder errors are actionable and omit a Node stack trace', () => {
  const scripts = [...installer.matchAll(/FOLDER_UNIT_LINES=\$\(node -e '\n([\s\S]*?)\n'\) \|\|/g)].map(m => m[1]);
  const script = scripts.find(s => s.includes('configured folder path does not exist'));
  assert.ok(script, 'full-folder validation script found');
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

test('tier installer: monitor-only mode requires just a token and a watched path', () => {
  assert.match(installer, /if \[ "\$\{TIER_MONITOR_ONLY:-0\}" = "1" \]; then/);
  assert.match(installer, /TIER_FOLDER_ROOT \(path to watch/);
  assert.match(installer, /printf 'TIER_MONITOR_ONLY=1\\n' >> "\$ENV_FILE\.new"/);
  assert.match(installer, /printf 'TIER_SMART_DEVICES=%s\\n' "\$TIER_SMART_DEVICES" >> "\$ENV_FILE\.new"/);
});

test('tier installer: required-var validation branches on TIER_MONITOR_ONLY', () => {
  const start = installer.indexOf("missing=''");
  assert.ok(start >= 0, 'validation block found');
  const end = installer.indexOf('\nfi\n', start);
  const block = `${installer.slice(start, end + '\nfi'.length)}\n[ -z "$missing" ] || echo "MISSING:$missing"\necho OK\n`;
  const run = env => spawnSync('sh', ['-c', block], { encoding: 'utf8', env: { ...process.env, ...env } });
  const monitorOnly = run({ TIER_MONITOR_ONLY: '1', TIER_AGENT_TOKEN: 'x', TIER_FOLDER_ROOT: '/tmp' });
  assert.strictEqual(monitorOnly.status, 0);
  assert.match(monitorOnly.stdout, /OK/);
  assert.doesNotMatch(monitorOnly.stdout, /MISSING/);
  const monitorMissing = run({ TIER_MONITOR_ONLY: '1' });
  assert.match(monitorMissing.stdout, /MISSING:.*TIER_AGENT_TOKEN/);
  assert.match(monitorMissing.stdout, /MISSING:.*TIER_FOLDER_ROOT/);
  assert.doesNotMatch(monitorMissing.stdout, /SYNCTHING_API_KEY/);
  const fullMissing = run({ TIER_AGENT_TOKEN: 'x' });
  assert.match(fullMissing.stdout, /MISSING:.*SYNCTHING_API_KEY/);
});

test('tier installer: monitor-only install reports the first heartbeat result', () => {
  assert.match(installer, /Installed \(monitor-only\)\. First heartbeat reported successfully/);
});

test('tier installer: monitor-only watched-path validation rejects a missing directory', () => {
  const scripts = [...installer.matchAll(/FOLDER_UNIT_LINES=\$\(node -e '\n([\s\S]*?)\n'\) \|\|/g)].map(m => m[1]);
  const monitorScript = scripts.find(s => s.includes('TIER_FOLDER_ROOT'));
  assert.ok(monitorScript, 'monitor-only folder validation script found');
  const good = spawnSync(process.execPath, ['-e', monitorScript], {
    encoding: 'utf8', env: { ...process.env, TIER_FOLDER_ROOT: os.tmpdir() },
  });
  assert.strictEqual(good.status, 0);
  assert.match(good.stdout, /ReadOnlyPaths=/);
  assert.doesNotMatch(good.stdout, /ReadWritePaths=/);
  const bad = spawnSync(process.execPath, ['-e', monitorScript], {
    encoding: 'utf8', env: { ...process.env, TIER_FOLDER_ROOT: '/definitely-not-a-watched-path' },
  });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /watched path problem/);
});
