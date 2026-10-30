'use strict';

// Automation → Fleet and host: every automation-related thing that is not a bot registry job, in
// one place, without overstating liveness. Server-rendered from the bot's own stores on each page
// render (like Jobs); there is no client fetch, so nothing can sit on a loading state.
//
// Three kinds of row:
//   - live from bot data: tier nodes (tier_nodes + their last check-in) and the two RackNerd feeds
//     (uptime_samples, rolled up; the graphs stay on Home → Uptime);
//   - heartbeat rows: the allowlist in src/fleet-host-inventory.js, fed by POST
//     /api/automation/heartbeat (src/routes/automation-heartbeat.js);
//   - inventory rows: listed with schedule, path and log, status always unknown.
//
// Status, per row, against that row's own period:
//   ok       last report within last + period + grace
//   stale    past last + period + grace (grace = one period, at most 12 hours)
//   failed   the last heartbeat itself said it failed
//   no data  never reported
//   unknown  inventory rows, and heartbeat rows with no schedule to judge against
// "ok" needs a real report; nothing is ever ok by default.

const inventory = require('./fleet-host-inventory');
const { ENDPOINTS: UPTIME_ENDPOINTS } = require('./uptime-monitor');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RETAIN_MS = 30 * DAY;
const MAX_GRACE_MS = 12 * HOUR;
const MAX_AGE_MS = DAY;
const MAX_SKEW_MS = 10 * MINUTE;
const SUMMARY_MAX = 200;
const SOURCE_MAX = 60;
const MAX_COUNTS = 10;
// The RackNerd checker and monitor both run every 5 minutes.
const RACKNERD_PERIOD_MS = 5 * MINUTE;

// ---------------------------------------------------------------------------------------------
// Status

function graceFor(periodMs) {
  return Math.min(periodMs, MAX_GRACE_MS);
}

// { status, overdueAt } for a row with period periodMs (null = no schedule), last report at lastAt
// (null = never), and whether that last report said it failed.
function rowStatus({ periodMs, lastAt, lastFailed = false, now = Date.now() }) {
  if (lastAt == null) return { status: 'no-data', overdueAt: null };
  if (!(periodMs > 0)) return { status: lastFailed ? 'failed' : 'unknown', overdueAt: null };
  const overdueAt = lastAt + periodMs + graceFor(periodMs);
  if (lastFailed) return { status: 'failed', overdueAt, overdue: now > overdueAt };
  return { status: now > overdueAt ? 'stale' : 'ok', overdueAt };
}

// ---------------------------------------------------------------------------------------------
// Heartbeat store

class HeartbeatError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const ALLOWED = new Map(inventory.heartbeats.map(h => [h.name, h]));

// Text that looks like it carries a credential. A sender should never put one in a summary; when
// it does, the whole post is refused rather than stored with the secret blanked out.
const SECRET_PATTERNS = [
  /\b(?:token|password|passwd|pwd|secret|api[_ -]?key|apikey|access[_ -]?key|auth(?:orization)?|bearer|cookie|session|credential|private[_ -]?key)\b\s*[:=]/i,
  /\bbearer\s+\S{8,}/i,
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, // user:password@ in a URL
  /[?&](?:token|key|apikey|api_key|secret|password|auth|sig|signature)=/i,
  /\b[A-Fa-f0-9]{32,}\b/, // long hex runs (keys, tokens, hashes)
  /(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{32,}={0,2}/, // long letter+digit runs (base64-ish keys)
  /\b(?:ghp|gho|ghs|github_pat|xox[abprs]|sk|pk|rk)_[A-Za-z0-9_]{10,}/, // well-known token prefixes
];
const SECRET_KEY_NAME = /(token|secret|pass|key|auth|cred|cookie|session|bearer)/i;

function looksSecret(text) {
  return SECRET_PATTERNS.some(re => re.test(text));
}

function cleanText(value, max, field) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new HeartbeatError(`${field} must be text.`);
  const text = [...String(value)].map(c => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > max) throw new HeartbeatError(`${field} is longer than ${max} characters.`);
  if (looksSecret(text)) throw new HeartbeatError(`${field} looks like it contains a credential; nothing was stored. Send counts and plain words only.`);
  return text;
}

function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

