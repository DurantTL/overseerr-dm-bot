#!/usr/bin/env node
'use strict';

// Tests for the /member self-service dashboard: DM-code auth flow, member gating,
// and command dispatch through the member-surface adapter.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApp, listen, close } = require('../../src/app');
const { escapeHtml } = require('../../src/dashboard-render');
const { registerMemberRoutes } = require('../../src/routes/member');

// Minimal in-memory stand-in for the member_login_codes table.
function fakeDb() {
  const codes = [];
  return {
    _codes: codes,
    prepare(sql) {
      if (sql.startsWith('INSERT INTO member_login_codes')) {
        return { run: (discord_id, code_hash, expires_at) => { codes.push({ id: codes.length + 1, discord_id, code_hash, expires_at, used: 0, attempts: 0 }); } };
      }
      if (sql.includes('COUNT(*) AS c FROM member_login_codes')) {
        return { get: () => ({ c: 0 }) };
      }
      if (sql.startsWith('SELECT * FROM member_login_codes')) {
        return {
          get: (discordId, now) => codes
            .filter(c => c.discord_id === discordId && !c.used && c.expires_at > now)
            .sort((a, b) => b.id - a.id)[0],
        };
      }
      if (sql.startsWith('UPDATE member_login_codes SET attempts')) {
        return { run: id => { const c = codes.find(x => x.id === id); if (c) c.attempts += 1; } };
      }
      if (sql.startsWith('UPDATE member_login_codes SET used')) {
        return { run: id => { const c = codes.find(x => x.id === id); if (c) c.used = 1; } };
      }
      if (sql.includes('FROM requests')) {
        return { all: () => [] };
      }
      throw new Error(`unexpected SQL in member-routes test: ${sql}`);
    },
  };
}

function fixture({ adminUserId = null } = {}) {
  const app = createApp();
  const db = fakeDb();
  const dms = [];
  const seen = {};
  const stubHandler = name => async interaction => {
    seen[name] = {
      userId: interaction.user.id,
      options: {
        title: interaction.options.getString('title'),
        type: interaction.options.getString('type'),
        details: interaction.options.getString('details'),
        season: interaction.options.getInteger('season'),
        episode: interaction.options.getInteger('episode'),
        one_time: interaction.options.getBoolean('one_time'),
        is4k: interaction.options.getBoolean('is4k'),
        seasons: interaction.options.getString('seasons'),
        asian_content: interaction.options.getBoolean('asian_content'),
        request_updates: interaction.options.getBoolean('request_updates'),
      },
    };
    await interaction.reply({ content: `ok:${name}` });
  };
  const linkedUsers = { '123456789012345678': { discord_id: '123456789012345678', email: 'caleb@example.com', plex_username: 'caleb' } };
  registerMemberRoutes(app, {
    CONFIG: { SESSION_SECRET: 'test-secret', ADMIN_USER_ID: adminUserId },
    db,
    audit: () => {},
    escapeHtml,
    css: '',
    sessionSecret: 'test-secret',
    handlers: {
      request: stubHandler('request'),
      myRequests: stubHandler('myRequests'),
      requestStatus: stubHandler('requestStatus'),
      requestCancel: stubHandler('requestCancel'),
      download: stubHandler('download'),
      downloads: stubHandler('downloads'),
      report: stubHandler('report'),
      notifications: stubHandler('notifications'),
      me: stubHandler('me'),
      stats: stubHandler('stats'),
      keep: stubHandler('keep'),
    },
    searchSeerr: async () => [],
    getGuildMembers: async () => [{ user: { id: '123456789012345678', username: 'caleb' }, displayName: 'Caleb' }],
    getUserByDiscordId: id => linkedUsers[id] || null,
    getSetting: () => null,
    sendMemberDm: async (discordId, text) => { dms.push({ discordId, text }); },
  });
  return { app, db, dms, seen };
}

function request(port, method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const form = obj => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const formHeaders = body => ({ 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) });

function sessionCookieFrom(res) {
  const setCookie = res.headers['set-cookie'] || [];
  const member = setCookie.find(c => c.startsWith('member_session='));
  assert.ok(member, 'expected a member_session cookie');
  return member.split(';')[0];
}

