'use strict';

// Service uptime history for the Services board. The service-down sweep (index.js) already checks
// every alertable service on a fixed cadence; each round's results are stored here as one row per
// service, so the board can show real 24-hour history instead of only "up right now".
// Only definite answers are stored: 'skip' (not configured, no signal) is not a sample, so a
// service that was never set up never reads as 0% up.

const HISTORY_MS = 8 * 24 * 60 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const BUCKETS = 48; // 30 minutes each across the last 24 hours

function recordServiceSamples(database, results, sampledAt = Date.now()) {
  const insert = database.prepare('INSERT OR REPLACE INTO service_samples (service, state, sampled_at) VALUES (?, ?, ?)');
  const write = database.transaction(rows => {
    for (const r of rows) insert.run(String(r.key), r.state, sampledAt);
  });
  write((results || []).filter(r => r && r.key && (r.state === 'ok' || r.state === 'down')));
}

function pruneServiceSamples(database, now = Date.now()) {
  database.prepare('DELETE FROM service_samples WHERE sampled_at < ?').run(now - HISTORY_MS);
}

// Per service: the share of checks that were up over the window, and a strip of BUCKETS slots,
// oldest first. A slot is 'ok' (every check up), 'down' (every check down), 'mixed', or null
// (no check fell in it, for example before sampling began).
function uptimeSummary(database, { now = Date.now(), windowMs = WINDOW_MS, buckets = BUCKETS } = {}) {
  const since = now - windowMs;
  const rows = database.prepare('SELECT service, state, sampled_at FROM service_samples WHERE sampled_at >= ? AND sampled_at <= ? ORDER BY sampled_at').all(since, now);
  const slotMs = windowMs / buckets;
  const out = {};
  for (const row of rows) {
    let s = out[row.service];
    if (!s) {
      s = { checks: 0, down: 0, slots: Array.from({ length: buckets }, () => null), firstAt: row.sampled_at };
      out[row.service] = s;
    }
    s.checks += 1;
    if (row.state === 'down') s.down += 1;
    const i = Math.min(buckets - 1, Math.max(0, Math.floor((row.sampled_at - since) / slotMs)));
    const prev = s.slots[i];
    s.slots[i] = prev == null || prev === row.state ? row.state : 'mixed';
  }
  for (const key of Object.keys(out)) {
    const s = out[key];
    s.pct = Math.round(((s.checks - s.down) / s.checks) * 1000) / 10;
    // Down spells: runs of slots that were not fully up.
    let spells = 0;
    let inSpell = false;
    for (const slot of s.slots) {
      const bad = slot === 'down' || slot === 'mixed';
      if (bad && !inSpell) spells += 1;
      inSpell = bad;
    }
    s.spells = spells;
    s.coversMs = now - s.firstAt;
    delete s.firstAt;
  }
  return out;
}

module.exports = { HISTORY_MS, WINDOW_MS, BUCKETS, recordServiceSamples, pruneServiceSamples, uptimeSummary };
