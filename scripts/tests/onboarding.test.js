#!/usr/bin/env node
// Core concierge/onboarding coverage: the "reply with your Plex email" pending-flag state
// machine (setPendingEmail/hasPendingEmail/clearPendingEmail/rehydratePendingEmails, including
// the #71 expiry behavior) and the user-linking path (storeUserEmail/linkUserToEmail, including
// the plex_* row absorption case). Everything else in this file is thoroughly tested; this was
// the one gap (#70) — the concierge flow the project is named for.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { loadSandbox } = require('./extract');
const { canonicalizeEmail } = require('../../src/util');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseerr-bot-onboarding-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE users (
      discord_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      invited INTEGER DEFAULT 0,
      invited_at TEXT,
      requested_at TEXT NOT NULL,
      overseerr_created INTEGER DEFAULT 0,
      overseerr_user_id INTEGER,
      plex_username TEXT
    );
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      actor_discord_id TEXT,
      target_discord_id TEXT,
      metadata_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

test('onboarding: pending-email state machine (set/has/clear/rehydrate)', () => {
  const db = tempDb();
  const pendingEmailRequests = new Map();
  const auditLog = [];
  const getSetting = key => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value || null;
  const setSetting = (key, value) => db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value));

  const sb = loadSandbox(['setPendingEmail', 'hasPendingEmail', 'clearPendingEmail', 'rehydratePendingEmails'], {
    db, pendingEmailRequests, getSetting, setSetting, log: { info: () => {} },
    audit: (action, details) => auditLog.push({ action, details }),
    CONFIG: { PENDING_EMAIL_EXPIRY_DAYS: 14 },
  });

  assert.strictEqual(sb.run("hasPendingEmail('u1')"), false, 'no flag set → not pending');

  sb.run("setPendingEmail('u1')");
  assert.strictEqual(sb.run("hasPendingEmail('u1')"), true, 'flag set → pending');
  assert.strictEqual(pendingEmailRequests.get('u1'), true, 'in-memory map mirrors the flag');
  assert.ok(getSetting('pending_email:u1'), 'DB row persisted too');

  sb.run("clearPendingEmail('u1')");
  assert.strictEqual(sb.run("hasPendingEmail('u1')"), false, 'cleared → no longer pending');
  assert.strictEqual(pendingEmailRequests.has('u1'), false, 'cleared from memory too');
  assert.strictEqual(getSetting('pending_email:u1'), null, 'cleared from DB too');

  // Rehydration: a flag written straight to the DB (simulating a prior process) should be picked
  // up into memory on restart, same as rehydratePendingEmails() does at boot.
  setSetting('pending_email:u2', '1');
  sb.run('rehydratePendingEmails()');
  assert.strictEqual(pendingEmailRequests.get('u2'), true, 'rehydrate loads DB-only flags into memory');
  assert.strictEqual(sb.run("hasPendingEmail('u2')"), true, 'rehydrated flag reads back as pending');

  // #71: a flag older than PENDING_EMAIL_EXPIRY_DAYS is treated as expired and cleared on read.
  sb.run("setPendingEmail('u3')");
  db.prepare("UPDATE app_settings SET updated_at = datetime('now', '-30 days') WHERE key = 'pending_email:u3'").run();
  assert.strictEqual(sb.run("hasPendingEmail('u3')"), false, 'a flag older than the expiry window reads as not-pending');
  assert.strictEqual(getSetting('pending_email:u3'), null, 'expired flag is cleared from the DB on read, not just masked');

  db.close();
});

test('onboarding: storeUserEmail creates then updates a user row', () => {
  const db = tempDb();
  const sb = loadSandbox(['storeUserEmail'], { db, canonicalizeEmail });

  sb.run("storeUserEmail('123', 'Person@Example.com')");
  const row = db.prepare('SELECT * FROM users WHERE discord_id = ?').get('123');
  assert.strictEqual(row.email, 'person@example.com', 'email is lowercased/trimmed on store');
  assert.strictEqual(row.invited, 0);

  db.prepare('UPDATE users SET invited = 1, overseerr_created = 1 WHERE discord_id = ?').run('123');
  sb.run("storeUserEmail('123', 'person@example.com')");
  const same = db.prepare('SELECT * FROM users WHERE discord_id = ?').get('123');
  assert.strictEqual(same.invited, 1, 're-storing the same (canonically) email preserves invited state');

  sb.run("storeUserEmail('123', 'new-address@example.com')");
  const changed = db.prepare('SELECT * FROM users WHERE discord_id = ?').get('123');
  assert.strictEqual(changed.email, 'new-address@example.com');
  assert.strictEqual(changed.invited, 0, 'a genuinely different email resets invited/overseerr state');

  db.close();
});

