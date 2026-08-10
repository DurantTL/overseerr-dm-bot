#!/usr/bin/env node
// writeStignore (agent/agent.js) must write .stignore atomically: a temp file in the same
// directory, fsynced, then renamed into place — never a truncate-in-place that a crash or a
// concurrent Syncthing rescan could observe half-written. Directly exercises the helper (no
// need to boot the full runOnce cycle for this).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeStignore } = require('../../agent/agent');

test('tier-agent: writeStignore writes atomically and leaves no temp-file residue', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-agent-atomic-'));
  const ctx = { dryRun: false, log: () => {} };
  const fp = { folderRoot: tmp, drop: [{ relPath: 'Old Movie (2001)' }], stignore: '/Old Movie (2001)\n' };

  writeStignore(ctx, fp);
  const target = path.join(tmp, '.stignore');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), fp.stignore, 'the file lands with the exact expected content');
  assert.deepStrictEqual(fs.readdirSync(tmp).filter(f => f !== '.stignore'), [], 'no leftover temp file after a successful write');

  // A second write (overwriting an existing .stignore) must also go through the same
  // temp-then-rename path and leave no residue — this is the common case (every converge run).
  const fp2 = { folderRoot: tmp, drop: [{ relPath: 'Old Movie (2001)' }, { relPath: 'Another (1999)' }], stignore: '/Old Movie (2001)\n/Another (1999)\n' };
  writeStignore(ctx, fp2);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), fp2.stignore, 'overwrite replaces the content atomically');
  assert.deepStrictEqual(fs.readdirSync(tmp).filter(f => f !== '.stignore'), [], 'no leftover temp file after an overwrite either');

  // dry-run never touches disk.
  const dryCtx = { dryRun: true, log: () => {} };
  fs.rmSync(target);
  writeStignore(dryCtx, fp2);
  assert.ok(!fs.existsSync(target), 'dry-run writes nothing');

  // A write that can't complete (unwritable target directory) must not leave a stray temp file
  // behind for someone to find later. Skipped as root, which bypasses directory permission bits
  // entirely — this box's sandbox runs as root, but the real target (a systemd-managed agent
  // user) does not.
  if (process.getuid && process.getuid() !== 0) {
    const roDir = path.join(tmp, 'ro');
    fs.mkdirSync(roDir);
    fs.chmodSync(roDir, 0o500); // r-x — can list/read, cannot create files
    try {
      let threw = false;
      try { writeStignore(ctx, { ...fp2, folderRoot: roDir }); } catch (_e) { threw = true; }
      assert.ok(threw, 'a failed write propagates the error rather than silently succeeding');
      assert.deepStrictEqual(fs.readdirSync(roDir), [], 'no half-written temp file left behind on failure');
    } finally {
      fs.chmodSync(roDir, 0o700); // restore so rmSync below can clean up
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});
