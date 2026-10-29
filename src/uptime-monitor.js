'use strict';

// Uptime history for the Services board's Uptime section, from two RackNerd feeds that already
// exist and already own their own alerts: the reachability checker (four public paths, probed every
// 5 minutes) and the tailscale monitor (the fleet's Tailscale nodes, online or offline). Each POSTs
// its results here after a run; this module only stores them and summarises what was stored. No
// judgment of its own: a sample is up or down because the checker or monitor said so. Nothing here
// alerts.
//
// Never invents history: a period with no samples has no percentage, an hour with no samples is
// "no data" (grey, never green), and a period the stored samples do not yet cover is reported as
// still collecting.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RETAIN_MS = 30 * DAY;
// The checker runs every 5 minutes; a period counts as covered when the oldest stored sample is
// within one run (plus slack) of the period's start.
const COVER_SLACK_MS = 10 * MINUTE;
// Accept a result stamped at most this far in the past (a retried post) or future (clock skew).
const MAX_AGE_MS = DAY;
const MAX_SKEW_MS = 10 * MINUTE;
const DETAIL_MAX = 200;

// Exactly the four paths the checker probes, in its order, then the fleet's Tailscale nodes the
// RackNerd tailscale monitor tracks (online/offline as it reports them). Keys are what each posts.
// Nodes without a monitor feed (Central Iowa, Europe), retired registrations and the watcher itself
// are not listed, so a post naming them is refused and they never become rows.
const ENDPOINTS = Object.freeze([
  { key: 'plex-funnel', kind: 'path', name: 'Plex via Tailscale Funnel', target: 'durant-server.end-cobra.ts.net/identity' },
  { key: 'dashboard-funnel', kind: 'path', name: 'Bot dashboard via Funnel', target: 'durant-server.end-cobra.ts.net/dashboard' },
  { key: 'bot-cloudflare', kind: 'path', name: 'Bot via Cloudflare Tunnel', target: 'media.durantlogic.com/live' },
  { key: 'seedbox-rutorrent', kind: 'path', name: 'EvoSeedbox ruTorrent', target: 'pace.myseedbox.site/rutorrent/' },
  { key: 'node-durant-server', kind: 'node', name: 'durant-server', target: 'Tailscale node' },
  { key: 'node-ph-server', kind: 'node', name: 'ph-server', target: 'Tailscale node' },
  { key: 'node-southcentral-server', kind: 'node', name: 'southcentral-server', target: 'Tailscale node' },
  { key: 'node-cali-plex-server', kind: 'node', name: 'cali-plex-server', target: 'Tailscale node' },
]);
const KEYS = new Set(ENDPOINTS.map(e => e.key));

const PERIODS = Object.freeze([['24h', DAY], ['7d', 7 * DAY], ['30d', 30 * DAY]]);

class IngestError extends Error {}

function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

// Body: { checked_at?, results: [{ key, up, detail?, checked_at? }] } — one result per endpoint
// per run. A per-result checked_at wins over the run's. Returns rows to store, or throws
// IngestError with a reason the caller sends back as a 400.
function parseIngest(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.results)) throw new IngestError('Expected a JSON object with a results array.');
  if (!body.results.length || body.results.length > ENDPOINTS.length) throw new IngestError(`Send between 1 and ${ENDPOINTS.length} results per run.`);
  const runAt = body.checked_at == null ? null : parseTime(body.checked_at);
  if (body.checked_at != null && runAt == null) throw new IngestError('checked_at is not a valid time.');
  const seen = new Set();
  return body.results.map((r, i) => {
    if (!r || typeof r !== 'object') throw new IngestError(`Result ${i + 1} is not an object.`);
    const key = String(r.key || '');
    if (!KEYS.has(key)) throw new IngestError(`Unknown endpoint key: ${key.slice(0, 40) || '(empty)'}.`);
    if (seen.has(key)) throw new IngestError(`Endpoint ${key} appears twice in one run.`);
    seen.add(key);
    if (typeof r.up !== 'boolean') throw new IngestError(`Result for ${key} needs up: true or false.`);
    const at = r.checked_at == null ? (runAt ?? now) : parseTime(r.checked_at);
    if (at == null) throw new IngestError(`Result for ${key} has an invalid checked_at.`);
    if (at > now + MAX_SKEW_MS || at < now - MAX_AGE_MS) throw new IngestError(`Result for ${key} is stamped outside the accepted window.`);
    const detail = r.detail == null ? '' : [...String(r.detail)].map(c => (c.charCodeAt(0) < 32 ? ' ' : c)).join('').replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX);
    return { endpoint: key, checkedAt: at, up: r.up, detail };
  });
}