// Body: { name, status: "ok"|"fail", at?, source?, summary?, counts?: { key: number } }.
// Only those fields are read; anything else in the body is dropped and never stored. Returns the
// row to store, or throws HeartbeatError (404 for a name not on the allowlist, else 400).
function parseHeartbeat(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HeartbeatError('Expected a JSON object.');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new HeartbeatError('name is required.');
  if (!ALLOWED.has(name)) throw new HeartbeatError('Unknown heartbeat name. Only names on the bot\'s allowlist are accepted.', 404);
  if (body.status !== 'ok' && body.status !== 'fail') throw new HeartbeatError('status must be "ok" or "fail".');
  const at = body.at == null ? now : parseTime(body.at);
  if (at == null) throw new HeartbeatError('at is not a valid time.');
  if (at > now + MAX_SKEW_MS || at < now - MAX_AGE_MS) throw new HeartbeatError('at is outside the accepted window (the last 24 hours).');
  const source = cleanText(body.source, SOURCE_MAX, 'source');
  const summary = cleanText(body.summary, SUMMARY_MAX, 'summary');
  let counts = null;
  if (body.counts != null) {
    if (typeof body.counts !== 'object' || Array.isArray(body.counts)) throw new HeartbeatError('counts must be an object of numbers.');
    const entries = Object.entries(body.counts);
    if (entries.length > MAX_COUNTS) throw new HeartbeatError(`counts can hold at most ${MAX_COUNTS} numbers.`);
    counts = {};
    for (const [key, value] of entries) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) throw new HeartbeatError('counts keys must be short lowercase words (a-z, 0-9, _).');
      if (SECRET_KEY_NAME.test(key)) throw new HeartbeatError('counts keys must not name credentials; nothing was stored.');
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new HeartbeatError('counts values must be numbers.');
      counts[key] = value;
    }
    if (!entries.length) counts = null;
  }
  return { name, at, ok: body.status === 'ok', source, summary, counts };
}

