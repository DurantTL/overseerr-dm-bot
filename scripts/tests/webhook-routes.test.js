#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { createWebhookHandlers } = require('../../src/routes/webhooks');

const SECRET = 'a'.repeat(64);
const TAUTULLI_SECRET = 'b'.repeat(64);

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
  };
}

function setup() {
  const audits = [];
  const handled = [];
  const claimed = new Set();
  const handlers = createWebhookHandlers({
    config: { WEBHOOK_SECRET: SECRET, TAUTULLI_WEBHOOK_SECRET: TAUTULLI_SECRET },
    audit: (event, detail) => audits.push({ event, detail }),
    webhookEventKey: (source, body) => `${source}:${JSON.stringify(body)}`,
    recordWebhookEvent: eventKey => {
      if (claimed.has(eventKey)) return false;
      claimed.add(eventKey);
      return true;
    },
    forgetWebhookEvent: eventKey => claimed.delete(eventKey),
    webhookUserKey: email => email ? `email:${email}` : null,
    resolvePlexWebhookEmail: async () => 'viewer@example.com',
    handleOverseerrWebhook: async body => handled.push({ source: 'overseerr', body }),
    handlePlexWebhook: async body => handled.push({ source: 'plex', body }),
    handleTautulliWebhook: async body => handled.push({ source: 'tautulli', body }),
    log: { warn() {} },
  });
  return { handlers, audits, handled };
}

test('webhook routes accept valid secrets and payload formats', async () => {
  const { handlers, handled } = setup();
  const overseerrResponse = response();
  const plexResponse = response();
  const tautulliResponse = response();

  await handlers.overseerr({ headers: { 'x-webhook-secret': SECRET }, query: {}, body: { payload: '{"notification_type":"MEDIA_AVAILABLE"}' } }, overseerrResponse);
  await handlers.plex({ headers: {}, query: { secret: SECRET }, body: { payload: '{"event":"media.play"}' } }, plexResponse);
  await handlers.tautulli({ headers: { 'x-tautulli-secret': TAUTULLI_SECRET }, query: {}, body: { event: 'play' } }, tautulliResponse);

  assert.strictEqual(overseerrResponse.statusCode, 200);
  assert.strictEqual(plexResponse.statusCode, 200);
  assert.strictEqual(tautulliResponse.statusCode, 200);
  assert.deepStrictEqual(handled.map(entry => entry.source), ['overseerr', 'plex', 'tautulli']);
  assert.strictEqual(handled[0].body.notification_type, 'MEDIA_AVAILABLE');
});

test('webhook routes reject invalid and missing secrets', async () => {
  const { handlers, handled } = setup();
  const invalidResponse = response();
  const missingResponse = response();

  await handlers.overseerr({ headers: { 'x-webhook-secret': 'wrong' }, query: {}, body: {} }, invalidResponse);
  await handlers.overseerr({ headers: {}, query: {}, body: {} }, missingResponse);

  assert.strictEqual(invalidResponse.statusCode, 401);
  assert.deepStrictEqual(invalidResponse.body, { error: 'Unauthorized' });
  assert.strictEqual(missingResponse.statusCode, 401);
  assert.deepStrictEqual(missingResponse.body, { error: 'Unauthorized' });
  assert.deepStrictEqual(handled, []);
});

test('webhook routes acknowledge replayed events without processing them twice', async () => {
  const { handlers, audits, handled } = setup();
  const req = { headers: { 'x-webhook-secret': SECRET }, query: {}, body: { notification_type: 'MEDIA_AVAILABLE' } };
  const firstResponse = response();
  const replayResponse = response();

  await handlers.overseerr(req, firstResponse);
  await handlers.overseerr(req, replayResponse);

  assert.strictEqual(firstResponse.statusCode, 200);
  assert.strictEqual(replayResponse.statusCode, 200);
  assert.strictEqual(handled.length, 1);
  assert.strictEqual(audits.at(-1).event, 'webhook_duplicate');
});

test('webhook routes acknowledge malformed embedded payloads and audit the error', async () => {
  const { handlers, audits, handled } = setup();
  const res = response();

  await handlers.plex({ headers: { 'x-webhook-secret': SECRET }, query: {}, body: { payload: '{' } }, res);

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(handled, []);
  assert.strictEqual(audits.at(-1).event, 'external_api_error');
  assert.strictEqual(audits.at(-1).detail.provider, 'plex_webhook');
});
