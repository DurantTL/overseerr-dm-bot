// Premiumize.me API: account info, transfer listing/cleanup, and stuck-transfer detection for
// the watchdog. Premiumize reports business failures (bad/expired key, unknown id) as HTTP 200
// with status:"error", so every call goes through the envelope-aware helper.
const axios = require('axios');
const { CONFIG } = require('./config');

const premiumizeConfigured = () => !!CONFIG.PREMIUMIZE_API_KEY;

// Overridable so the test suite can point calls at a mock server.
const PM_API_BASE = process.env.PREMIUMIZE_API_URL || 'https://www.premiumize.me/api';

// Reads are GET; the mutating transfer endpoints (delete/retry/clearfinished) are documented
// as POST with form-encoded parameters — the apikey rides the query string either way.
async function pmApi(path, params = {}, { post = false } = {}) {
  const res = post
    ? await axios.post(`${PM_API_BASE}${path}`, new URLSearchParams(params).toString(), {
      params: { apikey: CONFIG.PREMIUMIZE_API_KEY },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    })
    : await axios.get(`${PM_API_BASE}${path}`, {
      params: { apikey: CONFIG.PREMIUMIZE_API_KEY, ...params },
      timeout: 10000,
    });
  if (res.data?.status && res.data.status !== 'success') {
    throw new Error(res.data.message || `Premiumize ${path} returned status ${res.data.status}`);
  }
  return res.data;
}

const accountInfo = () => pmApi('/account/info');
const listTransfers = () => pmApi('/transfer/list').then(d => d?.transfers || []);
const deleteTransfer = id => pmApi('/transfer/delete', { id }, { post: true });
const retryTransfer = id => pmApi('/transfer/retry', { id }, { post: true });
const clearFinished = () => pmApi('/transfer/clearfinished', {}, { post: true });

// A transfer is "active" when Premiumize might still move it; finished/seeding never count as
// stuck, and finished ones are cleared with clearFinished instead.
const ACTIVE_STATUSES = ['waiting', 'queued', 'running'];
function isStuckCandidate(t) {
  return String(t.status) === 'error' || ACTIVE_STATUSES.includes(String(t.status));
}

// Pure stuck detection, mirroring the *arr stuckTracker pattern: `tracker` is the caller's
// Map(id -> { progress, since }) persisted across sweeps. Returns the transfers that are in
// error state, or active with progress frozen (0% forever included) for at least stuckAfterMs.
// Also prunes tracker entries for transfers that left the list.
function findStuckTransfers(transfers, tracker, { stuckAfterMs, now = Date.now() } = {}) {
  const stuck = [];
  const seen = new Set();
  for (const t of transfers) {
    const id = String(t.id);
    seen.add(id);
    if (!isStuckCandidate(t)) { tracker.delete(id); continue; }
    if (String(t.status) === 'error') { stuck.push(t); continue; }
    const progress = Number(t.progress || 0);
    const entry = tracker.get(id);
    if (!entry || entry.progress !== progress) {
      tracker.set(id, { progress, since: now });
      continue; // progress moved (or first sighting) — nothing to flag yet
    }
    if (now - entry.since >= stuckAfterMs) stuck.push(t);
  }
  for (const id of tracker.keys()) {
    if (!seen.has(id)) tracker.delete(id);
  }
  return stuck;
}

// A transfer that has moved essentially nothing has no prospect of moving: an error status, or
// an active status Premiumize itself is reporting as sourceless ("0 peer", "0 Bytes", not
// cached). findStuckTransfers already proves the freeze lasted stuckAfterMs — this only tells a
// dead torrent apart from one that's merely slow.
const NO_SOURCE_MESSAGE = /no (seeders?|peers?|source)|not cached|unknown left|0\s*bytes\s+of\s+0\s*bytes/i;
function isDeadTransfer(t, { maxProgress = 0.01 } = {}) {
  if (Number(t.progress || 0) > maxProgress) return false;
  if (String(t.status) === 'error') return true;
  return NO_SOURCE_MESSAGE.test(String(t.message || ''));
}

// Split an already-stuck list into what to auto-delete, what to give one more shot before
// deleting, and what still needs a human — honoring per-id ignore flags and the alert cooldown.
// `alertedAt` maps id -> ms of the last alert (0/missing = never); an id inside cooldown is
// neither deleted again nor re-alerted, so a batch stays idempotent across sweeps. Deletion never
// respects the alert cooldown — a dead transfer is cleaned up the moment it's found, whether or
// not it was already alerted on.
//
// `retried` is the set of ids that already got Premiumize's own retry on a previous sweep: a
// transfer that looks dead only 45+ minutes after being grabbed may just be a slow tracker
// rather than a genuinely dead one, so the first time a dead-looking transfer is seen it's
// retried instead of deleted outright, and only deleted once it's still dead on the *next* sweep
// after that retry. Set retryBeforeClear=false to go straight to the old immediate-delete
// behavior.
function planStuckTransferActions(stuck, { autoDelete = false, maxProgress = 0.01, ignored = new Set(), alertedAt = new Map(), cooldownMs = 0, retried = new Set(), retryBeforeClear = true, now = Date.now() } = {}) {
  const deletes = [];
  const retries = [];
  const alerts = [];
  let suppressed = 0;
  for (const t of stuck) {
    const id = String(t.id);
    if (ignored.has(id)) { suppressed++; continue; }
    if (autoDelete && isDeadTransfer(t, { maxProgress })) {
      if (retryBeforeClear && !retried.has(id)) { retries.push(t); continue; }
      deletes.push(t);
      continue;
    }
    const last = alertedAt.get(id) || 0;
    if (now - last < cooldownMs) { suppressed++; continue; }
    alerts.push(t);
  }
  return { deletes, retries, alerts, suppressed };
}

module.exports = { premiumizeConfigured, pmApi, accountInfo, listTransfers, deleteTransfer, retryTransfer, clearFinished, findStuckTransfers, isStuckCandidate, isDeadTransfer, planStuckTransferActions };
