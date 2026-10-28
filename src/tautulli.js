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
    throw new Error(detail ? `Tautulli ${cmd}: ${detail}` : `Tautulli ${cmd}: ${err.message}`, { cause: err });
  }
  if (res.data?.response?.result !== 'success') throw new Error(res.data?.response?.message || `Tautulli ${cmd} failed`);
  return res.data.response.data;
}

// Aggregated watch history for one Tautulli instance, normalized for the tiering planner:
// one row per TITLE — episode plays collapse onto the series (grandparent), matching the
// tmdb:/tvdb: per-title granularity of the arr inventory. Paginates get_history; music is
// ignored. Throws on an unreachable/misconfigured endpoint — the planner catches and treats
// that node's history as empty (a missing Tautulli must never fail a whole plan).
// Raw get_history rows (one per play), paginated. F10's viewing insights need them per user.
async function fetchHistoryRows(endpoint, { afterDays = 90, length = 5000 } = {}) {
  const after = new Date(Date.now() - afterDays * 86400000).toISOString().slice(0, 10);
  const pageSize = 1000;
  const rows = [];
  for (let start = 0; rows.length < length; start += pageSize) {
    const data = await tautulliApi('get_history', { after, start, length: Math.min(pageSize, length - rows.length) }, endpoint);
    const page = data?.data || [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function fetchHistory(endpoint, { afterDays = 90, length = 5000 } = {}) {
  const rows = await fetchHistoryRows(endpoint, { afterDays, length });
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

// ---- Recently added (dashboard Overview strip) ----
// Plex library sections by id; Tautulli's own library_name is the fallback for any other section.
const PLEX_SECTIONS = { 1: 'Movies', 2: 'TV Shows', 3: '4K', 4: 'Family Films', 5: 'Extra Movies', 6: 'Extra TV Shows' };

// One card per item from get_recently_added: what it is, which library, when, and the Plex image
// path for its poster. Episodes and seasons use the show's poster so the strip stays portrait.
function mapRecentlyAdded(data) {
  const rows = Array.isArray(data?.recently_added) ? data.recently_added : [];
  return rows.map(r => {
    const type = r.media_type;
    const num = v => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    let title = r.title || r.full_title || 'Unknown';
    let detail = r.year ? String(r.year) : '';
    let thumb = r.thumb;
    if (type === 'episode') {
      title = r.grandparent_title || title;
      const season = num(r.parent_media_index);
      const episode = num(r.media_index);
      detail = season != null && episode != null ? `S${season}E${episode}` : (r.title || '');
      thumb = r.grandparent_thumb || r.parent_thumb || r.thumb;
    } else if (type === 'season') {
      title = r.parent_title || title;
      detail = r.title || (num(r.media_index) != null ? `Season ${num(r.media_index)}` : '');
      thumb = r.thumb || r.parent_thumb;
    }
    const addedSec = Number(r.added_at);
    // The title a play is counted under: the show for episodes and seasons, else the item itself
    // (the same key fetchHistory groups plays by).
    const titleKey = String((type === 'episode' ? r.grandparent_rating_key : type === 'season' ? r.parent_rating_key : r.rating_key) || r.rating_key || '');
    return {
      ratingKey: String(r.rating_key || ''),
      titleKey,
      type: type || 'movie',
      title,
      detail,
      library: PLEX_SECTIONS[Number(r.section_id)] || r.library_name || '',
      addedAt: Number.isFinite(addedSec) && addedSec > 0 ? addedSec * 1000 : null,
      thumb: typeof thumb === 'string' && thumb.startsWith('/') ? thumb : null,
    };
  }).filter(i => i.ratingKey);
}

async function fetchRecentlyAdded(count = 12) {
  return mapRecentlyAdded(await tautulliApi('get_recently_added', { count }));
}

// Poster bytes through Tautulli's pms_image_proxy, so the page never needs PLEX_URL or a Plex
// token, and the Tautulli API key stays on the server (the browser only sees /admin/api/poster).
// Only Plex image paths are accepted; the reply must be an image and is capped in size.
const POSTER_MAX_BYTES = 3 * 1024 * 1024;
// /library/metadata/<id>/thumb or /art, with an optional numeric version: nothing else.
function isPlexImagePath(value) {
  if (typeof value !== 'string' || value.length > 100) return false;
  const parts = value.split('/');
  const [lead, library, metadata, id, kind, version] = parts;
  return lead === '' && library === 'library' && metadata === 'metadata' && /^\d+$/.test(id || '')
    && (kind === 'thumb' || kind === 'art')
    && (parts.length === 5 || (parts.length === 6 && /^\d+$/.test(version)));
}

async function fetchPoster(thumb) {
  if (!isPlexImagePath(thumb)) throw new Error('Not a Plex poster path');
  const res = await axios.get(`${String(CONFIG.TAUTULLI_URL).replace(/\/$/, '')}/api/v2`, {
    params: { apikey: CONFIG.TAUTULLI_API_KEY, cmd: 'pms_image_proxy', img: thumb, width: 300, height: 450, fallback: 'poster' },
    responseType: 'arraybuffer',
    timeout: 10000,
    maxContentLength: POSTER_MAX_BYTES,
    validateStatus: () => true,
  });
  const type = String(res.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (res.status !== 200 || !/^image\/(jpeg|png|webp|gif)$/.test(type)) throw new Error(`Poster unavailable (HTTP ${res.status})`);
  return { type, body: Buffer.from(res.data) };
}

module.exports = { tautulliConfigured, tautulliApi, fetchHistory, fetchHistoryRows, describeSession, PLEX_SECTIONS, mapRecentlyAdded, fetchRecentlyAdded, fetchPoster };
