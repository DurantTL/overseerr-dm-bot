#!/usr/bin/env node
// #78: quotaLine formats Overseerr's GET /user/{id}/quota response into a short human line, and
// treats a missing/zero limit as unlimited rather than "0 left".
const { test } = require('node:test');
const assert = require('node:assert');
const { quotaLine } = require('../../src/util');

test('quota: formats remaining/limit with the reset period', () => {
  const quota = { movie: { days: 7, limit: 10, used: 3, remaining: 7 } };
  assert.strictEqual(quotaLine(quota, 'movie'), '7 of 10 movie requests left (resets every 7d)');
});

test('quota: falls back to limit - used when remaining is absent', () => {
  const quota = { tv: { days: 7, limit: 5, used: 2 } };
  assert.strictEqual(quotaLine(quota, 'tv'), '3 of 5 series requests left (resets every 7d)');
});

test('quota: a zero/missing limit means unlimited (no line)', () => {
  assert.strictEqual(quotaLine({ movie: { limit: 0 } }, 'movie'), null);
  assert.strictEqual(quotaLine({}, 'movie'), null);
  assert.strictEqual(quotaLine(null, 'movie'), null);
});

test('quota: singular wording at a limit of exactly 1, and no reset clause when days is absent', () => {
  const quota = { movie: { limit: 1, used: 0, remaining: 1 } };
  assert.strictEqual(quotaLine(quota, 'movie'), '1 of 1 movie request left');
});