test('member auth: login page renders, /member redirects when logged out', async () => {
  const { app } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const login = await request(port, 'GET', '/member/login');
    assert.strictEqual(login.statusCode, 200);
    assert.match(login.body, /Member login/);

    const home = await request(port, 'GET', '/member');
    assert.strictEqual(home.statusCode, 302);
    assert.strictEqual(home.headers.location, '/member/login');
  } finally {
    await close(server);
  }
});

test('member auth: unknown handle 404s, unlinked ID 403s', async () => {
  const { app } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const unknown = await request(port, 'POST', '/member/login', {
      headers: formHeaders(form({ handle: 'nobody' })), body: form({ handle: 'nobody' }),
    });
    assert.strictEqual(unknown.statusCode, 404);

    const unlinked = await request(port, 'POST', '/member/login', {
      headers: formHeaders(form({ handle: '999999999999999999' })), body: form({ handle: '999999999999999999' }),
    });
    assert.strictEqual(unlinked.statusCode, 403);
    assert.match(unlinked.body, /linked to the media server/);
  } finally {
    await close(server);
  }
});

test('member auth: full DM-code flow mints a session cookie', async () => {
  const { app, db, dms } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;

    // Username resolves to the linked Discord ID and triggers a DM.
    const sent = await request(port, 'POST', '/member/login', {
      headers: formHeaders(form({ handle: 'caleb' })), body: form({ handle: 'caleb' }),
    });
    assert.strictEqual(sent.statusCode, 200);
    assert.match(sent.body, /Check your DMs/);
    assert.strictEqual(dms.length, 1);
    assert.strictEqual(dms[0].discordId, '123456789012345678');
    const code = dms[0].text.match(/\b(\d{6})\b/)[1];
    assert.strictEqual(db._codes.length, 1);

    // Wrong code is rejected without minting a session.
    const wrong = await request(port, 'POST', '/member/verify', {
      headers: formHeaders(form({ handle: 'caleb', code: '000000' })), body: form({ handle: 'caleb', code: '000000' }),
    });
    assert.strictEqual(wrong.statusCode, 400);
    assert.ok(!wrong.headers['set-cookie']?.some(c => c.startsWith('member_session=')), 'no session on wrong code');

    // Right code mints the session.
    const verified = await request(port, 'POST', '/member/verify', {
      headers: formHeaders(form({ handle: 'caleb', code })), body: form({ handle: 'caleb', code }),
    });
    assert.strictEqual(verified.statusCode, 302);
    assert.strictEqual(verified.headers.location, '/member');
    const cookie = sessionCookieFrom(verified);

    // The code is single-use.
    const replay = await request(port, 'POST', '/member/verify', {
      headers: formHeaders(form({ handle: 'caleb', code })), body: form({ handle: 'caleb', code }),
    });
    assert.strictEqual(replay.statusCode, 400);

    // Authenticated home renders through the myRequests handler.
    const home = await request(port, 'GET', '/member', { headers: { Cookie: cookie } });
    assert.strictEqual(home.statusCode, 200);
    assert.match(home.body, /ok:myRequests/);

    // Logout clears the session.
    const logout = await request(port, 'POST', '/member/logout', { headers: { Cookie: cookie } });
    assert.strictEqual(logout.statusCode, 302);
    const after = await request(port, 'GET', '/member');
    assert.strictEqual(after.statusCode, 302);
  } finally {
    await close(server);
  }
});

test('member dispatch: notifications toggle coerces to boolean', async () => {
  const { app, dms, seen } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const loginBody = form({ handle: '123456789012345678' });
    await request(port, 'POST', '/member/login', { headers: formHeaders(loginBody), body: loginBody });
    const code = dms[0].text.match(/\b(\d{6})\b/)[1];
    const verifyBody = form({ handle: '123456789012345678', code });
    const verified = await request(port, 'POST', '/member/verify', { headers: formHeaders(verifyBody), body: verifyBody });
    const cookie = sessionCookieFrom(verified);

    const offBody = form({ request_updates: 'off' });
    const off = await request(port, 'POST', '/member/notifications', { headers: { Cookie: cookie, ...formHeaders(offBody) }, body: offBody });
    assert.strictEqual(off.statusCode, 200);
    assert.strictEqual(seen.notifications.options.request_updates, false);
    assert.strictEqual(seen.notifications.userId, '123456789012345678');

    const onBody = form({ request_updates: 'on' });
    const on = await request(port, 'POST', '/member/notifications', { headers: { Cookie: cookie, ...formHeaders(onBody) }, body: onBody });
    assert.strictEqual(on.statusCode, 200);
    assert.strictEqual(seen.notifications.options.request_updates, true);
  } finally {
    await close(server);
  }
});

