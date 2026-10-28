#!/usr/bin/env node
// Prowlarr indexer-health flips (src/indexer-health.js): reading Prowlarr's backoff list, the
// two-check confirmation, one note per flip, and recovery only after a reported failure.
const { test } = require('node:test');
const assert = require('node:assert');

const { fetchIndexerHealth, evaluateIndexerFlips } = require('../../src/indexer-health');

const NOW = Date.parse('2026-10-28T15:00:00Z');

function prowlarr({ indexers, statuses, statusFails = false }) {
  const calls = [];
  return {
    calls,
    get: async (url, opts) => {
      calls.push({ url, key: opts.headers['X-Api-Key'] });
      if (url.endsWith('/indexer')) return { data: indexers };
      if (statusFails) throw new Error('boom');
      return { data: statuses };
    },
  };
}

test('indexer health: failing means enabled and backing off into the future', async () => {
  const http = prowlarr({
    indexers: [{ id: 1, name: 'AvistaZ', enable: true }, { id: 2, name: 'Nyaa', enable: true }, { id: 3, name: 'Old', enable: false }, { id: 4, name: 'Retried', enable: true }],
    statuses: [
      { indexerId: 1, disabledTill: '2026-10-28T15:30:00Z', initialFailure: '2026-10-28T14:00:00Z' },
      { indexerId: 3, disabledTill: '2026-10-28T16:00:00Z' },
      { indexerId: 4, disabledTill: '2026-10-28T14:00:00Z' },
    ],
  });
  const rows = await fetchIndexerHealth({ PROWLARR_URL: 'http://prowlarr:9696/', PROWLARR_API_KEY: 'k' }, { http, now: NOW });
  assert.deepStrictEqual(rows.map(r => [r.name, r.enabled, r.failing]), [['AvistaZ', true, true], ['Nyaa', true, false], ['Old', false, false], ['Retried', true, false]]);
  assert.strictEqual(rows[0].failingSince, '2026-10-28T14:00:00Z');
  assert.deepStrictEqual(http.calls.map(c => c.url), ['http://prowlarr:9696/api/v1/indexer', 'http://prowlarr:9696/api/v1/indexerstatus']);
  const noStatus = await fetchIndexerHealth({ PROWLARR_URL: 'http://p', PROWLARR_API_KEY: 'k' }, { http: prowlarr({ indexers: [{ id: 1, name: 'A' }], statusFails: true }), now: NOW });
  assert.strictEqual(noStatus[0].failing, false, 'a status read failure counts as no backoff list, not as failing');
});

test('indexer flips: one failed check is quiet, the second alerts once, then silence until recovery', () => {
  const ix = failing => ({ id: 1, name: 'AvistaZ', enabled: true, failing, disabledTill: null });
  let state = {};
  const step = (failing, now) => { const r = evaluateIndexerFlips({ results: [ix(failing)], state, now }); state = r.state; return r.events; };
  assert.deepStrictEqual(step(true, 1000), []);
  const alerted = step(true, 2000);
  assert.deepStrictEqual(alerted.map(e => [e.type, e.firstDownAt]), [['failing', 1000]]);
  assert.deepStrictEqual(step(true, 3000), [], 'no repeat while it stays down');
  const back = step(false, 61000);
  assert.deepStrictEqual(back.map(e => [e.type, e.downForMs]), [['recovered', 60000]]);
  assert.deepStrictEqual(state, {});
  assert.deepStrictEqual(step(false, 62000), [], 'no second recovery note');
});

test('indexer flips: a blip that clears before confirmation sends nothing; disabled indexers drop out', () => {
  let r = evaluateIndexerFlips({ results: [{ id: 1, name: 'A', enabled: true, failing: true }], state: {}, now: 1 });
  r = evaluateIndexerFlips({ results: [{ id: 1, name: 'A', enabled: true, failing: false }], state: r.state, now: 2 });
  assert.deepStrictEqual(r.events, []);
  const alerted = { 5: { downChecks: 3, alerted: true, firstDownAt: 1 } };
  const off = evaluateIndexerFlips({ results: [{ id: 5, name: 'B', enabled: false, failing: false }], state: alerted, now: 9 });
  assert.deepStrictEqual(off, { events: [], state: {} }, 'disabling an indexer is not a recovery');
});