// Append-only: a repeated post for the same endpoint and time (a retry) is ignored, never
// overwrites what was stored. Returns how many rows were new.
function recordSamples(database, rows) {
  const insert = database.prepare('INSERT OR IGNORE INTO uptime_samples (endpoint, checked_at, up, detail) VALUES (?, ?, ?, ?)');
  let added = 0;
  database.transaction(list => {
    for (const r of list) added += insert.run(r.endpoint, r.checkedAt, r.up ? 1 : 0, r.detail || null).changes;
  })(rows);
  return added;
}

function pruneSamples(database, now = Date.now()) {
  return database.prepare('DELETE FROM uptime_samples WHERE checked_at < ?').run(now - RETAIN_MS).changes;
}

function pct(up, total) {
  return total ? Math.round((up / total) * 10000) / 100 : null;
}

// Summary for one endpoint from its samples (oldest first, all within the retention window).
function summarizeEndpoint(samples, now) {
  const last = samples[samples.length - 1] || null;
  const oldest = samples[0] || null;
  const periods = {};
  for (const [label, span] of PERIODS) {
    const start = now - span;
    const inWindow = samples.filter(s => s.checkedAt >= start);
    const up = inWindow.filter(s => s.up).length;
    periods[label] = {
      pct: pct(up, inWindow.length),
      samples: inWindow.length,
      covered: !!oldest && oldest.checkedAt <= start + COVER_SLACK_MS,
    };
  }
  // Last outage: the most recent run of down samples that ended in an up sample. An outage still
  // going on is reported separately as `ongoing`.
  let lastOutage = null;
  let ongoing = null;
  let downStart = null;
  for (const s of samples) {
    if (!s.up && downStart == null) downStart = s.checkedAt;
    if (s.up && downStart != null) {
      lastOutage = { start: downStart, end: s.checkedAt, durationMs: s.checkedAt - downStart };
      downStart = null;
    }
  }
  if (downStart != null) ongoing = { start: downStart, durationMs: now - downStart };
  // 24 hourly blocks, oldest first, ending now. Worst status wins; no samples is null (no data).
  const blocks = [];
  for (let i = 0; i < 24; i++) {
    const from = now - (24 - i) * HOUR;
    const to = from + HOUR;
    const hour = samples.filter(s => s.checkedAt >= from && s.checkedAt < (i === 23 ? to + 1 : to));
    blocks.push(hour.length ? (hour.some(s => !s.up) ? 'down' : 'up') : null);
  }
  return {
    current: last ? { up: last.up, at: last.checkedAt, detail: last.detail || null } : null,
    periods,
    collecting: !periods['30d'].covered,
    historySince: oldest ? oldest.checkedAt : null,
    lastOutage,
    ongoing,
    blocks,
  };
}

function uptimeReport(database, now = Date.now()) {
  const rows = database.prepare('SELECT endpoint, checked_at, up, detail FROM uptime_samples WHERE checked_at >= ? AND checked_at <= ? ORDER BY checked_at')
    .all(now - RETAIN_MS, now + MAX_SKEW_MS);
  const by = new Map(ENDPOINTS.map(e => [e.key, []]));
  for (const r of rows) {
    const list = by.get(r.endpoint);
    if (list) list.push({ checkedAt: r.checked_at, up: r.up === 1, detail: r.detail });
  }
  return ENDPOINTS.map(e => ({ key: e.key, kind: e.kind, name: e.name, target: e.target, ...summarizeEndpoint(by.get(e.key), now) }));
}

module.exports = { ENDPOINTS, RETAIN_MS, IngestError, parseIngest, recordSamples, pruneSamples, summarizeEndpoint, uptimeReport };
