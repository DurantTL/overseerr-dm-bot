#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sha256 } = require('../../src/util');

// src/db.js honors DB_PATH from the environment. Point it at a scratch file per test so the
// scenarios below don't see each other's state.
const DB_MODULE = require.resolve('../../src/db');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-agent-tokens-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  delete require.cache[DB_MODULE];
  return { ...require('../../src/db'), dir };
}

function cleanup({ db, dir }) {
  db.close();
  delete process.env.DB_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('migration v4 creates the agent_api_tokens table', () => {
  const handle = freshDb();
  try {
    handle.runMigrations();
    const tables = handle.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
    assert.ok(tables.includes('agent_api_tokens'));
    assert.ok(handle.schemaVersion() >= 4);
  } finally { cleanup(handle); }
});

test('createAgentApiToken returns the raw token once and stores only its hash', () => {
  const handle = freshDb();
  try {
    handle.runMigrations();
    const created = handle.createAgentApiToken('Edith');
    assert.strictEqual(created.label, 'Edith');
    assert.ok(Number.isInteger(created.id));
    assert.strictEqual(typeof created.token, 'string');
    assert.ok(created.token.length >= 32, 'raw token has real entropy');
    const row = handle.db.prepare('SELECT label, token_hash FROM agent_api_tokens WHERE id = ?').get(created.id);
    assert.strictEqual(row.label, 'Edith');
    assert.strictEqual(row.token_hash, sha256(created.token), 'only the hash is stored');
    assert.ok(!row.token_hash.includes(created.token.slice(0, 8)), 'hash does not embed the token');
    const listed = handle.listAgentApiTokens();
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].label, 'Edith');
    assert.ok(!('token_hash' in listed[0]) && !('hash' in listed[0]), 'list never exposes hashes');
  } finally { cleanup(handle); }
});

test('createAgentApiToken rejects blank and overlong labels', () => {
  const handle = freshDb();
  try {
    handle.runMigrations();
    assert.throws(() => handle.createAgentApiToken(''), /label/i);
    assert.throws(() => handle.createAgentApiToken('   '), /label/i);
    assert.throws(() => handle.createAgentApiToken('x'.repeat(65)), /label/i);
  } finally { cleanup(handle); }
});

test('revokeAgentApiToken removes the token from the live hash set', () => {
  const handle = freshDb();
  try {
    handle.runMigrations();
    const first = handle.createAgentApiToken('Edith');
    const second = handle.createAgentApiToken('automation');
    assert.deepStrictEqual(handle.getAgentApiTokenHashes().sort(),
      [sha256(first.token), sha256(second.token)].sort());
    assert.strictEqual(handle.revokeAgentApiToken(first.id), true);
    assert.strictEqual(handle.revokeAgentApiToken(first.id), false, 'double revoke reports not-found');
    assert.strictEqual(handle.revokeAgentApiToken(999999), false, 'unknown id reports not-found');
    assert.deepStrictEqual(handle.getAgentApiTokenHashes(), [sha256(second.token)]);
    const listed = handle.listAgentApiTokens();
    assert.strictEqual(listed.find(t => t.id === first.id).revoked, true);
    assert.strictEqual(listed.find(t => t.id === second.id).revoked, false);
  } finally { cleanup(handle); }
});

test('touchAgentApiTokenUse records last use, throttled to one write per hour', () => {
  const handle = freshDb();
  try {
    handle.runMigrations();
    const created = handle.createAgentApiToken('Edith');
    const hash = sha256(created.token);
    const lastUsed = () => handle.db.prepare('SELECT last_used_at FROM agent_api_tokens WHERE id = ?').get(created.id).last_used_at;
    assert.strictEqual(lastUsed(), null);
    handle.touchAgentApiTokenUse(hash);
    const first = lastUsed();
    assert.ok(first, 'first use is recorded');
    handle.touchAgentApiTokenUse(hash);
    assert.strictEqual(lastUsed(), first, 'repeat use within the hour is not rewritten');
    handle.db.prepare("UPDATE agent_api_tokens SET last_used_at = datetime('now', '-2 hours') WHERE id = ?").run(created.id);
    const stale = lastUsed();
    handle.touchAgentApiTokenUse(hash);
    assert.ok(lastUsed() > stale, 'use after an hour is recorded');
  } finally { cleanup(handle); }
});
