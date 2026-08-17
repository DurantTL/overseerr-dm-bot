#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { createTierAgentAuth } = require('../../src/routes/tier-agent-auth');
const { sha256, safeEqual } = require('../../src/util');

const TOKEN = 'a'.repeat(40);

function setup() {
  const audits = [];
  const auth = createTierAgentAuth({
    getTierAgentTokenHash: node => (node === 'known' ? sha256(TOKEN) : null),
    sha256,
    safeEqual,
    audit: (event, detail) => audits.push({ event, detail }),
  });
  return { auth, audits };
}

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('tier agent auth accepts a matching bearer token for a known node', () => {
  const { auth } = setup();
  const req = { params: { node: 'known' }, headers: { authorization: `Bearer ${TOKEN}` }, ip: '1.2.3.4' };
  const res = response();
  let nextCalled = false;
  auth(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
});

test('tier agent auth rejects before any handler/body work for a bad token, unknown node, or missing header', () => {
  const { auth, audits } = setup();
  const cases = [
    { params: { node: 'known' }, headers: { authorization: 'Bearer wrong' }, ip: '1.2.3.4' },
    { params: { node: 'unknown' }, headers: { authorization: `Bearer ${TOKEN}` }, ip: '1.2.3.4' },
    { params: { node: 'known' }, headers: {}, ip: '1.2.3.4' },
  ];
  for (const req of cases) {
    const res = response();
    let nextCalled = false;
    auth(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(res.body, { error: 'Unauthorized' });
  }
  assert.strictEqual(audits.length, cases.length);
  assert.ok(audits.every(a => a.event === 'tier_agent_auth_failed'));
});

test('tier agent auth is a pure header check: it never reads req.body, so it can run before body parsing', () => {
  const { auth } = setup();
  const req = { params: { node: 'known' }, headers: { authorization: `Bearer ${TOKEN}` }, ip: '1.2.3.4' };
  Object.defineProperty(req, 'body', {
    get() { throw new Error('body was accessed before parsing'); },
  });
  const res = response();
  let nextCalled = false;
  auth(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
});
