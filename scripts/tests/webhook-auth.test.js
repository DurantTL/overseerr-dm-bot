#!/usr/bin/env node
// Shared-secret gate on the three inbound webhook routes. The Plex route is the only one that
// accepts the secret in the query string, because Plex's webhook feature cannot send headers.
const { test } = require('node:test');
const assert = require('node:assert');
const { webhookSecretOk } = require('../../src/routes/webhooks');

const SECRET = 'a'.repeat(64);
const check = (req, expected, opts) => webhookSecretOk(req, expected, opts);

test('webhook auth: header secret accepted, wrong or missing rejected', () => {
  assert.strictEqual(check({ headers: { 'x-webhook-secret': SECRET } }, SECRET), true, 'correct header passes');
  assert.strictEqual(check({ headers: {} }, SECRET), false, 'missing header rejected');
  assert.strictEqual(check({ headers: { 'x-webhook-secret': 'b'.repeat(64) } }, SECRET), false, 'wrong secret rejected');
  assert.strictEqual(check({ headers: { 'x-webhook-secret': SECRET.slice(0, 32) } }, SECRET), false, 'prefix of the secret rejected');
});

test('webhook auth: query secret only where explicitly allowed', () => {
  const asQuery = { headers: {}, query: { secret: SECRET } };
  assert.strictEqual(check(asQuery, SECRET), false, 'query string ignored by default (Overseerr/Tautulli)');
  assert.strictEqual(check(asQuery, SECRET, { allowQuery: true }), true, 'Plex route accepts ?secret=');
  assert.strictEqual(check({ headers: {}, query: { secret: 'nope' } }, SECRET, { allowQuery: true }), false, 'wrong query secret still rejected');
  // Express parses a repeated key into an array; it must not stringify into a match.
  assert.strictEqual(check({ headers: {}, query: { secret: [SECRET, SECRET] } }, SECRET, { allowQuery: true }), false, 'array query value rejected');
});

test('webhook auth: custom header name for Tautulli', () => {
  const req = { headers: { 'x-tautulli-secret': SECRET } };
  assert.strictEqual(check(req, SECRET, { header: 'x-tautulli-secret' }), true, 'tautulli header honored');
  assert.strictEqual(check(req, SECRET), false, 'default header name does not see the tautulli header');
});

test('webhook auth: an unset secret leaves the route open', () => {
  // Not reachable in a real deployment — validateConfig refuses to start with TUNNEL_DOMAIN set
  // and either secret blank — but the predicate must still be explicit about it.
  assert.strictEqual(check({ headers: {} }, ''), true, 'no secret configured means no check');
});
