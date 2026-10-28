#!/usr/bin/env node
// Dead-man's switch (src/deadman.js + the automation registry's heartbeat hook): parse
// DEADMAN_PING_URLS, ping after scheduled successes only, record the outcome, and never let a
// push URL (which carries the monitor's token) reach a log line or the dashboard.
const { test } = require('node:test');
const assert = require('node:assert');

const { parseDeadmanUrls, pingDeadman, createDeadman } = require('../../src/deadman');
const { createAutomationRegistry } = require('../../src/automation-registry');
const { renderAutomationRegistry } = require('../../src/dashboard-render');

const HC = 'https://hc-ping.com/0f1e2d3c-SECRET-TOKEN';
const KUMA = 'https://kuma.example.test/api/push/KUMASECRET?status=up&msg=OK&ping=';

function capture() {
  const lines = [];
  return { lines, logger: { warn: m => lines.push(String(m)), info: m => lines.push(String(m)) } };
}

test('dead-man: parses job-id=url pairs, keeps query strings, reports bad entries by id only', () => {
  const { urls, invalid } = parseDeadmanUrls(` backup=${HC},\n grab=${KUMA}  Bad_Id=https://x.test ftp-job=ftp://x.test/p nourl= =https://y.test`);
  assert.deepStrictEqual([...urls.entries()], [['backup', HC], ['grab', KUMA]]);
  assert.deepStrictEqual(invalid, ['entry 1', 'ftp-job', 'nourl', 'entry 4']);
  assert.strictEqual(parseDeadmanUrls('').urls.size, 0);
});

test('dead-man: a ping is a plain GET; 2xx is ok; errors carry no URL', async () => {
  const seen = [];
  const http = { get: async (url, opts) => { seen.push({ url, opts }); return { status: 200 }; } };
  assert.deepStrictEqual(await pingDeadman(HC, { http }), { ok: true, status: 200 });
  assert.strictEqual(seen[0].url, HC);
  assert.strictEqual(seen[0].opts.timeout, 10000);
  assert.deepStrictEqual(await pingDeadman(HC, { http: { get: async () => ({ status: 404 }) } }), { ok: false, status: 404 });
  const failed = await pingDeadman(HC, { http: { get: async () => { const e = new Error(`connect ECONNREFUSED ${HC}`); e.code = 'ECONNREFUSED'; throw e; } } });
  assert.deepStrictEqual(failed, { ok: false, status: null, reason: 'ECONNREFUSED' });
});

test('dead-man: warnings name jobs, never URLs', async () => {
  const { lines, logger } = capture();
  const deadman = createDeadman({
    raw: `backup=${HC},typo-job=${KUMA},bad=notaurl`,
    knownIds: ['backup', 'grab'],
    http: { get: async () => ({ status: 500 }) },
    logger,
  });
  assert.deepStrictEqual(deadman.unknown(), ['typo-job']);
  assert.deepStrictEqual(deadman.invalid(), ['bad']);
  const sent = await deadman.ping('backup');
  assert.strictEqual(sent.ok, false);
  assert.strictEqual(await deadman.ping('grab'), null, 'unconfigured jobs are not pinged');
  assert.ok(lines.some(l => /typo-job/.test(l)) && lines.some(l => /dead-man ping for backup failed \(500\)/.test(l)));
  assert.ok(!lines.some(l => /SECRET|hc-ping|kuma\.example/.test(l)), `no URL in logs: ${lines.join(' | ')}`);
});

test('dead-man: the registry pings after scheduled and startup successes, never manual runs or failures', async () => {
  const pinged = [];
  let clock = 5000;
  let fail = false;
  const heartbeat = { configured: id => id === 'backup', ping: async id => { pinged.push(id); return { at: clock, ok: true }; } };
  const registry = createAutomationRegistry({
    definitions: [
      { id: 'backup', cadence: { minutes: 360 }, run: async () => { if (fail) throw new Error('disk full'); return { count: 1 }; }, manual: { enabled: true } },
      { id: 'grab', cadence: { minutes: 5 }, run: async () => ({ count: 0 }), manual: { enabled: true } },
    ],
    store: { get: () => undefined, set: () => {} },
    now: () => clock,
    heartbeat,
  });
  await registry.run('backup', { trigger: 'manual' });
  await registry.run('grab', { trigger: 'scheduled', requireManual: false });
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(pinged, [], 'manual runs and unwatched jobs send nothing');

  await registry.run('backup', { trigger: 'scheduled', requireManual: false });
  await registry.run('backup', { trigger: 'startup', requireManual: false });
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(pinged, ['backup', 'backup']);
  assert.strictEqual(registry.readState('backup').heartbeatAt, 5000);
  assert.strictEqual(registry.readState('backup').heartbeatOk, true);

  fail = true;
  await assert.rejects(registry.run('backup', { trigger: 'scheduled', requireManual: false }), /disk full/);
  await new Promise(r => setImmediate(r));
  assert.strictEqual(pinged.length, 2, 'a failed run is not pinged: the monitor notices the silence');
  assert.deepStrictEqual(registry.list().map(i => [i.id, i.heartbeat]), [['backup', true], ['grab', false]]);
});

test('dead-man: a ping that throws never fails or delays the run', async () => {
  const { lines, logger } = capture();
  const registry = createAutomationRegistry({
    definitions: [{ id: 'backup', cadence: { minutes: 60 }, run: async () => ({ count: 1 }) }],
    store: { get: () => undefined, set: () => {} },
    logger,
    heartbeat: { configured: () => true, ping: async () => { throw new Error('boom'); } },
  });
  const outcome = await registry.run('backup', { trigger: 'scheduled', requireManual: false });
  assert.strictEqual(outcome.ok, true);
  await new Promise(r => setImmediate(r));
  assert.ok(lines.some(l => /dead-man ping failed: boom/.test(l)));
});

test('dead-man: registry card shows job ids, the monitor window and last ping, and the ignored entries', () => {
  const html = renderAutomationRegistry([
    { id: 'backup', label: 'Database backup', enabled: true, cadence: { minutes: 360, source: 'compose' }, manual: { enabled: false, reason: 'x' }, heartbeat: true, state: { status: 'ok', finishedAt: Date.now() - 60000, heartbeatAt: Date.now() - 3 * 60000, heartbeatOk: true } },
    { id: 'grab', label: 'Grab transfers', enabled: true, cadence: { minutes: 5, source: 'compose' }, manual: { enabled: false, reason: 'x' }, heartbeat: true, state: { heartbeatAt: Date.now() - 60000, heartbeatOk: false } },
    { id: 'janitor', label: 'Janitor', enabled: true, cadence: { minutes: 60, source: 'compose' }, manual: { enabled: false, reason: 'x' }, heartbeat: false, state: {} },
  ], { heartbeatIssues: ['typo-job'] });
  assert.match(html, /Job id backup/);
  assert.match(html, /Dead-man: monitor window every 360 min, grace 360 min · last ping 3m ago/);
  assert.match(html, /Dead-man: monitor window every 5 min, grace 5 min · last ping failed 1m ago/);
  assert.strictEqual((html.match(/Dead-man:/g) || []).length, 2, 'unwatched jobs show no dead-man line');
  assert.match(html, /DEADMAN_PING_URLS has entries that were ignored: typo-job/);
});
