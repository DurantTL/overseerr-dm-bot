#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('edge-diagnostics: runEdgeDiagnostics against a fake rclone binary', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-doctor-'));
  const source = path.join(tmp, 'california');
  fs.mkdirSync(source);
  const fakeRclone = path.join(tmp, 'rclone');
  fs.writeFileSync(fakeRclone, `#!/usr/bin/env node
const cmd = process.argv[2];
if (cmd === 'version') console.log('rclone v-test');
else if (cmd === 'about') console.log(JSON.stringify({ free: 107374182400, total: 214748364800 }));
else if (cmd === 'lsjson') console.log(JSON.stringify([{ Path: 'Movies', IsDir: true }]));
else process.exitCode = 2;
`);
  fs.chmodSync(fakeRclone, 0o755);

  Object.assign(process.env, {
    STAGING_ENABLED: 'true',
    PH_SERVER_NAMES: 'philippines-edge',
    CA_EDGE_SERVER_NAMES: 'california-edge',
    PRIMARY_SERVER_NAMES: 'durant-main-1,durant-main-2,durant-main-3',
    STAGE_RCLONE_REMOTE: 'phbox:/cache',
    STAGE_RCLONE_BINARY: fakeRclone,
    TIER_SOURCE_ROOT: source,
    PH_TUNNEL_HEALTH_URL: '',
  });
  const { runEdgeDiagnostics } = require('../../src/edge-diagnostics');
  const checks = await runEdgeDiagnostics({ live: true });
  assert.strictEqual(checks.some(c => c.status === 'fail'), false, JSON.stringify(checks));
  assert.ok(checks.some(c => c.name === 'Main source' && c.status === 'ok'));
  assert.ok(checks.some(c => c.name === 'Philippines free space' && /100\.0 GB free/.test(c.detail)));
  assert.ok(checks.some(c => c.name === 'Philippines cache read' && c.status === 'ok'));
  fs.rmSync(tmp, { recursive: true, force: true });
});
