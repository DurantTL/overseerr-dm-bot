'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const ma = require('../../src/member-activity');

function memDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE plex_last_watched (account_id TEXT NOT NULL, server TEXT NOT NULL, watched_at INTEGER NOT NULL, title TEXT, PRIMARY KEY (account_id, server));
    CREATE TABLE discord_last_active (discord_id TEXT PRIMARY KEY, active_at INTEGER NOT NULL, place TEXT);`);
  return db;
}

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 29, 12);

test('webhook plays from any server are recorded; other events are not', () => {
  const play = ma.playFromWebhook({ event: 'media.play', Account: { id: 42 }, Server: { title: 'PH Server' }, Metadata: { type: 'episode', grandparentTitle: 'Severance', title: 'Hello, Ms. Cobel' } }, NOW);
  assert.deepStrictEqual(play, { accountId: '42', server: 'PH Server', at: NOW, title: 'Severance · Hello, Ms. Cobel' });
  assert.strictEqual(ma.playFromWebhook({ event: 'media.pause', Account: { id: 42 }, Server: { title: 'x' }, Metadata: {} }), null);
  assert.strictEqual(ma.playFromWebhook({ event: 'library.new', Server: { title: 'x' } }), null);
  assert.strictEqual(ma.playFromWebhook({ event: 'media.scrobble', Account: {}, Server: { title: 'x' }, Metadata: {} }), null);
});

test('only the newest play per account and server is kept, whatever order sources arrive in', () => {
  const db = memDb();
  ma.recordPlexPlay(db, { accountId: '42', server: 'Main', at: NOW - DAY, title: 'Dune' });
  ma.recordPlexPlay(db, { accountId: '42', server: 'Main', at: NOW - 5 * DAY, title: 'Older' });
  const rows = db.prepare('SELECT * FROM plex_last_watched').all();
  assert.deepStrictEqual(rows, [{ account_id: '42', server: 'Main', watched_at: NOW - DAY, title: 'Dune' }]);
  ma.recordPlexPlay(db, { accountId: '42', server: 'Main', at: NOW, title: 'Arrival' });
  assert.strictEqual(db.prepare('SELECT title FROM plex_last_watched').get().title, 'Arrival');
});

test('Tautulli and Plex history rows map to plays by Plex account ID', () => {
  assert.deepStrictEqual(ma.playsFromTautulli([{ user_id: 42, date: NOW / 1000, full_title: 'Dune' }, { user_id: null, date: 1 }], 'Main'),
    [{ accountId: '42', server: 'Main', at: NOW, title: 'Dune' }]);
  assert.deepStrictEqual(ma.playsFromPlex([{ accountID: 7, viewedAt: NOW / 1000, type: 'episode', grandparentTitle: 'Shogun', title: 'Anjin' }], 'ph'),
    [{ accountId: '7', server: 'ph', at: NOW, title: 'Shogun · Anjin' }]);
  const db = memDb();
  const changed = ma.recordPlays(db, [
    { accountId: '42', server: 'Main', at: NOW - 3 * DAY, title: 'A' },
    { accountId: '42', server: 'Main', at: NOW - DAY, title: 'B' },
    { accountId: '42', server: 'ph', at: NOW - 2 * DAY, title: 'C' },
  ]);
  assert.strictEqual(changed, 2, 'one row per account and server');
});

test('activityForMembers: newest play on any server, matched by email, else Plex username', () => {
  const db = memDb();
  ma.recordPlexPlay(db, { accountId: '42', server: 'Main', at: NOW - 3 * DAY, title: 'Old' });
  ma.recordPlexPlay(db, { accountId: '42', server: 'ph', at: NOW - DAY, title: 'Newest' });
  ma.recordPlexPlay(db, { accountId: '7', server: 'cali', at: NOW - 2 * DAY, title: 'Shogun' });
  ma.recordDiscordActivity(db, { discordId: '111111111111111111', at: NOW - 3600000, place: '#requests' });
  ma.recordDiscordActivity(db, { discordId: '111111111111111111', at: NOW - DAY, place: 'DM to the bot' });
  const users = [
    { discord_id: '111111111111111111', email: 'Ana@Example.com', plex_username: null },
    { discord_id: '222222222222222222', email: 'nomatch@example.com', plex_username: 'bo' },
    { discord_id: '333333333333333333', email: 'cy@example.com', plex_username: null },
  ];
  const out = ma.activityForMembers(db, users, {
    emailByAccount: new Map([['42', 'ana@example.com'], ['8', 'cy@example.com']]),
    nameByAccount: new Map([['7', 'Bo']]),
  });
  assert.deepStrictEqual(out.get('111111111111111111'), { plexMatched: true, watched: { at: NOW - DAY, server: 'ph', title: 'Newest' }, discord: { at: NOW - 3600000, place: '#requests' } });
  assert.deepStrictEqual(out.get('222222222222222222').watched, { at: NOW - 2 * DAY, server: 'cali', title: 'Shogun' });
  assert.deepStrictEqual(out.get('333333333333333333'), { plexMatched: true, watched: null, discord: null }, 'matched but never played: no invented play');
  const none = ma.activityForMembers(db, [{ discord_id: '444444444444444444', email: 'x@example.com' }]);
  assert.deepStrictEqual(none.get('444444444444444444'), { plexMatched: false, watched: null, discord: null });
});

test('recordDiscordActivity ignores bad ids and times', () => {
  const db = memDb();
  assert.strictEqual(ma.recordDiscordActivity(db, { discordId: 'not-an-id', at: NOW }), false);
  assert.strictEqual(ma.recordDiscordActivity(db, { discordId: '111111111111111111', at: 0 }), false);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM discord_last_active').get().n, 0);
});
