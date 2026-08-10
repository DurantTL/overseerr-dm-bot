#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const axios = require('axios');
const { loadSandbox } = require('./extract');

test('deletion: resolveDeletableMedia/executeDeletion against a mock Radarr/Sonarr', async () => {
  const app = express();
  const deleted = [];
  const movie = id => [{ id, tmdbId: 603, title: 'The Matrix', movieFile: { path: `/media/${id}.mkv` } }];
  app.get('/radarr/api/v3/movie', (_req, res) => res.json(movie(10)));
  app.get('/radarr4k/api/v3/movie', (_req, res) => res.json(movie(20)));
  app.get('/sonarr/api/v3/series', (_req, res) => res.json([{ id: 30, tvdbId: 81189, title: 'Breaking Bad' }]));
  app.get('/sonarr/api/v3/episodefile', (_req, res) => res.json([{ id: 31, path: '/tv/e1.mkv' }, { id: 32, path: '/tv/e2.mkv' }]));
  app.delete('*', (req, res) => { deleted.push(req.path); res.sendStatus(200); });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const CONFIG = {
    RADARR_URL: `${base}/radarr`, RADARR_API_KEY: 'r',
    RADARR_4K_URL: `${base}/radarr4k`, RADARR_4K_API_KEY: 'r4k',
    SONARR_URL: `${base}/sonarr`, SONARR_API_KEY: 's', DELETION_DRY_RUN: false,
  };
  const audits = [];
  const sandbox = loadSandbox(
    ['radarrGetFrom', 'sonarrGet', 'getEpisodeFiles', 'resolveDeletableMedia', 'executeDeletion'],
    { axios, CONFIG, audit: (action, details) => audits.push({ action, details }) },
  );

  let result = await sandbox.run("resolveDeletableMedia('tmdb:603')");
  assert.strictEqual(result.found, false);
  assert.strictEqual(result.reason, 'ambiguous_source', 'duplicate editions fail closed without source identity');

  result = await sandbox.run("executeDeletion('tmdb:603', 'The Matrix 4K', { arrSource: 'radarr-4k' })");
  assert.strictEqual(result.outcome, 'deleted');
  assert.deepStrictEqual(deleted, ['/radarr4k/api/v3/movie/20'], '4K action deletes only the 4K Radarr copy');

  deleted.length = 0;
  result = await sandbox.run("executeDeletion('tvdb:81189', 'Breaking Bad', {})");
  assert.strictEqual(result.outcome, 'scope_required');
  assert.deepStrictEqual(deleted, [], 'generic TV playback action deletes nothing');

  result = await sandbox.run("executeDeletion('tvdb:81189', 'Breaking Bad', { scope: 'series' })");
  assert.strictEqual(result.outcome, 'deleted');
  assert.deepStrictEqual(deleted.sort(), ['/sonarr/api/v3/episodefile/31', '/sonarr/api/v3/episodefile/32']);
  assert.ok(audits.some(a => a.action === 'deletion_blocked' && a.details.result === 'tv_scope_required'));
  server.close();
});