test('onboarding: linkUserToEmail absorbs a matching plex_* placeholder row', () => {
  const db = tempDb();
  const auditLog = [];
  const removeUser = discordId => db.prepare('DELETE FROM users WHERE discord_id = ?').run(discordId);
  const sb = loadSandbox(['storeUserEmail', 'linkUserToEmail'], {
    db, canonicalizeEmail, removeUser,
    audit: (action, details) => auditLog.push({ action, details }),
  });

  db.prepare(`INSERT INTO users (discord_id, email, requested_at, invited, invited_at, overseerr_created, overseerr_user_id, plex_username)
    VALUES ('plex_abc', 'shared@example.com', '2024-01-01T00:00:00Z', 1, '2024-01-01T00:00:00Z', 1, 42, 'plexuser')`).run();

  sb.run("linkUserToEmail('999', 'shared@example.com')");

  const linked = db.prepare('SELECT * FROM users WHERE discord_id = ?').get('999');
  assert.ok(linked, 'the real Discord user row now exists');
  assert.strictEqual(linked.invited, 1, 'absorbed the placeholder row\'s invited state');
  assert.strictEqual(linked.overseerr_user_id, 42, 'absorbed the placeholder row\'s overseerr_user_id');
  assert.strictEqual(linked.plex_username, 'plexuser', 'absorbed the placeholder row\'s plex_username');

  const placeholder = db.prepare('SELECT * FROM users WHERE discord_id = ?').get('plex_abc');
  assert.strictEqual(placeholder, undefined, 'the placeholder row is removed after being absorbed');
  assert.ok(auditLog.some(e => e.action === 'plex_row_absorbed'), 'the absorption is audited');

  db.close();
});

test('onboarding: linkUserToEmail leaves unrelated users alone', () => {
  const db = tempDb();
  const removeUser = discordId => db.prepare('DELETE FROM users WHERE discord_id = ?').run(discordId);
  const sb = loadSandbox(['storeUserEmail', 'linkUserToEmail'], {
    db, canonicalizeEmail, removeUser, audit: () => {},
  });

  db.prepare(`INSERT INTO users (discord_id, email, requested_at) VALUES ('other_user', 'different@example.com', '2024-01-01T00:00:00Z')`).run();

  sb.run("linkUserToEmail('999', 'brand-new@example.com')");

  assert.ok(db.prepare('SELECT * FROM users WHERE discord_id = ?').get('other_user'), 'unrelated user untouched');
  assert.ok(db.prepare('SELECT * FROM users WHERE discord_id = ?').get('999'), 'new user created');

  db.close();
});

test('onboarding: findConflictingRealUser flags a different real account already holding the email', () => {
  const db = tempDb();
  const sb = loadSandbox(['findConflictingRealUser'], { db, canonicalizeEmail });

  db.prepare(`INSERT INTO users (discord_id, email, requested_at) VALUES ('other_real_user', 'shared@example.com', '2024-01-01T00:00:00Z')`).run();

  const conflict = sb.run("findConflictingRealUser('999', 'shared@example.com')");
  assert.strictEqual(conflict.discord_id, 'other_real_user');

  db.close();
});

test('onboarding: findConflictingRealUser ignores plex_* placeholders, the caller\'s own row, and unrelated emails', () => {
  const db = tempDb();
  const sb = loadSandbox(['findConflictingRealUser'], { db, canonicalizeEmail });

  db.prepare(`INSERT INTO users (discord_id, email, requested_at) VALUES ('plex_abc', 'shared@example.com', '2024-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO users (discord_id, email, requested_at) VALUES ('999', 'own@example.com', '2024-01-01T00:00:00Z')`).run();

  assert.strictEqual(sb.run("findConflictingRealUser('999', 'shared@example.com')"), null, 'a plex_* placeholder is not a conflict — it gets absorbed instead');
  assert.strictEqual(sb.run("findConflictingRealUser('999', 'own@example.com')"), null, 'the caller\'s own row is never its own conflict');
  assert.strictEqual(sb.run("findConflictingRealUser('999', 'nobody-has-this@example.com')"), null, 'no match at all');

  db.close();
});
