'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerAgentApiRoutes } = require('../../src/routes/agent-api');
const { createArrService } = require('../../src/routes/agent-arr');
const { createApp, listen, close } = require('../../src/app');
const { sha256, safeEqual } = require('../../src/util');

const SHAPED_SERIES = { id: 71, title: 'Bleach', tvdbId: 12345, year: 2004, path: '/share/media/Tv Shows/Bleach', monitored: true, seasonCount: 16, episodeCount: 366, episodeFileCount: 366 };
const SHAPED_EPISODES = [
  { id: 1, seriesId: 71, seasonNumber: 16, episodeNumber: 1, title: 'E1', airDate: '2026-01-01', monitored: true, hasFile: true, file: { id: 11, quality: 'HDTV-1080p', qualityRevision: 1, size: 1400000000, path: '/share/media/Tv Shows/Bleach/Season 16/e1.mkv', dateAdded: '2026-09-23T00:00:00Z' } },
  { id: 2, seriesId: 71, seasonNumber: 16, episodeNumber: 2, title: 'E2', airDate: '2026-01-08', monitored: true, hasFile: false, file: null },
];
const SHAPED_MOVIES = [
  { id: 5, title: 'Dune', year: 2021, tmdbId: 438631, hasFile: true, monitored: true, source: 'radarr-4k', file: { id: 9, quality: 'Bluray-2160p', qualityRevision: 1, size: 50000000000, path: '/share/media/4k/Dune (2021)/dune.mkv', dateAdded: '2026-09-01T00:00:00Z' } },
];

function fixtureService(overrides = {}) {
  return {
    listSources: () => [
      { label: 'sonarr', kind: 'tv', configured: true },
      { label: 'radarr', kind: 'movie', configured: true },
      { label: 'radarr-4k', kind: 'movie', configured: true },
    ],
    sonarrConfigured: () => true,
    radarrLabels: () => ['radarr', 'radarr-4k'],
    searchSonarrSeries: async () => [SHAPED_SERIES],
    getSonarrSeriesByTvdbId: async () => SHAPED_SERIES,
    getSonarrSeriesById: async () => SHAPED_SERIES,
    getSeriesEpisodes: async (_seriesId, seasonNumber) => seasonNumber == null ? SHAPED_EPISODES : SHAPED_EPISODES.filter(e => e.seasonNumber === seasonNumber),
    getRadarrMovies: async () => SHAPED_MOVIES,
    ...overrides,
  };
}

