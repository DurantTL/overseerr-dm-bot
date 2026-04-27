#!/usr/bin/env node
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function resolveSafeMediaPath(root, requestedPath) {
  const normalizedRoot = fs.realpathSync(path.resolve(root));
  const realResolved = fs.realpathSync(path.resolve(requestedPath));
  if (!realResolved.startsWith(normalizedRoot + path.sep) && realResolved !== normalizedRoot) {
    throw new Error('Resolved file path escapes configured RAID_PATH');
  }
  return realResolved;
}

(function run() {
  const token = crypto.randomBytes(16).toString('hex');
  const hash = sha256(token);
  assert.notStrictEqual(hash, token, 'Token hash should not equal token');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-test-'));
  const raid = path.join(tmp, 'raid');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(raid, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  const inFile = path.join(raid, 'movie.mkv');
  fs.writeFileSync(inFile, 'ok');
  assert.strictEqual(resolveSafeMediaPath(raid, inFile), inFile, 'Valid in-root path should pass');

  const outsideFile = path.join(outside, 'escape.mkv');
  fs.writeFileSync(outsideFile, 'no');
  const link = path.join(raid, 'escape-link.mkv');
  fs.symlinkSync(outsideFile, link);

  let escaped = false;
  try {
    resolveSafeMediaPath(raid, link);
    escaped = true;
  } catch (_e) {}
  assert.strictEqual(escaped, false, 'Symlink escape should be blocked');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('security helper tests passed');
})();
