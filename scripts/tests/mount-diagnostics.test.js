#!/usr/bin/env node
// #181 read-only merged-mount diagnostic (checkMergedMount / readMountOptions, agent/agent.js).
// Every case here is fixture-only — real files/dirs and a fake /proc/mounts, never a real
// mergerfs/rclone mount — matching the issue's "no mount mutation" requirement. Cross-device
// local-first precedence (a title actually served from a DIFFERENT physical device) can't be
// faked without root/a real second filesystem, so that path is covered by the manual
// device-number check in docs/mergerfs-plex-operational.md §2.2 instead; what IS covered here is
// every case reachable with ordinary stat calls: presence, read-only mount options, and a sample
// path missing through the merged view (which is the failure mode an incomplete/broken merge
// actually produces).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildCtx, checkMergedMount, readMountOptions } = require('../../agent/agent');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'edge-mount-'));
}

function baseEnv(tmp, extra = {}) {
  return {
    TIER_BOT_URL: 'http://x', TIER_NODE: 'california', TIER_AGENT_TOKEN: 't',
    TIER_FOLDER_ROOT: path.join(tmp, 'local'), SYNCTHING_FOLDER_ID: 'media',
    ...extra,
  };
}

test('mount-diagnostics: buildCtx requires EDGE_REMOTE_ROOT alongside EDGE_MERGED_ROOT', () => {
  const tmp = mkTmp();
  assert.throws(() => buildCtx(baseEnv(tmp, { EDGE_MERGED_ROOT: path.join(tmp, 'merged') })), /requires EDGE_REMOTE_ROOT/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('mount-diagnostics: unconfigured (no EDGE_MERGED_ROOT) is a silent no-op', () => {
  const tmp = mkTmp();
  const ctx = buildCtx(baseEnv(tmp));
  const result = checkMergedMount(ctx);
  assert.deepStrictEqual(result, { configured: false, ok: true, checks: [] });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('mount-diagnostics: merged root missing is a hard fail with no further checks', () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, 'local'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'remote'), { recursive: true });
  const ctx = buildCtx(baseEnv(tmp, { EDGE_MERGED_ROOT: path.join(tmp, 'merged'), EDGE_REMOTE_ROOT: path.join(tmp, 'remote') }));
  const result = checkMergedMount(ctx);
  assert.strictEqual(result.configured, true);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.checks.length, 1);
  assert.strictEqual(result.checks[0].name, 'Merged library mount');
  assert.strictEqual(result.checks[0].status, 'fail');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('mount-diagnostics: remote branch missing fails, without touching or creating anything', () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, 'local'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'merged'), { recursive: true });
  const ctx = buildCtx(baseEnv(tmp, { EDGE_MERGED_ROOT: path.join(tmp, 'merged'), EDGE_REMOTE_ROOT: path.join(tmp, 'remote-never-mounted') }));
  const result = checkMergedMount(ctx);
  assert.strictEqual(result.ok, false);
  const remoteCheck = result.checks.find(c => c.name === 'Remote fallback branch');
  assert.strictEqual(remoteCheck.status, 'fail');
  assert.match(remoteCheck.detail, /ENOENT|not reachable/);
  assert.strictEqual(fs.existsSync(path.join(tmp, 'remote-never-mounted')), false, 'the diagnostic never creates the mount it is checking for');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('mount-diagnostics: readMountOptions picks the longest (most specific) matching mount point', () => {
  const tmp = mkTmp();
  const procMounts = path.join(tmp, 'proc-mounts');
  fs.writeFileSync(procMounts,
    '/dev/sda1 / ext4 rw,relatime 0 0\n'
    + `rclone: ${path.join(tmp, 'remote')} fuse.rclone ro,nodev,relatime,user_id=0,group_id=0 0 0\n`
    + `mergerfs ${path.join(tmp, 'merged')} fuse.mergerfs rw,nosuid,nodev,noatime 0 0\n`);
  fs.mkdirSync(path.join(tmp, 'remote'), { recursive: true });
  assert.strictEqual(readMountOptions(path.join(tmp, 'remote'), { procMountsPath: procMounts }), 'ro,nodev,relatime,user_id=0,group_id=0');
  assert.strictEqual(readMountOptions(path.join(tmp, 'remote', 'nested', 'file.mkv'), { procMountsPath: procMounts }), 'ro,nodev,relatime,user_id=0,group_id=0');
  assert.strictEqual(readMountOptions(path.join(tmp, 'merged'), { procMountsPath: procMounts }), 'rw,nosuid,nodev,noatime');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('mount-diagnostics: readMountOptions returns null when /proc/mounts is unreadable (unknown, not a failure)', () => {
  assert.strictEqual(readMountOptions('/anything', { procMountsPath: '/does/not/exist/proc-mounts' }), null);
});

test('mount-diagnostics: a writable remote branch fails the read-only check', () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, 'local'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'merged'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'remote'), { recursive: true });
  const procMounts = path.join(tmp, 'proc-mounts');
  fs.writeFileSync(procMounts, `sshfs ${path.join(tmp, 'remote')} fuse.sshfs rw,nosuid,nodev,relatime 0 0\n`);
  const ctx = buildCtx(baseEnv(tmp, { EDGE_MERGED_ROOT: path.join(tmp, 'merged'), EDGE_REMOTE_ROOT: path.join(tmp, 'remote') }));
  const result = checkMergedMount(ctx, { fsImpl: { ...fs, readFileSync: (p, enc) => fs.readFileSync(p === '/proc/mounts' ? procMounts : p, enc), statSync: fs.statSync.bind(fs) } });
  assert.strictEqual(result.ok, false);
  const roCheck = result.checks.find(c => c.name === 'Remote branch read-only');
  assert.strictEqual(roCheck.status, 'fail');
  assert.match(roCheck.detail, /do not include 'ro'/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('mount-diagnostics: read-only remote + no sample paths configured is healthy but warns on precedence', () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, 'local'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'merged'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'remote'), { recursive: true });
  const procMounts = path.join(tmp, 'proc-mounts');
  fs.writeFileSync(procMounts, `rclone: ${path.join(tmp, 'remote')} fuse.rclone ro,relatime 0 0\n`);
  const ctx = buildCtx(baseEnv(tmp, { EDGE_MERGED_ROOT: path.join(tmp, 'merged'), EDGE_REMOTE_ROOT: path.join(tmp, 'remote') }));
  const result = checkMergedMount(ctx, { fsImpl: { ...fs, readFileSync: (p, enc) => fs.readFileSync(p === '/proc/mounts' ? procMounts : p, enc) } });
  assert.strictEqual(result.ok, true, JSON.stringify(result.checks));
  assert.strictEqual(result.checks.find(c => c.name === 'Remote branch read-only').status, 'ok');
  assert.strictEqual(result.checks.find(c => c.name === 'Local-first precedence').status, 'warn');
});

test('mount-diagnostics: a sample path missing through the merged view fails precedence', () => {
  const tmp = mkTmp();
  const localRoot = path.join(tmp, 'local');
  const mergedRoot = path.join(tmp, 'merged');
  const remoteRoot = path.join(tmp, 'remote');
  fs.mkdirSync(localRoot, { recursive: true });
  fs.mkdirSync(mergedRoot, { recursive: true });
  fs.mkdirSync(remoteRoot, { recursive: true });
  // A title cached on the local branch, but the merged FUSE view hasn't picked it up (or is
  // broken) — the merged path for it is simply absent, which is the failure the path-layout
  // mismatch in docs/edge-playback-architecture.md §2.2 produces.
  fs.mkdirSync(path.join(localRoot, 'Movies', 'Cached Movie (2020)'), { recursive: true });
  fs.writeFileSync(path.join(localRoot, 'Movies', 'Cached Movie (2020)', 'movie.mkv'), 'x');
  const procMounts = path.join(tmp, 'proc-mounts');
  fs.writeFileSync(procMounts, `rclone: ${remoteRoot} fuse.rclone ro,relatime 0 0\n`);
  const ctx = buildCtx(baseEnv(tmp, {
    EDGE_MERGED_ROOT: mergedRoot,
    EDGE_REMOTE_ROOT: remoteRoot,
    EDGE_MOUNT_SAMPLE_RELPATHS: 'Movies/Cached Movie (2020)/movie.mkv',
  }));
  const result = checkMergedMount(ctx, { fsImpl: { ...fs, readFileSync: (p, enc) => fs.readFileSync(p === '/proc/mounts' ? procMounts : p, enc) } });
  assert.strictEqual(result.ok, false, JSON.stringify(result.checks));
  const precedence = result.checks.find(c => c.name === 'Local-first precedence');
  assert.strictEqual(precedence.status, 'fail');
  assert.match(precedence.detail, /missing through the merged view/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('mount-diagnostics: a sample path resolved through both branches passes precedence (same device in this fixture)', () => {
  const tmp = mkTmp();
  const localRoot = path.join(tmp, 'local');
  const mergedRoot = path.join(tmp, 'merged');
  const remoteRoot = path.join(tmp, 'remote');
  const rel = path.join('Movies', 'Cached Movie (2020)', 'movie.mkv');
  for (const root of [localRoot, mergedRoot]) {
    fs.mkdirSync(path.join(root, 'Movies', 'Cached Movie (2020)'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Movies', 'Cached Movie (2020)', 'movie.mkv'), 'x');
  }
  fs.mkdirSync(remoteRoot, { recursive: true });
  const procMounts = path.join(tmp, 'proc-mounts');
  fs.writeFileSync(procMounts, `rclone: ${remoteRoot} fuse.rclone ro,relatime 0 0\n`);
  const ctx = buildCtx(baseEnv(tmp, { EDGE_MERGED_ROOT: mergedRoot, EDGE_REMOTE_ROOT: remoteRoot, EDGE_MOUNT_SAMPLE_RELPATHS: rel }));
  const result = checkMergedMount(ctx, { fsImpl: { ...fs, readFileSync: (p, enc) => fs.readFileSync(p === '/proc/mounts' ? procMounts : p, enc) } });
  assert.strictEqual(result.ok, true, JSON.stringify(result.checks));
  assert.strictEqual(result.checks.find(c => c.name === 'Local-first precedence').status, 'ok');
  fs.rmSync(tmp, { recursive: true, force: true });
});
