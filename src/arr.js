// Radarr/Radarr-4K/Sonarr API: queues, disk space, library lookups, deletion.
const axios = require('axios');
const { CONFIG } = require('./config');
const { audit } = require('./db');
const { pad } = require('./util');

async function radarrGetFrom(url, apiKey, endpoint) {
  const res = await axios.get(`${url}/api/v3${endpoint}`, { params: { apikey: apiKey }, timeout: 10000 });
  return res.data;
}

async function sonarrGet(endpoint, params = {}) {
  const res = await axios.get(`${CONFIG.SONARR_URL}/api/v3${endpoint}`, { params: { apikey: CONFIG.SONARR_API_KEY, ...params }, timeout: 10000 });
  return res.data;
}

// The configured *arr instances, used for queue reads and stuck-download actions.
function arrSources() {
  const sources = [];
  if (CONFIG.RADARR_URL) sources.push({ kind: 'movie', label: 'radarr', url: CONFIG.RADARR_URL, key: CONFIG.RADARR_API_KEY });
  if (CONFIG.RADARR_4K_URL) sources.push({ kind: 'movie', label: 'radarr-4k', url: CONFIG.RADARR_4K_URL, key: CONFIG.RADARR_4K_API_KEY });
  if (CONFIG.SONARR_URL) sources.push({ kind: 'tv', label: 'sonarr', url: CONFIG.SONARR_URL, key: CONFIG.SONARR_API_KEY });
  return sources;
}

const arrSourceByLabel = label => arrSources().find(s => s.label === label) || null;

// Normalized view of every active download across Radarr / Radarr-4K / Sonarr.
async function fetchArrQueues() {
  const items = [];
  for (const s of arrSources()) {
    try {
      const params = s.kind === 'movie'
        ? { pageSize: 200, includeMovie: true }
        : { pageSize: 200, includeSeries: true, includeEpisode: true };
      const res = await axios.get(`${s.url}/api/v3/queue`, { params, headers: { 'X-Api-Key': s.key }, timeout: 10000 });
      for (const r of res.data.records || []) {
        const displayTitle = s.kind === 'movie'
          ? (r.movie?.title || r.title || 'Unknown')
          : `${r.series?.title || r.title || 'Unknown'}${r.episode ? ` S${pad(r.episode.seasonNumber)}E${pad(r.episode.episodeNumber)}` : ''}`;
        items.push({
          source: s,
          queueId: r.id,
          title: displayTitle,
          size: r.size || 0,
          sizeleft: r.sizeleft || 0,
          timeleft: r.timeleft || null,
          status: r.status || '',
          trackedStatus: r.trackedDownloadStatus || '',
          trackedState: r.trackedDownloadState || '',
          messages: (r.statusMessages || []).flatMap(m => m.messages || []).slice(0, 3),
        });
      }
    } catch (err) {
      audit('external_api_error', { provider: s.label, error: err.message, action: 'queue_fetch' });
    }
  }
  return items;
}

// Free/total space of every volume the *arrs can see, deduped by path across instances.
async function fetchDiskSpace() {
  const seen = new Map();
  const sources = arrSources();
  for (const s of sources) {
    try {
      const res = await axios.get(`${s.url}/api/v3/diskspace`, { headers: { 'X-Api-Key': s.key }, timeout: 8000 });
      for (const d of res.data || []) {
        if (!seen.has(d.path)) seen.set(d.path, d);
      }
    } catch (err) {
      audit('external_api_error', { provider: s.label, error: err.message, action: 'diskspace' });
    }
  }
  let disks = [...seen.values()].filter(d => (d.totalSpace || 0) > 10 * 1024 ** 3);
  // Optional allowlist: keep only mounts an admin cares about, and relabel a mount with the more
  // specific media folder (the *arr diskspace API reports the `/share` mount, but the real media
  // lives at `/share/media` — show that instead). Unset = report every mount.
  const wanted = CONFIG.DISK_SPACE_PATHS;
  if (wanted.length) {
    const norm = p => (p.length > 1 ? p.replace(/\/+$/, '') : p);
    const related = (a, b) => { a = norm(a); b = norm(b); return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); };
    disks = disks
      .filter(d => wanted.some(w => related(d.path, w)))
      .map(d => {
        const moreSpecific = wanted.find(w => norm(w).startsWith(`${norm(d.path)}/`));
        return moreSpecific ? { ...d, displayPath: norm(moreSpecific) } : d;
      });
  }
  return disks;
}

async function searchMovies(title) {
  const lower = title.toLowerCase();
  const results = [];
  if (CONFIG.RADARR_URL) {
    const all = await radarrGetFrom(CONFIG.RADARR_URL, CONFIG.RADARR_API_KEY, '/movie');
    all.filter(m => m.hasFile && m.title.toLowerCase().includes(lower)).forEach(m => results.push({ ...m, _radarrUrl: CONFIG.RADARR_URL, _radarrKey: CONFIG.RADARR_API_KEY }));
  }
  if (CONFIG.RADARR_4K_URL) {
    const all = await radarrGetFrom(CONFIG.RADARR_4K_URL, CONFIG.RADARR_4K_API_KEY, '/movie');
    all.filter(m => m.hasFile && m.title.toLowerCase().includes(lower)).forEach(m => results.push({ ...m, _radarrUrl: CONFIG.RADARR_4K_URL, _radarrKey: CONFIG.RADARR_4K_API_KEY }));
  }
  return results;
}

