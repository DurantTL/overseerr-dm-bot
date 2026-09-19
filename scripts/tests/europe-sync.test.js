#!/usr/bin/env node
'use strict';

// Tests for the Europe node sync: script config parsing, output parsing, and the
// dashboard routes (auth gating, missing-script 503, preview/run via a fixture
// shell script that exercises the real spawn path).

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, listen, close } = require('../../src/app');
const { escapeHtml } = require('../../src/dashboard-render');
const { parseScriptConfig, parseScriptOutput } = require('../../src/europe-sync');
const { registerEuropeSyncRoutes } = require('../../src/routes/dashboard-europe');

const SAMPLE_SCRIPT = `#!/bin/bash
SOURCE="/mnt/raid/media/media/Movies"
DEST="/mnt/raid/media/media/latest-movies"
YEARS_BACK=2
CURRENT_YEAR=$(date +%Y)
MIN_YEAR=$((CURRENT_YEAR - YEARS_BACK))
DRY_RUN=true
`;

const SAMPLE_OUTPUT = `=== Qualifying movies (release year 2024-2026, must have a real video file) ===
WOULD REMOVE (aged out/unreleased): Old Movie (2019)
WOULD ADD: Dune Part Two (2024) (year: 2024)
WOULD ADD: The Wild Robot (2024) (year: 2024)
SKIPPED (no video file - likely placeholder): Avatar 4 (2029)
SKIPPED (no video file - likely placeholder): Shrek 5 (2027)
=== Done ===
`;

test('parseScriptConfig extracts source, dest, and the year window', () => {
  const config = parseScriptConfig(SAMPLE_SCRIPT);
  assert.strictEqual(config.source, '/mnt/raid/media/media/Movies');
  assert.strictEqual(config.dest, '/mnt/raid/media/media/latest-movies');
  assert.strictEqual(config.yearsBack, 2);
  assert.strictEqual(config.dryRunDefault, true);
  const thisYear = new Date().getFullYear();
  assert.strictEqual(config.yearMax, thisYear);
  assert.strictEqual(config.yearMin, thisYear - 2);
});

test('parseScriptConfig returns null for scripts missing the expected lines', () => {
  assert.strictEqual(parseScriptConfig('#!/bin/bash\necho hi\n'), null);
});

test('parseScriptOutput splits adds, removes, and skips', () => {
  const parsed = parseScriptOutput(SAMPLE_OUTPUT);
  assert.deepStrictEqual(parsed.adds.map(a => a.name), ['Dune Part Two (2024)', 'The Wild Robot (2024)']);
  assert.strictEqual(parsed.adds[0].year, '2024');
  assert.deepStrictEqual(parsed.removes.map(r => r.name), ['Old Movie (2019)']);
  assert.deepStrictEqual(parsed.skips.map(s => s.name), ['Avatar 4 (2029)', 'Shrek 5 (2027)']);
});

test('parseScriptOutput handles live-run verbs too', () => {
  const parsed = parseScriptOutput('ADDED: Dune Part Two (2024) (year: 2024)\nREMOVED (aged out/unreleased): Old Movie (2019)\n');
  assert.strictEqual(parsed.adds.length, 1);
  assert.strictEqual(parsed.removes.length, 1);
  assert.strictEqual(parsed.skips.length, 0);
});

// Fixture shell script: honors the rewritten DRY_RUN line and echoes canned output.
function writeFixtureScript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'europe-sync-test-'));
  const file = path.join(dir, 'sync-latest-movies.sh');
  fs.writeFileSync(file, `#!/bin/bash
SOURCE="/src"
DEST="/dst"
YEARS_BACK=2
DRY_RUN=true
if [ "$DRY_RUN" = true ]; then
  echo "WOULD ADD: Dune Part Two (2024) (year: 2024)"
  echo "WOULD REMOVE (aged out/unreleased): Old Movie (2019)"
  echo "SKIPPED (no video file - likely placeholder): Avatar 4 (2029)"
else
  echo "ADDED: Dune Part Two (2024) (year: 2024)"
  echo "REMOVED (aged out/unreleased): Old Movie (2019)"
fi
`, { mode: 0o755 });
  return { dir, file };
}

function routeFixture(scriptPath, audits) {
  const app = createApp();
  registerEuropeSyncRoutes(app, {
    audit: (action, details) => audits.push({ action, details }),
    dashboardAuth: (req, res, next) => (req.headers['x-admin-token'] === 'secret' ? next() : res.status(401).json({ ok: false, error: 'no' })),
    dashboardActor: () => ({ actor: 'test' }),
    db: { prepare: () => ({ get: () => null }) },
    rateLimit: require('express-rate-limit').rateLimit,
    escapeHtml,
    scriptPath,
  });
  return app;
}

