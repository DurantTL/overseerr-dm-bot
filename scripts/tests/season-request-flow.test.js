#!/usr/bin/env node
// #255: end-to-end season-selection plumbing for src/seerr.js — createSeerrRequestAs submitting
// only the chosen seasons, and fetchSeerrTvSeasonInfo reporting what's eligible/already covered
// so a partial selection can be narrowed correctly — against a mock Seerr.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const express = require('express');

// src/seerr.js requires src/db.js (for audit()); point it at a scratch DB like the other tests
// that exercise real modules instead of the vm-extraction harness.
process.env.DB_PATH = path.join(os.tmpdir(), `durant-season-request-flow-${process.pid}.db`);

const { CONFIG } = require('../../src/config');
const { createSeerrRequestAs, fetchSeerrTvSeasonInfo } = require('../../src/seerr');
const { splitCoveredSeasons, formatSeasonsLabel, ALL_SEASONS } = require('../../src/season-select');

function mockSeerr() {
  const app = express();
  app.use(express.json());
  const state = { requests: [], tvSeasons: [], media: {} };
  app.get('/api/v1/tv/:id', (req, res) => res.json({ id: Number(req.params.id), seasons: state.tvSeasons, mediaInfo: state.media[`tv:${req.params.id}`] }));
  app.post('/api/v1/request', (req, res) => {
    state.requests.push(req.body);
    res.json({ id: 77, status: 1, media: { tvdbId: 81189 } });
  });
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, state, port: server.address().port }));
  });
}

test('season-request-flow: createSeerrRequestAs submits only the chosen seasons', async () => {
  const { server, state, port } = await mockSeerr();
  CONFIG.OVERSEERR_URL = `http://127.0.0.1:${port}`;
  CONFIG.OVERSEERR_API_KEY = 'k';
  try {
    await createSeerrRequestAs(9, 'tv', 1396, false); // no seasons arg → unchanged default
    assert.strictEqual(state.requests[0].seasons, 'all', 'omitted seasons still defaults to all (back-compat)');

    await createSeerrRequestAs(9, 'tv', 1396, false, ALL_SEASONS);
    assert.strictEqual(state.requests[1].seasons, 'all', 'explicit ALL_SEASONS sentinel');

    await createSeerrRequestAs(9, 'tv', 1396, false, [2, 5]);
    assert.deepStrictEqual(state.requests[2].seasons, [2, 5], 'explicit season list is sent verbatim');

    await createSeerrRequestAs(9, 'movie', 603, false, [2, 5]);
    assert.strictEqual('seasons' in state.requests[3], false, 'a season list is ignored for movies');
  } finally {
    server.close();
  }
});

test('season-request-flow: fetchSeerrTvSeasonInfo reports eligible/covered seasons and narrows a partial pick', async () => {
  const { server, state, port } = await mockSeerr();
  CONFIG.OVERSEERR_URL = `http://127.0.0.1:${port}`;
  CONFIG.OVERSEERR_API_KEY = 'k';
  try {
    // Specials (season 0) and a zero-episode season are excluded from "eligible", matching
    // checkExistingSeerrMedia's own requestable filter.
    state.tvSeasons = [
      { seasonNumber: 0, episodeCount: 3 },
      { seasonNumber: 1, episodeCount: 10 },
      { seasonNumber: 2, episodeCount: 8 },
      { seasonNumber: 3, episodeCount: 0 },
    ];
    state.media['tv:1396'] = { seasons: [{ seasonNumber: 1, status: 5 }, { seasonNumber: 2, status: 2 }] };

    const info = await fetchSeerrTvSeasonInfo(1396, false);
    assert.deepStrictEqual(info.eligible, [1, 2], 'unaired/specials excluded');
    assert.deepStrictEqual(info.covered, [1, 2], 'both already available/pending');
    assert.deepStrictEqual(info.available, [1]);

    // A member asks for seasons 1 (already available), 2 (already pending), and 3 (unaired) —
    // only season 2/1 are "covered", season 3 isn't eligible at all, nothing is left to submit.
    const split = splitCoveredSeasons({ requested: [1, 2, 3], eligible: info.eligible, covered: info.covered });
    assert.deepStrictEqual(split.toSubmit, []);
    assert.deepStrictEqual(split.alreadyCovered, [1, 2]);
    assert.deepStrictEqual(split.invalid, [3]);
    assert.strictEqual(formatSeasonsLabel(split.alreadyCovered), 'seasons 1, 2');

    // A season that's genuinely open still gets through.
    state.tvSeasons.push({ seasonNumber: 4, episodeCount: 6 });
    const info2 = await fetchSeerrTvSeasonInfo(1396, false);
    const split2 = splitCoveredSeasons({ requested: [1, 4], eligible: info2.eligible, covered: info2.covered });
    assert.deepStrictEqual(split2.toSubmit, [4]);
    assert.deepStrictEqual(split2.alreadyCovered, [1]);

    // Unreachable Seerr fails open with empty arrays rather than throwing.
    CONFIG.OVERSEERR_URL = 'http://127.0.0.1:1';
    const failed = await fetchSeerrTvSeasonInfo(1396, false);
    assert.deepStrictEqual(failed, { eligible: [], covered: [], available: [] });
  } finally {
    server.close();
  }
});
