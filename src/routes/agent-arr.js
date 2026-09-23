'use strict';

// Read-only library file-status API for the *arr instances. Lets an agent verify that an
// import actually landed — series episodes / movie files with quality and size — closing the
// loop the import endpoints cannot close on their own (they can copy bytes and trigger a
// rescan, but never see what the *arr library holds afterwards).

const MOVIE_SOURCES = ['radarr', 'radarr-4k'];

function isValidId(value) {
  return typeof value === 'string' && /^\d{1,10}$/.test(value);
}

function isValidTitle(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200;
}

function shapeFile(f) {
  if (!f) return null;
  return {
    id: f.id ?? null,
    quality: f.quality?.quality?.name || null,
    qualityRevision: f.quality?.revision?.version ?? null,
    size: f.size ?? 0,
    path: f.path || null,
    dateAdded: f.dateAdded || null,
  };
}

function shapeSeries(s) {
  return {
    id: s.id,
    title: s.title,
    tvdbId: s.tvdbId ?? null,
    year: s.year ?? null,
    path: s.path || null,
    monitored: Boolean(s.monitored),
    seasonCount: s.statistics?.seasonCount ?? (Array.isArray(s.seasons) ? s.seasons.length : 0),
    episodeCount: s.statistics?.episodeCount ?? 0,
    episodeFileCount: s.statistics?.episodeFileCount ?? 0,
  };
}

// Production service: thin delegation to src/arr.js and CONFIG. Tests inject a fake service
// (or fake arr/config here) instead of touching the network.
function createArrService({ arr = require('../arr'), config = require('../config').CONFIG } = {}) {
  return {
    listSources: () => [
      { label: 'sonarr', kind: 'tv', configured: Boolean(config.SONARR_URL) },
      { label: 'radarr', kind: 'movie', configured: Boolean(config.RADARR_URL) },
      { label: 'radarr-4k', kind: 'movie', configured: Boolean(config.RADARR_4K_URL) },
    ],
    sonarrConfigured: () => Boolean(config.SONARR_URL),
    radarrLabels: () => MOVIE_SOURCES.filter(label => {
      const s = arr.arrSourceByLabel(label);
      return Boolean(s) && s.kind === 'movie';
    }),
    searchSonarrSeries: title => arr.searchSeries(title).then(list => list.map(shapeSeries)),
    getSonarrSeriesByTvdbId: tvdbId => arr.getSeriesByTvdbId(tvdbId).then(s => (s ? shapeSeries(s) : null)),
    getSonarrSeriesById: async id => {
      try {
        return shapeSeries(await arr.sonarrGet(`/series/${id}`));
      } catch (err) {
        if (err?.response?.status === 404) return null;
        throw err;
      }
    },
    getSeriesEpisodes: async (seriesId, seasonNumber = null) => {
      const [episodes, files] = await Promise.all([
        arr.getSeriesEpisodes(seriesId),
        arr.getEpisodeFiles(seriesId),
      ]);
      const byId = new Map((files || []).map(f => [f.id, f]));
      return (episodes || [])
        .filter(e => seasonNumber == null || e.seasonNumber === seasonNumber)
        .map(e => ({
          id: e.id,
          seriesId: e.seriesId,
          seasonNumber: e.seasonNumber,
          episodeNumber: e.episodeNumber,
          title: e.title || null,
          airDate: e.airDate || null,
          monitored: Boolean(e.monitored),
          hasFile: Boolean(e.hasFile),
          file: shapeFile(e.episodeFileId ? byId.get(e.episodeFileId) : null),
        }));
    },
    getRadarrMovies: async (label, { tmdbId = null, title = '' } = {}) => {
      const source = arr.arrSourceByLabel(label);
      if (!source || source.kind !== 'movie') return null;
      const all = await arr.radarrGetFrom(source.url, source.key, '/movie');
      const lower = String(title).toLowerCase();
      return (all || [])
        .filter(m => (tmdbId == null || m.tmdbId === tmdbId) && (!title || String(m.title || '').toLowerCase().includes(lower)))
        .map(m => ({
          id: m.id,
          title: m.title,
          year: m.year ?? null,
          tmdbId: m.tmdbId ?? null,
          hasFile: Boolean(m.hasFile),
          monitored: Boolean(m.monitored),
          source: label,
          file: shapeFile(m.movieFile),
        }));
    },
  };
}

