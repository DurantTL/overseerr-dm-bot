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

// ---- Alert inbox: incidents rebuilt from the audit rows the sweep writes ----
const { alertInbox, INBOX_ACTIONS } = require('../../src/service-alerts');

function row(id, action, createdAt, meta) {
  return { id, action, created_at: createdAt, metadata_json: JSON.stringify(meta) };
}

test('alert inbox: reads exactly the alert, recovery and alert-restart audit actions', () => {
  assert.deepStrictEqual(INBOX_ACTIONS, ['service_down_alerted', 'service_down_recovered', 'service_alert_restart']);
});

test('alert inbox: an alert, its reminders and a restart make one open incident on top', () => {
  const rows = [
    row(1, 'service_down_alerted', '2026-10-27 09:00:00', { service: 'prowlarr', attemptCount: 1 }),
    row(2, 'service_down_recovered', '2026-10-27 09:14:00', { service: 'prowlarr', downForMs: 14 * 60000 }),
    row(3, 'service_down_alerted', '2026-10-28 14:31:00', { service: 'radarr', attemptCount: 1 }),
    row(4, 'service_alert_restart', '2026-10-28 14:33:00', { service: 'radarr', container: 'radarr', ok: true }),
    row(5, 'service_down_alerted', '2026-10-28 14:56:00', { service: 'radarr', attemptCount: 6 }),
    row(6, 'service_down_alerted', '2026-10-28 16:51:00', { service: 'radarr', attemptCount: 24, stoodDown: true }),
  ];
  // Rows arrive newest-first from the query; order must not matter.
  const inbox = alertInbox(rows.reverse());
  assert.strictEqual(inbox.length, 2);
  const [radarr, prowlarr] = inbox;
  assert.strictEqual(radarr.name, 'Radarr');
  assert.strictEqual(radarr.open, true);
  assert.strictEqual(radarr.alerts, 3);
  assert.strictEqual(radarr.restarts, 1);
  assert.strictEqual(radarr.stoodDown, true);
  assert.strictEqual(radarr.alertedAt, Date.parse('2026-10-28T14:31:00Z'));
  assert.strictEqual(prowlarr.open, false);
  assert.strictEqual(prowlarr.downForMs, 14 * 60000);
  assert.strictEqual(prowlarr.recoveredAt, Date.parse('2026-10-27T09:14:00Z'));
});

test('alert inbox: a recovery whose alert was pruned still shows, and open incidents sort first', () => {
  const inbox = alertInbox([
    row(10, 'service_down_recovered', '2026-10-28 12:00:00', { service: 'sonarr', downForMs: 9 * 60000 }),
    row(11, 'service_down_alerted', '2026-10-28 08:00:00', { service: 'tautulli' }),
    row(12, 'service_alert_restart', '2026-10-28 13:00:00', { service: 'plex', ok: true }),
    row(13, 'service_down_alerted', '2026-10-28 13:00:00', { service: 'bogus' }),
    { id: 14, action: 'service_down_alerted', created_at: '2026-10-28 13:00:00', metadata_json: '{not json' },
  ]);
  assert.deepStrictEqual(inbox.map(i => [i.service, i.open]), [['bogus', true], ['tautulli', true], ['sonarr', false]]);
  assert.strictEqual(inbox[0].name, 'bogus', 'an unknown key shows as-is rather than vanishing');
  assert.strictEqual(inbox[2].alertedAt, null);
  assert.ok(!inbox.some(i => i.service === 'plex'), 'a restart with no open incident adds nothing');
});

test('alert inbox: a second outage after recovery is a new incident; the list stops at 20', () => {
  const rows = [];
  let id = 0;
  for (let n = 0; n < 30; n++) {
    const hh = String(n % 24).padStart(2, '0');
    rows.push(row(++id, 'service_down_alerted', `2026-10-${n < 24 ? '01' : '02'} ${hh}:00:00`, { service: 'radarr' }));
    rows.push(row(++id, 'service_down_recovered', `2026-10-${n < 24 ? '01' : '02'} ${hh}:10:00`, { service: 'radarr', downForMs: 600000 }));
  }
  const inbox = alertInbox(rows);
  assert.strictEqual(inbox.length, 20);
  assert.ok(inbox.every(i => i.alerts === 1 && !i.open));
});
