#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { rateLimit } = require('express-rate-limit');
const Database = require('better-sqlite3');
const { createApp, listen, close } = require('../../src/app');
const { SqliteRollingWindowStore } = require('../../src/rate-limit');
const {
  createDashboardSession,
  createSessionGeneration,
  createPasswordLoginGate,
  describePasswordLoginState,
  createHeaderAuthThrottle,
  createDashboardAuth,
  registerDashboardAuthRoutes,
} = require('../../src/routes/dashboard-auth');

function request(port, { method = 'GET', path: requestPath = '/', headers = {}, body, form } = {}) {
  return new Promise((resolve, reject) => {
    const payload = form === undefined ? (body === undefined ? undefined : JSON.stringify(body)) : new URLSearchParams(form).toString();
    const contentType = form === undefined ? 'application/json' : 'application/x-www-form-urlencoded';
    const req = http.request({
      host: '127.0.0.1', port, method, path: requestPath,
      headers: payload === undefined ? headers : { 'content-type': contentType, 'content-length': Buffer.byteLength(payload), ...headers },
    }, res => {
      let responseBody = '';
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: responseBody }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function createFixture(overrides = {}) {
  const config = {
    COOKIE_SECURE: true,
    DASHBOARD_ADMIN_PASSWORD: 'correct-password',
    DASHBOARD_ADMIN_TOKEN: 'header-token',
    STRICT_DASHBOARD_POST_AUTH: true,
    ...overrides.config,
  };
  const settings = new Map();
  const sessionGeneration = createSessionGeneration({ store: { get: k => settings.get(k) ?? null, set: (k, v) => settings.set(k, v) }, secret: 'test-session-secret' });
  const session = createDashboardSession({ secret: 'test-session-secret', ttlHours: 1, cookieSecure: config.COOKIE_SECURE !== false, generation: sessionGeneration.current });
  const audits = [];
  const passkeys = overrides.passkeys || [];
  const passwordLoginEnabled = createPasswordLoginGate({ config, listPasskeys: () => passkeys });
  const dashboardAuth = createDashboardAuth({
    config, session, safeEqual: (a, b) => a === b, passwordLoginEnabled,
    ...(overrides.headerThrottle ? { headerThrottle: overrides.headerThrottle, clientKey: () => 'test-client' } : {}),
    onHeaderAuthFailure: failure => audits.push({ event: 'dashboard_header_auth_failed', metadata: failure }),
  });
  const app = createApp({ trustProxy: true });
  registerDashboardAuthRoutes(app, {
    config,
    session,
    dashboardAuth,
    httpRateLimitKey: () => 'test-client',
    renderLogin: (error, message, options) => `login:${error}:${message || ''}:${options.passkeyEnabled}${options.passwordEnabled === false ? ':password-off' : ''}`,
    listPasskeys: () => passkeys,
    passkeyService: overrides.passkeyService || {
      authenticationOptions: async binding => ({ challenge: `challenge:${binding}` }),
      finishAuthentication: async () => {},
      registrationOptions: async (_binding, label) => ({ challenge: 'register', label }),
      finishRegistration: async () => ({ label: 'Laptop' }),
    },
    safeEqual: (a, b) => a === b,
    audit: (event, metadata) => audits.push({ event, metadata }),
    renamePasskey: overrides.renamePasskey || (() => false),
    revokePasskey: overrides.revokePasskey || (() => false),
    passkeyClientPath: path.join(__dirname, '..', '..', 'src', 'passkey-client.js'),
    webauthnBrowserPath: require.resolve('@simplewebauthn/browser'),
    sessionGeneration,
    passwordLoginEnabled,
    ...(overrides.loginStore ? { loginStore: overrides.loginStore } : {}),
  });
  app.get('/admin', rateLimit({ windowMs: 60000, limit: 120 }), dashboardAuth, (_req, res) => res.send('dashboard'));
  app.post('/admin/protected', rateLimit({ windowMs: 60000, limit: 120 }), dashboardAuth, (_req, res) => res.json({ ok: true }));
  return { app, session, audits, sessionGeneration, settings, passkeys };
}

test('dashboard auth routes preserve password login, secure cookie, redirect, and logout contracts', async () => {
  const { app } = createFixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const login = await request(port, { path: '/admin/login' });
    assert.strictEqual(login.statusCode, 200);
    assert.strictEqual(login.body, 'login:false::false');

    const rejected = await request(port, { method: 'POST', path: '/admin/login', form: { password: 'wrong' } });
    assert.strictEqual(rejected.statusCode, 302);
    assert.strictEqual(rejected.headers.location, '/admin/login?error=1');

    const accepted = await request(port, {
      method: 'POST', path: '/admin/login', form: { password: 'correct-password' }, headers: { 'x-forwarded-proto': 'https' },
    });
    assert.strictEqual(accepted.statusCode, 302);
    assert.strictEqual(accepted.headers.location, '/admin');
    assert.match(accepted.headers['set-cookie'][0], /^dm_session=.*HttpOnly; SameSite=Strict; Path=\/admin; Max-Age=3600; Secure$/);
    const cookie = accepted.headers['set-cookie'][0].split(';')[0];

    const dashboard = await request(port, { path: '/admin', headers: { cookie } });
    assert.strictEqual(dashboard.statusCode, 200);
    assert.strictEqual(dashboard.body, 'dashboard');

    const logout = await request(port, { method: 'POST', path: '/admin/logout', headers: { cookie } });
    assert.strictEqual(logout.statusCode, 302);
    assert.strictEqual(logout.headers.location, '/admin/login');
    assert.strictEqual(logout.headers['set-cookie'][0], 'dm_session=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0');
  } finally {
    await close(server);
  }
});

test('dashboard middleware preserves browser redirects, header auth, and exact same-origin POST checks', async () => {
  const { app } = createFixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const browser = await request(port, { path: '/admin', headers: { accept: 'text/html' } });
    assert.strictEqual(browser.statusCode, 302);
    assert.strictEqual(browser.headers.location, '/admin/login');
    assert.strictEqual((await request(port, { path: '/admin' })).statusCode, 401);
    assert.strictEqual((await request(port, { path: '/admin', headers: { 'x-admin-token': 'header-token' } })).statusCode, 200);

    const hostile = await request(port, {
      method: 'POST', path: '/admin/protected', body: {},
      headers: { 'x-admin-password': 'correct-password', origin: 'http://127.0.0.1.evil.test' },
    });
    assert.strictEqual(hostile.statusCode, 403);
    assert.strictEqual(hostile.body, 'Cross-site POST denied');
    const sameOrigin = await request(port, {
      method: 'POST', path: '/admin/protected', body: {},
      headers: { 'x-admin-password': 'correct-password', origin: `http://127.0.0.1:${port}` },
    });
    assert.strictEqual(sameOrigin.statusCode, 200);
  } finally {
    await close(server);
  }
});

test('passkey login preserves no-store options, binding cookie, verification, and failure responses', async () => {
  let expectedBinding;
  const passkeyService = {
    authenticationOptions: async binding => { expectedBinding = binding; return { challenge: 'login-challenge' }; },
    finishAuthentication: async (binding, body) => {
      if (binding !== expectedBinding || body.answer !== 'valid') throw new Error('invalid');
    },
    registrationOptions: async () => ({}),
    finishRegistration: async () => ({ label: 'unused' }),
  };
  const { app, audits } = createFixture({ passkeys: [{ credential_id: 'one' }], passkeyService });
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const options = await request(port, { path: '/admin/passkey/authentication-options', headers: { 'x-forwarded-proto': 'https' } });
    assert.strictEqual(options.statusCode, 200);
    assert.strictEqual(options.headers['cache-control'], 'no-store');
    assert.deepStrictEqual(JSON.parse(options.body), { challenge: 'login-challenge' });
    assert.match(options.headers['set-cookie'][0], /^dm_webauthn=.*Max-Age=300; Secure$/);
    const bindingCookie = options.headers['set-cookie'][0].split(';')[0];

    const authenticated = await request(port, {
      method: 'POST', path: '/admin/passkey/authenticate', body: { answer: 'valid' }, headers: { cookie: bindingCookie },
    });
    assert.strictEqual(authenticated.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(authenticated.body), { verified: true });
    assert.strictEqual(authenticated.headers['set-cookie'].length, 3);
    assert.match(authenticated.headers['set-cookie'][0], /^dm_session=/);
    assert.match(authenticated.headers['set-cookie'][1], /^dm_setup_nudge=;/);
    assert.match(authenticated.headers['set-cookie'][2], /^dm_webauthn=;/);
    assert.ok(audits.some(entry => entry.event === 'dashboard_login_success' && entry.metadata.method === 'passkey'));

    const failed = await request(port, { method: 'POST', path: '/admin/passkey/authenticate', body: { answer: 'bad' } });
    assert.strictEqual(failed.statusCode, 401);
    assert.deepStrictEqual(JSON.parse(failed.body), { verified: false, error: 'Passkey sign-in failed.' });
  } finally {
    await close(server);
  }
});

test('passkey challenge cookie Secure flag follows COOKIE_SECURE config (L2)', async () => {
  // L2: the Secure flag is config-driven, not header-driven. With COOKIE_SECURE=true the
  // challenge cookie carries `; Secure` even without X-Forwarded-Proto; with false it omits it.
  const { app } = createFixture({ config: { COOKIE_SECURE: false }, passkeys: [{ credential_id: 'one' }] });
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const plain = await request(port, { path: '/admin/passkey/authentication-options' });
    assert.strictEqual(plain.statusCode, 200);
    assert.match(plain.headers['set-cookie'][0], /^dm_webauthn=[^;]+; HttpOnly; SameSite=Strict; Path=\/admin; Max-Age=300$/);
    // And with the flag on, a spoofed plain-http header cannot clear it.
    const { app: app2 } = createFixture({ passkeys: [{ credential_id: 'one' }] });
    const server2 = await listen(app2, 0);
    try {
      const port2 = server2.address().port;
      const spoofed = await request(port2, { path: '/admin/passkey/authentication-options', headers: { 'x-forwarded-proto': 'http' } });
      assert.strictEqual(spoofed.statusCode, 200);
      assert.match(spoofed.headers['set-cookie'][0], /; Secure$/);
    } finally {
      await close(server2);
    }
  } finally {
    await close(server);
  }
});

