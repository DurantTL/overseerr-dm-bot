#!/usr/bin/env node
// Security guards, tested against the SHIPPED code.
//
// resolveSafeMediaPath is the only thing standing between a download token and the rest of the
// filesystem, so this file used to be actively misleading: it defined its own copy of the
// function and tested that, which would stay green even if the real guard in index.js regressed.
// It now pulls the real function out of index.js with the same vm sandbox the rest of the suite
// uses, so a regression there fails here.
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadSandbox } = require('./tests/extract');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

(function run() {
  const token = crypto.randomBytes(16).toString('hex');
  assert.notStrictEqual(sha256(token), token, 'Token hash should not equal token');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-test-'));
  const raid = path.join(tmp, 'raid');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(raid, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  // The real function reads CONFIG.RAID_PATH, so the sandbox supplies one pointing at our fixture.
  const { resolveSafeMediaPath } = loadSandbox(['resolveSafeMediaPath'], {
    fs, path, CONFIG: { RAID_PATH: raid },
  });

  const inFile = path.join(raid, 'movie.mkv');
  fs.writeFileSync(inFile, 'ok');
  assert.strictEqual(resolveSafeMediaPath(inFile), fs.realpathSync(inFile), 'Valid in-root path should pass');

  const nested = path.join(raid, 'shows', 'season 1');
  fs.mkdirSync(nested, { recursive: true });
  const nestedFile = path.join(nested, 'ep.mkv');
  fs.writeFileSync(nestedFile, 'ok');
  assert.strictEqual(resolveSafeMediaPath(nestedFile), fs.realpathSync(nestedFile), 'Nested in-root path should pass');

  const blocked = (requestedPath, why) => {
    let escaped = false;
    try { resolveSafeMediaPath(requestedPath); escaped = true; } catch (_e) { /* expected */ }
    assert.strictEqual(escaped, false, why);
  };

  // Symlink escape: the file resolves inside the root but points outside it.
  const outsideFile = path.join(outside, 'escape.mkv');
  fs.writeFileSync(outsideFile, 'no');
  fs.symlinkSync(outsideFile, path.join(raid, 'escape-link.mkv'));
  blocked(path.join(raid, 'escape-link.mkv'), 'Symlink escape should be blocked');

  // Traversal out of the root, both as a suffix and as an absolute path.
  blocked(path.join(raid, '..', 'outside', 'escape.mkv'), 'Directory traversal should be blocked');
  blocked(outsideFile, 'An absolute path outside the root should be blocked');

  // A sibling directory that merely shares the root's name prefix must not pass the
  // startsWith check (/mnt/raid-backup vs /mnt/raid).
  const lookalike = `${raid}-backup`;
  fs.mkdirSync(lookalike, { recursive: true });
  const lookalikeFile = path.join(lookalike, 'movie.mkv');
  fs.writeFileSync(lookalikeFile, 'no');
  blocked(lookalikeFile, 'A path sharing the root name as a prefix should be blocked');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('security helper tests passed');
})();