function registerAgentArrRoutes(app, { service, auth, readLimiter, requireRead, audit }) {
  // Lazily built on first request: registering the routes must not pull in src/arr.js (and
  // its sqlite handle) when a fake service is injected, or before it is ever needed.
  const getService = () => {
    if (!service) service = createArrService();
    return service;
  };
  const wrap = (action, handler) => async (req, res) => {
    const actor = `agent:${req.agentTokenLabel || 'unknown'}`;
    try {
      res.json(await handler(req, getService()));
    } catch (err) {
      // Neither API keys, upstream URLs nor fault strings enter logs or responses.
      audit('agent_arr_error', { actor, action, outcome: 'failed' });
      const status = [400, 404, 503].includes(err.status) ? err.status : 502;
      res.status(status).json({ error: status === 502 ? 'Media server request failed; check state before retrying' : err.message });
    }
  };
  const read = [auth, readLimiter, requireRead];
  const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
  const missing = message => { throw Object.assign(new Error(message), { status: 404 }); };
  const unavailable = message => { throw Object.assign(new Error(message), { status: 503 }); };

  app.get('/api/v1/arr/sources', ...read, wrap('sources', (_req, service) => ({ sources: service.listSources() })));

  app.get('/api/v1/arr/sonarr/series', ...read, wrap('sonarr-series', async (req, service) => {
    if (!service.sonarrConfigured()) unavailable('Sonarr is not configured');
    const { title = '', tvdbId = '' } = req.query;
    if (tvdbId !== '') {
      if (!isValidId(tvdbId)) bad('Invalid tvdbId');
      const series = await service.getSonarrSeriesByTvdbId(Number(tvdbId));
      if (!series) missing(`No Sonarr series with tvdbId ${tvdbId}`);
      return { series: [series] };
    }
    if (!isValidTitle(title)) bad('Provide title (1-200 chars) or tvdbId');
    return { series: await service.searchSonarrSeries(title) };
  }));

  app.get('/api/v1/arr/sonarr/series/:id/episodes', ...read, wrap('sonarr-episodes', async (req, service) => {
    if (!service.sonarrConfigured()) unavailable('Sonarr is not configured');
    if (!isValidId(req.params.id)) bad('Invalid series id');
    const { seasonNumber = '' } = req.query;
    let season = null;
    if (seasonNumber !== '') {
      if (!/^\d{1,3}$/.test(seasonNumber) || Number(seasonNumber) > 200) bad('Invalid seasonNumber');
      season = Number(seasonNumber);
    }
    const seriesId = Number(req.params.id);
    const episodes = await service.getSeriesEpisodes(seriesId, season);
    if (!episodes.length && !(await service.getSonarrSeriesById(seriesId))) {
      missing(`No Sonarr series with id ${seriesId}`);
    }
    return { seriesId, seasonNumber: season, episodeCount: episodes.length, episodes };
  }));

  app.get('/api/v1/arr/radarr/movies', ...read, wrap('radarr-movies', async (req, service) => {
    const { source = '', tmdbId = '', title = '' } = req.query;
    const labels = service.radarrLabels();
    let wanted = labels;
    if (source !== '') {
      if (!MOVIE_SOURCES.includes(source)) bad('Invalid source (radarr or radarr-4k)');
      if (!labels.includes(source)) unavailable(`Radarr source "${source}" is not configured`);
      wanted = [source];
    }
    if (!wanted.length) unavailable('No Radarr instance is configured');
    let tmdb = null;
    if (tmdbId !== '') {
      if (!isValidId(tmdbId)) bad('Invalid tmdbId');
      tmdb = Number(tmdbId);
    }
    if (tmdb == null && !isValidTitle(title)) bad('Provide tmdbId or title (1-200 chars)');
    const movies = [];
    for (const label of wanted) {
      const found = await service.getRadarrMovies(label, { tmdbId: tmdb, title });
      if (found) movies.push(...found);
    }
    return { movies };
  }));
}

module.exports = { registerAgentArrRoutes, createArrService };