async function searchSeries(title) {
  const all = await sonarrGet('/series');
  return all.filter(s => s.title.toLowerCase().includes(title.toLowerCase()));
}

async function getEpisodeFiles(seriesId) {
  return sonarrGet('/episodefile', { seriesId });
}

// Resolve a stored mediaId (tmdb:/tvdb:) to the concrete Radarr movie or Sonarr episode files
// behind it, so deletion can report exact paths in dry-run and issue the right API call when live.
async function resolveDeletableMedia(mediaId) {
  if (mediaId.startsWith('tmdb:')) {
    const tmdbId = Number(mediaId.slice('tmdb:'.length));
    const sources = [
      { url: CONFIG.RADARR_URL, key: CONFIG.RADARR_API_KEY, label: 'radarr' },
      { url: CONFIG.RADARR_4K_URL, key: CONFIG.RADARR_4K_API_KEY, label: 'radarr-4k' },
    ].filter(s => s.url);
    for (const s of sources) {
      const all = await radarrGetFrom(s.url, s.key, '/movie').catch(() => []);
      const movie = all.find(m => m.tmdbId === tmdbId);
      if (movie) {
        return {
          found: true, kind: 'movie', source: s, movie,
          paths: movie.movieFile?.path ? [movie.movieFile.path] : [],
          apiCall: `DELETE ${s.url}/api/v3/movie/${movie.id}?deleteFiles=true (${s.label})`,
        };
      }
    }
    return { found: false, kind: 'movie' };
  }
  if (mediaId.startsWith('tvdb:')) {
    if (!CONFIG.SONARR_URL) return { found: false, kind: 'tv' };
    const tvdbId = Number(mediaId.slice('tvdb:'.length));
    const all = await sonarrGet('/series').catch(() => []);
    const series = all.find(s => s.tvdbId === tvdbId);
    if (!series) return { found: false, kind: 'tv' };
    const files = await getEpisodeFiles(series.id).catch(() => []);
    return {
      found: true, kind: 'tv', series, files,
      paths: files.map(f => f.path),
      apiCall: `DELETE ${CONFIG.SONARR_URL}/api/v3/episodefile/{id} ×${files.length}`,
    };
  }
  return { found: false, kind: 'unknown' };
}

// Shared deletion core used by the Delete Now button and the janitor sweep. Honors
// DELETION_DRY_RUN. Callers are responsible for the guard rails (ENABLE_DELETION,
// keep list, never-delete list) and for recording the pending_deletions outcome.
async function executeDeletion(mediaId, title, ctx = {}) {
  let resolved;
  try {
    resolved = await resolveDeletableMedia(mediaId);
  } catch (err) {
    audit('external_api_error', { provider: 'arr', error: err.message, mediaId, action: 'delete_resolve', ...ctx });
    return { outcome: 'error', error: err.message };
  }
  if (!resolved.found) {
    audit('deletion_dry_run', { mediaId, title, result: 'not_found', ...ctx });
    return { outcome: 'not_found' };
  }
  if (CONFIG.DELETION_DRY_RUN) {
    audit('deletion_dry_run', { mediaId, title, kind: resolved.kind, paths: resolved.paths, apiCall: resolved.apiCall, ...ctx });
    return { outcome: 'dry_run', kind: resolved.kind, paths: resolved.paths, apiCall: resolved.apiCall };
  }
  try {
    let detail;
    if (resolved.kind === 'movie') {
      await axios.delete(`${resolved.source.url}/api/v3/movie/${resolved.movie.id}`, { params: { apikey: resolved.source.key, deleteFiles: true } });
      detail = `Radarr movie #${resolved.movie.id} deleted with files.`;
    } else {
      let n = 0;
      for (const f of resolved.files) {
        await axios.delete(`${CONFIG.SONARR_URL}/api/v3/episodefile/${f.id}`, { params: { apikey: CONFIG.SONARR_API_KEY } });
        n++;
      }
      detail = `Sonarr episode files deleted: ${n}/${resolved.files.length}.`;
    }
    audit('media_deleted', { mediaId, title, kind: resolved.kind, paths: resolved.paths, apiCall: resolved.apiCall, ...ctx });
    return { outcome: 'deleted', kind: resolved.kind, paths: resolved.paths, detail };
  } catch (err) {
    audit('external_api_error', { provider: 'arr', error: err.message, mediaId, action: 'delete', ...ctx });
    return { outcome: 'error', error: err.message };
  }
}

function remapPath(hostPath) {
  if (CONFIG.PATH_REMAP_FROM && hostPath.startsWith(CONFIG.PATH_REMAP_FROM)) {
    return hostPath.replace(CONFIG.PATH_REMAP_FROM, CONFIG.PATH_REMAP_TO);
  }
  return hostPath;
}

module.exports = { radarrGetFrom, sonarrGet, arrSources, arrSourceByLabel, fetchArrQueues, fetchDiskSpace, searchMovies, searchSeries, getEpisodeFiles, resolveDeletableMedia, executeDeletion, remapPath };
