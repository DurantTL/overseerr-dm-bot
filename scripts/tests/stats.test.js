#!/usr/bin/env node
// #81: the server-stats "titles added" count must count the primary MEDIA_AVAILABLE DM once per
// title, not once per #75 subscriber fan-out DM.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseerr-bot-stats-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.exec(`CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    actor_discord_id TEXT,
    target_discord_id TEXT,
    metadata_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  return db;
}

const TITLES_ADDED_QUERY = "SELECT COUNT(*) AS c FROM audit_log WHERE action = 'media_available_notification_sent' AND created_at >= ? AND (metadata_json IS NULL OR metadata_json NOT LIKE '%\"subscriber\":true%')";

test('stats: titles-added counts the primary DM once, ignoring subscriber fan-out rows', () => {
  const db = tempDb();
  const insert = (metadata) => db.prepare('INSERT INTO audit_log (action, metadata_json) VALUES (?, ?)').run('media_available_notification_sent', JSON.stringify(metadata));

  insert({ targetDiscordId: 'u1', title: 'Movie A' });
  insert({ targetDiscordId: 'u2', title: 'Movie A', subscriber: true });
  insert({ targetDiscordId: 'u3', title: 'Movie A', subscriber: true });
  insert({ targetDiscordId: 'u4', title: 'Movie B' });

  const count = db.prepare(TITLES_ADDED_QUERY).get('2000-01-01').c;
  assert.strictEqual(count, 2, 'two titles delivered, regardless of how many subscribers each had');
});

test('stats: respects the since-timestamp filter', () => {
  const db = tempDb();
  db.prepare('INSERT INTO audit_log (action, metadata_json, created_at) VALUES (?, ?, ?)')
    .run('media_available_notification_sent', JSON.stringify({ title: 'Old' }), '2020-01-01 00:00:00');
  db.prepare('INSERT INTO audit_log (action, metadata_json) VALUES (?, ?)')
    .run('media_available_notification_sent', JSON.stringify({ title: 'Recent' }));

  const count = db.prepare(TITLES_ADDED_QUERY).get('2024-01-01').c;
  assert.strictEqual(count, 1, 'only the row after the since-timestamp counts');
});
