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

// Scopes are mandatory at mint since migration 5; these tests are about hashing, listing and
// revocation, so they pass the narrowest grant that satisfies it.
const READ_ONLY = { scopes: ['read'] };

test('createAgentApiToken returns the raw token once and stores only its hash', () => {
  const handle = freshDb();
  try {
    handle.runMigrations();
    const created = handle.createAgentApiToken('Edith', READ_ONLY);
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
    assert.throws(() => handle.createAgentApiToken('', READ_ONLY), /label/i);
    assert.throws(() => handle.createAgentApiToken('   ', READ_ONLY), /label/i);
    assert.throws(() => handle.createAgentApiToken('x'.repeat(65), READ_ONLY), /label/i);
  } finally { cleanup(handle); }
});

test('revokeAgentApiToken removes the token from the live hash set', () => {
  const handle = freshDb();
  try {
    handle.runMigrations();
    const first = handle.createAgentApiToken('Edith', READ_ONLY);
    const second = handle.createAgentApiToken('automation', READ_ONLY);
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
    const created = handle.createAgentApiToken('Edith', READ_ONLY);
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

// ---- scopes (migration 5) ----

test('migration 5 grandfathers every pre-scopes token at full access', () => {
  const handle = freshDb();
  try {
    // Build the database as it stood at version 4: the table without the grant columns, and a
    // token already in use by a client that knows nothing about scopes.
    for (const step of handle.MIGRATIONS.filter(m => m.version <= 4)) step.run(handle.db);
    handle.db.pragma('user_version = 4');
    handle.db.prepare('INSERT INTO agent_api_tokens (label, token_hash) VALUES (?, ?)')
      .run('pre-existing', sha256('legacy-raw-token'));

    handle.runMigrations();
    assert.strictEqual(handle.schemaVersion(), 6, 'migrations 5 and 6 both run from version 4');

    const grants = handle.getAgentApiTokenGrants(sha256('legacy-raw-token'));
    assert.deepStrictEqual(grants.scopes, ['read', 'write', 'discord'], 'every scope, as before');
    assert.deepStrictEqual(
      grants.discordActions,
      ['*'],
      'the wildcard, not the command list of the day — a command added later must keep working',
    );
  } finally { cleanup(handle); }
});

test('a row with unreadable grants reads as full access rather than silently narrowing', () => {
  const handle = freshDb();
  try {
    handle.runMigrations();
    const created = handle.createAgentApiToken('hand-edited', { scopes: ['read'] });
    // However it got this way — a bad hand edit, a partial restore — a live token must not
    // quietly lose reach it was working with.
    handle.db.prepare('UPDATE agent_api_tokens SET scopes = ?, discord_actions = ? WHERE id = ?')
      .run('{not json', null, created.id);
    const grants = handle.getAgentApiTokenGrants(sha256(created.token));
    assert.deepStrictEqual(grants.scopes, ['read', 'write', 'discord']);
    assert.deepStrictEqual(grants.discordActions, ['*']);
  } finally { cleanup(handle); }
});

test('minting requires explicit scopes and an explicit discord action list', () => {
  const handle = freshDb();
  try {
    handle.runMigrations();
    assert.throws(() => handle.createAgentApiToken('x', {}), /at least one scope/);
    assert.throws(() => handle.createAgentApiToken('x', { scopes: [] }), /at least one scope/);
    assert.throws(() => handle.createAgentApiToken('x', { scopes: ['admin'] }), /Unknown scope/);
    assert.throws(() => handle.createAgentApiToken('x', { scopes: ['read', 'discord'] }), /explicit action list/);
    assert.throws(
      () => handle.createAgentApiToken('x', { scopes: ['discord'], discordActions: ['*'] }),
      /only carried by tokens that predate scopes/,
      'a new token cannot take the wildcard, however it is asked for',
    );
    assert.throws(
      () => handle.createAgentApiToken('x', { scopes: ['discord'], discordActions: ['queue; drop'] }),
      /Invalid discord action/,
    );

    const ok = handle.createAgentApiToken('director', { scopes: ['discord', 'read'], discordActions: ['Season', 'queue', 'queue'] });
    assert.deepStrictEqual(ok.scopes, ['read', 'discord'], 'scopes are normalized and ordered');
    assert.deepStrictEqual(ok.discordActions, ['queue', 'season'], 'actions are lowercased, deduped, sorted');

    const observer = handle.createAgentApiToken('observer', { scopes: ['read'], discordActions: ['queue'] });
    assert.deepStrictEqual(observer.discordActions, [], 'no discord scope means no action list is kept');
  } finally { cleanup(handle); }
});

test('grants are editable in place, so tightening a live token is not a re-mint', () => {
  const handle = freshDb();
  try {
    handle.runMigrations();
    const created = handle.createAgentApiToken('director', { scopes: ['read', 'write', 'discord'], discordActions: ['queue', 'season', 'downsize'] });
    const hash = sha256(created.token);

    const tightened = handle.setAgentApiTokenGrants(created.id, { scopes: ['read', 'discord'], discordActions: ['queue'] });
    assert.deepStrictEqual(tightened.scopes, ['read', 'discord']);
    assert.deepStrictEqual(tightened.discordActions, ['queue']);
    assert.deepStrictEqual(handle.getAgentApiTokenGrants(hash), tightened, 'the change is what the token now presents');
    assert.strictEqual(
      handle.getAgentApiTokenHashes().includes(hash),
      true,
      'and the client keeps the credential it already holds',
    );

    assert.strictEqual(handle.setAgentApiTokenGrants(999, { scopes: ['read'] }), null, 'unknown id');
    assert.throws(() => handle.setAgentApiTokenGrants(created.id, { scopes: [] }), /at least one scope/);
    assert.throws(
      () => handle.setAgentApiTokenGrants(created.id, { scopes: ['discord'], discordActions: ['*'] }),
      /predate scopes/,
      'an explicitly-scoped token cannot be widened to the wildcard',
    );
  } finally { cleanup(handle); }
});

test('a grandfathered token keeps its wildcard through an edit', () => {
  const handle = freshDb();
  try {
    for (const step of handle.MIGRATIONS.filter(m => m.version <= 4)) step.run(handle.db);
    handle.db.pragma('user_version = 4');
    handle.db.prepare('INSERT INTO agent_api_tokens (label, token_hash) VALUES (?, ?)').run('old', sha256('old-raw'));
    handle.runMigrations();
    const id = handle.listAgentApiTokens()[0].id;
    // Narrowing its scopes while leaving the action list alone must not be refused just because
    // the wildcard is present — that would make a grandfathered token uneditable.
    const updated = handle.setAgentApiTokenGrants(id, { scopes: ['read', 'discord'], discordActions: ['*'] });
    assert.deepStrictEqual(updated.scopes, ['read', 'discord']);
    assert.deepStrictEqual(updated.discordActions, ['*']);
  } finally { cleanup(handle); }
});

test('listAgentApiTokens shows grants and still never exposes hashes', () => {
  const handle = freshDb();
  try {
    handle.runMigrations();
    handle.createAgentApiToken('director', { scopes: ['read', 'discord'], discordActions: ['queue'] });
    const [row] = handle.listAgentApiTokens();
    assert.deepStrictEqual(row.scopes, ['read', 'discord']);
    assert.deepStrictEqual(row.discordActions, ['queue']);
    assert.ok(!('token_hash' in row) && !('hash' in row));
  } finally { cleanup(handle); }
});
