'use strict';

const { canonicalizeEmail } = require('./util');
const { summarizeSeriesGaps, describeGaps } = require('./incomplete');

function normalizeSearchQuery(query) {
  const value = String(query || '').trim();
  if (!value) return { query: '', error: null };
  if (value.length < 2) return { query: value, error: 'Search queries must contain at least 2 characters.' };
  return { query: value, error: null };
}

function includesQuery(value, query) {
  return String(value || '').toLowerCase().includes(query.toLowerCase());
}

function queueProgress(item) {
  if (!item) return '';
  const size = Number(item.size || 0);
  const left = Number(item.sizeleft || 0);
  const pct = size > 0 ? Math.max(0, Math.min(100, Math.round(((size - left) / size) * 100))) : null;
  return [item.status || 'queued', pct == null ? null : `${pct}%`, item.timeleft || null].filter(Boolean).join(' · ');
}

function searchDashboard({ query, requests = [], users = [], series = [], movies = [], missingEpisodes = [], auditRows = [], queues = [], members = [], downloadTokens = [], now = Date.now() } = {}) {
  const normalized = normalizeSearchQuery(query);
  const empty = { query: normalized.query, error: normalized.error, requests: [], users: [], library: [], audit: [] };
  if (normalized.error || !normalized.query) return empty;

  const q = normalized.query;
  const canonicalQuery = q.includes('@') ? canonicalizeEmail(q) : '';
  const memberNames = new Map(members.map(member => [String(member.discordId), member.name]));
  const userById = new Map(users.map(user => [String(user.discord_id), user]));
  const activeLinksByUser = new Map();
  for (const token of downloadTokens) {
    if (token.revoked || Number(token.expires_at) <= now) continue;
    const id = String(token.discord_id || '');
    activeLinksByUser.set(id, (activeLinksByUser.get(id) || 0) + 1);
  }

  const requestResults = requests.filter(request => {
    const user = userById.get(String(request.requested_by_discord_id || ''));
    const requesterName = memberNames.get(String(request.requested_by_discord_id || '')) || user?.plex_username || '';
    return [request.title, request.requested_by_discord_id, requesterName, user?.email].some(value => includesQuery(value, q));
  }).map(request => {
    const user = userById.get(String(request.requested_by_discord_id || ''));
    const requesterName = memberNames.get(String(request.requested_by_discord_id || '')) || user?.plex_username || '';
    const mediaId = String(request.media_id || '');
    const id = Number(mediaId.split(':')[1]);
    const queued = queues.find(item => (mediaId.startsWith('tvdb:') && Number(item.seriesTvdbId) === id)
      || (mediaId.startsWith('tmdb:') && Number(item.movieTmdbId) === id)
      || includesQuery(item.title, request.title));
    return {
      title: request.title,
      status: request.status,
      type: request.media_type === 'tv' ? (request.is_4k ? '4K TV show' : 'TV show') : (request.is_4k ? '4K movie' : 'Movie'),
      requestedBy: requesterName ? `${requesterName} (${request.requested_by_discord_id})` : (request.requested_by_discord_id || 'Unknown'),
      requestedAt: request.created_at,
      progress: queueProgress(queued),
    };
  });

  const userResults = users.filter(user => {
    const name = memberNames.get(String(user.discord_id)) || '';
    return [user.discord_id, name, user.plex_username, user.email].some(value => includesQuery(value, q))
      || (canonicalQuery && canonicalizeEmail(user.email).includes(canonicalQuery));
  }).map(user => ({
    discord: user.discord_id,
    name: memberNames.get(String(user.discord_id)) || user.plex_username || '',
    email: user.email,
    linked: user.overseerr_created ? 'Plex and Seerr' : (user.invited ? 'Plex only' : 'Pending'),
    homeServer: user.home_server === 'ph' ? 'Philippines' : 'Main',
    invited: user.invited ? 'Yes' : 'No',
    requests: requests.filter(request => String(request.requested_by_discord_id) === String(user.discord_id)).length,
    activeLinks: activeLinksByUser.get(String(user.discord_id)) || 0,
  }));

  const seriesResults = series.filter(item => includesQuery(item.title, q)).map(item => {
    const episodes = missingEpisodes.filter(episode => Number(episode.seriesId) === Number(item.id));
    const summary = summarizeSeriesGaps({ series: item, episodes, now });
    const total = Number(item.statistics?.episodeCount || summary.airedTotal || 0);
    const files = Number(item.statistics?.episodeFileCount || Math.max(0, total - summary.airedMissing));
    return {
      title: item.title,
      type: 'TV show',
      status: item.status || '',
      completeness: total ? `${Math.round((files / total) * 100)}% (${files}/${total})` : 'No aired episodes',
      gaps: describeGaps(summary) || 'No aired monitored gaps',
      source: 'Sonarr',
    };
  });
  const movieResults = movies.filter(item => includesQuery(item.title, q)).map(item => ({
    title: item.title,
    type: item.is4k ? '4K movie' : 'Movie',
    status: item.hasFile ? 'Available' : (item.monitored ? 'Monitored' : 'Unmonitored'),
    completeness: item.hasFile ? '100%' : '0%',
    gaps: '',
    source: item.source || 'Radarr',
  }));

  const auditResults = auditRows.filter(row => includesQuery(row.action, q) || includesQuery(row.metadata_json, q)).map(row => ({
    when: row.created_at,
    action: row.action,
    match: includesQuery(row.action, q) ? 'Action' : 'Metadata',
  }));

  return { ...empty, requests: requestResults, users: userResults, library: [...seriesResults, ...movieResults], audit: auditResults };
}

module.exports = { normalizeSearchQuery, searchDashboard };
