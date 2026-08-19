#!/usr/bin/env node
// Covers the admission-control fix: requireWebhookSecret must reject a bad/missing secret
// without ever touching req.body, so it's safe to run ahead of multer/JSON parsing.
const { test } = require('node:test');
const assert = require('node:assert');
const { requireWebhookSecret } = require('../../src/routes/webhooks');

const SECRET = 'a'.repeat(64);

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function bodyThrowingReq(overrides) {
  const req = { headers: {}, query: {}, ...overrides };
  Object.defineProperty(req, 'body', {
    get() { throw new Error('body was accessed before parsing'); },
  });
  return req;
}

test('requireWebhookSecret rejects a missing/invalid secret before any body access', () => {
  const middleware = requireWebhookSecret(() => SECRET);
  const cases = [
    bodyThrowingReq({ headers: { 'x-webhook-secret': 'wrong' } }),
    bodyThrowingReq({ headers: {} }),
  ];
  for (const req of cases) {
    const res = response();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(res.body, { error: 'Unauthorized' });
  }
});

test('requireWebhookSecret calls next() for a valid header secret without touching the body', () => {
  const middleware = requireWebhookSecret(() => SECRET);
  const req = bodyThrowingReq({ headers: { 'x-webhook-secret': SECRET } });
  const res = response();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
});

test('requireWebhookSecret honors allowQuery for Plex (which cannot send custom headers)', () => {
  const middleware = requireWebhookSecret(() => SECRET, { allowQuery: true });
  const req = bodyThrowingReq({ query: { secret: SECRET } });
  const res = response();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
});

test('requireWebhookSecret treats an unset expected secret as open (matches webhookSecretOk)', () => {
  const middleware = requireWebhookSecret(() => '');
  const req = bodyThrowingReq({});
  const res = response();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
});
