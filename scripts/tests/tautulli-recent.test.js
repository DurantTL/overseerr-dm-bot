#!/usr/bin/env node
// Recently-added strip (src/tautulli.js): mapping Tautulli's get_recently_added into poster
// cards, and the poster fetch through pms_image_proxy (Plex image paths only, images only).
const { test } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

process.env.TAUTULLI_URL = 'http://tautulli.example.test:8181/';
process.env.TAUTULLI_API_KEY = 'tautulli-key';

const { mapRecentlyAdded, fetchPoster, PLEX_SECTIONS } = require('../../src/tautulli');

test('recently added: movies, episodes and seasons map to portrait poster cards with library names', () => {
  const items = mapRecentlyAdded({ recently_added: [
    { rating_key: '501', media_type: 'movie', title: 'The Wild Robot', year: '2024', section_id: '1', library_name: 'Movies', added_at: '1761650000', thumb: '/library/metadata/501/thumb/1' },
    { rating_key: '702', media_type: 'episode', title: 'Hello Goodbye', grandparent_title: 'Slow Horses', parent_media_index: '5', media_index: '3', section_id: '2', added_at: '1761640000', thumb: '/library/metadata/702/thumb/2', grandparent_thumb: '/library/metadata/700/thumb/9' },
    { rating_key: '803', media_type: 'season', title: 'Season 2', parent_title: 'Shrinking', section_id: '6', added_at: '1761630000', thumb: '/library/metadata/803/thumb/3' },
    { rating_key: '904', media_type: 'movie', title: 'Dune: Part Two', section_id: '9', library_name: 'Concerts', added_at: '', thumb: 'http://evil.example/x.jpg' },
    { media_type: 'movie', title: 'No key' },
  ] });
  assert.strictEqual(items.length, 4, 'items without a rating key are dropped');
  assert.deepStrictEqual(items[0], { ratingKey: '501', titleKey: '501', type: 'movie', title: 'The Wild Robot', detail: '2024', library: 'Movies', addedAt: 1761650000000, thumb: '/library/metadata/501/thumb/1' });
  assert.strictEqual(items[1].title, 'Slow Horses');
  assert.strictEqual(items[1].detail, 'S5E3');
  assert.strictEqual(items[1].thumb, '/library/metadata/700/thumb/9', "episodes use the show's poster");
  assert.strictEqual(items[1].library, 'TV Shows');
  assert.strictEqual(items[2].title, 'Shrinking');
  assert.strictEqual(items[2].detail, 'Season 2');
  assert.strictEqual(items[2].library, 'Extra TV Shows');
  assert.strictEqual(items[3].library, 'Concerts', "an unknown section falls back to Tautulli's name");
  assert.strictEqual(items[3].addedAt, null);
  assert.strictEqual(items[3].thumb, null, 'only Plex-relative image paths are kept');
  assert.deepStrictEqual(mapRecentlyAdded(null), []);
  assert.strictEqual(PLEX_SECTIONS[3], '4K');
});

test('poster fetch: Plex image paths only, through pms_image_proxy, images only', async t => {
  const calls = [];
  const realGet = axios.get;
  let reply = { status: 200, headers: { 'content-type': 'image/jpeg' }, data: new Uint8Array([0xff, 0xd8]).buffer };
  axios.get = async (url, opts) => { calls.push({ url, opts }); return reply; };
  t.after(() => { axios.get = realGet; });

  const poster = await fetchPoster('/library/metadata/501/thumb/1730000000');
  assert.strictEqual(poster.type, 'image/jpeg');
  assert.strictEqual(poster.body.length, 2);
  assert.strictEqual(calls[0].url, 'http://tautulli.example.test:8181/api/v2');
  assert.strictEqual(calls[0].opts.params.cmd, 'pms_image_proxy');
  assert.strictEqual(calls[0].opts.params.img, '/library/metadata/501/thumb/1730000000');
  assert.strictEqual(calls[0].opts.responseType, 'arraybuffer');

  for (const bad of ['http://evil.example/x.jpg', '/library/metadata/1/../../etc', '/photo/:/transcode?url=x', '', null]) {
    await assert.rejects(fetchPoster(bad), /Not a Plex poster path/);
  }
  reply = { status: 200, headers: { 'content-type': 'text/html' }, data: Buffer.from('<html>') };
  await assert.rejects(fetchPoster('/library/metadata/501/thumb/1'), /Poster unavailable/);
  reply = { status: 401, headers: { 'content-type': 'application/json' }, data: Buffer.from('{}') };
  await assert.rejects(fetchPoster('/library/metadata/501/thumb/1'), /HTTP 401/);
  assert.strictEqual(calls.length, 3, 'rejected paths never reach Tautulli');
});
