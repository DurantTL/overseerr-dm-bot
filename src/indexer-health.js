'use strict';

// Service queue item 14: Prowlarr indexer-health flips, report-only. Prowlarr lists an indexer in
// /api/v1/indexerstatus while it is backing off after failures (disabledTill in the future). The
// sweep compares each enabled indexer with the last check and reports only changes:
//   - failing in CONFIRM_CHECKS checks in a row → one "failing" note (a short backoff stays quiet)
//   - working again after a reported failure → one "back" note with how long it was out
// Nothing is retried, disabled or edited in Prowlarr. Prowlarr itself being down is the
// service-down alert's job, so an unreachable Prowlarr fails the sweep without touching state.

const axios = require('axios');

const CONFIRM_CHECKS = 2;

// One row per Prowlarr indexer: { id, name, enabled, failing, disabledTill, failingSince }.
// Shared with /indexers so the command and the alert read health the same way.
async function fetchIndexerHealth(config, { http = axios, now = Date.now() } = {}) {
  const base = String(config.PROWLARR_URL || '').replace(/\/+$/, '');
  const headers = { 'X-Api-Key': config.PROWLARR_API_KEY };
  const [indexers, statuses] = await Promise.all([
    http.get(`${base}/api/v1/indexer`, { headers, timeout: 10000 }).then(r => r.data || []),
    http.get(`${base}/api/v1/indexerstatus`, { headers, timeout: 10000 }).then(r => r.data || []).catch(() => []),
  ]);
  const byId = new Map((Array.isArray(statuses) ? statuses : []).map(s => [s.indexerId, s]));
  return (Array.isArray(indexers) ? indexers : []).map(ix => {
    const st = byId.get(ix.id);
    const till = st?.disabledTill ? Date.parse(st.disabledTill) : NaN;
    return {
      id: ix.id,
      name: ix.name || `Indexer ${ix.id}`,
      enabled: ix.enable !== false,
      failing: ix.enable !== false && Number.isFinite(till) && till > now,
      disabledTill: st?.disabledTill || null,
      failingSince: st?.initialFailure || st?.mostRecentFailure || null,
    };
  });
}

// Pure. state: { [id]: { downChecks, alerted, firstDownAt } } from the last check. Returns the
// events to post and the state to store. Disabled or removed indexers drop out quietly.
function evaluateIndexerFlips({ results, state = {}, now = Date.now(), confirmChecks = CONFIRM_CHECKS }) {
  const next = {};
  const events = [];
  for (const ix of results) {
    if (!ix.enabled) continue;
    const prev = state[ix.id] || null;
    if (ix.failing) {
      const downChecks = (prev?.downChecks || 0) + 1;
      const firstDownAt = prev?.firstDownAt || now;
      const alerted = !!prev?.alerted || downChecks >= confirmChecks;
      if (alerted && !prev?.alerted) events.push({ type: 'failing', indexer: ix, firstDownAt });
      next[ix.id] = { downChecks, alerted, firstDownAt };
    } else if (prev?.alerted) {
      events.push({ type: 'recovered', indexer: ix, downForMs: Math.max(0, now - Number(prev.firstDownAt || now)) });
    }
  }
  return { events, state: next };
}

module.exports = { CONFIRM_CHECKS, fetchIndexerHealth, evaluateIndexerFlips };
