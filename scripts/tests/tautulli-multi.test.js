#!/usr/bin/env node
// Multi-Tautulli refactor: the default endpoint binding keeps /watching's calls on the main
// server, explicit endpoints reach per-node instances, fetchHistory aggregates and paginates,
// and an unreachable Tautulli yields an empty history (never a failed plan).
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

// The main-server binding comes from CONFIG, which reads env at require time — set it before
// loading the module.
process.env.TAUTULLI_URL = 'http://127.0.0.1:59991';
process.env.TAUTULLI_API_KEY = 'main-key';

const { tautulliApi, fetchHistory, describeSession, tautulliConfigured } = require('../../src/tautulli');
const { gatherNodeHistories } = require('../../src/tier');

const DAY = 86400;
const nowSec = Math.floor(Date.now() / 1000);

function tautulliMock(name, historyRows) {
  const app = express();
  app.get('/api/v2', (req, res) => {
    const { cmd, apikey } = req.query;
    if (apikey !== `${name}-key`) {
      return res.status(400).json({ response: { result: 'error', message: 'Invalid apikey' } });
    }
    if (cmd === 'get_activity') {
      return res.json({ response: { result: 'success', data: { sessions: [{ friendly_name: name, full_title: 'Now Playing', transcode_decision: 'copy' }] } } });
    }
    if (cmd === 'get_history') {
      const start = Number(req.query.start) || 0;
      const length = Number(req.query.length) || 25;
      return res.json({ response: { result: 'success', data: { recordsFiltered: historyRows.length, data: historyRows.slice(start, start + length) } } });
    }
    return res.json({ response: { result: 'error', message: `unknown cmd ${cmd}` } });
  });
  return app;
}

const movieRow = (key, title, user, daysAgo) => ({ media_type: 'movie', rating_key: key, title, user_id: user, date: nowSec - daysAgo * DAY });
const epRow = (gpKey, gpTitle, user, daysAgo) => ({ media_type: 'episode', rating_key: Math.random(), grandparent_rating_key: gpKey, grandparent_title: gpTitle, user_id: user, date: nowSec - daysAgo * DAY });

test('tautulli-multi: per-node endpoint binding, history aggregation/pagination, gatherNodeHistories', async () => {
  // Node B's history: >1000 rows so fetchHistory has to paginate, plus aggregation fodder.
  const bulk = Array.from({ length: 1001 }, (_, i) => movieRow(7, 'Padding Movie', 1, 80 - (i % 3)));
  const bRows = [
    movieRow(1, 'The Matrix', 10, 5),
    movieRow(1, 'The Matrix', 11, 2),
    movieRow(1, 'The Matrix', 10, 9),
    epRow(5, 'Bluey', 20, 1),
    epRow(5, 'Bluey', 21, 3),
    { media_type: 'track', rating_key: 99, title: 'Some Song', user_id: 1, date: nowSec },
    ...bulk,
  ];

  const mainApp = tautulliMock('main', []);
  const nodeApp = tautulliMock('nodeb', bRows);
  const mainSrv = await new Promise(r => { const s = mainApp.listen(59991, () => r(s)); });
  const nodeSrv = await new Promise(r => { const s = nodeApp.listen(0, () => r(s)); });
  const nodeUrl = `http://127.0.0.1:${nodeSrv.address().port}`;

  // Default binding: existing callers (the /watching path) hit the main server unchanged.
  assert.strictEqual(tautulliConfigured(), true, 'main server configured');
  const activity = await tautulliApi('get_activity');
  assert.strictEqual(activity.sessions[0].friendly_name, 'main', 'no-endpoint call goes to CONFIG main server');
  assert.ok(describeSession(activity.sessions[0]).includes('Direct Stream'), 'describeSession unchanged');

  // Explicit endpoint: same command, different server.
  const nodeActivity = await tautulliApi('get_activity', {}, { url: nodeUrl, apiKey: 'nodeb-key' });
  assert.strictEqual(nodeActivity.sessions[0].friendly_name, 'nodeb', 'endpoint param overrides the default');

  // fetchHistory: pagination + per-title aggregation.
  const history = await fetchHistory({ url: nodeUrl, apiKey: 'nodeb-key' }, { afterDays: 90, length: 5000 });
  const byTitle = Object.fromEntries(history.map(h => [h.title, h]));
  assert.strictEqual(byTitle['The Matrix'].plays, 3, 'movie plays summed across rows');
  assert.strictEqual(byTitle['The Matrix'].distinctUsers, 2, 'distinct users counted');
  assert.strictEqual(byTitle['The Matrix'].mediaType, 'movie');
  assert.ok(Math.abs(byTitle['The Matrix'].lastPlayed - (nowSec - 2 * DAY) * 1000) < 1500, 'lastPlayed = newest row');
  assert.strictEqual(byTitle['Bluey'].mediaType, 'tv', 'episodes collapse to the series');
  assert.strictEqual(byTitle['Bluey'].plays, 2, 'series plays aggregated across episodes');
  assert.strictEqual(byTitle['Bluey'].distinctUsers, 2);
  assert.strictEqual(byTitle['Padding Movie'].plays, 1001, 'pagination crossed the 1000-row page boundary');
  assert.ok(!byTitle['Some Song'], 'music ignored');

  // length cap respected.
  const capped = await fetchHistory({ url: nodeUrl, apiKey: 'nodeb-key' }, { length: 10 });
  assert.ok(capped.reduce((a, h) => a + h.plays, 0) <= 10, 'length caps total rows fetched');

  // Bad API key surfaces Tautulli's own message.
  await assert.rejects(
    () => fetchHistory({ url: nodeUrl, apiKey: 'wrong' }),
    /Invalid apikey/, 'HTTP 400 body message surfaced');

  // gatherNodeHistories: missing/unreachable Tautulli ⇒ empty demand + onError, no crash;
  // atime nodes and disabled nodes skip Tautulli entirely.
  const errors = [];
  const nodes = [
    { name: 'good', enabled: 1, demand_source: 'tautulli', tautulli_url: nodeUrl, tautulli_api_key: 'nodeb-key' },
    { name: 'dead', enabled: 1, demand_source: 'tautulli', tautulli_url: 'http://127.0.0.1:1', tautulli_api_key: 'x' },
    { name: 'none', enabled: 1, demand_source: 'tautulli', tautulli_url: null, tautulli_api_key: null },
    { name: 'cali', enabled: 1, demand_source: 'atime', tautulli_url: nodeUrl, tautulli_api_key: 'nodeb-key' },
    { name: 'bench', enabled: 0, demand_source: 'tautulli', tautulli_url: nodeUrl, tautulli_api_key: 'nodeb-key' },
  ];
  const histories = await gatherNodeHistories(nodes, { fetchHistory, afterDays: 90, onError: (n, err) => errors.push(`${n.name}:${err.message}`) });
  assert.ok(histories.good.length > 0, 'reachable node has history');
  assert.deepStrictEqual(histories.dead, [], 'unreachable Tautulli → empty history, not a crash');
  assert.strictEqual(errors.length, 1, 'failure logged exactly once');
  assert.ok(errors[0].startsWith('dead:'), 'error attributed to the dead node');
  assert.deepStrictEqual(histories.none, [], 'unconfigured node contributes no demand signal');
  assert.deepStrictEqual(histories.cali, [], 'atime node never calls Tautulli');
  assert.strictEqual(histories.bench, undefined, 'disabled node skipped entirely');

  mainSrv.close();
  nodeSrv.close();
});
