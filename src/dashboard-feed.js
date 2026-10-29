'use strict';

// "What just happened": the Home feed of recent events people care about, read from the audit
// log the bot already writes. Only the actions listed here appear, each as one plain sentence;
// the rest of the log (searches, heartbeats, webhooks, previews) stays on the Activity tab.

function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }
function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || `${one}s`)}`; }
function duration(ms) {
  const m = Math.round(Number(ms) / 60000);
  if (!Number.isFinite(m) || m <= 0) return null;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
}

// tone: ok | warn | down | info. text(meta, ctx) returns the sentence, or null to leave the row out.
const FEED_ACTIONS = {
  media_requested: { tone: 'info', icon: 'plus', text: m => str(m.title) && `${m.title} was requested` },
  media_request_auto_approved: { tone: 'ok', icon: 'plus', text: m => str(m.title) && `${m.title} was requested and approved automatically` },
  request_approved: { tone: 'ok', icon: 'check', text: (m, c) => { const t = c.requestTitle(m.requestId); return t ? `${t} was approved` : 'A request was approved'; } },
  request_denied: { tone: 'warn', icon: 'x', text: (m, c) => { const t = c.requestTitle(m.requestId); return t ? `${t} was denied` : 'A request was denied'; } },
  media_available_notification_sent: { tone: 'ok', icon: 'play', text: m => (!m.subscriber && str(m.title)) ? `${m.title} is ready to watch` : null },
  service_down_alerted: { tone: 'down', icon: 'alert', text: (m, c) => (m.attemptCount == null || m.attemptCount === 1) ? `${c.serviceName(m.service)} went down` : null },
  service_down_recovered: { tone: 'ok', icon: 'check', text: (m, c) => { const d = duration(m.downForMs); return `${c.serviceName(m.service)} is back${d ? ` after ${d}` : ''}`; } },
  dashboard_service_restart: { tone: 'info', icon: 'restart', text: m => str(m.container) && (m.ok ? `${m.container} was restarted from the dashboard` : `Restarting ${m.container} failed`) },
  service_alert_restart: { tone: 'info', icon: 'restart', text: (m, c) => (m.ok === false ? `Restarting ${c.serviceName(m.service)} from an alert failed` : `${c.serviceName(m.service)} was restarted from an alert`) },
  stuck_download_removed: { tone: 'info', icon: 'download', text: m => (Number(m.removed) > 0 ? `Removed ${plural(Number(m.removed), 'stuck download')}` : null) },
  grab_import_rejected: { tone: 'warn', icon: 'alert', text: m => str(m.title) && `${m.title} could not be imported` },
  stage_job_failed: { tone: 'warn', icon: 'alert', text: m => str(m.title) && `Staging ${m.title} failed` },
  escalation_alerted: { tone: 'warn', icon: 'alert', text: m => str(m.title) && `${m.title} is waiting on a manual grab` },
  season_pack_force_grabbed: { tone: 'ok', icon: 'download', text: m => str(m.title) && `${m.title}${m.season != null ? ` season ${m.season}` : ''} pack was grabbed` },
  media_deleted: { tone: 'info', icon: 'trash', text: m => str(m.title) && `${m.title} was deleted${m.reason === 'retention_rule' ? ' by a retention rule' : ''}` },
  support_case_created: { tone: 'info', icon: 'help', text: m => `New support case${str(m.mediaTitle) ? ` about ${m.mediaTitle}` : ''}` },
  user_linked: { tone: 'info', icon: 'user', text: () => 'A member linked their account' },
  plex_invite_sent: { tone: 'info', icon: 'user', text: () => 'A Plex invite was sent' },
  tier_agent_drive_missing: { tone: 'down', icon: 'drive', text: m => `A drive went missing on ${str(m.node) || 'a node'}` },
  tier_agent_drive_recovered: { tone: 'ok', icon: 'drive', text: m => `The missing drive is back on ${str(m.node) || 'a node'}` },
  smart_health_transition: { tone: 'warn', icon: 'drive', text: m => `Disk health changed on ${str(m.node) || 'a node'}` },
  indexer_health_changed: { tone: 'warn', icon: 'alert', text: m => (str(m.failing) ? `Indexers failing: ${m.failing}` : str(m.recovered) ? `Indexers back: ${m.recovered}` : null) },
  dashboard_bulk_action: { tone: 'info', icon: 'check', text: m => (Number(m.attempted) > 0 ? `Bulk action: ${m.succeeded || 0} of ${m.attempted} done` : null) },
};
const FEED_ACTION_NAMES = Object.keys(FEED_ACTIONS);

// rows: audit_log rows (id, action, created_at, metadata_json), newest first.
function feedItems(rows, { requestTitle = () => null, serviceName = k => k || 'A service', toMs, limit = 10 } = {}) {
  const ctx = { requestTitle, serviceName };
  const out = [];
  for (const row of rows || []) {
    const def = FEED_ACTIONS[row.action];
    if (!def) continue;
    let meta;
    try { meta = JSON.parse(row.metadata_json || '{}') || {}; } catch { continue; }
    let text;
    try { text = def.text(meta, ctx); } catch { text = null; }
    if (!text) continue;
    out.push({ id: row.id, at: toMs ? toMs(row.created_at) : row.created_at, tone: def.tone, icon: def.icon, text });
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { FEED_ACTIONS, FEED_ACTION_NAMES, feedItems };