async function startApp(service, grants) {
  const audits = [];
  const app = createApp();
  registerAgentApiRoutes(app, {
    config: { AGENT_API_READ_MAX_PER_MINUTE: 100, AGENT_API_WRITE_MAX_PER_MINUTE: 100 },
    getAgentApiTokenHashes: () => [sha256('reader'), sha256('nobody')],
    getAgentApiTokenLabel: () => 'test-agent',
    getAgentApiTokenGrants: h => grants(h),
    sha256, safeEqual, audit: (...args) => audits.push(args), httpRateLimitKey: () => 'test',
    arrService: service,
  });
  const server = await listen(app, 0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1/arr`;
  const request = (path, token = 'reader') => fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
  return { server, base, request, audits };
}

const readGrants = h => ({ scopes: h === sha256('reader') ? ['read'] : [], discordActions: [] });

test('HTTP boundaries enforce auth, read scope and input validation', async () => {
  const { server, request } = await startApp(fixtureService(), readGrants);
  try {
    assert.equal((await request('/sources', 'invalid')).status, 401);
    assert.equal((await request('/sources', 'nobody')).status, 403);
    assert.equal((await request('/sources')).status, 200);

    assert.equal((await request('/sonarr/series')).status, 400);
    assert.equal((await request('/sonarr/series?title=')).status, 400);
    assert.equal((await request(`/sonarr/series?title=${'a'.repeat(201)}`)).status, 400);
    assert.equal((await request('/sonarr/series?tvdbId=abc')).status, 400);
    assert.equal((await request('/sonarr/series?title=bleach')).status, 200);

    assert.equal((await request('/sonarr/series/abc/episodes')).status, 400);
    assert.equal((await request('/sonarr/series/71/episodes?seasonNumber=xyz')).status, 400);
    assert.equal((await request('/sonarr/series/71/episodes?seasonNumber=999')).status, 400);
    const eps = await (await request('/sonarr/series/71/episodes?seasonNumber=16')).json();
    assert.equal(eps.seriesId, 71);
    assert.equal(eps.episodeCount, 2);

    assert.equal((await request('/radarr/movies')).status, 400);
    assert.equal((await request('/radarr/movies?source=bogus&tmdbId=1')).status, 400);
    assert.equal((await request('/radarr/movies?source=radarr&tmdbId=abc')).status, 400);
    assert.equal((await request('/radarr/movies?source=radarr')).status, 400);
    const movies = await (await request('/radarr/movies?source=radarr-4k&tmdbId=438631')).json();
    assert.equal(movies.movies.length, 1);
    assert.equal(movies.movies[0].source, 'radarr-4k');
  } finally { await close(server); }
});

test('not-found and unconfigured instances map to 404/503', async () => {
  const svc = fixtureService({
    getSonarrSeriesByTvdbId: async () => null,
    getSonarrSeriesById: async () => null,
    getSeriesEpisodes: async () => [],
  });
  const { server, request } = await startApp(svc, readGrants);
  try {
    assert.equal((await request('/sonarr/series?tvdbId=999')).status, 404);
    assert.equal((await request('/sonarr/series/999/episodes')).status, 404);
    // Empty episode list for an existing series is 200, not 404.
    const svc2 = fixtureService({ getSeriesEpisodes: async () => [] });
    const t2 = await startApp(svc2, readGrants);
    try {
      assert.equal((await t2.request('/sonarr/series/71/episodes')).status, 200);
    } finally { await close(t2.server); }
  } finally { await close(server); }
  const unconfigured = await startApp(fixtureService({ sonarrConfigured: () => false, radarrLabels: () => [] }), readGrants);
  try {
    assert.equal((await unconfigured.request('/sonarr/series?title=x')).status, 503);
    assert.equal((await unconfigured.request('/sonarr/series/71/episodes')).status, 503);
    assert.equal((await unconfigured.request('/radarr/movies?tmdbId=1')).status, 503);
    assert.equal((await unconfigured.request('/radarr/movies?source=radarr-4k&tmdbId=1')).status, 503);
  } finally { await close(unconfigured.server); }
});

test('upstream failures become generic 502s with no secret leakage', async () => {
  const secret = 'SUPERSECRET-API-KEY-123';
  const svc = fixtureService({
    searchSonarrSeries: async () => { throw new Error(`request failed: https://user:${secret}@sonarr:8989/api/v3/series?apikey=${secret}`); },
  });
  const { server, request, audits } = await startApp(svc, readGrants);
  try {
    const res = await request('/sonarr/series?title=bleach');
    assert.equal(res.status, 502);
    const body = await res.text();
    assert.equal(body.includes(secret), false);
    assert.equal(body.includes('apikey'), false);
    assert.equal(JSON.stringify(audits).includes(secret), false);
    assert.ok(audits.some(([event, d]) => event === 'agent_arr_error' && d.actor === 'agent:test-agent' && d.outcome === 'failed'));
  } finally { await close(server); }
});