test('authenticated passkey management preserves validation and last-credential protection', async () => {
  const { app, session } = createFixture({
    config: { DASHBOARD_ADMIN_PASSWORD: '', DASHBOARD_ADMIN_TOKEN: '' },
    passkeys: [{ credential_id: 'only' }],
    renamePasskey: () => false,
    revokePasskey: () => true,
  });
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const cookie = `dm_session=${session.sign()}`;
    assert.strictEqual((await request(port, { method: 'POST', path: '/admin/passkey/registration-options', body: { label: 'Phone' } })).statusCode, 401);

    const options = await request(port, { method: 'POST', path: '/admin/passkey/registration-options', body: { label: 'Phone' }, headers: { cookie } });
    assert.strictEqual(options.statusCode, 200);
    assert.strictEqual(options.headers['cache-control'], 'no-store');
    assert.deepStrictEqual(JSON.parse(options.body), { challenge: 'register', label: 'Phone' });

    const invalidRename = await request(port, { method: 'POST', path: '/admin/passkey/rename', body: { credentialId: 'only', label: '' }, headers: { cookie } });
    assert.strictEqual(invalidRename.statusCode, 400);
    const missingRename = await request(port, { method: 'POST', path: '/admin/passkey/rename', body: { credentialId: 'missing', label: 'Phone' }, headers: { cookie } });
    assert.strictEqual(missingRename.statusCode, 404);
    const lastRevoke = await request(port, { method: 'POST', path: '/admin/passkey/revoke', body: { credentialId: 'only' }, headers: { cookie } });
    assert.strictEqual(lastRevoke.statusCode, 409);
    assert.match(JSON.parse(lastRevoke.body).error, /password fallback/);
  } finally {
    await close(server);
  }
});

