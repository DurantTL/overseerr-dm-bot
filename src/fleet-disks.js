'use strict';

// Fleet-wide disk visibility: merges the *arr-reported volumes (durant-server's own disks)
// with per-tier-node disks from the latest agent telemetry, and evaluates low-space /
// SMART-health transitions with hysteresis. Pure functions — the sweep in index.js supplies
// data and applies the returned events (notify + audit + persist state).

const {
  TELEMETRY_STALE_AFTER_MS,
  assessDiskLevel,
  telemetryAge,
} = require('./node-telemetry');

function percentUsed(total, free) {
  if (!(total > 0)) return null;
  return Math.round(((total - free) / total) * 1000) / 10;
}

// Merge *arr diskspace entries with tier-node telemetry disks into one fleet list.
// Shape per entry: { name, freeBytes, totalBytes, percentUsed, source: 'arr'|'tier-agent',
// node, telemetryAgeMs, smartHealth }. Tier nodes with no usable telemetry are skipped;
// stale telemetry is included but flagged via telemetryAgeMs so callers can see it.
function mergeFleetDisks({ arrDisks = [], tierNodes = [], now = Date.now() } = {}) {
  const disks = [];
  for (const d of arrDisks) {
    const total = Number(d.totalSpace) || 0;
    const free = Number(d.freeSpace) || 0;
    disks.push({
      name: String(d.displayPath || d.path || 'unknown').slice(0, 200),
      freeBytes: free,
      totalBytes: total,
      percentUsed: percentUsed(total, free),
      source: 'arr',
      node: 'durant-server',
      telemetryAgeMs: null,
      smartHealth: null,
    });
  }
  for (const { name, telemetry } of tierNodes) {
    const total = Number(telemetry?.filesystemTotalBytes) || 0;
    const free = Number(telemetry?.filesystemFreeBytes) || 0;
    if (!(total > 0)) continue;
    disks.push({
      name: String(name).slice(0, 200),
      freeBytes: free,
      totalBytes: total,
      percentUsed: percentUsed(total, free),
      source: 'tier-agent',
      node: String(name).slice(0, 120),
      telemetryAgeMs: telemetry?.collectedAt ? Math.max(0, now - telemetry.collectedAt) : null,
      smartHealth: Array.isArray(telemetry?.smartHealth) ? telemetry.smartHealth : null,
    });
  }
  return disks;
}

// Evaluate low-space transitions across the fleet. getAlertState(key) returns the stored
// {level} (or null). Returns { events, levels }: events for transitions into/out of
// warn|urgent (ok→ok and unknown→anything stay silent), and levels mapping every checked
// key to its assessed level so the sweep can persist state for all of them.
// Stale tier telemetry (> staleAfterMs) is treated as unknown: a dead agent must not page
// about disk space (its liveness is covered elsewhere).
function evaluateFleetDiskAlerts({
  arrDisks = [],
  tierNodes = [],
  getAlertState,
  warnFreePct = 15,
  urgentFreePct = 8,
  clearMarginPct = 3,
  staleAfterMs = TELEMETRY_STALE_AFTER_MS,
  now = Date.now(),
}) {
  const events = [];
  const levels = {};
  const check = (key, label, freeBytes, totalBytes, stale) => {
    const previous = getAlertState(key)?.level || 'unknown';
    const assessed = stale
      ? { level: 'unknown', reason: 'telemetry stale', freePct: null }
      : assessDiskLevel({ freeBytes, totalBytes }, { warnFreePct, urgentFreePct, clearMarginPct, previousLevel: previous });
    levels[key] = assessed.level;
    if (assessed.level === previous) return;
    if (assessed.level !== 'unknown' && previous !== 'unknown') {
      events.push({ key, label, type: 'transition', from: previous, to: assessed.level, freePct: assessed.freePct, reason: assessed.reason });
      return;
    }
    // First real reading (unknown → level): only page if it's already bad.
    if (previous === 'unknown' && (assessed.level === 'warn' || assessed.level === 'urgent')) {
      events.push({ key, label, type: 'transition', from: previous, to: assessed.level, freePct: assessed.freePct, reason: assessed.reason });
    }
  };
  for (const d of arrDisks) {
    const pathLabel = String(d.displayPath || d.path || 'unknown');
    check(`arr:${pathLabel}`, `durant-server ${pathLabel}`, Number(d.freeSpace) || 0, Number(d.totalSpace) || 0, false);
  }
  for (const { name, telemetry } of tierNodes) {
    const total = Number(telemetry?.filesystemTotalBytes) || 0;
    if (!(total > 0)) continue;
    const ageMs = telemetryAge(telemetry, now);
    check(`tier:${name}`, `node ${name}`, Number(telemetry.filesystemFreeBytes) || 0, total, ageMs != null && ageMs > staleAfterMs);
  }
  return { events, levels };
}

// Evaluate SMART health transitions per node. getPreviousFailing(node) returns the stored
// array of failing device names (or null). Returns { events, failingByNode }: events for
// newly failing devices and for recoveries (previously failing, now ok or no longer
// reported), and failingByNode mapping every node with SMART data to its current failing
// list so the sweep can persist it.
function evaluateSmartTransitions({ tierNodes = [], getPreviousFailing }) {
  const events = [];
  const failingByNode = {};
  for (const { name, telemetry } of tierNodes) {
    const reported = Array.isArray(telemetry?.smartHealth) ? telemetry.smartHealth : null;
    if (!reported) continue; // no SMART data — never a transition
    const failing = reported.filter(d => d.health === 'failing').map(d => d.device).sort();
    failingByNode[name] = failing;
    const previous = (getPreviousFailing(name) || []).slice().sort();
    const newlyFailing = failing.filter(d => !previous.includes(d));
    const recovered = previous.filter(d => !failing.includes(d));
    if (newlyFailing.length || recovered.length) {
      events.push({ node: name, type: 'smart-transition', newlyFailing, recovered, failing });
    }
  }
  return { events, failingByNode };
}

module.exports = {
  mergeFleetDisks,
  evaluateFleetDiskAlerts,
  evaluateSmartTransitions,
};
