#!/usr/bin/env node
// Monitor-only tier-agent mode (backup boxes) and SMART drive-health collection:
// the agent reports telemetry + disk + SMART and never touches the tier plan.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildCtx, runOnce, parentDiskDevice, parseSmartHealthOutput, collectSmartHealth } = require('../../agent/agent');

function listen(app) {
  return new Promise(resolve => { const server = app.listen(0, () => resolve(server)); });
}

test('parentDiskDevice strips partition suffixes down to the whole disk', () => {
  assert.strictEqual(parentDiskDevice('/dev/nvme0n1p1'), '/dev/nvme0n1');
  assert.strictEqual(parentDiskDevice('/dev/mmcblk0p2'), '/dev/mmcblk0');
  assert.strictEqual(parentDiskDevice('/dev/sda1'), '/dev/sda');
  assert.strictEqual(parentDiskDevice('/dev/vda12'), '/dev/vda');
  assert.strictEqual(parentDiskDevice('/dev/sda'), '/dev/sda');
  assert.strictEqual(parentDiskDevice(''), null);
});

test('parseSmartHealthOutput reads JSON and falls back to text', () => {
  assert.strictEqual(parseSmartHealthOutput(JSON.stringify({ smart_status: { passed: true } })), 'ok');
  assert.strictEqual(parseSmartHealthOutput(JSON.stringify({ smart_status: { passed: false } })), 'failing');
  assert.strictEqual(parseSmartHealthOutput('SMART overall-health self-assessment test result: PASSED'), 'ok');
  assert.strictEqual(parseSmartHealthOutput('SMART overall-health self-assessment test result: FAILED'), 'failing');
  assert.strictEqual(parseSmartHealthOutput('garbage with no verdict'), null);
  assert.strictEqual(parseSmartHealthOutput(''), null);
});

test('collectSmartHealth returns null when smartctl is missing — never throws', () => {
  const missing = () => { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err; };
  const ctx = { smartDevices: '/dev/sda' };
  assert.strictEqual(collectSmartHealth(ctx, '/mnt/media', { execImpl: missing }), null);
});

test('collectSmartHealth dedupes, caps at 8, and reports per-device health', () => {
  const calls = [];
  const execImpl = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'smartctl') {
      const device = args[args.length - 1];
      return JSON.stringify({ smart_status: { passed: device !== '/dev/sdb' } });
    }
    throw new Error('unexpected');
  };
  const ctx = { smartDevices: '/dev/sda, /dev/sdb /dev/sda' };
  const out = collectSmartHealth(ctx, '/mnt/media', { execImpl });
  assert.deepStrictEqual(out, [
    { device: '/dev/sda', health: 'ok' },
    { device: '/dev/sdb', health: 'failing' },
  ]);
  assert.strictEqual(calls.filter(c => c.startsWith('smartctl')).length, 2, 'deduped');
});

test('monitor-only runOnce reports telemetry with monitorOnly and never fetches a manifest', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-agent-monitor-only-'));
  const folderRoot = path.join(tmp, 'backup');
  fs.mkdirSync(folderRoot);
  let report; let manifestHit = false;
  const bot = express();
  bot.use(express.json());
  bot.get('/agent/manifest/:node', (_req, res) => { manifestHit = true; res.status(404).json({ error: 'No manifest published' }); });
  bot.post('/agent/report/:node', (req, res) => { report = req.body; res.json({ ok: true }); });
  const server = await listen(bot);
  try {
    const ctx = buildCtx({
      TIER_BOT_URL: `http://127.0.0.1:${server.address().port}`,
      TIER_NODE: 'central-iowa-backup',
      TIER_AGENT_TOKEN: 'test-token',
      TIER_FOLDER_ROOT: folderRoot,
      TIER_MONITOR_ONLY: '1',
      TIER_STATE_DIR: path.join(tmp, 'state'),
    });
    assert.strictEqual(ctx.monitorOnly, true);
    const logs = [];
    ctx.log = message => logs.push(message);
    const result = await runOnce(ctx);
    assert.deepStrictEqual(result, { skipped: true, heartbeat: true, monitorOnly: true });
    assert.strictEqual(manifestHit, false, 'no manifest fetch in monitor-only mode');
    assert.strictEqual(report.heartbeat, true);
    assert.strictEqual(report.monitorOnly, true);
    assert.ok(report.telemetry, 'telemetry is reported');
    assert.ok(logs.some(l => l.includes('monitor-only')), 'mode is logged');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('monitor-only mode is off without the env var', () => {
  const ctx = buildCtx({
    TIER_BOT_URL: 'http://127.0.0.1:1',
    TIER_NODE: 'edge',
    TIER_AGENT_TOKEN: 'test-token',
    TIER_FOLDER_ROOT: '/mnt/media',
    SYNCTHING_FOLDER_ID: 'media',
  });
  assert.strictEqual(ctx.monitorOnly, false);
});
