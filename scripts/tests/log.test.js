#!/usr/bin/env node
// src/log.js reads LOG_LEVEL/LOG_FORMAT once at require-time (via src/config.js's CONFIG
// singleton), so each combination is exercised in its own child process.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', '..', 'src', 'log.js');

function run(env, script) {
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return result;
}

const callAll = `
  const { log } = require(${JSON.stringify(LOG_PATH)});
  log.debug('d');
  log.info('i');
  log.ok('o');
  log.warn('w');
  log.error('e');
`;

// Default (LOG_LEVEL unset -> info): debug is suppressed, everything else passes through,
// human-readable format.
{
  const { stdout, stderr } = run({ LOG_LEVEL: '', LOG_FORMAT: '' }, callAll);
  assert.strictEqual(stdout.includes('[DEBUG] d'), false, 'debug suppressed at default info level');
  assert.strictEqual(stdout.includes('[INFO] i'), true);
  assert.strictEqual(stdout.includes('[OK] o'), true);
  assert.strictEqual(stderr.includes('[WARN] w'), true, 'console.warn goes to stderr');
  assert.strictEqual(stderr.includes('[ERROR] e'), true, 'console.error goes to stderr');
}

// LOG_LEVEL=debug: everything passes, including debug.
{
  const { stdout } = run({ LOG_LEVEL: 'debug', LOG_FORMAT: 'text' }, callAll);
  assert.strictEqual(stdout.includes('[DEBUG] d'), true, 'debug level lets debug through');
}

// LOG_LEVEL=error: only error survives (warn is suppressed).
{
  const { stdout, stderr } = run({ LOG_LEVEL: 'error', LOG_FORMAT: 'text' }, callAll);
  assert.strictEqual(stdout.includes('[INFO] i'), false, 'info suppressed at error level');
  assert.strictEqual(stderr.includes('[WARN] w'), false, 'warn suppressed at error level');
  assert.strictEqual(stderr.includes('[ERROR] e'), true, 'error still gets through');
}

// LOG_FORMAT=json: each surviving line is a single JSON object with ts/level/msg.
{
  const { stdout } = run({ LOG_LEVEL: 'info', LOG_FORMAT: 'json' }, callAll);
  const lines = stdout.trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2, 'info + ok, debug suppressed');
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.strictEqual(typeof parsed.ts, 'string');
    assert.strictEqual(parsed.level, 'info');
    assert.ok(['i', 'o'].includes(parsed.msg));
  }
}

console.log('log.test.js: all tests passed');
