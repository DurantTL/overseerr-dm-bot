#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { rateLimit } = require('express-rate-limit');
const { createApp, listen, close } = require('../../src/app');
const {
  createDashboardSession,
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
    DASHBOARD_ADMIN_PASSWORD: 'correct-password',
    DASHBOARD_ADMIN_TOKEN: 'header-token',
    STRICT_DASHBOARD_POST_AUTH: true,
    ...overrides.config,
  };
  const session = createDashboardSession({ secret: 'test-session-secret', ttlHours: 1 });
  const dashboardAuth = createDashboardAuth({ config, session, safeEqual: (a, b) => a === b });
  const passkeys = overrides.passkeys || [];
  const audits = [];
  const app = createApp({ trustProxy: true });
  registerDashboardAuthRoutes(app, {
    config,
    session,
    dashboardAuth,
    httpRateLimitKey: () => 'test-client',
    renderLogin: (error, message, options) => `login:${error}:${message || ''}:${options.passkeyEnabled}`,
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
  });
  app.get('/admin', rateLimit({ windowMs: 60000, limit: 120 }), dashboardAuth, (_req, res) => res.send('dashboard'));
  app.post('/admin/protected', rateLimit({ windowMs: 60000, limit: 120 }), dashboardAuth, (_req, res) => res.json({ ok: true }));
  return { app, session, audits };
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
    assert.strictEqual(authenticated.headers['set-cookie'].length, 2);
    assert.match(authenticated.headers['set-cookie'][0], /^dm_session=/);
    assert.match(authenticated.headers['set-cookie'][1], /^dm_webauthn=;/);
    assert.ok(audits.some(entry => entry.event === 'dashboard_login_success' && entry.metadata.method === 'passkey'));

    const failed = await request(port, { method: 'POST', path: '/admin/passkey/authenticate', body: { answer: 'bad' } });
    assert.strictEqual(failed.statusCode, 401);
    assert.deepStrictEqual(JSON.parse(failed.body), { verified: false, error: 'Passkey sign-in failed.' });
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
