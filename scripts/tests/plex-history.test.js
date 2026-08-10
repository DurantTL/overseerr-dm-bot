#!/usr/bin/env node
// demand_source 'plex': watch history pulled straight from a node's Plex Media Server
// (/status/sessions/history/all) — token auth, pagination, per-title aggregation with
// episode→series collapse, and gatherNodeHistories routing (plex vs tautulli vs atime,
// unreachable ⇒ empty demand).
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { fetchPlexHistory, gatherNodeHistories } = require('../../src/tier');

const DAY = 86400;
const nowSec = Math.floor(Date.now() / 1000);
const movie = (key, title, account, daysAgo) => ({ type: 'movie', ratingKey: String(key), title, accountID: account, viewedAt: nowSec - daysAgo * DAY });
const episode = (gpKey, gpTitle, account, daysAgo) => ({ type: 'episode', ratingKey: String(Math.random()), grandparentKey: `/library/metadata/${gpKey}`, grandparentTitle: gpTitle, accountID: account, viewedAt: nowSec - daysAgo * DAY });

test('plex-history: fetchPlexHistory pagination/aggregation and gatherNodeHistories routing', async () => {
  const rows = [
    movie(101, 'The Matrix', 1, 5),
    movie(101, 'The Matrix', 2, 2),
    movie(101, 'The Matrix', 1, 9),
    episode(55, 'Bluey', 3, 1),
    episode(55, 'Bluey', 4, 3),
    { type: 'track', ratingKey: '900', title: 'Some Song', accountID: 1, viewedAt: nowSec },
    ...Array.from({ length: 1001 }, (_, i) => movie(777, 'Padding Movie', 1, 80 - (i % 3))),
  ];

  const queries = [];
  const app = express();
  app.get('/status/sessions/history/all', (req, res) => {
    if (req.headers['x-plex-token'] !== 'pms-token') return res.status(401).send('Unauthorized');
    queries.push(req.query);
    const start = Number(req.query['X-Plex-Container-Start']) || 0;
    const size = Number(req.query['X-Plex-Container-Size']) || 100;
    const page = rows.slice(start, start + size);
    res.json({ MediaContainer: { size: page.length, totalSize: rows.length, Metadata: page } });
  });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}`;

  const history = await fetchPlexHistory({ url, token: 'pms-token' }, { afterDays: 90 });
  const byTitle = Object.fromEntries(history.map(h => [h.title, h]));
  assert.strictEqual(byTitle['The Matrix'].plays, 3, 'movie plays summed');
  assert.strictEqual(byTitle['The Matrix'].mediaType, 'movie');
  assert.strictEqual(byTitle['The Matrix'].distinctUsers, 2, 'distinct accountIDs counted');
  assert.ok(Math.abs(byTitle['The Matrix'].lastPlayed - (nowSec - 2 * DAY) * 1000) < 1500, 'lastPlayed = newest viewedAt');
  assert.strictEqual(byTitle['Bluey'].mediaType, 'tv', 'episodes collapse to the series');
  assert.strictEqual(byTitle['Bluey'].plays, 2, 'series plays aggregated');
  assert.strictEqual(byTitle['Bluey'].ratingKey, '55', 'series keyed by grandparent rating key');
  assert.strictEqual(byTitle['Padding Movie'].plays, 1001, 'pagination crossed the 1000-row boundary');
  assert.ok(!byTitle['Some Song'], 'music ignored');
  assert.ok(queries.every(q => Number(q['viewedAt>']) > 0), 'history window filter sent to the PMS');

  await assert.rejects(() => fetchPlexHistory({ url, token: 'wrong' }), /401/, 'bad token surfaces');

  // Routing: plex nodes use the PMS fetcher; unconfigured/unreachable → empty demand, no crash.
  const errors = [];
  const histories = await gatherNodeHistories([
    { name: 'cali', enabled: 1, demand_source: 'plex', plex_url: url, plex_token: 'pms-token' },
    { name: 'noplex', enabled: 1, demand_source: 'plex', plex_url: null, plex_token: null },
    { name: 'deadplex', enabled: 1, demand_source: 'plex', plex_url: 'http://127.0.0.1:1', plex_token: 'x' },
    { name: 'lru', enabled: 1, demand_source: 'atime', plex_url: url, plex_token: 'pms-token' },
  ], { fetchPlexHistory, afterDays: 90, onError: (n, err) => errors.push(`${n.name}:${err.message}`) });
  assert.ok(histories.cali.some(h => h.title === 'The Matrix'), 'plex node gets PMS history');
  assert.deepStrictEqual(histories.noplex, [], 'plex node without url/token contributes no demand');
  assert.deepStrictEqual(histories.deadplex, [], 'unreachable PMS → empty demand, not a failed plan');
  assert.strictEqual(errors.length, 1, 'failure logged once');
  assert.ok(errors[0].startsWith('deadplex:'), 'error attributed to the dead node');
  assert.deepStrictEqual(histories.lru, [], 'atime node never calls the PMS');

  srv.close();
});
