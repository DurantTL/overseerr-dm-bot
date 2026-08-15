// Radarr/Radarr-4K/Sonarr API: queues, disk space, library lookups, deletion.
const axios = require('axios');
const { CONFIG } = require('./config');
const { audit } = require('./db');
const { pad } = require('./util');
const { normalizeTitle, parseReleaseName } = require('./grab');

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

// The instances eligible for AvistaZ escalation. Radarr-4K is excluded on purpose: private-tracker
// fallback is for hard-to-find content, not 4K upgrades.
const escalationSources = () => arrSources().filter(s => s.label !== 'radarr-4k');

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
          movieTmdbId: r.movie?.tmdbId ?? null,
          seriesTvdbId: r.series?.tvdbId ?? null,
          seriesId: r.seriesId ?? r.series?.id ?? null,
          seriesTitle: s.kind === 'tv' ? (r.series?.title || r.title || 'Unknown') : null,
          seasonNumber: r.episode?.seasonNumber ?? (r.seasonNumber ?? null),
          episodeNumber: r.episode?.episodeNumber ?? null,
          title: displayTitle,
          size: r.size || 0,
          sizeleft: r.sizeleft || 0,
          timeleft: r.timeleft || null,
          status: r.status || '',
          trackedStatus: r.trackedDownloadStatus || '',
          trackedState: r.trackedDownloadState || '',
          downloadId: r.downloadId || '',
          sourceTitle: r.title || '',
          episodeNumbers: (r.episodes || []).map(ep => ep.episodeNumber).filter(Number.isFinite),
          fullSeason: parseReleaseName(r.title).seasonPack,
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

async function listRadarrMovies() {
  const sources = [
    { url: CONFIG.RADARR_URL, key: CONFIG.RADARR_API_KEY, source: 'Radarr', is4k: false },
    { url: CONFIG.RADARR_4K_URL, key: CONFIG.RADARR_4K_API_KEY, source: 'Radarr 4K', is4k: true },
  ].filter(source => source.url);
  const lists = await Promise.all(sources.map(async source => {
    const movies = await radarrGetFrom(source.url, source.key, '/movie');
    return movies.map(movie => ({ ...movie, source: source.source, is4k: source.is4k }));
  }));
  return lists.flat();
}

async function listSonarrMissingEpisodes() {
  if (!CONFIG.SONARR_URL) return [];
  const data = await sonarrGet('/wanted/missing', { page: 1, pageSize: 10000, sortKey: 'airDateUtc', sortDirection: 'descending' });
  return data.records || [];
}

async function getEpisodeFiles(seriesId) {
  return sonarrGet('/episodefile', { seriesId });
}

