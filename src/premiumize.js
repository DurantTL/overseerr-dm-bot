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

module.exports = { premiumizeConfigured, pmApi, accountInfo, listTransfers, deleteTransfer, retryTransfer, clearFinished, findStuckTransfers, isStuckCandidate };
