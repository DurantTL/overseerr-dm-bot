#!/usr/bin/env node
// Runs the durant-server restart logger's Python tests (deploy/durant-server-restart-logger) as
// part of `npm test`, so CI covers the host script too.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

test('durant-server restart logger: python unit tests pass', () => {
  const dir = path.join(__dirname, '..', '..', 'deploy', 'durant-server-restart-logger');
  const res = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', dir, '-p', 'test_*.py'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.ifError(res.error);
  assert.strictEqual(res.status, 0, `python tests failed:\n${(res.stderr || '').slice(-4000)}`);
  assert.match(res.stderr, /\nOK/);
});
