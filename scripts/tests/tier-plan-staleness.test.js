#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const {
  DEFAULT_CHECK_INTERVAL_MS,
  evaluateTierPlanStaleness,
  scheduleTierPlanStaleness,
} = require('../../src/tier-plan-staleness');

function fixture({ publishedAt, planHash = 'plan-a', enabled = true, staleDays = 14 } = {}) {
  const states = new Map();
  const plan = publishedAt == null ? null : { published: { planHash, publishedAt } };
  const now = 1_700_000_000_000;
  const evaluate = () => evaluateTierPlanStaleness({
    nodes: [{ name: 'edge', enabled }],
    getPlan: () => plan,
    getAlertState: node => states.get(node) || null,
    setAlertState: (node, value) => states.set(node, value),
    clearAlertState: node => states.delete(node),
    staleDays,
    now,
  });
  return { states, plan, now, evaluate };
}

test('stale plan alerts back off on attempts 1, 2, and 4, then stands down', () => {
  const fx = fixture({ publishedAt: 1_700_000_000_000 - 15 * 86400000 });
  assert.deepStrictEqual(fx.evaluate().map(event => event.type), ['stale']);
  assert.deepStrictEqual(fx.evaluate().map(event => event.type), ['stale']);
  assert.deepStrictEqual(fx.evaluate(), []);
  assert.deepStrictEqual(fx.evaluate().map(event => event.type), ['stale']);
  assert.strictEqual(fx.states.get('edge').stoodDown, true);
  assert.deepStrictEqual(fx.evaluate(), []);
});

test('fresh, unpublished, and disabled nodes never alert', () => {
  assert.deepStrictEqual(fixture({ publishedAt: 1_700_000_000_000 - 2 * 86400000 }).evaluate(), []);
  assert.deepStrictEqual(fixture({ publishedAt: null }).evaluate(), []);
  assert.deepStrictEqual(fixture({ publishedAt: 1, enabled: false }).evaluate(), []);
});

test('a newly published plan clears stale state and emits one recovery', () => {
  const states = new Map([['edge', { fingerprint: 'edge:old:1', planHash: 'old', publishedAt: 1 }]]);
  const now = 1_700_000_000_000;
  const events = evaluateTierPlanStaleness({
    nodes: [{ name: 'edge', enabled: true }],
    getPlan: () => ({ published: { planHash: 'new', publishedAt: now - 60000 } }),
    getAlertState: node => states.get(node),
    setAlertState: (node, value) => states.set(node, value),
    clearAlertState: node => states.delete(node),
    staleDays: 14,
    now,
  });
  assert.deepStrictEqual(events.map(event => event.type), ['recovered']);
  assert.strictEqual(states.has('edge'), false);
});

test('scheduler runs once after boot and then hourly without applying a plan', async () => {
  const scheduled = [];
  let runs = 0;
  const timer = (kind, fn, delay) => {
    const value = { kind, fn, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
    scheduled.push(value);
    return value;
  };
  scheduleTierPlanStaleness({
    run: () => { runs += 1; },
    setTimeoutFn: (fn, delay) => timer('timeout', fn, delay),
    setIntervalFn: (fn, delay) => timer('interval', fn, delay),
  });
  assert.deepStrictEqual(scheduled.map(item => [item.kind, item.delay]), [
    ['timeout', 2 * 60000],
    ['interval', DEFAULT_CHECK_INTERVAL_MS],
  ]);
  assert.ok(scheduled.every(item => item.unrefCalled));
  await scheduled[0].fn();
  await scheduled[1].fn();
  assert.strictEqual(runs, 2);
});
