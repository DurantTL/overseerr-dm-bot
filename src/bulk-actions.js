'use strict';

// F14 bulk Quick Actions. Each action is two steps: plan (read-only: exactly which items it would
// touch, plus the ones it deliberately skips) and run. The run re-plans and refuses unless the
// list still matches the listKey from the plan the admin confirmed, so nothing outside what was
// shown can be touched. Every item goes through the same single-item path the dashboard and
// Discord already use; nothing here talks to an API directly.
//
//   approve-pending   every pending request, approved one by one (plain approve, never the
//                     AvistaZ pre-authorised variant)
//   deny-pending      pending requests denied one by one through the same /gate deny path
// Either request kind can be narrowed to the rows the admin ticked (`only`: item ids); the plan,
// and so the listKey the run must match, then covers exactly those.
//   pause-downloads   rTorrent torrents still downloading → stop. Seeding (complete) torrents are
//                     never touched, so private-tracker ratio is unaffected.
//   resume-downloads  rTorrent torrents still downloading → start (a no-op for running ones)
//   clear-imported    *arr queue entries the *arr has already imported → removed from the queue
//                     only (removeFromClient: false, no blocklist), so the torrent keeps seeding
//                     and no files are touched. Completed-but-not-imported entries are skipped.

const crypto = require('crypto');

const MAX_ITEMS = 50;

const KINDS = Object.freeze({
  'approve-pending': { label: 'Approve all pending', verb: 'Approve', needsDiscord: true },
  'deny-pending': { label: 'Deny pending', verb: 'Deny', needsDiscord: true },
  'pause-downloads': { label: 'Pause all downloads', verb: 'Pause', needsDiscord: false },
  'resume-downloads': { label: 'Resume all downloads', verb: 'Resume', needsDiscord: false },
  'clear-imported': { label: 'Clear imported from queues', verb: 'Clear', needsDiscord: false },
});

const pct = (done, size) => (size > 0 ? `${Math.floor((done / size) * 100)}%` : '');

function planItems(kind, { pending = [], torrents = [], queue = [] }) {
  const items = [];
  const skipped = [];
  if (kind === 'approve-pending' || kind === 'deny-pending') {
    for (const p of pending) {
      items.push({ id: `req:${p.nonce}`, label: p.label || 'Request', detail: [p.mediaType === 'tv' ? 'TV' : p.mediaType === 'movie' ? 'Movie' : null, p.is4k ? '4K' : null].filter(Boolean).join(' · '), ref: p.nonce });
    }
  } else if (kind === 'pause-downloads' || kind === 'resume-downloads') {
    for (const t of torrents) {
      if (t.complete) continue; // seeding: never touched
      items.push({ id: `tor:${t.hash}`, label: t.name, detail: [pct(t.doneBytes, t.sizeBytes), t.label || null].filter(Boolean).join(' · '), ref: t.hash });
    }
    const seeding = torrents.filter(t => t.complete).length;
    if (seeding) skipped.push({ label: `${seeding} seeding torrent${seeding === 1 ? '' : 's'}`, reason: 'complete, left alone' });
  } else if (kind === 'clear-imported') {
    for (const q of queue) {
      const done = q.trackedState === 'imported';
      if (done) {
        items.push({ id: `q:${q.source?.label}:${q.queueId}`, label: q.title, detail: `${q.source?.label || ''} · imported`, ref: { source: q.source, queueId: q.queueId } });
      } else if (String(q.status).toLowerCase() === 'completed') {
        skipped.push({ label: q.title, reason: q.trackedState ? `completed, ${q.trackedState}` : 'completed, not imported yet' });
      }
    }
  } else {
    throw Object.assign(new Error('Unknown bulk action'), { status: 400 });
  }
  return { items, skipped };
}

function planListKey(kind, items) {
  const ids = items.map(i => i.id).sort().join('\n');
  return crypto.createHash('sha256').update(`${kind}\n${ids}`).digest('hex').slice(0, 16);
}

// Kinds that accept `only` (a ticked subset of their items).
const SELECTABLE = new Set(['approve-pending', 'deny-pending']);

// Read-only. { kind, label, items, skipped, listKey, truncated }
function plan(kind, sources, { only = null } = {}) {
  if (!Object.hasOwn(KINDS, kind)) throw Object.assign(new Error('Unknown bulk action'), { status: 400 });
  let { items, skipped } = planItems(kind, sources);
  let label = KINDS[kind].label;
  if (only) {
    if (!SELECTABLE.has(kind)) throw Object.assign(new Error('This action cannot be limited to a selection'), { status: 400 });
    const wanted = new Set(only);
    const gone = only.filter(id => !items.some(i => i.id === id)).length;
    items = items.filter(i => wanted.has(i.id));
    skipped = gone ? [{ label: `${gone} selected request${gone === 1 ? '' : 's'}`, reason: 'no longer pending' }] : [];
    label = `${KINDS[kind].verb} selected`;
  }
  const capped = items.slice(0, MAX_ITEMS);
  return { kind, label, items: capped, skipped, listKey: planListKey(kind, capped), truncated: items.length > capped.length ? items.length - capped.length : 0 };
}

// `only` from a request body: item ids like req:<8 hex>, at most MAX_ITEMS; null when absent.
function parseOnly(raw) {
  if (raw == null) return null;
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_ITEMS) throw Object.assign(new Error('Pick between 1 and ' + MAX_ITEMS + ' items'), { status: 400 });
  const ids = [...new Set(raw.map(String))];
  if (!ids.every(id => /^req:[0-9a-f]{8}$/.test(id))) throw Object.assign(new Error('Unknown item in the selection'), { status: 400 });
  return ids;
}

// What the browser sees: the plan without `ref`, which for queue items carries the *arr source
// (including its API key) and stays server-side.
function publicPlan(planned) {
  return { ...planned, items: planned.items.map(({ ref: _ref, ...rest }) => rest) };
}

// Runs the plan's items one at a time through `act(kind, item)`; one failure never stops the
// rest. Returns { attempted, succeeded, failed: [{ label, error }] } with error text bounded.
async function run(planned, act) {
  const failed = [];
  let succeeded = 0;
  for (const item of planned.items) {
    try {
      const outcome = await act(planned.kind, item);
      if (outcome && outcome.ok === false) failed.push({ label: item.label, error: String(outcome.error || 'not done').slice(0, 160) });
      else succeeded += 1;
    } catch (err) {
      failed.push({ label: item.label, error: String(err?.message || err).slice(0, 160) });
    }
  }
  return { attempted: planned.items.length, succeeded, failed };
}

module.exports = { KINDS, MAX_ITEMS, plan, parseOnly, planItems, planListKey, publicPlan, run };
