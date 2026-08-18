#!/usr/bin/env node
// Dashboard session cookie signing (see issue #177): sessionSecret() must come straight from
// SESSION_SECRET — never derived from the admin password/token via a fast hash, and never a
// per-process fallback that would silently invalidate sessions on restart. validateConfig()
// (tested in config.test.js) is what makes SESSION_SECRET mandatory whenever the dashboard is on;
// this file covers the sign/verify contract that depends on it.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { loadSandbox } = require('./extract');

function makeSandbox(sessionSecretValue) {
  return loadSandbox(
    ['sessionSecret', 'signSession', 'verifySession', 'readCookie'],
    { crypto, CONFIG: { SESSION_SECRET: sessionSecretValue } },
  );
}

test('dashboard session: sessionSecret() is exactly SESSION_SECRET, no derivation or fallback', () => {
  const sandbox = makeSandbox('explicit-secret-value');
  assert.strictEqual(sandbox.run('sessionSecret()'), 'explicit-secret-value');
});

test('dashboard session: a token signed with one secret does not verify under another', () => {
  const a = makeSandbox('secret-a');
  const b = makeSandbox('secret-b');
  const token = a.run('signSession(3600000)');
  assert.strictEqual(a.run(`verifySession(${JSON.stringify(token)})`), true, 'verifies under the signing secret');
  assert.strictEqual(b.run(`verifySession(${JSON.stringify(token)})`), false, 'does not verify under a different secret (e.g. after rotation)');
});

test('dashboard session: a freshly signed token verifies and carries a future expiry', () => {
  const sandbox = makeSandbox('s');
  const token = sandbox.run('signSession(3600000)');
  assert.match(token, /^[\w-]+\.[\w-]+$/, 'payload.signature shape');
  assert.strictEqual(sandbox.run(`verifySession(${JSON.stringify(token)})`), true);
});

test('dashboard session: an expired token does not verify', () => {
  const sandbox = makeSandbox('s');
  const token = sandbox.run('signSession(-1)'); // already expired
  assert.strictEqual(sandbox.run(`verifySession(${JSON.stringify(token)})`), false);
});

test('dashboard session: malformed/tampered/missing tokens never verify', () => {
  const sandbox = makeSandbox('s');
  const token = sandbox.run('signSession(3600000)');
  const [payload, sig] = token.split('.');
  assert.strictEqual(sandbox.run('verifySession(undefined)'), false, 'missing cookie');
  assert.strictEqual(sandbox.run('verifySession("")'), false, 'empty string');
  assert.strictEqual(sandbox.run('verifySession(42)'), false, 'non-string');
  assert.strictEqual(sandbox.run('verifySession("no-dot-separator")'), false, 'no payload/signature separator');
  assert.strictEqual(sandbox.run(`verifySession(${JSON.stringify(`${payload}.tampered${sig}`)})`), false, 'tampered signature');
  assert.strictEqual(sandbox.run(`verifySession(${JSON.stringify(`bm90LWpzb24.${sig}`)})`), false, 'non-JSON payload');
});

test('dashboard session: restart is transparent as long as SESSION_SECRET is unchanged', () => {
  // "Restart" == a fresh sandbox/process reading the same persisted SESSION_SECRET. Sessions
  // must keep verifying — this is the whole point of requiring an explicit, stable secret
  // instead of the old per-process-random fallback.
  const before = makeSandbox('persisted-secret');
  const token = before.run('signSession(3600000)');
  const after = makeSandbox('persisted-secret');
  assert.strictEqual(after.run(`verifySession(${JSON.stringify(token)})`), true);
});

test('dashboard session: rotating SESSION_SECRET invalidates every prior session', () => {
  const before = makeSandbox('old-secret');
  const token = before.run('signSession(3600000)');
  const after = makeSandbox('new-secret');
  assert.strictEqual(after.run(`verifySession(${JSON.stringify(token)})`), false);
});

test('dashboard session: readCookie extracts dm_session from a cookie header', () => {
  const sandbox = makeSandbox('s');
  const req = { headers: { cookie: 'other=1; dm_session=abc.def; another=2' } };
  assert.strictEqual(sandbox.run(`readCookie(${JSON.stringify(req)}, 'dm_session')`), 'abc.def');
  assert.strictEqual(sandbox.run(`readCookie(${JSON.stringify({ headers: {} })}, 'dm_session')`), undefined);
});
