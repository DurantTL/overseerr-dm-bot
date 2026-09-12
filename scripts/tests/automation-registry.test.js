#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createAutomationRegistry, summarizeResult } = require('../../src/automation-registry');

const memoryStore = initial => {
  const values = new Map(Object.entries(initial || {}));
  return { values, get: key => values.get(key), set: (key, value) => values.set(key, value) };
};

test('automation registry persists success, failure, trigger, result, and duration', async () => {
  let clock = 1000;
  const store = memoryStore();
  const registry = createAutomationRegistry({
    definitions: [{ id: 'example', label: 'Example', cadence: { minutes: 5 }, run: async () => { clock += 250; return { acted: 3, skipped: 1 }; }, manual: { enabled: true } }],
    store,
    now: () => clock,
  });
  const outcome = await registry.run('example');
  assert.strictEqual(outcome.ok, true);
  assert.deepStrictEqual(registry.readState('example'), {
    status: 'ok', startedAt: 1000, finishedAt: 1250, durationMs: 250, trigger: 'manual',
    resultCount: 3, resultSummary: 'acted=3, skipped=1', error: null,
  });

  const failed = createAutomationRegistry({
    definitions: [{ id: 'failure', cadence: { minutes: 1 }, run: async () => { clock += 10; throw new Error('broken'); } }],
    store, now: () => clock,
  });
  await assert.rejects(failed.run('failure', { trigger: 'scheduled', requireManual: false }), /broken/);
  assert.strictEqual(failed.readState('failure').status, 'failed');
  assert.strictEqual(failed.readState('failure').trigger, 'scheduled');
  assert.strictEqual(failed.readState('failure').durationMs, 10);
});

test('automation registry shares one overlap guard across scheduled and manual runs', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const registry = createAutomationRegistry({
    definitions: [{ id: 'worker', cadence: { minutes: 1 }, run: () => pending, manual: { enabled: true } }],
    store: memoryStore(),
  });
  const first = registry.run('worker', { trigger: 'scheduled', requireManual: false });
  await Promise.resolve();
  assert.deepStrictEqual(await registry.run('worker'), { ok: false, busy: true });
  assert.strictEqual(registry.readState('worker').overlapSkips, 1);
  release({ processed: 2 });
  await first;
});

test('automation registry reports disabled prerequisites and manual policy', async () => {
  const registry = createAutomationRegistry({
    definitions: [{ id: 'unsafe', cadence: { minutes: 5 }, prerequisite: () => ({ enabled: false, reason: 'service missing' }), run: async () => {}, manual: { enabled: false, reason: 'destructive' } }],
    store: memoryStore(),
  });
  assert.deepStrictEqual(await registry.run('unsafe'), { ok: false, disabled: true, reason: 'service missing' });
  const item = registry.list()[0];
  assert.strictEqual(item.enabled, false);
  assert.strictEqual(item.disabledReason, 'service missing');
  assert.strictEqual(item.manual.reason, 'destructive');
});

test('automation registry re-reads cadence and rehydrates next run after restart', async () => {
  let clock = 1000;
  let minutes = 5;
  const timers = [];
  const store = memoryStore({ 'automation_run:worker': JSON.stringify({ status: 'ok', nextRunAt: 61000 }) });
  const make = () => createAutomationRegistry({
    definitions: [{ id: 'worker', cadence: () => ({ minutes, source: 'override', mutable: true }), run: async () => ({ count: 1 }) }],
    store, now: () => clock,
    setTimer: (fn, delay) => { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimer() {}, logger: { warn() {} },
  });
  const registry = make();
  registry.start();
  const rehydrated = timers.shift();
  assert.strictEqual(rehydrated.delay, 60000, 'persisted future next-run is rehydrated');
  minutes = 2;
  clock = 61000;
  await rehydrated.fn();
  assert.strictEqual(registry.list()[0].cadence.minutes, 2);
  assert.strictEqual(timers.at(-1).delay, 120000, 'next arm uses the live cadence');
});

test('automation inventory is declarative and contains every recurring media worker', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');
  const block = source.slice(source.indexOf('function createAutomationDefinitions()'), source.indexOf('function channelFor'));
  const ids = [...block.matchAll(/id: '([^']+)'/g)].map(match => match[1]);
  assert.deepStrictEqual(ids.sort(), [
    'adoption', 'backup', 'episode-recovery', 'escalation', 'grab', 'janitor', 'monthly-recap',
    'pending-approvals', 'premiumize', 'ratio-cleanup', 'request-reconcile', 'season-pack',
    'stage-queue', 'stage-reconcile', 'stuck', 'tier-plan-stale-alert', 'transcode', 'tunnel',
  ]);
  assert.ok(!/setInterval\(/.test(source.slice(source.indexOf('async function startDiscordWorkers()'), source.indexOf("client.on('guildMemberAdd'"))), 'worker startup must schedule only through the registry');
});

test('result summarization tolerates heterogeneous worker result shapes', () => {
  assert.deepStrictEqual(summarizeResult({ searched: 4, failed: 1 }), { count: 4, summary: 'searched=4, failed=1' });
  assert.deepStrictEqual(summarizeResult(undefined), { count: 0, summary: 'completed' });
});

test('automation registry marks an interrupted persisted run failed on restart', () => {
  const store = memoryStore({ 'automation_run:worker': JSON.stringify({ status: 'running', startedAt: 400 }) });
  const registry = createAutomationRegistry({
    definitions: [{ id: 'worker', cadence: { minutes: 1 }, run: async () => {} }],
    store, now: () => 1000,
  });
  assert.deepStrictEqual(registry.readState('worker'), {
    status: 'failed', startedAt: 400, finishedAt: 1000, durationMs: 600,
    error: 'process restarted before this run finished',
  });
});

test('startup pumps use the shared guard even when their recurring cadence is off', async () => {
  const calls = [];
  const timers = [];
  const registry = createAutomationRegistry({
    definitions: [{
      id: 'pump', cadence: { minutes: 0 }, prerequisite: () => ({ enabled: true }),
      runOnStartup: true, startupIgnoresCadence: true, firstRunDelayMs: 1,
      run: async () => calls.push('scheduled'), startupRun: async () => calls.push('startup'),
    }],
    store: memoryStore(),
    setTimer: (fn, delay) => { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimer() {}, logger: { warn() {} },
  });
  registry.start();
  await timers.shift().fn();
  assert.deepStrictEqual(calls, ['startup']);
  assert.strictEqual(registry.readState('pump').trigger, 'startup');
});