// Resolve a stored mediaId (tmdb:/tvdb:) to the concrete Radarr movie or Sonarr episode files
// behind it, so deletion can report exact paths in dry-run and issue the right API call when live.
async function resolveDeletableMedia(mediaId, { sourceLabel = null } = {}) {
  if (mediaId.startsWith('tmdb:')) {
    const tmdbId = Number(mediaId.slice('tmdb:'.length));
    let sources = [
      { url: CONFIG.RADARR_URL, key: CONFIG.RADARR_API_KEY, label: 'radarr' },
      { url: CONFIG.RADARR_4K_URL, key: CONFIG.RADARR_4K_API_KEY, label: 'radarr-4k' },
    ].filter(s => s.url);
    if (sourceLabel) sources = sources.filter(s => s.label === sourceLabel);
    const matches = [];
    for (const s of sources) {
      const all = await radarrGetFrom(s.url, s.key, '/movie').catch(() => []);
      const movie = all.find(m => m.tmdbId === tmdbId);
      if (movie) matches.push({ s, movie });
    }
    // Never guess when the same title exists in both Radarr instances. Legacy pending rows that
    // predate arr_source must be reviewed/re-prompted instead of risking the wrong edition.
    if (matches.length > 1) {
      return { found: false, kind: 'movie', reason: 'ambiguous_source', sources: matches.map(m => m.s.label) };
    }
    if (matches.length === 1) {
      const { s, movie } = matches[0];
      return {
        found: true, kind: 'movie', source: s, movie,
        paths: movie.movieFile?.path ? [movie.movieFile.path] : [],
        apiCall: `DELETE ${s.url}/api/v3/movie/${movie.id}?deleteFiles=true (${s.label})`,
      };
    }
    return { found: false, kind: 'movie', reason: sourceLabel ? 'not_found_in_source' : 'not_found' };
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
    resolved = await resolveDeletableMedia(mediaId, { sourceLabel: ctx.arrSource || null });
  } catch (err) {
    audit('external_api_error', { provider: 'arr', error: err.message, mediaId, action: 'delete_resolve', ...ctx });
    return { outcome: 'error', error: err.message };
  }
  if (!resolved.found) {
    const outcome = resolved.reason === 'ambiguous_source' ? 'ambiguous' : 'not_found';
    audit('deletion_blocked', { mediaId, title, result: resolved.reason || outcome, sources: resolved.sources, ...ctx });
    return { outcome, reason: resolved.reason, sources: resolved.sources || [] };
  }
  // Generic tvdb IDs identify a series, not an episode. Deleting every episode file is only
  // allowed when a caller explicitly requests series scope; playback webhooks never do that.
  if (resolved.kind === 'tv' && ctx.scope !== 'series') {
    audit('deletion_blocked', { mediaId, title, result: 'tv_scope_required', fileCount: resolved.files.length, ...ctx });
    return { outcome: 'scope_required', kind: 'tv', paths: resolved.paths };
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

// ---- AvistaZ escalation: tag-gated private-tracker fallback ----
// The AvistaZ indexer in Radarr/Sonarr carries a tag, so it only applies to movies/series that
// carry the same tag. Escalating a title = add the tag to that one movie/series and re-search.

async function getArrTagId(source, tagName) {
  const res = await axios.get(`${source.url}/api/v3/tag`, { headers: { 'X-Api-Key': source.key }, timeout: 10000 });
  const wanted = String(tagName).toLowerCase();
  return (res.data || []).find(t => String(t.label).toLowerCase() === wanted)?.id ?? null;
}

async function getMovieByTmdbId(tmdbId) {
  const res = await axios.get(`${CONFIG.RADARR_URL}/api/v3/movie`, { params: { tmdbId }, headers: { 'X-Api-Key': CONFIG.RADARR_API_KEY }, timeout: 10000 });
  return (res.data || [])[0] || null;
}

async function getSeriesByTvdbId(tvdbId) {
  const res = await axios.get(`${CONFIG.SONARR_URL}/api/v3/series`, { params: { tvdbId }, headers: { 'X-Api-Key': CONFIG.SONARR_API_KEY }, timeout: 10000 });
  return (res.data || [])[0] || null;
}

// The bulk /editor endpoints with applyTags:'add' change ONLY the tags array — no round-tripping
// the whole movie/series object through PUT, so nothing else can get clobbered.
async function addTagToMovie(movieId, tagId) {
  await axios.put(`${CONFIG.RADARR_URL}/api/v3/movie/editor`,
    { movieIds: [movieId], tags: [tagId], applyTags: 'add' },
    { headers: { 'X-Api-Key': CONFIG.RADARR_API_KEY }, timeout: 15000 });
}

async function addTagToSeries(seriesId, tagId) {
  await axios.put(`${CONFIG.SONARR_URL}/api/v3/series/editor`,
    { seriesIds: [seriesId], tags: [tagId], applyTags: 'add' },
    { headers: { 'X-Api-Key': CONFIG.SONARR_API_KEY }, timeout: 15000 });
}

async function triggerMovieSearch(movieId) {
  await axios.post(`${CONFIG.RADARR_URL}/api/v3/command`, { name: 'MoviesSearch', movieIds: [movieId] },
    { headers: { 'X-Api-Key': CONFIG.RADARR_API_KEY }, timeout: 15000 });
}

async function triggerSeriesSearch(seriesId) {
  await axios.post(`${CONFIG.SONARR_URL}/api/v3/command`, { name: 'SeriesSearch', seriesId },
    { headers: { 'X-Api-Key': CONFIG.SONARR_API_KEY }, timeout: 15000 });
}

// Ask Sonarr to search one season. A fully missing season can produce one pack; for a partially
// missing season Sonarr may still search at episode granularity, which verification now records.
async function triggerSeasonSearch(seriesId, seasonNumber) {
  const res = await axios.post(`${CONFIG.SONARR_URL}/api/v3/command`, { name: 'SeasonSearch', seriesId, seasonNumber },
    { headers: { 'X-Api-Key': CONFIG.SONARR_API_KEY }, timeout: 15000 });
  return res.data;
}

// Sonarr's interactive search returns accepted and rejected candidates. Indexers can take tens
// of seconds to answer, so this deliberately uses the same long timeout as the Prowlarr search.
async function interactiveSeasonSearch(seriesId, seasonNumber) {
  try {
    const res = await axios.get(`${CONFIG.SONARR_URL}/api/v3/release`, {
      params: { seriesId, seasonNumber },
      headers: { 'X-Api-Key': CONFIG.SONARR_API_KEY },
      timeout: 90000,
    });
    return res.data || [];
  } catch (err) {
    audit('external_api_error', { provider: 'sonarr', error: err.message, action: 'interactive_season_search', seriesId, season: seasonNumber });
    throw err;
  }
}

// Manual-release grab. This can override Sonarr's decision-engine rejection, so callers must own
// the admin gate, offer audit, consumed-offer check, and confidence guard rails.
async function forceGrabRelease({ guid, indexerId }) {
  try {
    const res = await axios.post(`${CONFIG.SONARR_URL}/api/v3/release`, { guid, indexerId }, {
      headers: { 'X-Api-Key': CONFIG.SONARR_API_KEY },
      timeout: 30000,
    });
    return res.data;
  } catch (err) {
    audit('external_api_error', { provider: 'sonarr', error: err.message, action: 'force_grab_release', indexerId });
    throw err;
  }
}

const getSeriesEpisodes = seriesId => sonarrGet('/episode', { seriesId });

// Recent Sonarr grab/import history is the durable half of season-search verification: a pack can
// finish and leave the queue before the command poll returns. Keep only this season and time
// window, and normalize the release identity used by summarizeSeasonFillActivity.
async function getSeasonDownloadHistory(seriesId, seasonNumber, since = 0) {
  const data = await sonarrGet('/history', {
    page: 1, pageSize: 500, sortKey: 'date', sortDirection: 'descending',
    includeEpisode: true, includeSeries: true, seriesId,
  });
  return (data.records || []).filter(row => {
    const event = String(row.eventType || '').toLowerCase();
    const date = Date.parse(row.date || '');
    return ['grabbed', 'downloadfolderimported'].includes(event)
      && Number(row.episode?.seasonNumber ?? row.seasonNumber) === Number(seasonNumber)
      && (!since || (Number.isFinite(date) && date >= since));
  }).map(row => {
    const sourceTitle = row.sourceTitle || row.data?.sourceTitle || '';
    return {
      downloadId: row.downloadId || row.data?.downloadId || '',
      sourceTitle,
      episodeNumber: row.episode?.episodeNumber ?? row.episodeNumber ?? null,
      episodeNumbers: (row.episodes || []).map(ep => ep.episodeNumber).filter(Number.isFinite),
      fullSeason: row.fullSeason === true || parseReleaseName(sourceTitle).seasonPack,
    };
  });
}

const listSonarrSeries = () => sonarrGet('/series');

// ---- Sonarr series identity resolution ----
// Match a torrent/release name against the Sonarr library BEFORE a grab job is created for
// it, instead of letting Sonarr guess from the release filename at import time — the guess
// is where foreign titles, alternate names, sequels-filed-as-a-season, and complete-series
// packs go wrong. tvdbId (when the caller already has one, e.g. a normal request grab) is
// authoritative and wins outright. Otherwise: an exact normalized-title match, falling back
// to alternate titles, falling back to a loose token-overlap match — but a loose match is
// NEVER auto-selected, only offered as a candidate a human can click.
//
// status: 'tvdb' | 'exact' | 'alternate' | 'ambiguous' | 'none'. Only 'tvdb'/'exact'/
// 'alternate' carry a single resolved `series`; 'ambiguous' carries `candidates` (2+) for a
// manual pick; 'none' means nothing plausible was found (Sonarr can still be handed the
// files for its own guess, same as before this resolver existed).
async function resolveSonarrSeriesIdentity({ title, year, tvdbId } = {}) {
  const all = await sonarrGet('/series').catch(() => []);
  if (tvdbId) {
    const hit = all.find(s => Number(s.tvdbId) === Number(tvdbId));
    if (hit) return { status: 'tvdb', series: hit, candidates: [hit] };
  }
  const wanted = normalizeTitle(title);
  if (!wanted) return { status: 'none', series: null, candidates: [] };
  const altTitlesOf = s => (s.alternateTitles || []).map(t => t.title);
  const exact = all.filter(s => normalizeTitle(s.title) === wanted);
  const alt = all.filter(s => altTitlesOf(s).some(t => normalizeTitle(t) === wanted));
  const pool = exact.length ? exact : alt;
  const matchType = exact.length ? 'exact' : alt.length ? 'alternate' : null;
  if (pool.length === 1) return { status: matchType, series: pool[0], candidates: pool };
  if (pool.length > 1) {
    // Year narrows an exact-title tie — two different shows sharing a name from different
    // decades ("Full House" 1987 vs 2004) — but only when it narrows to exactly one.
    const byYear = year ? pool.filter(s => Number(s.year) === Number(year)) : [];
    if (byYear.length === 1) return { status: matchType, series: byYear[0], candidates: byYear };
    return { status: 'ambiguous', series: null, candidates: pool };
  }
  const tokens = wanted.split(' ').filter(Boolean);
  if (!tokens.length) return { status: 'none', series: null, candidates: [] };
  const loose = all
    .map(s => ({ s, score: tokens.filter(t => ` ${normalizeTitle(`${s.title} ${altTitlesOf(s).join(' ')}`)} `.includes(` ${t} `)).length }))
    .filter(x => x.score >= Math.max(1, Math.ceil(tokens.length * 0.6)))
    .sort((a, b) => b.score - a.score);
  if (!loose.length) return { status: 'none', series: null, candidates: [] };
  // Even a single loose hit still requires a click — nothing below exact/alternate is ever
  // auto-selected.
  return { status: 'ambiguous', series: null, candidates: loose.slice(0, 8).map(x => x.s) };
}

// Add the AvistaZ tag to a movie/series without searching — used at approval time (a
// pre-authorized fallback is definitely AvistaZ-bound, so the tag goes on up front) and by
// the direct-grab escalation (every escalated title must carry the tag for traceability and
// so future arr searches include AvistaZ). Never throws — callers branch on { ok, reason }
// and the reasons are stable strings (tag_missing, not_in_arr, no_tvdb_id, api_error:*).
async function applyAvistazTag({ mediaType, tmdbId, tvdbId }) {
  const source = escalationSources().find(s => (mediaType === 'movie' ? s.kind === 'movie' : s.kind === 'tv'));
  if (!source) return { ok: false, reason: 'not_in_arr' };
  try {
    const tagId = await getArrTagId(source, CONFIG.AVISTAZ_TAG);
    if (tagId == null) return { ok: false, reason: 'tag_missing' };
    if (mediaType === 'movie') {
      const movie = await getMovieByTmdbId(tmdbId);
      if (!movie) return { ok: false, reason: 'not_in_arr' };
      await addTagToMovie(movie.id, tagId);
      return { ok: true, source, arrId: movie.id, title: movie.title, detail: `Tagged Radarr movie #${movie.id} '${CONFIG.AVISTAZ_TAG}'.` };
    }
    if (!tvdbId) return { ok: false, reason: 'no_tvdb_id' };
    const series = await getSeriesByTvdbId(tvdbId);
    if (!series) return { ok: false, reason: 'not_in_arr' };
    await addTagToSeries(series.id, tagId);
    return { ok: true, source, arrId: series.id, title: series.title, detail: `Tagged Sonarr series #${series.id} '${CONFIG.AVISTAZ_TAG}'.` };
  } catch (err) {
    audit('external_api_error', { provider: source.label, error: err.message, action: 'avistaz_tag', mediaId: `tmdb:${tmdbId}` });
    return { ok: false, reason: `api_error:${err.message}` };
  }
}

// Orchestrates one tag-based escalation: add the AvistaZ tag, then kick a search so the
// tag-gated indexer gets used immediately.
async function escalateMediaToAvistaz({ mediaType, tmdbId, tvdbId }) {
  const tagged = await applyAvistazTag({ mediaType, tmdbId, tvdbId });
  if (!tagged.ok) return tagged;
  try {
    if (mediaType === 'movie') await triggerMovieSearch(tagged.arrId);
    else await triggerSeriesSearch(tagged.arrId);
    audit('avistaz_escalated', { mediaId: `tmdb:${tmdbId}`, ...(tvdbId ? { tvdbId } : {}), title: tagged.title, arr: tagged.source.label });
    return { ok: true, detail: `${tagged.detail.replace(/\.$/, '')} and triggered a search.` };
  } catch (err) {
    audit('external_api_error', { provider: tagged.source.label, error: err.message, action: 'avistaz_escalate', mediaId: `tmdb:${tmdbId}` });
    return { ok: false, reason: `api_error:${err.message}` };
  }
}

// Add a movie/series straight to the arr, bypassing Seerr entirely — the rescue path for
// requests Seerr accepted and then lost ('Media data not found' in its log, usually a broken
// TMDB↔TVDB mapping). Root folder / quality profile come from RADARR_ROOT_FOLDER-style config
// when set, else the arr's first of each. tagLabel (optional) is applied when that tag exists.
// Never throws — callers branch on { ok, reason } with stable reason strings.
async function addMediaToArr({ mediaType, tmdbId, tvdbId, tagLabel }) {
  const source = escalationSources().find(s => (mediaType === 'movie' ? s.kind === 'movie' : s.kind === 'tv'));
  if (!source) return { ok: false, reason: 'arr_not_configured' };
  const H = { headers: { 'X-Api-Key': source.key }, timeout: 20000 };
  try {
    const roots = (await axios.get(`${source.url}/api/v3/rootfolder`, H)).data || [];
    const wantRoot = mediaType === 'movie' ? CONFIG.RADARR_ROOT_FOLDER : CONFIG.SONARR_ROOT_FOLDER;
    const rootFolderPath = wantRoot || roots[0]?.path;
    if (!rootFolderPath) return { ok: false, reason: 'no_root_folder' };
    const profiles = (await axios.get(`${source.url}/api/v3/qualityprofile`, H)).data || [];
    const wantProfile = mediaType === 'movie' ? CONFIG.RADARR_QUALITY_PROFILE : CONFIG.SONARR_QUALITY_PROFILE;
    const profile = wantProfile
      ? profiles.find(p => String(p.name).toLowerCase() === wantProfile.toLowerCase())
      : profiles[0];
    if (!profile) return { ok: false, reason: 'no_quality_profile' };
    const tagId = tagLabel ? await getArrTagId(source, tagLabel) : null;
    const tags = tagId != null ? [tagId] : [];
    const tagNote = tagId != null ? `, tag \`${tagLabel}\`` : '';

    if (mediaType === 'movie') {
      const existing = await getMovieByTmdbId(tmdbId);
      if (existing) return { ok: true, already: true, arrId: existing.id, title: existing.title, detail: `Already in Radarr as movie #${existing.id} — nothing to add.` };
      const looked = (await axios.get(`${source.url}/api/v3/movie/lookup/tmdb`, { params: { tmdbId }, ...H })).data;
      const movie = Array.isArray(looked) ? looked[0] : looked;
      if (!movie?.title) return { ok: false, reason: 'lookup_empty' };
      const created = (await axios.post(`${source.url}/api/v3/movie`,
        { ...movie, qualityProfileId: profile.id, rootFolderPath, monitored: true, tags, addOptions: { searchForMovie: true } }, H)).data;
      audit('arr_direct_add', { mediaId: `tmdb:${tmdbId}`, title: movie.title, arr: source.label, arrId: created?.id ?? null });
      return { ok: true, arrId: created?.id ?? null, title: movie.title, detail: `Added **${movie.title}** to Radarr (root \`${rootFolderPath}\`, profile \`${profile.name}\`${tagNote}) and started a search.` };
    }

    if (!tvdbId) return { ok: false, reason: 'no_tvdb_id' };
    const existingSeries = await getSeriesByTvdbId(tvdbId);
    if (existingSeries) return { ok: true, already: true, arrId: existingSeries.id, title: existingSeries.title, detail: `Already in Sonarr as series #${existingSeries.id} — nothing to add.` };
    const results = (await axios.get(`${source.url}/api/v3/series/lookup`, { params: { term: `tvdb:${tvdbId}` }, ...H })).data || [];
    const series = results[0];
    if (!series?.title) return { ok: false, reason: 'lookup_empty' };
    const body = { ...series, qualityProfileId: profile.id, rootFolderPath, monitored: true, seasonFolder: true, tags, addOptions: { searchForMissingEpisodes: true } };
    // Sonarr v3 requires a language profile; v4 removed the endpoint and ignores the field.
    try {
      const langs = (await axios.get(`${source.url}/api/v3/languageprofile`, H)).data || [];
      if (langs[0]?.id != null) body.languageProfileId = langs[0].id;
    } catch (_e) { /* v4 — endpoint gone, field not needed */ }
    const created = (await axios.post(`${source.url}/api/v3/series`, body, H)).data;
    audit('arr_direct_add', { mediaId: `tvdb:${tvdbId}`, title: series.title, arr: source.label, arrId: created?.id ?? null });
    return { ok: true, arrId: created?.id ?? null, title: series.title, detail: `Added **${series.title}** to Sonarr (root \`${rootFolderPath}\`, profile \`${profile.name}\`${tagNote}) and started a search for all episodes.` };
  } catch (err) {
    audit('external_api_error', { provider: source.label, error: err.message, action: 'arr_direct_add', mediaId: mediaType === 'movie' ? `tmdb:${tmdbId}` : `tvdb:${tvdbId}` });
    return { ok: false, reason: `api_error:${err.message}` };
  }
}

// ---- Guided manual import: pair loose episode files with Sonarr episodes ----
// Old/foreign releases ("They Kiss Again (2007) Complete (hardsubbed)") often carry no SxxEyy
// pattern Sonarr can parse, and TVDB may file the show under a different title entirely. The
// guided-import wizard lets an admin pick the series+season in Discord; these pure helpers do
// the file→episode matching.

// Best-effort episode number from a filename. Prefers explicit markers (E05 / EP05 /
// Episode 5), else the last standalone digit-run that fits within the season's episode count
// (which naturally skips years, resolutions, and season numbers).
function extractEpisodeNumber(name, maxEp) {
  const base = String(name || '').replace(/\.[^.]+$/, '');
  const marked = base.match(/(?:^|[^a-z0-9])e(?:p(?:isode)?)?[\s._-]*(\d{1,3})(?![0-9])/i);
  if (marked && +marked[1] >= 1 && (!maxEp || +marked[1] <= maxEp)) return +marked[1];
  const nums = (base.match(/\d+/g) || []).map(Number).filter(n => n >= 1 && (!maxEp || n <= maxEp));
  return nums.length ? nums[nums.length - 1] : null;
}

// Pair files (natural filename order) with a season's episodes. Uses per-file episode numbers
// when every file yields a unique, valid one; otherwise falls back to ordinal order (file 1 →
// episode 1, ...). files = [{ path, ... }], episodes = [{ id, episodeNumber }].
// Returns { strategy, pairs: [{ ...file, episodeId, episodeNumber }], leftoverFiles, leftoverEpisodes }.
function pairFilesToEpisodes(files, episodes) {
  const natural = (a, b) => String(a.path).localeCompare(String(b.path), undefined, { numeric: true, sensitivity: 'base' });
  const sorted = [...files].sort(natural);
  const epSorted = [...episodes].sort((a, b) => a.episodeNumber - b.episodeNumber);
  const maxEp = epSorted.length ? epSorted[epSorted.length - 1].episodeNumber : 0;
  const byNumber = new Map(epSorted.map(e => [e.episodeNumber, e]));

  const numbered = sorted.map(f => {
    const base = String(f.path).split('/').pop();
    return { file: f, ep: byNumber.get(extractEpisodeNumber(base, maxEp)) ?? null };
  });
  const hits = numbered.filter(x => x.ep);
  const unique = new Set(hits.map(x => x.ep.id)).size === hits.length;
  if (hits.length === sorted.length && sorted.length > 0 && unique) {
    return { strategy: 'numbered', pairs: numbered.map(x => ({ ...x.file, episodeId: x.ep.id, episodeNumber: x.ep.episodeNumber })), leftoverFiles: 0, leftoverEpisodes: epSorted.length - sorted.length };
  }
  const n = Math.min(sorted.length, epSorted.length);
  return {
    strategy: 'ordinal',
    pairs: sorted.slice(0, n).map((f, i) => ({ ...f, episodeId: epSorted[i].id, episodeNumber: epSorted[i].episodeNumber })),
    leftoverFiles: sorted.length - n,
    leftoverEpisodes: epSorted.length - n,
  };
}

// Startup sanity check: warn (non-fatal) when an escalation-eligible instance has no tag named
// AVISTAZ_TAG — escalation would fail with tag_missing on every attempt until it's created.
async function verifyAvistazTags(tagName) {
  const warnings = [];
  for (const s of escalationSources()) {
    try {
      const tagId = await getArrTagId(s, tagName);
      if (tagId == null) warnings.push(`${s.label} has no tag named \`${tagName}\` — create it and put it on the AvistaZ indexer (see README "AvistaZ private-tracker fallback").`);
    } catch (err) {
      warnings.push(`${s.label} tag check failed (${err.message}) — can't confirm the \`${tagName}\` tag exists.`);
    }
  }
  return warnings;
}

// ---- Release ETA: when might a title actually become downloadable? ----
// Radarr tracks a movie's theatrical/digital/physical release dates; Sonarr tracks a series'
// air dates. Best-effort by design: any failure (not configured, not in the arr yet, API down)
// returns null and callers simply omit the ETA line.
async function fetchReleaseEta({ mediaType, tmdbId, tvdbId }) {
  try {
    if (mediaType === 'movie') {
      if (!tmdbId) return null;
      const sources = [
        { url: CONFIG.RADARR_URL, key: CONFIG.RADARR_API_KEY, label: 'radarr' },
        { url: CONFIG.RADARR_4K_URL, key: CONFIG.RADARR_4K_API_KEY, label: 'radarr-4k' },
      ].filter(s => s.url);
      for (const s of sources) {
        const res = await axios.get(`${s.url}/api/v3/movie`, { params: { tmdbId }, headers: { 'X-Api-Key': s.key }, timeout: 10000 });
        const m = (res.data || [])[0];
        if (m) {
          return {
            kind: 'movie',
            status: m.status || null,
            inCinemas: m.inCinemas || null,
            digitalRelease: m.digitalRelease || null,
            physicalRelease: m.physicalRelease || null,
          };
        }
      }
      return null;
    }
    if (!tvdbId || !CONFIG.SONARR_URL) return null;
    const series = await getSeriesByTvdbId(tvdbId);
    if (!series) return null;
    return {
      kind: 'tv',
      status: series.status || null,
      firstAired: series.firstAired || null,
      nextAiring: series.nextAiring || null,
    };
  } catch (err) {
    audit('external_api_error', { provider: 'arr', error: err.message, action: 'release_eta', mediaId: mediaType === 'movie' ? `tmdb:${tmdbId}` : `tvdb:${tvdbId}` });
    return null;
  }
}

function remapPath(hostPath) {
  if (CONFIG.PATH_REMAP_FROM && hostPath.startsWith(CONFIG.PATH_REMAP_FROM)) {
    return hostPath.replace(CONFIG.PATH_REMAP_FROM, CONFIG.PATH_REMAP_TO);
  }
  return hostPath;
}

module.exports = { radarrGetFrom, sonarrGet, arrSources, arrSourceByLabel, escalationSources, fetchArrQueues, fetchDiskSpace, searchMovies, searchSeries, listRadarrMovies, listSonarrMissingEpisodes, getEpisodeFiles, resolveDeletableMedia, executeDeletion, getArrTagId, getMovieByTmdbId, getSeriesByTvdbId, addTagToMovie, addTagToSeries, triggerMovieSearch, triggerSeriesSearch, triggerSeasonSearch, interactiveSeasonSearch, forceGrabRelease, getSeriesEpisodes, getSeasonDownloadHistory, listSonarrSeries, resolveSonarrSeriesIdentity, applyAvistazTag, escalateMediaToAvistaz, addMediaToArr, extractEpisodeNumber, pairFilesToEpisodes, verifyAvistazTags, fetchReleaseEta, remapPath };