test('password login sets the passkey-setup nudge cookie; logout clears it', async () => {
  const { app } = createFixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const accepted = await request(port, {
      method: 'POST', path: '/admin/login', form: { password: 'correct-password' }, headers: { 'x-forwarded-proto': 'https' },
    });
    assert.strictEqual(accepted.statusCode, 302);
    const nudge = accepted.headers['set-cookie'].find(c => c.startsWith('dm_setup_nudge='));
    assert.ok(nudge, 'password login sets the nudge cookie');
    assert.match(nudge, /^dm_setup_nudge=1; HttpOnly; SameSite=Strict; Path=\/admin; Secure; Max-Age=43200$/);

    const logout = await request(port, { method: 'POST', path: '/admin/logout' });
    const cleared = logout.headers['set-cookie'].find(c => c.startsWith('dm_setup_nudge='));
    assert.ok(cleared, 'logout clears the nudge cookie');
    assert.match(cleared, /^dm_setup_nudge=; HttpOnly; SameSite=Strict; Path=\/admin; Max-Age=0/);
  } finally { await close(server); }
});

test('wrong admin headers are throttled per client without affecting cookie sessions', async () => {
  const config = { DASHBOARD_ADMIN_PASSWORD: 'correct-password', DASHBOARD_ADMIN_TOKEN: '', STRICT_DASHBOARD_POST_AUTH: true };
  const session = createDashboardSession({ secret: 'test-session-secret', ttlHours: 1 });
  let clock = 1_000_000;
  const failures = [];
  const dashboardAuth = createDashboardAuth({
    config, session, safeEqual: (a, b) => a === b,
    headerThrottle: createHeaderAuthThrottle({ limit: 3, windowMs: 60000, now: () => clock }),
    onHeaderAuthFailure: failure => failures.push(failure),
  });
  const app = createApp();
  app.get('/admin/x', dashboardAuth, (_req, res) => res.send('ok'));
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    for (let i = 0; i < 3; i++) {
      const wrong = await request(port, { path: '/admin/x', headers: { 'x-admin-password': `guess-${i}` } });
      assert.strictEqual(wrong.statusCode, 401);
    }
    assert.deepStrictEqual(failures.map(f => f.attempt), [1, 2, 3]);

    // Locked: even the right password is refused for header auth until the window passes.
    const locked = await request(port, { path: '/admin/x', headers: { 'x-admin-password': 'correct-password' } });
    assert.strictEqual(locked.statusCode, 429);

    // A signed-in browser session is unaffected by the header lockout.
    const cookie = await request(port, { path: '/admin/x', headers: { cookie: `dm_session=${session.sign()}`, 'x-admin-password': 'stale' } });
    assert.strictEqual(cookie.statusCode, 200);

    clock += 60001;
    const reopened = await request(port, { path: '/admin/x', headers: { 'x-admin-password': 'correct-password' } });
    assert.strictEqual(reopened.statusCode, 200);
  } finally {
    await close(server);
  }
});

