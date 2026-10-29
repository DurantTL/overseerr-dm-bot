#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { redactRcloneDetail, redactEdgeChecksForHttp } = require('../../src/diagnostic-redaction');

test('rclone stderr: first non-empty line only, URLs and user@host redacted', () => {
  assert.strictEqual(redactRcloneDetail('2026/10/29 ERROR : sftp://caleb@10.0.0.5:22/mnt failed\nline two'), '2026/10/29 ERROR : <url> failed');
  assert.strictEqual(redactRcloneDetail('ssh: handshake failed: caleb@phbox.example.net'), 'ssh: handshake failed: <user@host>');
  assert.strictEqual(redactRcloneDetail('\n\n  first real line  \nsecond'), 'first real line');
  assert.strictEqual(redactRcloneDetail('rclone v1.68.1'), 'rclone v1.68.1', 'a version line is left alone');
  assert.strictEqual(redactRcloneDetail(''), '');
  assert.strictEqual(redactRcloneDetail(undefined), '');
});

test('only the rclone-sourced checks are rewritten', () => {
  const checks = [
    { name: 'rclone binary', status: 'fail', detail: 'exec failed\nstack' },
    { name: 'Philippines free space', status: 'warn', detail: 'see https://ph.example.net/status' },
    { name: 'Merged mount (cali) — remote', status: 'ok', detail: 'kept\nas is' },
  ];
  assert.deepStrictEqual(redactEdgeChecksForHttp(checks), [
    { name: 'rclone binary', status: 'fail', detail: 'exec failed' },
    { name: 'Philippines free space', status: 'warn', detail: 'see <url>' },
    { name: 'Merged mount (cali) — remote', status: 'ok', detail: 'kept\nas is' },
  ]);
  assert.strictEqual(checks[0].detail, 'exec failed\nstack', 'input not mutated');
});