// Append-only: a repeated post for the same name and time (a retry) is ignored.
function recordHeartbeat(database, row, receivedAt = Date.now()) {
  return database.prepare('INSERT OR IGNORE INTO automation_heartbeats (name, reported_at, received_at, ok, source, summary, counts) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(row.name, row.at, receivedAt, row.ok ? 1 : 0, row.source, row.summary, row.counts ? JSON.stringify(row.counts) : null).changes;
}

function pruneHeartbeats(database, now = Date.now()) {
  return database.prepare('DELETE FROM automation_heartbeats WHERE reported_at < ?').run(now - RETAIN_MS).changes;
}

// The newest heartbeat per name, plus when it last succeeded. Map name → row.
function latestHeartbeats(database, now = Date.now()) {
  const rows = database.prepare(`
    SELECT h.name, h.reported_at, h.ok, h.source, h.summary, h.counts,
      (SELECT MAX(reported_at) FROM automation_heartbeats o WHERE o.name = h.name AND o.ok = 1 AND o.reported_at <= ?) AS last_ok_at
    FROM automation_heartbeats h
    JOIN (SELECT name, MAX(reported_at) AS m FROM automation_heartbeats WHERE reported_at <= ? GROUP BY name) x
      ON x.name = h.name AND x.m = h.reported_at`).all(now + MAX_SKEW_MS, now + MAX_SKEW_MS);
  const out = new Map();
  for (const r of rows) {
    let counts;
    try { counts = r.counts ? JSON.parse(r.counts) : null; } catch (_e) { counts = null; }
    out.set(r.name, { at: r.reported_at, ok: r.ok === 1, source: r.source, summary: r.summary, counts, lastOkAt: r.last_ok_at });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Model

// The two RackNerd feeds from uptime_samples: newest sample per endpoint, then counts per feed.
// The newest sample of the feed is that feed's last report.
function racknerdRollup(database, now = Date.now()) {
  const rows = database.prepare(`
    SELECT u.endpoint, u.checked_at, u.up FROM uptime_samples u
    JOIN (SELECT endpoint, MAX(checked_at) AS m FROM uptime_samples WHERE checked_at <= ? AND checked_at >= ? GROUP BY endpoint) x
      ON x.endpoint = u.endpoint AND x.m = u.checked_at`).all(now + MAX_SKEW_MS, now - RETAIN_MS);
  const latest = new Map(rows.map(r => [r.endpoint, { at: r.checked_at, up: r.up === 1 }]));
  const feed = (kind, label, where, noun) => {
    const endpoints = UPTIME_ENDPOINTS.filter(e => e.kind === kind);
    const staleAfter = RACKNERD_PERIOD_MS + graceFor(RACKNERD_PERIOD_MS);
    let up = 0;
    let down = 0;
    let stale = 0;
    let none = 0;
    let lastAt = null;
    for (const e of endpoints) {
      const s = latest.get(e.key);
      if (!s) { none++; continue; }
      if (s.up) up++; else down++;
      if (now - s.at > staleAfter) stale++;
      lastAt = lastAt == null ? s.at : Math.max(lastAt, s.at);
    }
    const st = rowStatus({ periodMs: RACKNERD_PERIOD_MS, lastAt, now });
    const parts = [`${up} of ${endpoints.length} ${noun} up`, down ? `${down} down` : null, stale ? `${stale} stale` : null, none ? `${none} never reported` : null].filter(Boolean);
    return {
      kind: 'racknerd', key: kind, label, where, schedule: 'every 5 min', periodMs: RACKNERD_PERIOD_MS,
      lastAt, status: st.status, overdueAt: st.overdueAt,
      counts: { total: endpoints.length, up, down, stale, noData: none },
      summary: lastAt == null ? 'No results stored yet.' : parts.join(' · '),
      attention: down > 0 || stale > 0,
    };
  };
  return [
    feed('path', 'RackNerd reachability checker', 'RackNerd · cron, 4 public paths + TCP', 'paths'),
    feed('node', 'RackNerd tailscale monitor', 'RackNerd · cron (5 min), Tailscale nodes', 'nodes'),
  ];
}

function tierRows({ tierNodes = [], getTierPlan, lastReportAt = () => null, now = Date.now() }) {
  const meta = new Map(inventory.tierNodes.map(t => [t.node, t]));
  const rows = [];
  const seen = new Set();
  for (const n of tierNodes) {
    seen.add(n.name);
    const m = meta.get(n.name) || {};
    const periodMinutes = m.period || inventory.tierDefaults.period;
    const plan = getTierPlan ? getTierPlan(n.name) : null;
    const lastAt = plan?.lastHeartbeatAt || lastReportAt(n.name) || null;
    const st = rowStatus({ periodMs: periodMinutes * MINUTE, lastAt, now });
    const monitor = !!(m.monitor || n.monitor_only);
    const telemetry = plan?.lastTelemetry || null;
    const notes = [];
    if (!n.enabled) notes.push('disabled in the tier registry');
    if (monitor && lastAt == null) notes.push('no telemetry row yet');
    if (monitor && telemetry) notes.push(Number(telemetry.filesystemTotalBytes) > 0 ? 'fleet-disks row present' : 'no fleet-disks row (no volume size reported; SMART only)');
    if (plan?.lastErrors?.length) notes.push(`last report had ${plan.lastErrors.length} error(s), see Fleet → Nodes`);
    rows.push({
      kind: 'tier', key: n.name, label: n.name, where: m.where || inventory.tierDefaults.where + (monitor ? ' (monitor-only)' : ''),
      schedule: m.schedule || inventory.tierDefaults.schedule, periodMs: periodMinutes * MINUTE,
      lastAt, status: !n.enabled ? 'disabled' : st.status, overdueAt: st.overdueAt,
      summary: lastAt == null && monitor ? 'No telemetry row yet.' : null,
      notes,
    });
  }
  for (const m of inventory.tierNodes) {
    if (!m.listWhenMissing || seen.has(m.node)) continue;
    rows.push({
      kind: 'tier', key: m.node, label: m.node, where: m.where, schedule: m.schedule, periodMs: m.period * MINUTE,
      lastAt: null, status: 'no-data', overdueAt: null,
      summary: 'No telemetry row yet: the node is not registered in the tier registry.',
      notes: [],
    });
  }
  return rows;
}

function heartbeatRows(latest, now = Date.now()) {
  return inventory.heartbeats.map(h => {
    const last = latest.get(h.name) || null;
    const periodMs = h.period ? h.period * MINUTE : null;
    const st = rowStatus({ periodMs, lastAt: last ? last.at : null, lastFailed: last ? !last.ok : false, now });
    const notes = [];
    if (!periodMs) notes.push('no schedule set yet, so a heartbeat cannot be judged on time');
    if (last && !last.ok && last.lastOkAt) notes.push(`last success ${new Date(last.lastOkAt).toISOString()}`);
    if (st.overdue) notes.push('and no report since it was due');
    if (last?.source) notes.push(`reported from ${last.source}`);
    return {
      kind: 'heartbeat', key: h.name, label: h.label, group: h.group, where: h.where, schedule: h.schedule || 'schedule not set yet',
      periodMs, lastAt: last ? last.at : null, status: st.status, overdueAt: st.overdueAt,
      summary: last ? last.summary : 'Awaiting first heartbeat.',
      counts: last?.counts || null,
      path: h.path || null, log: h.log || null, notes,
    };
  });
}

function inventoryRows() {
  return inventory.inventory.map(i => ({
    kind: 'inventory', key: i.name, label: i.label, where: i.where, schedule: i.schedule, periodMs: null,
    lastAt: null, status: 'unknown', overdueAt: null, summary: i.note || null, path: i.path || null, log: i.log || null, notes: [],
  }));
}

// Each group is read on its own: one failing store renders an error line for that group, and
// the rest of the section still renders.
function buildModel({ db, tierNodes, listTierNodes, getTierPlan, lastReportAt, now = Date.now() }) {
  const group = (fn) => {
    try { return { rows: fn() }; } catch (err) { return { rows: [], error: 'Could not read this group right now.', detail: err && err.message ? String(err.message).slice(0, 120) : null }; }
  };
  return {
    now,
    tier: group(() => tierRows({ tierNodes: tierNodes || (listTierNodes ? listTierNodes() : []), getTierPlan, lastReportAt, now })),
    racknerd: group(() => racknerdRollup(db, now)),
    heartbeats: group(() => heartbeatRows(latestHeartbeats(db, now), now)),
    inventory: group(() => inventoryRows()),
  };
}

// ---------------------------------------------------------------------------------------------
// Render

const STATUS_TEXT = { ok: 'ok', stale: 'stale', failed: 'failed', 'no-data': 'no data', unknown: 'unknown', disabled: 'disabled' };
// Existing dot styles only: ok green, warn amber, down red, skip grey.
const STATUS_DOT = { ok: 'ok', stale: 'warn', failed: 'down', 'no-data': 'skip', unknown: 'skip', disabled: 'skip' };

function periodWords(ms) {
  if (!(ms > 0)) return null;
  const m = Math.round(ms / MINUTE);
  if (m % (7 * 24 * 60) === 0) return m === 7 * 24 * 60 ? 'weekly' : `every ${m / (7 * 24 * 60)} weeks`;
  if (m % (24 * 60) === 0) return m === 24 * 60 ? 'daily' : `every ${m / (24 * 60)} days`;
  if (m % 60 === 0) return m === 60 ? 'hourly' : `every ${m / 60} h`;
  return `every ${m} min`;
}

function durationWords(ms) {
  const m = Math.round(ms / MINUTE);
  if (m % (24 * 60) === 0) return m === 24 * 60 ? '1 day' : `${m / (24 * 60)} days`;
  if (m % 60 === 0) return `${m / 60} h`;
  return `${m} min`;
}

function renderRow(row, { escapeHtml, fmtAgo }) {
  const statusText = row.kind === 'inventory' ? 'unknown, see log'
    : row.kind === 'heartbeat' && row.status === 'no-data' ? 'awaiting first heartbeat'
      : STATUS_TEXT[row.status] || row.status;
  const seen = row.lastAt != null ? `last seen ${fmtAgo(row.lastAt)}` : row.kind === 'inventory' ? 'not tracked' : 'never reported';
  const expected = row.kind === 'inventory' || !row.periodMs ? row.schedule : `expected ${row.schedule}`;
  // A failure's reason goes on the row itself; other summaries are one tap away.
  const reason = row.status === 'failed' && row.summary ? row.summary : null;
  const sub = [row.where, expected, seen, reason].filter(Boolean).join(' · ');
  const counts = row.counts && row.kind === 'heartbeat'
    ? Object.entries(row.counts).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ')
    : null;
  const more = [
    row.summary ? `<p>${escapeHtml(row.summary)}</p>` : '',
    counts ? `<p>${escapeHtml(counts)}</p>` : '',
    row.lastAt != null ? `<p>Last report ${escapeHtml(new Date(row.lastAt).toISOString())}${row.overdueAt ? ` · ${row.status === 'stale' ? 'overdue since' : 'due by'} ${escapeHtml(new Date(row.overdueAt).toISOString())}` : ''}</p>` : '',
    row.periodMs ? `<p class="muted">Expected ${escapeHtml(periodWords(row.periodMs))}; stale after one missed run plus a grace of ${escapeHtml(durationWords(graceFor(row.periodMs)))}.</p>` : '',
    row.path ? `<p>Script: <code>${escapeHtml(row.path)}</code></p>` : '',
    row.log ? `<p>Log: <code>${escapeHtml(row.log)}</code></p>` : '',
    ...(row.notes || []).map(n => `<p class="muted">${escapeHtml(n)}</p>`),
  ].join('');
  const shown = row.kind === 'racknerd' && row.summary ? `${sub} · ${row.summary}` : sub;
  return `<div class="item fh-row" data-key="fh-${escapeHtml(row.kind)}-${escapeHtml(row.key)}" data-fh-status="${escapeHtml(row.status)}">
      <span class="dot ${STATUS_DOT[row.status] || 'skip'}"></span>
      <div class="item-main"><div class="item-title">${escapeHtml(row.label)}</div>
      <div class="item-sub">${escapeHtml(shown)}</div>
      ${more ? `<div class="item-more">${more}</div>` : ''}</div>
      <div class="item-right">${escapeHtml(statusText)}</div>
    </div>`;
}

function renderGroup(title, sub, result, deps, extra = '') {
  const body = result.error
    ? `<p class="fh-error" role="alert">${deps.escapeHtml(result.error)} The rest of this page is unaffected.</p>`
    : result.rows.length ? `<div class="items">${result.rows.map(r => renderRow(r, deps)).join('')}</div>` : `<p class="muted">${deps.escapeHtml(deps.empty || 'Nothing to list.')}</p>`;
  return `<div class="fh-group"><h3>${deps.escapeHtml(title)}${sub ? `<span class="sub">${deps.escapeHtml(sub)}</span>` : ''}</h3>${body}${extra}</div>`;
}

function countRows(model) {
  return ['tier', 'racknerd', 'heartbeats', 'inventory'].reduce((n, k) => n + (model[k]?.rows?.length || 0), 0);
}

function renderSection(model, { escapeHtml, fmtAgo }) {
  const deps = { escapeHtml, fmtAgo, now: model.now };
  const heartbeatGroups = new Map();
  for (const r of model.heartbeats.rows) {
    if (!heartbeatGroups.has(r.group)) heartbeatGroups.set(r.group, []);
    heartbeatGroups.get(r.group).push(r);
  }
  const heartbeatHtml = model.heartbeats.error
    ? renderGroup('Heartbeats', null, model.heartbeats, deps)
    : [...heartbeatGroups.entries()].map(([g, rows]) => renderGroup(g, 'Heartbeat rows: grey until the first heartbeat arrives.', { rows }, deps)).join('');
  const uptimeLink = '<p class="muted fh-link">Per-path and per-node history (24 h, 7 d, 30 d): <a href="#home" data-tab="home" data-scroll="svcUptime">Home → Uptime</a>.</p>';
  return `<div class="card" id="fleet-host" data-rows-open><h2>Fleet and host<span class="sub">Automation outside the bot's own jobs. Each row is judged against its own schedule; ok only with a real report. Tap a row for details.</span></h2>
    ${renderGroup('Tier agents', 'Last check-in from the tier registry.', model.tier, { ...deps, empty: 'No tier nodes registered.' })}
    ${renderGroup('RackNerd', 'Roll-up of the uptime feeds; counts are each path\'s or node\'s newest result.', model.racknerd, deps, uptimeLink)}
    ${heartbeatHtml}
    ${renderGroup('Listed only', 'No heartbeat: schedule and log location only, status never ok.', model.inventory, deps)}
    <p class="muted fh-rule">Stale means past the last report plus one period plus a grace of one period (at most 12 hours). Failed means the last heartbeat itself reported a failure. Jobs above stay the bot's own truth; this list is the fleet and host view.</p>
  </div>`;
}

const FLEET_HOST_CSS = `
#fleet-host .fh-group { margin-top: 14px; }
#fleet-host .fh-group h3 { font-size: 14px; margin: 0 0 6px; display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
#fleet-host .fh-group h3 .sub { font-weight: 400; font-size: 12px; opacity: .75; }
#fleet-host .fh-error { color: var(--bad, #ff8a80); margin: 4px 0; }
#fleet-host .item-sub, #fleet-host .item-more p { overflow-wrap: anywhere; }
#fleet-host .fh-row .item-sub { white-space: normal; overflow: visible; text-overflow: clip; display: block; -webkit-line-clamp: unset; }
#fleet-host .item-more code { overflow-wrap: anywhere; white-space: normal; }
#fleet-host .fh-rule { margin-top: 14px; }
`;

module.exports = {
  RETAIN_MS,
  HeartbeatError,
  graceFor,
  rowStatus,
  parseHeartbeat,
  recordHeartbeat,
  pruneHeartbeats,
  latestHeartbeats,
  racknerdRollup,
  tierRows,
  heartbeatRows,
  inventoryRows,
  buildModel,
  renderSection,
  countRows,
  FLEET_HOST_CSS,
};
