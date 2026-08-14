#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeSearchQuery, searchDashboard } = require('../../src/search');

const now = Date.parse('2026-08-12T12:00:00Z');
const data = {
  now,
  requests: [
    { title: 'The Matrix', status: 'approved', media_type: 'movie', is_4k: 0, media_id: 'tmdb:603', requested_by_discord_id: '123', created_at: '2026-08-10 12:00:00' },
    { title: 'Dark', status: 'available', media_type: 'tv', is_4k: 0, media_id: 'tvdb:334824', requested_by_discord_id: '456', created_at: '2026-08-09 12:00:00' },
  ],
  users: [
    { discord_id: '123', email: 'Neo+Plex@gmail.com', plex_username: 'neo', invited: 1, overseerr_created: 1, home_server: 'primary' },
    { discord_id: '456', email: 'martha@example.net', plex_username: 'martha', invited: 1, overseerr_created: 0, home_server: 'ph' },
  ],
  members: [{ discordId: '123', name: 'Thomas Anderson' }],
  downloadTokens: [{ discord_id: '123', revoked: 0, expires_at: now + 1000 }],
  queues: [{ movieTmdbId: 603, title: 'The Matrix', status: 'downloading', size: 100, sizeleft: 25, timeleft: '00:10:00' }],
  series: [{ id: 7, tvdbId: 334824, title: 'Dark', status: 'ended', statistics: { episodeCount: 26, episodeFileCount: 25 } }],
  missingEpisodes: [{ seriesId: 7, seasonNumber: 2, episodeNumber: 3, monitored: true, hasFile: false, airDateUtc: '2020-01-01T00:00:00Z' }],
  movies: [{ title: 'The Matrix', tmdbId: 603, hasFile: true, monitored: true, source: 'Radarr', is4k: false }],
  auditRows: [{ created_at: '2026-08-11 12:00:00', action: 'request_created', metadata_json: '{"title":"The Matrix","apiKey":"matrix-secret"}' }],
};

test('search: empty is empty and one-character queries are rejected', () => {
  assert.deepStrictEqual(normalizeSearchQuery('  '), { query: '', error: null });
  assert.match(normalizeSearchQuery('x').error, /at least 2/);
  assert.deepStrictEqual(searchDashboard({ ...data, query: '' }).requests, []);
});

test('search: matches requests, users, library, and audit case-insensitively', () => {
  const results = searchDashboard({ ...data, query: 'MATRIX' });
  assert.strictEqual(results.requests.length, 1);
  assert.strictEqual(results.requests[0].progress, 'downloading · 75% · 00:10:00');
  assert.strictEqual(results.library.length, 1);
  assert.strictEqual(results.audit.length, 1);
  assert.deepStrictEqual(Object.keys(results.audit[0]), ['when', 'action', 'match'], 'audit metadata is never returned');

  const user = searchDashboard({ ...data, query: 'neo@gmail.com' }).users[0];
  assert.strictEqual(user.name, 'Thomas Anderson');
  assert.strictEqual(user.requests, 1);
  assert.strictEqual(user.activeLinks, 1);
});

test('search: series results include completeness and aired gaps', () => {
  const result = searchDashboard({ ...data, query: 'dark' }).library[0];
  assert.strictEqual(result.completeness, '96% (25/26)');
  assert.match(result.gaps, /S02 all 1/);
});

test('search: audit secrets stay hidden even when the secret itself matches', () => {
  const result = searchDashboard({ ...data, query: 'matrix-secret' }).audit[0];
  assert.deepStrictEqual(result, { when: '2026-08-11 12:00:00', action: 'request_created', match: 'Metadata' });
  assert.strictEqual(JSON.stringify(result).includes('matrix-secret'), false);
});
