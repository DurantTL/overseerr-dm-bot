#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
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
    PRIMARY_SERVER_NAMES: 'california-primary',
    STAGE_RCLONE_REMOTE: 'phbox:/cache',
    STAGE_RCLONE_BINARY: fakeRclone,
    TIER_SOURCE_ROOT: source,
    PH_TUNNEL_HEALTH_URL: '',
  });
  const { runEdgeDiagnostics } = require('../../src/edge-diagnostics');
  const checks = await runEdgeDiagnostics({ live: true });
  assert.strictEqual(checks.some(c => c.status === 'fail'), false, JSON.stringify(checks));
  assert.ok(checks.some(c => c.name === 'California source' && c.status === 'ok'));
  assert.ok(checks.some(c => c.name === 'Philippines free space' && /100\.0 GB free/.test(c.detail)));
  assert.ok(checks.some(c => c.name === 'Philippines cache read' && c.status === 'ok'));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('edge-diagnostics.test.js: all tests passed');
})().catch(err => { console.error(err); process.exit(1); });
