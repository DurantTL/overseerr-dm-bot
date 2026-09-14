#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// edge-diagnostics.js reads tier node / plan state (§181 merged-mount surfacing) straight from
// src/db.js, so every test needs its own scratch database.
// DB_PATH must be set before src/db.js is first required (it opens the database at require
// time). src/config.js is ALSO reloaded fresh here (and read by db.js at require time), so any
// other env var a test needs (STAGING_ENABLED, EDGE_MOUNT_DIAG_STALE_HOURS, ...) must be set
// BEFORE calling withScratchDb, not inside its callback.
function withScratchDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-doctor-db-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/db')];
  delete require.cache[require.resolve('../../src/edge-diagnostics')];
  try {
    const db = require('../../src/db');
    db.runMigrations();
    return fn(db);
  } finally {
    delete process.env.DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

  // Must be set before withScratchDb (below) triggers the first fresh require of src/config.js.
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
  await withScratchDb(async () => {
    const { runEdgeDiagnostics } = require('../../src/edge-diagnostics');
    const checks = await runEdgeDiagnostics({ live: true });
    assert.strictEqual(checks.some(c => c.status === 'fail'), false, JSON.stringify(checks));
    assert.ok(checks.some(c => c.name === 'Main source' && c.status === 'ok'));
    assert.ok(checks.some(c => c.name === 'Philippines free space' && /100\.0 GB free/.test(c.detail)));
    assert.ok(checks.some(c => c.name === 'Philippines cache read' && c.status === 'ok'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('edge-diagnostics: §181 surfaces a node\'s last-reported merged-mount diagnostic', async () => {
  await withScratchDb(async db => {
    db.upsertTierNode({ name: 'california', enabled: 1 });
    db.recordTierMergedMountDiagnostics('california', {
      configured: true,
      ok: false,
      checks: [
        { name: 'Merged library mount', status: 'ok', detail: '/mnt/plex-library is present' },
        { name: 'Remote branch read-only', status: 'fail', detail: "mount options do not include 'ro' (rw,relatime)" },
      ],
    });

    const { runEdgeDiagnostics } = require('../../src/edge-diagnostics');
    const checks = await runEdgeDiagnostics({ live: false });
    assert.ok(checks.some(c => c.name === 'Merged mount (california) — Merged library mount' && c.status === 'ok'));
    assert.ok(checks.some(c => c.name === 'Merged mount (california) — Remote branch read-only' && c.status === 'fail'));
  });
});

test('edge-diagnostics: §181 an unconfigured node contributes no merged-mount checks', async () => {
  await withScratchDb(async db => {
    db.upsertTierNode({ name: 'philippines-server', enabled: 1 });
    const { runEdgeDiagnostics } = require('../../src/edge-diagnostics');
    const checks = await runEdgeDiagnostics({ live: false });
    assert.strictEqual(checks.some(c => c.name.startsWith('Merged mount (')), false, 'no EDGE_MERGED_ROOT configured → no checks, not a failure');
  });
});

test('edge-diagnostics: §181 a stale merged-mount report is a warning, not a stale pass', async () => {
  process.env.EDGE_MOUNT_DIAG_STALE_HOURS = '1'; // read by src/config.js at require time — must be set first
  await withScratchDb(async db => {
    db.upsertTierNode({ name: 'california', enabled: 1 });
    db.recordTierMergedMountDiagnostics('california', { configured: true, ok: true, checks: [{ name: 'Merged library mount', status: 'ok', detail: 'ok' }] });
    // Back-date the report past the (test-shortened) staleness window.
    const rec = db.getTierPlan('california');
    rec.lastMergedMountDiagnosticsAt = Date.now() - 2 * 3600000;
    db.setSetting('tier_plan:california', JSON.stringify(rec));

    const { runEdgeDiagnostics } = require('../../src/edge-diagnostics');
    const checks = await runEdgeDiagnostics({ live: false });
    delete process.env.EDGE_MOUNT_DIAG_STALE_HOURS;
    const staleCheck = checks.find(c => c.name === 'Merged mount (california)');
    assert.ok(staleCheck, 'a stale report is surfaced as its own check');
    assert.strictEqual(staleCheck.status, 'warn');
    assert.strictEqual(checks.some(c => c.name.includes(' — ')), false, 'per-sub-check results are not shown once the report is stale');
  });
});