function post(port, apiPath, headers = {}) {
  const data = '{}';
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: apiPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const AUTH = { 'x-admin-token': 'secret' };

test('europe-sync routes require dashboard auth', async () => {
  const audits = [];
  const app = routeFixture('/nonexistent/script.sh', audits);
  const server = await listen(app, 0);
  try {
    const res = await post(server.address().port, '/admin/action/europe-sync/preview');
    assert.strictEqual(res.statusCode, 401);
  } finally {
    await close(server);
  }
});

test('europe-sync preview/run return 503 when the script is missing', async () => {
  const audits = [];
  const app = routeFixture('/nonexistent/sync-latest-movies.sh', audits);
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const preview = await post(port, '/admin/action/europe-sync/preview', AUTH);
    assert.strictEqual(preview.statusCode, 503);
    assert.match(preview.json.error, /not found/);
    const run = await post(port, '/admin/action/europe-sync/run', AUTH);
    assert.strictEqual(run.statusCode, 503);
  } finally {
    await close(server);
  }
});

test('europe-sync preview runs the script dry and renders the parsed output', async () => {
  const { dir, file } = writeFixtureScript();
  const audits = [];
  const app = routeFixture(file, audits);
  const server = await listen(app, 0);
  try {
    const res = await post(server.address().port, '/admin/action/europe-sync/preview', AUTH);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.ok, true);
    assert.match(res.json.html, /Dry run/);
    assert.match(res.json.html, /Dune Part Two/);
    assert.match(res.json.html, /Old Movie/);
    assert.match(res.json.html, /Avatar 4/);
    // Preview must not audit a run.
    assert.strictEqual(audits.filter(a => a.action === 'dashboard_europe_sync_run').length, 0);
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('europe-sync run executes for real and audits the result', async () => {
  const { dir, file } = writeFixtureScript();
  const audits = [];
  const app = routeFixture(file, audits);
  const server = await listen(app, 0);
  try {
    const res = await post(server.address().port, '/admin/action/europe-sync/run', AUTH);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.ok, true);
    assert.match(res.json.html, /Sync complete/);
    assert.match(res.json.html, /Dune Part Two/);
    const runAudit = audits.find(a => a.action === 'dashboard_europe_sync_run');
    assert.ok(runAudit, 'run is audited');
    assert.strictEqual(runAudit.details.added, 1);
    assert.strictEqual(runAudit.details.removed, 1);
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('estimateSizes measures would-add folders and dest disk context', async () => {
  const { estimateSizes } = require('../../src/europe-sync');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'europe-estimate-test-'));
  try {
    const source = path.join(root, 'Movies');
    const dest = path.join(root, 'latest-movies');
    fs.mkdirSync(path.join(source, 'Dune Part Two (2024)'), { recursive: true });
    fs.mkdirSync(path.join(source, 'The Wild Robot (2024)'), { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(source, 'Dune Part Two (2024)', 'movie.mkv'), Buffer.alloc(1024 * 1024));
    fs.writeFileSync(path.join(source, 'The Wild Robot (2024)', 'movie.mkv'), Buffer.alloc(2 * 1024 * 1024));
    fs.writeFileSync(path.join(dest, 'old.mkv'), Buffer.alloc(512 * 1024));
    const estimate = await estimateSizes({
      source,
      dest,
      adds: [{ name: 'Dune Part Two (2024)' }, { name: 'The Wild Robot (2024)' }],
    });
    assert.strictEqual(estimate.totalFolders, 2);
    assert.strictEqual(estimate.measuredFolders, 2);
    assert.ok(estimate.estimatedNewBytes >= 3 * 1024 * 1024, `expected >= 3MB, got ${estimate.estimatedNewBytes}`);
    assert.ok(estimate.destBytes >= 512 * 1024, `expected dest >= 512KB, got ${estimate.destBytes}`);
    assert.ok(Number.isFinite(estimate.destFreeBytes) && estimate.destFreeBytes > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('estimateSizes rejects path traversal and degrades on missing dirs', async () => {
  const { estimateSizes } = require('../../src/europe-sync');
  const estimate = await estimateSizes({
    source: '/nonexistent-source-xyz',
    dest: '/nonexistent-dest-xyz',
    adds: [{ name: '../../etc' }, { name: 'Nope (2024)' }],
  });
  assert.strictEqual(estimate.estimatedNewBytes, null);
  assert.strictEqual(estimate.measuredFolders, 0);
  assert.strictEqual(estimate.totalFolders, 2);
  assert.strictEqual(estimate.destBytes, null);
  assert.strictEqual(estimate.destFreeBytes, null);
});

test('estimateSizes returns nulls without source/dest', async () => {
  const { estimateSizes } = require('../../src/europe-sync');
  const estimate = await estimateSizes({ adds: [{ name: 'X (2024)' }] });
  assert.strictEqual(estimate.estimatedNewBytes, null);
  assert.strictEqual(estimate.totalFolders, 1);
});
