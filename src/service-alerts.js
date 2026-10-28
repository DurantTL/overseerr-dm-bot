'use strict';

// Service-down alerts: the container-level gap the external endpoint checker can't see.
// That checker watches the public endpoints (the dashboard's /live, Plex, the seedbox), so when
// Radarr dies the dashboard still answers and nothing pings. This sweep checks every configured
// service on the Services board on a fixed cadence, using the board's own state logic
// (resolveServiceState) so an alert and the board never disagree about what "down" means.
//
// Noise control:
//   - A service must fail CONFIRM_CHECKS checks in a row before the first alert, so one slow
//     probe or a container mid-restart stays quiet.
//   - While it stays down, src/repeat-alert.js repeats the alert on attempts 1, 6 and 24 (about
//     10 minutes, 35 minutes and 2 hours in at the default 5-minute cadence), then stands down.
//   - A recovery note is posted only for an outage that actually alerted.
// State lives in app_settings (one row per service), so a bot restart neither re-alerts an
// outage it already reported nor forgets one in progress.

const { SERVICES, resolveServiceState } = require('./services-board');
const { nextRepeatAlert } = require('./repeat-alert');

const CONFIRM_CHECKS = 2;
const ALERT_ATTEMPTS = new Set([1, 6, 24]);
const STAND_DOWN_AFTER = 24;

// Services worth alerting on: configured with a URL on this box, not the dashboard itself, not an
// external link, and not on the operator's ignore list.
function alertableServices(config, ignore = new Set()) {
  return SERVICES.filter(svc => !svc.self && !svc.external && !svc.externalKey && !svc.special
    && svc.urlKey && config[svc.urlKey]
    && !ignore.has(svc.key));
}

async function checkServices({ config, health, probe, ignore }) {
  const results = [];
  for (const svc of alertableServices(config, ignore)) {
    const { state } = await resolveServiceState(svc, { config, health, probe });
    const detail = state === 'down' && health?.errors?.[svc.healthKey]
      ? String(health.errors[svc.healthKey]).slice(0, 200)
      : null;
    results.push({ key: svc.key, name: svc.name, container: svc.container || null, state, detail });
  }
  return results;
}

// Turn one round of check results into alert events, updating per-service state as it goes.
// Returns [{ type: 'down', service, state } | { type: 'recovered', service, downForMs }].
function evaluateServiceAlerts({
  results,
  getAlertState,
  setAlertState,
  clearAlertState,
  confirmChecks = CONFIRM_CHECKS,
  now = Date.now(),
}) {
  const events = [];
  for (const service of results) {
    const previous = getAlertState(service.key);
    if (service.state === 'down') {
      const downChecks = (previous?.downChecks || 0) + 1;
      const firstDownAt = previous?.firstDownAt || now;
      if (downChecks < confirmChecks) {
        setAlertState(service.key, { downChecks, firstDownAt });
        continue;
      }
      // Before the first alert the stored state has no fingerprint, so the repeat sequence
      // starts fresh at attempt 1 and alerts immediately.
      const repeat = nextRepeatAlert(previous?.fingerprint ? previous : null, {
        fingerprint: `${service.key}:down`,
        now,
        alertAttempts: ALERT_ATTEMPTS,
        standDownAfter: STAND_DOWN_AFTER,
      });
      const state = { ...repeat, downChecks, firstDownAt, alerted: Boolean(previous?.alerted || repeat.shouldAlert), detail: service.detail };
      setAlertState(service.key, state);
      if (repeat.shouldAlert) events.push({ type: 'down', service, state });
      continue;
    }
    if (service.state === 'ok' && previous) {
      clearAlertState(service.key);
      if (previous.alerted) events.push({ type: 'recovered', service, downForMs: Math.max(0, now - Number(previous.firstDownAt || now)) });
    }
    // 'skip' (not configured or no signal) leaves any in-progress state alone.
  }
  return events;
}

function parseIgnoreList(raw) {
  return new Set(String(raw || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

module.exports = {
  CONFIRM_CHECKS,
  ALERT_ATTEMPTS,
  STAND_DOWN_AFTER,
  alertableServices,
  checkServices,
  evaluateServiceAlerts,
  parseIgnoreList,
};