// Restart-survival: the sign-in limiters and header-failure counter keep their counts in SQLite.
// "Restart" here is a brand-new app, limiters and throttle built over the same database file,
// which is exactly what a container restart does (in-memory state gone, SQLite kept).
function limitDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE rate_limit_hits (
    scope TEXT NOT NULL, identity TEXT NOT NULL, hit_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  ); CREATE INDEX idx_rate_limit_bucket ON rate_limit_hits(scope, identity, expires_at);`);
  return db;
}
function persistentFixture(db, clock, overrides = {}) {
  return createFixture({
    ...overrides,
    loginStore: ({ scope, limit, windowMs }) => new SqliteRollingWindowStore({ db, scope, limit, windowMs, now: () => clock.now }),
    headerThrottle: createHeaderAuthThrottle({
      limit: 10, windowMs: 15 * 60000,
      store: new SqliteRollingWindowStore({ db, scope: 'dashboard-header-auth-failures', limit: 10, windowMs: 15 * 60000, now: () => clock.now }),
    }),
  });
}

test('password login limit (5 per 15 min) survives a restart and still answers 429', async () => {
  const db = limitDb();
  const clock = { now: 1_000_000 };
  let fx = persistentFixture(db, clock);
  let server = await listen(fx.app, 0);
  try {
    let port = server.address().port;
    for (let i = 0; i < 5; i++) {
      const wrong = await request(port, { method: 'POST', path: '/admin/login', form: { password: `guess-${i}` } });
      assert.strictEqual(wrong.statusCode, 302);
      assert.strictEqual(wrong.headers.location, '/admin/login?error=1');
    }
    assert.strictEqual(fx.audits.filter(a => a.event === 'dashboard_login_failed').length, 5, 'each failure audited as before');
    await close(server);

    fx = persistentFixture(db, clock);
    server = await listen(fx.app, 0);
    port = server.address().port;
    const limited = await request(port, { method: 'POST', path: '/admin/login', form: { password: 'correct-password' } });
    assert.strictEqual(limited.statusCode, 429, 'still limited after the restart');
    assert.strictEqual(limited.body, 'login:false:Too many attempts. Try again in a few minutes.:false', 'same 429 page');

    clock.now += 15 * 60000;
    const reopened = await request(port, { method: 'POST', path: '/admin/login', form: { password: 'correct-password' } });
    assert.strictEqual(reopened.statusCode, 302, 'window over: sign-in works');
    assert.strictEqual(reopened.headers.location, '/admin');
  } finally {
    await close(server);
    db.close();
  }
});

test('passkey authenticate limit (10 per 15 min) survives a restart', async () => {
  const db = limitDb();
  const clock = { now: 1_000_000 };
  const failing = { authenticationOptions: async () => ({}), finishAuthentication: async () => { throw new Error('bad'); } };
  let fx = persistentFixture(db, clock, { passkeyService: failing });
  let server = await listen(fx.app, 0);
  try {
    let port = server.address().port;
    for (let i = 0; i < 10; i++) {
      assert.strictEqual((await request(port, { method: 'POST', path: '/admin/passkey/authenticate', body: {} })).statusCode, 401);
    }
    await close(server);
    fx = persistentFixture(db, clock);
    server = await listen(fx.app, 0);
    port = server.address().port;
    const limited = await request(port, { method: 'POST', path: '/admin/passkey/authenticate', body: { answer: 'valid' } });
    assert.strictEqual(limited.statusCode, 429);
    assert.deepStrictEqual(JSON.parse(limited.body), { error: 'Too many attempts. Try again in a few minutes.' });
    clock.now += 15 * 60000;
    const ok = await request(port, { method: 'POST', path: '/admin/passkey/authenticate', body: { answer: 'valid' } });
    assert.strictEqual(ok.statusCode, 200, 'a valid passkey works once the window is over');
  } finally {
    await close(server);
    db.close();
  }
});

test('header-auth failures (10 per 15 min) survive a restart; cookie sessions are never throttled', async () => {
  const db = limitDb();
  const clock = { now: 1_000_000 };
  let fx = persistentFixture(db, clock);
  let server = await listen(fx.app, 0);
  try {
    let port = server.address().port;
    assert.strictEqual((await request(port, { path: '/admin', headers: { 'x-admin-token': 'header-token' } })).statusCode, 200, 'right header works');
    for (let i = 0; i < 10; i++) {
      assert.strictEqual((await request(port, { path: '/admin', headers: { 'x-admin-token': `guess-${i}` } })).statusCode, 401);
    }
    assert.deepStrictEqual(fx.audits.filter(a => a.event === 'dashboard_header_auth_failed').map(a => a.metadata.attempt), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await close(server);

    fx = persistentFixture(db, clock);
    server = await listen(fx.app, 0);
    port = server.address().port;
    assert.strictEqual((await request(port, { path: '/admin', headers: { 'x-admin-token': 'header-token' } })).statusCode, 429, 'still blocked after the restart, even with the right token');
    const cookie = `dm_session=${fx.session.sign()}`;
    assert.strictEqual((await request(port, { path: '/admin', headers: { cookie, 'x-admin-token': 'stale' } })).statusCode, 200, 'a signed-in browser is unaffected');

    clock.now += 15 * 60000;
    assert.strictEqual((await request(port, { path: '/admin', headers: { 'x-admin-token': 'header-token' } })).statusCode, 200, 'window over: header auth works');
  } finally {
    await close(server);
    db.close();
  }
});

const sessionCookieFrom = res => (res.headers['set-cookie'] || []).find(c => c.startsWith('dm_session='));
const cookiePair = header => header.split(';')[0];

test('sign out everywhere: needs auth, ends every session, clears this cookie, and is audited', async () => {
  const { app, session, audits, sessionGeneration } = createFixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const path = '/admin/sessions/sign-out-everywhere';
    assert.strictEqual((await request(port, { method: 'POST', path, body: {} })).statusCode, 401, 'unauthenticated');
    assert.strictEqual(sessionGeneration.current(), 0, 'a refused request bumps nothing');

    const mine = `dm_session=${session.sign()}`;
    const other = `dm_session=${session.sign()}`;
    assert.strictEqual((await request(port, { path: '/admin', headers: { cookie: other } })).statusCode, 200, 'other browser signed in');

    const out = await request(port, { method: 'POST', path, body: {}, headers: { cookie: mine } });
    assert.strictEqual(out.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(out.body), { ok: true, redirect: '/admin/login' });
    assert.match(sessionCookieFrom(out), /^dm_session=; HttpOnly; SameSite=Strict; Path=\/admin; Max-Age=0$/);
    assert.strictEqual(sessionGeneration.current(), 1);
    assert.deepStrictEqual(audits.filter(a => a.event === 'dashboard_sign_out_everywhere').map(a => a.metadata.generation), [1]);

    for (const cookie of [mine, other]) {
      assert.strictEqual((await request(port, { path: '/admin', headers: { cookie } })).statusCode, 401, 'old-generation cookie rejected');
    }

    // A fresh password login works afterwards and the new cookie is accepted.
    const login = await request(port, { method: 'POST', path: '/admin/login', form: { password: 'correct-password' } });
    assert.strictEqual(login.statusCode, 302);
    assert.strictEqual(login.headers.location, '/admin');
    const fresh = cookiePair(sessionCookieFrom(login));
    assert.strictEqual((await request(port, { path: '/admin', headers: { cookie: fresh } })).statusCode, 200);

    // Header auth isn't a session and keeps working.
    assert.strictEqual((await request(port, { path: '/admin', headers: { 'x-admin-token': 'header-token' } })).statusCode, 200);
  } finally {
    await close(server);
  }
});

test('passkey login after a bump issues a current-generation session', async () => {
  const { app, sessionGeneration } = createFixture({ passkeys: [{ credential_id: 'a' }] });
  sessionGeneration.bump();
  sessionGeneration.bump();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const options = await request(port, { path: '/admin/passkey/authentication-options' });
    const binding = cookiePair(options.headers['set-cookie'].find(c => c.startsWith('dm_webauthn=')));
    const verified = await request(port, { method: 'POST', path: '/admin/passkey/authenticate', body: { answer: 'valid' }, headers: { cookie: binding } });
    assert.strictEqual(verified.statusCode, 200);
    const cookie = cookiePair(sessionCookieFrom(verified));
    assert.strictEqual((await request(port, { path: '/admin', headers: { cookie } })).statusCode, 200);
  } finally {
    await close(server);
  }
});

test('passkey revoke ends every other session, keeps the revoking browser signed in, and is audited', async () => {
  const { app, session, audits, sessionGeneration } = createFixture({ passkeys: [{ credential_id: 'a' }, { credential_id: 'b' }], revokePasskey: () => true });
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const mine = `dm_session=${session.sign()}`;
    const other = `dm_session=${session.sign()}`;
    const revoked = await request(port, { method: 'POST', path: '/admin/passkey/revoke', body: { credentialId: 'b' }, headers: { cookie: mine } });
    assert.strictEqual(revoked.statusCode, 200);
    assert.strictEqual(sessionGeneration.current(), 1);
    assert.deepStrictEqual(audits.filter(a => a.event === 'dashboard_session_generation_bumped').map(a => a.metadata.reason), ['passkey_revoked']);
    assert.ok(audits.some(a => a.event === 'dashboard_passkey_revoked'), 'the revoke itself is still audited');

    const replaced = sessionCookieFrom(revoked);
    assert.match(replaced, /; HttpOnly; SameSite=Strict; Path=\/admin; Max-Age=3600; Secure$/, 'same cookie flags as a login');
    assert.strictEqual((await request(port, { path: '/admin', headers: { cookie: cookiePair(replaced) } })).statusCode, 200, 'revoking browser stays in');
    for (const cookie of [mine, other]) {
      assert.strictEqual((await request(port, { path: '/admin', headers: { cookie } })).statusCode, 401, 'every earlier session ends');
    }

    // Header-authenticated revoke: bumped too, but no cookie is handed out.
    const viaHeader = await request(port, { method: 'POST', path: '/admin/passkey/revoke', body: { credentialId: 'a' }, headers: { 'x-admin-token': 'header-token' } });
    assert.strictEqual(viaHeader.statusCode, 200);
    assert.strictEqual(sessionGeneration.current(), 2);
    assert.strictEqual(sessionCookieFrom(viaHeader), undefined);
  } finally {
    await close(server);
  }
});

test('logout still only clears the browser cookie', async () => {
  const { app, session, sessionGeneration } = createFixture();
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const out = await request(port, { method: 'POST', path: '/admin/logout', headers: { cookie: `dm_session=${session.sign()}` } });
    assert.strictEqual(out.statusCode, 302);
    assert.strictEqual(out.headers.location, '/admin/login');
    assert.match(sessionCookieFrom(out), /^dm_session=; HttpOnly; SameSite=Strict; Path=\/admin; Max-Age=0$/);
    assert.strictEqual(sessionGeneration.current(), 0, 'logout does not end other sessions');
  } finally {
    await close(server);
  }
});

// DASHBOARD_PASSWORD_LOGIN
const OFF = { DASHBOARD_PASSWORD_LOGIN: false };

test('password login off (with a passkey enrolled): the form and admin headers are refused, passkey sign-in works', async () => {
  const { app, session, audits } = createFixture({ config: OFF, passkeys: [{ credential_id: 'a' }] });
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const page = await request(port, { path: '/admin/login' });
    assert.strictEqual(page.body, 'login:false::true:password-off', 'login page hides the password form');

    const form = await request(port, { method: 'POST', path: '/admin/login', form: { password: 'correct-password' } });
    assert.strictEqual(form.statusCode, 403, 'right password refused');
    assert.match(form.body, /Password sign-in is turned off/);
    assert.ok(!(form.headers['set-cookie'] || []).some(c => c.startsWith('dm_session=')), 'no session issued');
    const tokenInForm = await request(port, { method: 'POST', path: '/admin/login', form: { password: 'header-token' } });
    assert.strictEqual(tokenInForm.statusCode, 403, 'admin token in the form refused too');
    assert.deepStrictEqual(audits.filter(a => a.event === 'dashboard_login_failed').map(a => a.metadata.reason), ['password_login_disabled', 'password_login_disabled']);

    for (const headers of [{ 'x-admin-password': 'correct-password' }, { 'x-admin-token': 'header-token' }]) {
      assert.strictEqual((await request(port, { path: '/admin', headers })).statusCode, 401, `${Object.keys(headers)[0]} refused`);
      assert.strictEqual((await request(port, { method: 'POST', path: '/admin/protected', body: {}, headers })).statusCode, 401);
    }
    assert.strictEqual(audits.filter(a => a.event === 'dashboard_header_auth_failed').length, 0, 'ignored headers are not counted as guesses');

    const options = await request(port, { path: '/admin/passkey/authentication-options' });
    const binding = options.headers['set-cookie'].find(c => c.startsWith('dm_webauthn=')).split(';')[0];
    const passkey = await request(port, { method: 'POST', path: '/admin/passkey/authenticate', body: { answer: 'valid' }, headers: { cookie: binding } });
    assert.strictEqual(passkey.statusCode, 200);
    const cookie = passkey.headers['set-cookie'].find(c => c.startsWith('dm_session=')).split(';')[0];
    assert.strictEqual((await request(port, { path: '/admin', headers: { cookie } })).statusCode, 200, 'passkey session gets in');
    assert.strictEqual((await request(port, { path: '/admin', headers: { cookie: `dm_session=${session.sign()}` } })).statusCode, 200, 'existing sessions keep working');
  } finally {
    await close(server);
  }
});

test('password login off but no passkey enrolled: the flag is ignored and password sign-in still works', async () => {
  const { app } = createFixture({ config: OFF });
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    assert.strictEqual((await request(port, { path: '/admin/login' })).body, 'login:false::false', 'normal login page');
    const form = await request(port, { method: 'POST', path: '/admin/login', form: { password: 'correct-password' } });
    assert.strictEqual(form.statusCode, 302);
    assert.strictEqual(form.headers.location, '/admin');
    assert.strictEqual((await request(port, { path: '/admin', headers: { 'x-admin-token': 'header-token' } })).statusCode, 200);
  } finally {
    await close(server);
  }
  assert.deepStrictEqual(describePasswordLoginState({ config: OFF, listPasskeys: () => [] }).level, 'warn');
  assert.match(describePasswordLoginState({ config: OFF, listPasskeys: () => [] }).message, /no passkey is enrolled, so it is ignored/);
  assert.match(describePasswordLoginState({ config: OFF, listPasskeys: () => [{}, {}] }).message, /passkey-only \(2 passkeys enrolled\).*DASHBOARD_PASSWORD_LOGIN=on and recreate the bot container/);
  assert.strictEqual(describePasswordLoginState({ config: { DASHBOARD_PASSWORD_LOGIN: true }, listPasskeys: () => [{}] }), null, 'on: nothing to log');
});

test('password login off: revoking the last passkey brings password sign-in back; the last-passkey guard is unchanged', async () => {
  const passkeys = [{ credential_id: 'a' }, { credential_id: 'b' }];
  const { app, session } = createFixture({
    config: OFF, passkeys,
    revokePasskey: id => { const i = passkeys.findIndex(p => p.credential_id === id); if (i < 0) return false; passkeys.splice(i, 1); return true; },
  });
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    let cookie = `dm_session=${session.sign()}`;
    assert.strictEqual((await request(port, { method: 'POST', path: '/admin/login', form: { password: 'correct-password' } })).statusCode, 403, 'two passkeys: password off');
    const first = await request(port, { method: 'POST', path: '/admin/passkey/revoke', body: { credentialId: 'b' }, headers: { cookie } });
    assert.strictEqual(first.statusCode, 200);
    cookie = first.headers['set-cookie'].find(c => c.startsWith('dm_session=')).split(';')[0];
    assert.strictEqual((await request(port, { method: 'POST', path: '/admin/login', form: { password: 'correct-password' } })).statusCode, 403, 'one passkey left: still off');
    const last = await request(port, { method: 'POST', path: '/admin/passkey/revoke', body: { credentialId: 'a' }, headers: { cookie } });
    assert.strictEqual(last.statusCode, 200, 'a password fallback exists, so the last passkey may go');
    assert.strictEqual((await request(port, { method: 'POST', path: '/admin/login', form: { password: 'correct-password' } })).statusCode, 302, 'no passkeys left: password sign-in is back');
  } finally {
    await close(server);
  }

  // No fallback configured: the last passkey still cannot be revoked, flag or no flag.
  const guarded = createFixture({ config: { ...OFF, DASHBOARD_ADMIN_PASSWORD: '', DASHBOARD_ADMIN_TOKEN: '' }, passkeys: [{ credential_id: 'only' }], revokePasskey: () => true });
  const guardedServer = await listen(guarded.app, 0);
  try {
    const res = await request(guardedServer.address().port, { method: 'POST', path: '/admin/passkey/revoke', body: { credentialId: 'only' }, headers: { cookie: `dm_session=${guarded.session.sign()}` } });
    assert.strictEqual(res.statusCode, 409);
  } finally {
    await close(guardedServer);
  }
});

test('password login on (the default): form and admin headers behave exactly as before, passkeys enrolled or not', async () => {
  for (const passkeys of [[], [{ credential_id: 'a' }]]) {
    const { app } = createFixture({ passkeys });
    const server = await listen(app, 0);
    try {
      const port = server.address().port;
      assert.strictEqual((await request(port, { path: '/admin/login' })).body, `login:false::${passkeys.length > 0}`);
      assert.strictEqual((await request(port, { method: 'POST', path: '/admin/login', form: { password: 'correct-password' } })).headers.location, '/admin');
      assert.strictEqual((await request(port, { path: '/admin', headers: { 'x-admin-password': 'correct-password' } })).statusCode, 200);
      assert.strictEqual((await request(port, { path: '/admin', headers: { 'x-admin-token': 'header-token' } })).statusCode, 200);
    } finally {
      await close(server);
    }
  }
});
