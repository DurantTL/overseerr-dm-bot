#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createDashboardSession, createSessionGeneration, SESSION_GENERATION_KEY, SESSION_CREDENTIALS_KEY, readCookie } = require('../../src/routes/dashboard-auth');

function makeSession(secret, now = Date.now, cookieSecure = false) {
  return createDashboardSession({ secret, ttlHours: 1, now, cookieSecure });
}

test('dashboard session: a token signed with one secret does not verify under another', () => {
  const a = makeSession('secret-a');
  const b = makeSession('secret-b');
  const token = a.sign(3600000);
  assert.strictEqual(a.verify(token), true, 'verifies under the signing secret');
  assert.strictEqual(b.verify(token), false, 'does not verify under a different secret (e.g. after rotation)');
});

test('dashboard session: a freshly signed token verifies and carries a future expiry', () => {
  const session = makeSession('s');
  const token = session.sign(3600000);
  assert.match(token, /^[\w-]+\.[\w-]+$/, 'payload.signature shape');
  assert.strictEqual(session.verify(token), true);
});

test('dashboard session: an expired token does not verify', () => {
  const session = makeSession('s');
  const token = session.sign(-1);
  assert.strictEqual(session.verify(token), false);
});

test('dashboard session: malformed/tampered/missing tokens never verify', () => {
  const session = makeSession('s');
  const token = session.sign(3600000);
  const [payload, sig] = token.split('.');
  assert.strictEqual(session.verify(undefined), false, 'missing cookie');
  assert.strictEqual(session.verify(''), false, 'empty string');
  assert.strictEqual(session.verify(42), false, 'non-string');
  assert.strictEqual(session.verify('no-dot-separator'), false, 'no payload/signature separator');
  assert.strictEqual(session.verify(`${payload}.tampered${sig}`), false, 'tampered signature');
  assert.strictEqual(session.verify(`bm90LWpzb24.${sig}`), false, 'non-JSON payload');
});

test('dashboard session: restart is transparent as long as SESSION_SECRET is unchanged', () => {
  // "Restart" == a fresh sandbox/process reading the same persisted SESSION_SECRET. Sessions
  // must keep verifying — this is the whole point of requiring an explicit, stable secret
  // instead of the old per-process-random fallback.
  const before = makeSession('persisted-secret');
  const token = before.sign(3600000);
  const after = makeSession('persisted-secret');
  assert.strictEqual(after.verify(token), true);
});

test('dashboard session: rotating SESSION_SECRET invalidates every prior session', () => {
  const before = makeSession('old-secret');
  const token = before.sign(3600000);
  const after = makeSession('new-secret');
  assert.strictEqual(after.verify(token), false);
});

test('dashboard session: readCookie extracts dm_session from a cookie header', () => {
  const req = { headers: { cookie: 'other=1; dm_session=abc.def; another=2' } };
  assert.strictEqual(readCookie(req, 'dm_session'), 'abc.def');
  assert.strictEqual(readCookie({ headers: {} }, 'dm_session'), undefined);
});

test('dashboard session: setCookie marks `; Secure` from cookieSecure config (L2)', () => {
  // L2: the Secure flag is config-driven (COOKIE_SECURE), not header-driven. A spoofed
  // X-Forwarded-Proto must not flip it.
  const secureSession = makeSession('s', Date.now, true);
  const insecureSession = makeSession('s', Date.now, false);
  const cookieFor = (session, req) => {
    let header;
    session.setCookie(req, { setHeader: (_name, value) => { header = value; } });
    return header;
  };
  assert.match(cookieFor(secureSession, { secure: false, headers: {} }), /; Secure$/, 'config on → Secure even on plain request');
  assert.match(cookieFor(secureSession, { secure: false, headers: { 'x-forwarded-proto': 'http' } }), /; Secure$/, 'config on → spoofed http header cannot clear Secure');
  assert.doesNotMatch(cookieFor(insecureSession, { secure: false, headers: {} }), /Secure/, 'config off → no Secure flag');
  assert.doesNotMatch(cookieFor(insecureSession, { secure: true, headers: {} }), /Secure/, 'config off → req.secure cannot set Secure');
  assert.doesNotMatch(cookieFor(insecureSession, { secure: false, headers: { 'x-forwarded-proto': 'https' } }), /Secure/, 'config off → spoofed https header cannot set Secure');
  assert.match(
    cookieFor(insecureSession, { secure: false, headers: {} }),
    /^dm_session=[^;]+; HttpOnly; SameSite=Strict; Path=\/admin; Max-Age=3600$/,
    'the insecure cookie keeps every other attribute',
  );
});

function memoryStore() {
  const map = new Map();
  return { map, get: k => (map.has(k) ? map.get(k) : null), set: (k, v) => map.set(k, String(v)) };
}

test('dashboard session: a token from before session generations (no g) is rejected', () => {
  const secret = 's';
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 3600000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  assert.strictEqual(makeSession(secret).verify(`${payload}.${signature}`), false);
});

test('session generation: a bump rejects every older token and new tokens verify', () => {
  const store = memoryStore();
  const gen = createSessionGeneration({ store, secret: 's' });
  const session = createDashboardSession({ secret: 's', ttlHours: 1, generation: gen.current });
  const before = session.sign();
  assert.strictEqual(session.verify(before), true);
  assert.strictEqual(gen.bump(), 1);
  assert.strictEqual(store.get(SESSION_GENERATION_KEY), '1', 'stored in app_settings');
  assert.strictEqual(session.verify(before), false, 'old generation rejected');
  assert.strictEqual(session.verify(session.sign()), true, 'current generation accepted');
});

test('session generation: survives a restart (read back from the store)', () => {
  const store = memoryStore();
  const first = createSessionGeneration({ store, secret: 's' });
  first.bump(); first.bump();
  const token = createDashboardSession({ secret: 's', ttlHours: 1, generation: first.current }).sign();
  const after = createSessionGeneration({ store, secret: 's' });
  assert.strictEqual(after.current(), 2);
  assert.strictEqual(createDashboardSession({ secret: 's', ttlHours: 1, generation: after.current }).verify(token), true);
});

test('session generation: a changed admin password or token bumps once; unchanged does not', () => {
  const store = memoryStore();
  const gen = createSessionGeneration({ store, secret: 's' });
  assert.deepStrictEqual(gen.syncCredentials({ password: 'pw', token: 'tk' }), { changed: false, recorded: true }, 'first run only records');
  assert.strictEqual(gen.current(), 0);
  assert.deepStrictEqual(gen.syncCredentials({ password: 'pw', token: 'tk' }), { changed: false });
  assert.deepStrictEqual(gen.syncCredentials({ password: 'pw2', token: 'tk' }), { changed: true, generation: 1 }, 'password changed');
  assert.deepStrictEqual(gen.syncCredentials({ password: 'pw2', token: 'tk2' }), { changed: true, generation: 2 }, 'token changed');
  assert.deepStrictEqual(gen.syncCredentials({ password: 'pw2', token: 'tk2' }), { changed: false });
  const stored = store.get(SESSION_CREDENTIALS_KEY);
  assert.ok(!stored.includes('pw2') && !stored.includes('tk2'), 'stores a keyed fingerprint, never the values');
});
