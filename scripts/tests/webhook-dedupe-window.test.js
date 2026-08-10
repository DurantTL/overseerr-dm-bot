#!/usr/bin/env node
// The dedupe window is now a real sliding check against created_at (recordWebhookEvent), not a
// floor(now/window) bucket baked into the key — this covers the atomic claim/reject/reclaim
// behavior and the un-claim-on-failure path (forgetWebhookEvent).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { loadSandbox } = require('./extract');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseerr-bot-webhook-window-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.exec(`CREATE TABLE webhook_events (
    event_key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  return db;
}

test('webhook dedupe: a redelivery within the window is rejected, reclaimed once it ages out', () => {
  const db = tempDb();
  const sb = loadSandbox(['recordWebhookEvent', 'forgetWebhookEvent'], { db, CONFIG: { WEBHOOK_DEDUPE_WINDOW_MINUTES: 5 } });

  assert.strictEqual(sb.run("recordWebhookEvent('k1', 'overseerr')"), true, 'first delivery claims the key');
  assert.strictEqual(sb.run("recordWebhookEvent('k1', 'overseerr')"), false, 'an immediate redelivery is rejected as a duplicate');

  db.prepare("UPDATE webhook_events SET created_at = datetime('now', '-10 minutes') WHERE event_key = 'k1'").run();
  assert.strictEqual(sb.run("recordWebhookEvent('k1', 'overseerr')"), true, 'once outside the window, the same key is treated as new again');
  assert.strictEqual(sb.run("recordWebhookEvent('k1', 'overseerr')"), false, 'and is immediately deduped again after being reclaimed');

  db.close();
});

test('webhook dedupe: forgetWebhookEvent un-claims a key so a retry after failure is not swallowed', () => {
  const db = tempDb();
  const sb = loadSandbox(['recordWebhookEvent', 'forgetWebhookEvent'], { db, CONFIG: { WEBHOOK_DEDUPE_WINDOW_MINUTES: 5 } });

  assert.strictEqual(sb.run("recordWebhookEvent('k1', 'overseerr')"), true);
  sb.run("forgetWebhookEvent('k1')");
  assert.strictEqual(sb.run("recordWebhookEvent('k1', 'overseerr')"), true, 'a forgotten key is claimable again immediately, not stuck for the rest of the window');

  db.close();
});
