#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createWebhookHandlers, requireGitHubSignature } = require('../../src/routes/webhooks');

const SECRET = 'b'.repeat(64);

function sign(secret, raw) {
  return `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
}

function response() {
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      this.headersSent = true;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      this.headersSent = true;
      return this;
    },
  };
}

// Minimal fake of an incoming request stream for the signature middleware.
function fakeReq(raw, headers = {}) {
  const req = new EventEmitter();
  req.headers = headers;
  req._raw = raw;
  return req;
}

function runMiddleware(mw, req) {
  return new Promise(resolve => {
    const res = response();
    const origJson = res.json.bind(res);
    const origStatus = res.status.bind(res);
    res.json = body => { origJson(body); resolve({ res, nextCalled: false }); };
    res.status = code => { origStatus(code); return res; };
    mw(req, res, () => resolve({ res, nextCalled: true }));
    // Deliver the body on the next tick, after listeners attach.
    process.nextTick(() => {
      if (req._raw) req.emit('data', Buffer.from(req._raw));
      req.emit('end');
    });
  });
}

function setup() {
  const audits = [];
  const notified = [];
  const claimed = new Set();
  const handlers = createWebhookHandlers({
    config: { GITHUB_WEBHOOK_SECRET: SECRET },
    audit: (event, detail) => audits.push({ event, detail }),
    webhookEventKey: (source, body) => `${source}:${body.run_id}:${body.conclusion}`,
    recordWebhookEvent: eventKey => {
      if (claimed.has(eventKey)) return false;
      claimed.add(eventKey);
      return true;
    },
    forgetWebhookEvent: eventKey => claimed.delete(eventKey),
    webhookUserKey: () => null,
    resolvePlexWebhookEmail: async () => null,
    handleOverseerrWebhook: async () => {},
    handlePlexWebhook: async () => {},
    handleTautulliWebhook: async () => {},
    notifyCiFailure: async detail => notified.push(detail),
    log: { warn() {} },
  });
  return { handlers, audits, notified };
}

function githubReq(raw, event) {
  const req = { headers: { 'x-github-event': event }, rawBody: Buffer.from(raw) };
  return req;
}

const FAILURE_RUN = JSON.stringify({
  action: 'completed',
  workflow_run: {
    id: 4242,
    name: 'test',
    conclusion: 'failure',
    head_sha: 'abc123def456789',
    head_branch: 'feature/thing',
    html_url: 'https://github.com/o/r/actions/runs/4242',
    pull_requests: [{ number: 349 }],
  },
});

test('requireGitHubSignature accepts a valid signature and exposes the raw body', async () => {
  const raw = '{"hello":"world"}';
  const { res, nextCalled } = await runMiddleware(
    requireGitHubSignature(() => SECRET),
    fakeReq(raw, { 'x-hub-signature-256': sign(SECRET, raw) }),
  );
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
});

test('requireGitHubSignature rejects bad, missing, and misconfigured signatures', async () => {
  const raw = '{"hello":"world"}';
  const bad = await runMiddleware(
    requireGitHubSignature(() => SECRET),
    fakeReq(raw, { 'x-hub-signature-256': sign('wrong', raw) }),
  );
  assert.strictEqual(bad.nextCalled, false);
  assert.strictEqual(bad.res.statusCode, 401);

  const missing = await runMiddleware(
    requireGitHubSignature(() => SECRET),
    fakeReq(raw, {}),
  );
  assert.strictEqual(missing.res.statusCode, 401);

  // No secret configured: fail closed with 503, never accept.
  const unconfigured = await runMiddleware(
    requireGitHubSignature(() => ''),
    fakeReq(raw, { 'x-hub-signature-256': sign(SECRET, raw) }),
  );
  assert.strictEqual(unconfigured.nextCalled, false);
  assert.strictEqual(unconfigured.res.statusCode, 503);
});

test('requireGitHubSignature rejects oversized payloads', async () => {
  const raw = 'x'.repeat(100);
  const { res, nextCalled } = await runMiddleware(
    requireGitHubSignature(() => SECRET, { limit: 10 }),
    fakeReq(raw, { 'x-hub-signature-256': sign(SECRET, raw) }),
  );
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 413);
});

test('github handler acks ping and ignores non-workflow events', async () => {
  const { handlers, audits, notified } = setup();
  const pingRes = response();
  await handlers.github(githubReq('{"hook_id":7}', 'ping'), pingRes);
  assert.strictEqual(pingRes.statusCode, 200);
  assert.ok(audits.some(a => a.event === 'webhook_received' && a.detail.event === 'ping'));

  const pushRes = response();
  await handlers.github(githubReq('{"ref":"refs/heads/main"}', 'push'), pushRes);
  assert.strictEqual(pushRes.statusCode, 200);
  assert.strictEqual(notified.length, 0);
});

test('github handler alerts on a failed workflow_run with PR context', async () => {
  const { handlers, audits, notified } = setup();
  const res = response();
  await handlers.github(githubReq(FAILURE_RUN, 'workflow_run'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(notified.length, 1);
  assert.strictEqual(notified[0].workflow, 'test');
  assert.strictEqual(notified[0].conclusion, 'failure');
  assert.strictEqual(notified[0].prs, '#349');
  assert.strictEqual(notified[0].url, 'https://github.com/o/r/actions/runs/4242');
  assert.ok(audits.some(a => a.event === 'github_ci_failed'));

  // Redelivery of the same completed run dedupes: no second alert.
  const res2 = response();
  await handlers.github(githubReq(FAILURE_RUN, 'workflow_run'), res2);
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(notified.length, 1);
  assert.ok(audits.some(a => a.event === 'webhook_duplicate'));
});

test('github handler stays quiet on successful or in-progress runs', async () => {
  const { handlers, audits, notified } = setup();
  const success = FAILURE_RUN.replace('"conclusion":"failure"', '"conclusion":"success"');
  const res = response();
  await handlers.github(githubReq(success, 'workflow_run'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(notified.length, 0);
  assert.ok(audits.some(a => a.event === 'webhook_received' && a.detail.conclusion === 'success'));

  const inProgress = FAILURE_RUN.replace('"completed"', '"in_progress"');
  const res2 = response();
  await handlers.github(githubReq(inProgress, 'workflow_run'), res2);
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(notified.length, 0);
});

test('github handler audits invalid JSON instead of throwing', async () => {
  const { handlers, audits, notified } = setup();
  const res = response();
  await handlers.github(githubReq('not json{{{', 'workflow_run'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(notified.length, 0);
  assert.ok(audits.some(a => a.event === 'webhook_invalid_payload'));
});
