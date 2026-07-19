// Tautulli API: live Plex session activity for /watching and the transcode watchdog, plus
// per-node watch history for the regional tiering planner. One Tautulli instance monitors one
// Plex server, so multi-node callers pass an explicit { url, apiKey } endpoint; the default
// stays bound to the main server (CONFIG) so every existing caller is unchanged.
const axios = require('axios');
const { CONFIG } = require('./config');

// ---- Tautulli (playback visibility) ----
const tautulliConfigured = () => !!(CONFIG.TAUTULLI_URL && CONFIG.TAUTULLI_API_KEY);

async function tautulliApi(cmd, params = {}, endpoint = undefined) {
  const url = endpoint?.url || CONFIG.TAUTULLI_URL;
  const apiKey = endpoint?.apiKey || CONFIG.TAUTULLI_API_KEY;
  let res;
  try {
    res = await axios.get(`${String(url).replace(/\/$/, '')}/api/v2`, {
      params: { apikey: apiKey, cmd, ...params },
      timeout: 10000,
    });
  } catch (err) {
    // Tautulli signals auth/param problems as HTTP 400 with the reason in the JSON body (e.g.
    // "Invalid apikey"); without this the log only shows axios's bare "status code 400".
    const detail = err.response?.data?.response?.message;
    throw new Error(detail ? `Tautulli ${cmd}: ${detail}` : `Tautulli ${cmd}: ${err.message}`);
  }
  if (res.data?.response?.result !== 'success') throw new Error(res.data?.response?.message || `Tautulli ${cmd} failed`);
  return res.data.response.data;
}

// Aggregated watch history for one Tautulli instance, normalized for the tiering planner:
// one row per TITLE — episode plays collapse onto the series (grandparent), matching the
// tmdb:/tvdb: per-title granularity of the arr inventory. Paginates get_history; music is
// ignored. Throws on an unreachable/misconfigured endpoint — the planner catches and treats
// that node's history as empty (a missing Tautulli must never fail a whole plan).
async function fetchHistory(endpoint, { afterDays = 90, length = 5000 } = {}) {
  const after = new Date(Date.now() - afterDays * 86400000).toISOString().slice(0, 10);
  const pageSize = 1000;
  const rows = [];
  for (let start = 0; rows.length < length; start += pageSize) {
    const data = await tautulliApi('get_history', { after, start, length: Math.min(pageSize, length - rows.length) }, endpoint);
    const page = data?.data || [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  const byTitle = new Map();
  for (const r of rows) {
    if (r.media_type === 'track') continue;
    const tv = ['episode', 'season', 'show'].includes(r.media_type);
    const key = String((tv && r.grandparent_rating_key) || r.rating_key || '');
    if (!key) continue;
    const entry = byTitle.get(key) || {
      ratingKey: key,
      title: (tv ? r.grandparent_title : r.title) || r.full_title || 'Unknown',
      mediaType: tv ? 'tv' : 'movie',
      plays: 0,
      lastPlayed: 0,
      users: new Set(),
    };
    entry.plays++;
    const playedMs = (Number(r.date) || Number(r.started) || 0) * 1000;
    if (playedMs > entry.lastPlayed) entry.lastPlayed = playedMs;
    entry.users.add(String(r.user_id ?? r.user ?? 'unknown'));
    byTitle.set(key, entry);
  }
  return [...byTitle.values()].map(({ users, ...e }) => ({ ...e, distinctUsers: users.size }));
}

// One line per active Plex session, shared by /watching and the transcode sweep.
function describeSession(s) {
  const decision = s.video_decision === 'transcode' ? '🔥 Transcoding'
    : s.transcode_decision === 'copy' ? '📼 Direct Stream'
    : '▶️ Direct Play';
  const res = s.video_full_resolution || s.stream_video_full_resolution || '';
  const streamRes = s.stream_video_full_resolution || '';
  const quality = s.video_decision === 'transcode' && res && streamRes && res !== streamRes ? `${res} → ${streamRes}` : (streamRes || res);
  const pct = s.progress_percent ? ` (${s.progress_percent}%)` : '';
  return `• **${s.friendly_name || s.user || 'Unknown'}** — ${s.full_title || 'Unknown'} — ${decision}${quality ? ` — ${quality}` : ''}${pct}`;
}

module.exports = { tautulliConfigured, tautulliApi, fetchHistory, describeSession };
