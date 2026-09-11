#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { createDashboardSession, readCookie } = require('../../src/routes/dashboard-auth');

function makeSession(secret, now = Date.now) {
  return createDashboardSession({ secret, ttlHours: 1, now });
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