test('member dispatch: download form coerces ints, request-status passes media_id through', async () => {
  const { app, dms, seen } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const loginBody = form({ handle: '123456789012345678' });
    await request(port, 'POST', '/member/login', { headers: formHeaders(loginBody), body: loginBody });
    const code = dms[0].text.match(/\b(\d{6})\b/)[1];
    const verifyBody = form({ handle: '123456789012345678', code });
    const verified = await request(port, 'POST', '/member/verify', { headers: formHeaders(verifyBody), body: verifyBody });
    const cookie = sessionCookieFrom(verified);

    const dlBody = form({ title: 'Dune', season: '1', episode: '2', one_time: 'on' });
    const dl = await request(port, 'POST', '/member/downloads/new', { headers: { Cookie: cookie, ...formHeaders(dlBody) }, body: dlBody });
    assert.strictEqual(dl.statusCode, 200);
    assert.strictEqual(seen.download.options.title, 'Dune');
    assert.strictEqual(seen.download.options.season, 1);
    assert.strictEqual(seen.download.options.episode, 2);
    assert.strictEqual(seen.download.options.one_time, true);

    const status = await request(port, 'GET', '/member/requests/status?media_id=tmdb:42', { headers: { Cookie: cookie } });
    assert.strictEqual(status.statusCode, 200);
    assert.strictEqual(seen.requestStatus.options.title, 'tmdb:42');
    assert.match(status.body, /ok:requestStatus/);

    const badStatus = await request(port, 'GET', '/member/requests/status?media_id=nope', { headers: { Cookie: cookie } });
    assert.strictEqual(badStatus.statusCode, 302, 'non-media_id status lookups bounce back to the list');
  } finally {
    await close(server);
  }
});

async function loginAs(port, dms, handle = '123456789012345678') {
  const loginBody = form({ handle });
  await request(port, 'POST', '/member/login', { headers: formHeaders(loginBody), body: loginBody });
  const code = dms[dms.length - 1].text.match(/\b(\d{6})\b/)[1];
  const verifyBody = form({ handle, code });
  const verified = await request(port, 'POST', '/member/verify', { headers: formHeaders(verifyBody), body: verifyBody });
  return sessionCookieFrom(verified);
}

test('member admin: ADMIN_USER_ID sees the Admin nav link and all requests', async () => {
  const { app, dms } = fixture({ adminUserId: '123456789012345678' });
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const cookie = await loginAs(port, dms);

    const home = await request(port, 'GET', '/member', { headers: { Cookie: cookie } });
    assert.strictEqual(home.statusCode, 200);
    assert.match(home.body, /\/member\/admin/, 'admin nav link is present');

    const admin = await request(port, 'GET', '/member/admin', { headers: { Cookie: cookie } });
    assert.strictEqual(admin.statusCode, 200);
    assert.match(admin.body, /All requests/);
    assert.match(admin.body, /status=pending/);
  } finally {
    await close(server);
  }
});

test('member admin: non-admin gets 403 and no Admin nav link', async () => {
  const { app, dms } = fixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const cookie = await loginAs(port, dms);

    const home = await request(port, 'GET', '/member', { headers: { Cookie: cookie } });
    assert.strictEqual(home.statusCode, 200);
    assert.doesNotMatch(home.body, /\/member\/admin/, 'no admin nav link for regular members');

    const admin = await request(port, 'GET', '/member/admin', { headers: { Cookie: cookie } });
    assert.strictEqual(admin.statusCode, 403);
    assert.match(admin.body, /Admins only/);
  } finally {
    await close(server);
  }
});
