#!/usr/bin/env node
// Service-down alerts (src/service-alerts.js): which services are checked, the two-check
// confirmation before the first alert, the reminder schedule and stand-down, and recovery notes
// only for outages that actually alerted.
const { test } = require('node:test');
const assert = require('node:assert');

const {
  alertableServices,
  checkServices,
  evaluateServiceAlerts,
  parseIgnoreList,
  ALERT_ATTEMPTS,
  STAND_DOWN_AFTER,
} = require('../../src/service-alerts');

function store() {
  const rows = new Map();
  return {
    rows,
    getAlertState: key => rows.get(key) || null,
    setAlertState: (key, state) => rows.set(key, state),
    clearAlertState: key => rows.delete(key),
  };
}

const radarr = state => ({ key: 'radarr', name: 'Radarr', container: 'radarr', state, detail: state === 'down' ? 'ECONNREFUSED' : null });

function round(s, results, now) {
  return evaluateServiceAlerts({ results, ...s, now });
}

test('service alerts: only configured, non-self, non-external, non-ignored services are checked', () => {
  const config = { RADARR_URL: 'http://radarr:7878', SONARR_URL: 'http://sonarr:8989', PLEX_URL: 'http://plex:32400' };
  const keys = alertableServices(config, parseIgnoreList('plex')).map(s => s.key);
  assert.deepStrictEqual(keys.sort(), ['radarr', 'sonarr']);
  assert.ok(!keys.includes('director'), 'the dashboard itself is never checked');
  assert.ok(!keys.includes('premiumize'), 'external links are never checked');
  const withSites = alertableServices({ PORTFOLIO_URL: 'https://portfolio.example.test' }).map(s => s.key);
  assert.ok(!withSites.includes('portfolio'), 'website links are left to the external endpoint checker');
});

test('service alerts: checkServices uses the board state logic, health first then the URL probe', async () => {
  const config = { RADARR_URL: 'http://radarr:7878', GRAFANA_URL: 'http://grafana:3000' };
  const probed = [];
  const results = await checkServices({
    config,
    health: { radarr: 'down', errors: { radarr: 'connect ECONNREFUSED 10.0.0.5:7878' } },
    probe: async url => { probed.push(url); return 'ok'; },
    ignore: new Set(),
  });
  const byKey = Object.fromEntries(results.map(r => [r.key, r]));
  assert.strictEqual(byKey.radarr.state, 'down', 'health key decides Radarr');
  assert.match(byKey.radarr.detail, /ECONNREFUSED/);
  assert.strictEqual(byKey.radarr.container, 'radarr');
  assert.strictEqual(byKey.grafana.state, 'ok', 'no health key: the URL probe decides');
  assert.deepStrictEqual(probed, ['http://grafana:3000']);
});

test('service alerts: one failed check stays quiet; the second alerts', () => {
  const s = store();
  assert.deepStrictEqual(round(s, [radarr('down')], 1000), [], 'a single blip does not alert');
  const events = round(s, [radarr('down')], 2000);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, 'down');
  assert.strictEqual(events[0].state.downChecks, 2);
  assert.strictEqual(events[0].state.firstDownAt, 1000, 'the outage is dated from the first failed check');
  assert.strictEqual(events[0].state.attemptCount, 1);
});

test('service alerts: a blip that recovers before confirmation sends nothing at all', () => {
  const s = store();
  round(s, [radarr('down')], 1000);
  assert.deepStrictEqual(round(s, [radarr('ok')], 2000), [], 'no recovery note for an outage nobody was told about');
  assert.strictEqual(s.rows.size, 0, 'state cleared');
});

test('service alerts: reminders follow the attempt schedule, then stand down', () => {
  const s = store();
  round(s, [radarr('down')], 0);
  const alertedAt = [];
  for (let check = 2; check <= STAND_DOWN_AFTER + 10; check++) {
    const events = round(s, [radarr('down')], check * 1000);
    if (events.length) alertedAt.push(events[0].state.attemptCount);
  }
  assert.deepStrictEqual(alertedAt, [...ALERT_ATTEMPTS], 'alerts only on the scheduled attempts');
  assert.strictEqual(s.rows.get('radarr').stoodDown, true);
});

test('service alerts: recovery after an alerted outage posts once with the downtime', () => {
  const s = store();
  round(s, [radarr('down')], 60_000);
  round(s, [radarr('down')], 360_000);
  const events = round(s, [radarr('ok')], 660_000);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, 'recovered');
  assert.strictEqual(events[0].downForMs, 600_000);
  assert.deepStrictEqual(round(s, [radarr('ok')], 960_000), [], 'no second recovery note');
});

test('service alerts: an unknown (skip) result leaves an outage in progress untouched', () => {
  const s = store();
  round(s, [radarr('down')], 1000);
  round(s, [radarr('down')], 2000);
  const before = { ...s.rows.get('radarr') };
  assert.deepStrictEqual(round(s, [radarr('skip')], 3000), []);
  assert.deepStrictEqual(s.rows.get('radarr'), before);
});

test('service alerts: parseIgnoreList trims, lowercases and drops blanks', () => {
  assert.deepStrictEqual([...parseIgnoreList(' Plex, grafana ,,')], ['plex', 'grafana']);
  assert.strictEqual(parseIgnoreList('').size, 0);
});