test('createArrService delegates to the arr module and shapes results', async () => {
  const rawSeries = { id: 71, title: 'Bleach', tvdbId: 12345, year: 2004, path: '/tv/Bleach', monitored: true, seasons: [{ seasonNumber: 1 }, { seasonNumber: 16 }], statistics: { seasonCount: 16, episodeCount: 366, episodeFileCount: 365 } };
  const rawEpisodes = [
    { id: 1, seriesId: 71, seasonNumber: 16, episodeNumber: 1, title: 'E1', airDate: '2026-01-01', monitored: true, hasFile: true, episodeFileId: 11 },
    { id: 2, seriesId: 71, seasonNumber: 16, episodeNumber: 2, title: 'E2', airDate: null, monitored: false, hasFile: false, episodeFileId: 0 },
    { id: 3, seriesId: 71, seasonNumber: 15, episodeNumber: 1, title: 'Old', monitored: true, hasFile: true, episodeFileId: 10 },
  ];
  const rawFiles = [{ id: 11, quality: { quality: { name: 'HDTV-1080p' }, revision: { version: 1 } }, size: 1400000000, path: '/tv/Bleach/S16/e1.mkv', dateAdded: '2026-09-23T00:00:00Z' }];
  const rawMovies = [{ id: 5, title: 'Dune', year: 2021, tmdbId: 438631, hasFile: true, monitored: true, movieFile: { id: 9, quality: { quality: { name: 'Bluray-2160p' }, revision: { version: 1 } }, size: 50000000000, path: '/movies/Dune/dune.mkv', dateAdded: '2026-09-01T00:00:00Z' } }];
  const notFound = () => { const e = new Error('Not Found'); e.response = { status: 404 }; throw e; };
  const fakeArr = {
    searchSeries: async () => [rawSeries],
    getSeriesByTvdbId: async () => null,
    sonarrGet: async path => { if (path === '/series/71') return rawSeries; return notFound(); },
    getSeriesEpisodes: async () => rawEpisodes,
    getEpisodeFiles: async () => rawFiles,
    arrSourceByLabel: label => (label === 'radarr-4k' ? { kind: 'movie', label, url: 'http://radarr4k:7878', key: 'k4' } : null),
    radarrGetFrom: async () => rawMovies,
  };
  const svc = createArrService({ arr: fakeArr, config: { SONARR_URL: 'http://sonarr:8989', RADARR_4K_URL: 'http://radarr4k:7878' } });

  assert.deepEqual(svc.listSources(), [
    { label: 'sonarr', kind: 'tv', configured: true },
    { label: 'radarr', kind: 'movie', configured: false },
    { label: 'radarr-4k', kind: 'movie', configured: true },
  ]);
  assert.deepEqual(svc.radarrLabels(), ['radarr-4k']);

  const [series] = await svc.searchSonarrSeries('bleach');
  assert.equal(series.episodeFileCount, 365);
  assert.equal(series.seasonCount, 16);
  assert.equal(await svc.getSonarrSeriesByTvdbId(1), null);
  assert.equal((await svc.getSonarrSeriesById(71)).title, 'Bleach');
  assert.equal(await svc.getSonarrSeriesById(999), null);

  const s16 = await svc.getSeriesEpisodes(71, 16);
  assert.equal(s16.length, 2);
  assert.equal(s16[0].file.quality, 'HDTV-1080p');
  assert.equal(s16[0].file.size, 1400000000);
  assert.equal(s16[1].file, null);
  assert.equal(s16[1].hasFile, false);
  assert.equal((await svc.getSeriesEpisodes(71)).length, 3);

  const movies = await svc.getRadarrMovies('radarr-4k', { tmdbId: 438631 });
  assert.equal(movies.length, 1);
  assert.equal(movies[0].file.quality, 'Bluray-2160p');
  assert.equal(movies[0].source, 'radarr-4k');
  assert.equal(await svc.getRadarrMovies('radarr', { tmdbId: 438631 }), null);
  assert.deepEqual(await svc.getRadarrMovies('radarr-4k', { title: 'nope' }), []);
});

test('createArrService rethrows non-404 series lookup failures', async () => {
  const fakeArr = { sonarrGet: async () => { throw new Error('connection refused'); } };
  const svc = createArrService({ arr: fakeArr, config: { SONARR_URL: 'http://sonarr:8989' } });
  await assert.rejects(svc.getSonarrSeriesById(71), /connection refused/);
});
