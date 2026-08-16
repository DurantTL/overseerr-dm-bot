#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { nextSeasonNoGrabAlert, STAND_DOWN_AFTER } = require('../../src/season-alert');

test('season alert: identical failures back off and stand down while searches keep counting', () => {
  let state = null;
  const decisions = [];
  for (let attempt = 1; attempt <= 6; attempt++) {
    state = nextSeasonNoGrabAlert(state, { fingerprint: 'same', now: attempt * 1000 });
    decisions.push(state);
  }
  assert.deepStrictEqual(decisions.map(row => row.shouldAlert), [true, true, false, true, false, false]);
  assert.strictEqual(decisions[STAND_DOWN_AFTER - 1].stoodDown, true);
  assert.strictEqual(decisions[5].attemptCount, 6, 'silent searches continue after stand-down');
});

test('season alert: changed results re-arm a stood-down season immediately', () => {
  const stoodDown = { fingerprint: 'old', attemptCount: 8, stoodDown: true };
  const changed = nextSeasonNoGrabAlert(stoodDown, { fingerprint: 'new', now: 9000 });
  assert.deepStrictEqual(changed, {
    fingerprint: 'new', attemptCount: 1, changed: true, stoodDown: false,
    shouldAlert: true, nextAlertAttempt: 2, lastAttemptedAt: 9000,
  });
});
