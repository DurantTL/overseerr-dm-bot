#!/usr/bin/env node
// Regression coverage for a round of review findings:
// - subscriberKeyFor: standard vs 4K editions must not share a subscriber list.
// - resolveTmdbId: a tvdb:-keyed (approved TV) row must resolve its real tmdbId via its
//   tmdb:-keyed sibling row, not misread the tvdb id as a tmdbId.
// - the quota-reservation query backing quotaBlockReason: a user's own still-outstanding
//   'pending' rows must count against their live Seerr quota.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { loadSandbox } = require('./extract');

test('subscriberKeyFor: standard and 4K get distinct keys', () => {
  const sb = loadSandbox(['subscriberKeyFor'], {});
  assert.strictEqual(sb.run('subscriberKeyFor(42, false)'), 'tmdb:42');
  assert.strictEqual(sb.run('subscriberKeyFor(42, true)'), 'tmdb:42:4k');
  assert.notStrictEqual(sb.run('subscriberKeyFor(42, false)'), sb.run('subscriberKeyFor(42, true)'));
});

function tempRequestsDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseerr-bot-review-fixes-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.exec(`CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    overseerr_request_id TEXT,
    media_id TEXT NOT NULL,
    media_type TEXT NOT NULL,
    is_4k INTEGER DEFAULT 0,
    title TEXT NOT NULL,
    requested_by_discord_id TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  return db;
}

test('resolveTmdbId: a tmdb:-keyed row resolves directly', () => {
  const db = tempRequestsDb();
  db.prepare("INSERT INTO requests (media_id, media_type, title, status) VALUES ('tmdb:42', 'movie', 'A Movie', 'approved')").run();
  const row = db.prepare("SELECT * FROM requests WHERE media_id = 'tmdb:42'").get();
  const sb = loadSandbox(['resolveTmdbId'], { db });
  assert.strictEqual(sb.run(`resolveTmdbId(${JSON.stringify(row)})`), 42);
  db.close();
});

test('resolveTmdbId: a tvdb:-keyed approved TV row resolves via its tmdb:-keyed sibling, matched WITHOUT a shared request id', () => {
  const db = tempRequestsDb();
  // Mirrors what handleGateApprove actually writes: the tvdb:-keyed row gets the real Seerr
  // request id, but the tmdb:-keyed sibling's request id is deliberately left NULL (that column
  // is UNIQUE, and the tvdb: row already claims the real id) — so the two rows share no id at
  // all. They're both written from the same `pending` object though, so requester/type/edition/
  // title line up and are what resolveTmdbId actually has to match on.
  db.prepare("INSERT INTO requests (overseerr_request_id, media_id, media_type, is_4k, title, requested_by_discord_id, status) VALUES ('99', 'tvdb:555', 'tv', 0, 'A Show', 'u1', 'approved')").run();
  db.prepare("INSERT INTO requests (overseerr_request_id, media_id, media_type, is_4k, title, requested_by_discord_id, status) VALUES (NULL, 'tmdb:777', 'tv', 0, 'A Show', 'u1', 'approved')").run();
  const tvdbRow = db.prepare("SELECT * FROM requests WHERE media_id = 'tvdb:555'").get();
  const sb = loadSandbox(['resolveTmdbId'], { db });
  assert.strictEqual(sb.run(`resolveTmdbId(${JSON.stringify(tvdbRow)})`), 777, 'must return the real tmdbId (777), not misread the tvdb id (555) as one');
  db.close();
});

test('resolveTmdbId: matches the sibling by requester + type + edition + title, not just any tmdb: row', () => {
  const db = tempRequestsDb();
  db.prepare("INSERT INTO requests (overseerr_request_id, media_id, media_type, is_4k, title, requested_by_discord_id, status) VALUES ('99', 'tvdb:555', 'tv', 0, 'A Show', 'u1', 'approved')").run();
  // A same-titled 4K request from a different user — must not be picked as the sibling.
  db.prepare("INSERT INTO requests (overseerr_request_id, media_id, media_type, is_4k, title, requested_by_discord_id, status) VALUES (NULL, 'tmdb:111', 'tv', 1, 'A Show', 'u2', 'approved')").run();
  // The real (non-4K, same user) sibling.
  db.prepare("INSERT INTO requests (overseerr_request_id, media_id, media_type, is_4k, title, requested_by_discord_id, status) VALUES (NULL, 'tmdb:777', 'tv', 0, 'A Show', 'u1', 'approved')").run();
  const tvdbRow = db.prepare("SELECT * FROM requests WHERE media_id = 'tvdb:555'").get();
  const sb = loadSandbox(['resolveTmdbId'], { db });
  assert.strictEqual(sb.run(`resolveTmdbId(${JSON.stringify(tvdbRow)})`), 777);
  db.close();
});

test('resolveTmdbId: a tvdb:-keyed row with no sibling resolves to null', () => {
  const db = tempRequestsDb();
  db.prepare("INSERT INTO requests (media_id, media_type, title, requested_by_discord_id, status) VALUES ('tvdb:555', 'tv', 'A Show', 'u1', 'pending')").run();
  const row = db.prepare("SELECT * FROM requests WHERE media_id = 'tvdb:555'").get();
  const sb = loadSandbox(['resolveTmdbId'], { db });
  assert.strictEqual(sb.run(`resolveTmdbId(${JSON.stringify(row)})`), null, 'no sibling to resolve from means null, not a wrong guess');
  db.close();
});

test('quota reservation query: counts only this user\'s own pending rows for the same media type', () => {
  const db = tempRequestsDb();
  const insert = (discordId, mediaType, status) => db.prepare(
    'INSERT INTO requests (media_id, media_type, title, requested_by_discord_id, status) VALUES (?, ?, ?, ?, ?)',
  ).run(`tmdb:${Math.random()}`, mediaType, 'X', discordId, status);

  insert('u1', 'movie', 'pending');
  insert('u1', 'movie', 'pending');
  insert('u1', 'tv', 'pending'); // different media type — must not count
  insert('u1', 'movie', 'approved'); // not pending — must not count
  insert('u2', 'movie', 'pending'); // different user — must not count

  const reserved = db.prepare(
    "SELECT COUNT(*) AS c FROM requests WHERE requested_by_discord_id = ? AND media_type = ? AND status = 'pending'",
  ).get('u1', 'movie').c;
  assert.strictEqual(reserved, 2);
  db.close();
});

function quotaSandbox(db, quota) {
  return loadSandbox(['quotaBlockReason'], {
    db,
    fetchUserQuota: async () => quota,
    quotaLine: () => 'quota line',
  });
}

test('quotaBlockReason: a second pending request from the same user is blocked before it ever reaches Seerr', async () => {
  const db = tempRequestsDb();
  const quota = { movie: { limit: 1, used: 0, remaining: 1 } };
  const sb = quotaSandbox(db, quota);

  assert.strictEqual(await sb.run("quotaBlockReason('seerrUser1', 'u1', 'movie')"), null, 'first request is within quota');
  db.prepare("INSERT INTO requests (media_id, media_type, is_4k, title, requested_by_discord_id, status) VALUES ('tmdb:1', 'movie', 0, 'X', 'u1', 'pending')").run();
  const block = await sb.run("quotaBlockReason('seerrUser1', 'u1', 'movie')");
  assert.ok(block, 'a second request while the first is still pending must be blocked, even though Seerr\'s own quota has not moved yet');
  db.close();
});

test('quotaBlockReason: exclude lets the approval-time recheck ignore the request being approved itself', async () => {
  const db = tempRequestsDb();
  const quota = { movie: { limit: 1, used: 0, remaining: 1 } };
  db.prepare("INSERT INTO requests (media_id, media_type, is_4k, title, requested_by_discord_id, status) VALUES ('tmdb:1', 'movie', 0, 'X', 'u1', 'pending')").run();
  const sb = quotaSandbox(db, quota);

  const withoutExclude = await sb.run("quotaBlockReason('seerrUser1', 'u1', 'movie')");
  assert.ok(withoutExclude, 'without excluding itself, the only pending row reads as already using the one slot');

  const withExclude = await sb.run("quotaBlockReason('seerrUser1', 'u1', 'movie', { tmdbId: 1, is4k: false })");
  assert.strictEqual(withExclude, null, 'excluding the request being approved leaves it correctly within quota');
  db.close();
});

test('quotaBlockReason: a zero/missing limit never blocks', async () => {
  const db = tempRequestsDb();
  const sb = quotaSandbox(db, { movie: { limit: 0 } });
  assert.strictEqual(await sb.run("quotaBlockReason('seerrUser1', 'u1', 'movie')"), null);
  db.close();
});

test('quotaBlockReason: dashboard checks surface unavailable quota', async () => {
  const sb = loadSandbox(['quotaBlockReason'], {
    fetchUserQuota: async () => { throw new Error('Seerr unavailable'); },
  });
  await assert.rejects(sb.run("quotaBlockReason('seerrUser1', 'u1', 'movie', null, true)"), /Seerr unavailable/);
  assert.strictEqual(await sb.run("quotaBlockReason('seerrUser1', 'u1', 'movie')"), null);
});

function makeMember(id, hasRole) {
  const state = { hasRole, added: 0, removed: 0 };
  return {
    id,
    state,
    roles: {
      cache: { has: () => state.hasRole },
      add: async () => { state.added++; state.hasRole = true; },
      remove: async () => { state.removed++; state.hasRole = false; },
    },
  };
}

function reconcileSandbox({ members, fetchPlexFriends, getUserByCanonicalEmail }) {
  const guild = { members: { fetch: async () => new Map(members.map(m => [m.id, m])) } };
  return loadSandbox(['reconcilePlexMemberRoles'], {
    CONFIG: { PLEX_MEMBER_ROLE_ID: 'role1', DISCORD_GUILD_ID: 'g1' },
    client: { guilds: { cache: { get: () => guild } } },
    getPlexToken: async () => 'token',
    fetchPlexFriends,
    getUserByCanonicalEmail: getUserByCanonicalEmail || (() => null),
    isSnowflake: id => /^\d+$/.test(String(id)),
    log: { warn: () => {} },
  });
}

test('reconcilePlexMemberRoles: aborts and touches no roles when the Plex friends fetch fails', async () => {
  const alice = makeMember('111', true); // currently has the role
  const bob = makeMember('222', false); // currently doesn't
  const sb = reconcileSandbox({
    members: [alice, bob],
    fetchPlexFriends: async () => { throw new Error('Plex is down'); },
  });

  const result = await sb.run('reconcilePlexMemberRoles()');
  assert.strictEqual(result.granted, 0);
  assert.strictEqual(result.revoked, 0);
  assert.strictEqual(alice.state.removed, 0, 'a Plex outage must never strip the role from an existing holder');
  assert.strictEqual(alice.state.hasRole, true);
  assert.strictEqual(bob.state.added, 0);
});

test('reconcilePlexMemberRoles: grants and revokes correctly on a successful fetch', async () => {
  const alice = makeMember('111', false); // should gain the role (is a current Plex friend)
  const bob = makeMember('222', true); // should lose it (no longer a Plex friend)
  const sb = reconcileSandbox({
    members: [alice, bob],
    fetchPlexFriends: async () => [{ email: 'alice@example.com' }],
    getUserByCanonicalEmail: email => (email === 'alice@example.com' ? { discord_id: '111' } : null),
  });

  const result = await sb.run('reconcilePlexMemberRoles()');
  assert.strictEqual(result.granted, 1);
  assert.strictEqual(result.revoked, 1);
  assert.strictEqual(alice.state.hasRole, true);
  assert.strictEqual(bob.state.hasRole, false);
});
