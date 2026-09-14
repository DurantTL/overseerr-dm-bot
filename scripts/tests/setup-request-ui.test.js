#!/usr/bin/env node
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `durant-request-ui-${process.pid}.db`);
process.env.DB_PATH = dbPath;

const express = require('express');
const { CONFIG } = require('../../src/config');

const {
  requestResultOptions,
  encodePickedResult,
  requestInteractionProxy,
  stashSelection,
  takeSelection,
  seasonSelectOptions,
  pickRequest,
  pickSeasons,
} = require('../../src/setup-request-ui');

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch (_e) {}
  }
});

test('request wizard formats Seerr results for a mobile select menu', () => {
  const options = requestResultOptions([
    { mediaType: 'movie', id: 100, title: 'Example Movie', releaseDate: '2025-01-01', mediaInfo: { status: 5 } },
    { mediaType: 'tv', id: 200, name: 'Example Show', firstAirDate: '2024-02-02', mediaInfo: { status: 2 } },
  ]);
  assert.equal(options.length, 2);
  assert.match(options[0].label, /Example Movie/);
  assert.match(options[0].description, /on Plex/);
  assert.match(options[1].label, /Example Show/);
  assert.match(options[1].description, /requested/);
  assert.equal(options[0].value, 'movie:100:Example Movie');
});

test('request wizard sanitizes result values for Discord limits', () => {
  const value = encodePickedResult({ mediaType: 'movie', id: 9, title: 'A:Title\nWith Breaks' });
  assert.equal(value, 'movie:9:A Title With Breaks');
  assert.ok(value.length <= 100);
});

test('request selection sessions are user-bound and one-time', () => {
  const nonce = stashSelection('123', 'movie:99:Movie');
  assert.equal(takeSelection(nonce, '456'), null);
  assert.equal(takeSelection(nonce, '123'), 'movie:99:Movie');
  assert.equal(takeSelection(nonce, '123'), null);
});

test('request_confirm customId parses nonce and quality in the same order the button sets them', () => {
  const nonce = stashSelection('123', 'movie:99:Movie');
  const customId = `setup:request_confirm:${nonce}:4k`;
  const [, , parsedNonce, quality] = customId.split(':');
  assert.equal(parsedNonce, nonce);
  assert.equal(quality, '4k');
  assert.equal(takeSelection(parsedNonce, '123'), 'movie:99:Movie');
});

test('request proxy masquerades as /request while preserving the real interaction', () => {
  const original = {
    user: { id: '123' },
    customId: 'setup:request_confirm:abc:4k',
    isChatInputCommand() { return false; },
    isButton() { return true; },
    deferReply(payload) { return ['defer', payload]; },
  };
  const proxy = requestInteractionProxy(original, 'tv:321:Example Show', true);
  assert.equal(proxy.commandName, 'request');
  assert.equal(proxy.isChatInputCommand(), true);
  assert.equal(proxy.isButton(), false);
  assert.equal(proxy.options.getString('title'), 'tv:321:Example Show');
  assert.equal(proxy.options.getBoolean('is4k'), true);
  assert.deepEqual(proxy.deferReply({ ephemeral: true }), ['defer', { ephemeral: true }]);

  const hdProxy = requestInteractionProxy(original, 'movie:654:Example Movie', false);
  assert.equal(hdProxy.options.getBoolean('is4k'), false);
});

test('request proxy carries a season selection through to the /request "seasons" option', () => {
  const original = { user: { id: '123' }, isChatInputCommand() { return false; }, isButton() { return true; } };
  const proxy = requestInteractionProxy(original, 'tv:321:Example Show', false, '2,5');
  assert.equal(proxy.options.getString('seasons'), '2,5');

  const allProxy = requestInteractionProxy(original, 'tv:321:Example Show', false, 'all');
  assert.equal(allProxy.options.getString('seasons'), 'all');

  // The movie path never stashes a seasonsRaw, so the proxy's seasons option is null — /request
  // never even looks at it for a movie, but this keeps the shape honest either way.
  const movieProxy = requestInteractionProxy(original, 'movie:654:Example Movie', false);
  assert.equal(movieProxy.options.getString('seasons'), null);
});

test('seasonSelectOptions always offers All Seasons plus up to 24 season numbers', () => {
  const few = seasonSelectOptions([1, 2, 3]);
  assert.deepEqual(few.map(o => o.value), ['all', 'season:1', 'season:2', 'season:3']);

  const many = seasonSelectOptions(Array.from({ length: 40 }, (_, i) => i + 1));
  assert.equal(many.length, 25, 'capped at 25 total options (Discord select menu limit)');
  assert.equal(many[0].value, 'all');
  assert.equal(many[24].value, 'season:24');
});

function mockSeerrForWizard() {
  const app = express();
  const state = { tvSeasons: [], media: {} };
  app.get('/api/v1/tv/:id', (req, res) => res.json({ id: Number(req.params.id), seasons: state.tvSeasons, mediaInfo: state.media[`tv:${req.params.id}`] }));
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, state, port: server.address().port }));
  });
}

function fakeSelectInteraction({ userId = '123', values = [], customId }) {
  const calls = { updates: [] };
  return {
    calls,
    user: { id: userId },
    customId,
    values,
    update: async payload => { calls.updates.push(payload); return payload; },
  };
}

test('mobile wizard: picking a TV result offers a season step instead of requesting everything', async () => {
  const { server, state, port } = await mockSeerrForWizard();
  CONFIG.OVERSEERR_URL = `http://127.0.0.1:${port}`;
  CONFIG.OVERSEERR_API_KEY = 'k';
  try {
    state.tvSeasons = [{ seasonNumber: 1, episodeCount: 8 }, { seasonNumber: 2, episodeCount: 10 }];
    const interaction = fakeSelectInteraction({ values: ['tv:1396:Breaking Bad'] });
    await pickRequest(interaction);
    assert.equal(interaction.calls.updates.length, 1);
    const menuRow = interaction.calls.updates[0].components[0];
    const menu = menuRow.components[0];
    assert.match(menu.data.custom_id, /^setup:request_seasons:[0-9a-z]{8}$/);
    const values = menu.toJSON().options.map(o => o.value);
    assert.deepEqual(values, ['all', 'season:1', 'season:2']);

    // Full round trip: picking specific seasons lands on the quality-confirm step with THAT
    // selection stashed under a fresh nonce, and the original raw selection survives.
    const nonce = menu.data.custom_id.split(':')[2];
    const seasonInteraction = fakeSelectInteraction({ values: ['season:2'], customId: menu.data.custom_id });
    await pickSeasons(seasonInteraction);
    assert.match(seasonInteraction.calls.updates[0].embeds[0].data.description, /Seasons: \*\*season 2\*\*/);
    const confirmRow = seasonInteraction.calls.updates[0].components[0];
    const confirmNonce = confirmRow.components[0].data.custom_id.split(':')[2];
    assert.notEqual(confirmNonce, nonce, 'season step consumes the first nonce and mints a new one');
    assert.equal(takeSelection(nonce, '123'), null, 'the pre-season-pick nonce is single-use');
    const picked = takeSelection(confirmNonce, '123');
    assert.deepEqual(picked, { raw: 'tv:1396:Breaking Bad', seasonsRaw: '2' });
  } finally {
    server.close();
  }
});

test('mobile wizard: movies skip the season step entirely', async () => {
  const interaction = fakeSelectInteraction({ values: ['movie:603:The Matrix'] });
  await pickRequest(interaction);
  assert.equal(interaction.calls.updates.length, 1);
  assert.match(interaction.calls.updates[0].embeds[0].data.title, /Confirm Request/);
  const button = interaction.calls.updates[0].components[0].components[0];
  assert.match(button.data.custom_id, /^setup:request_confirm:/);
});

test('mobile wizard: an unreachable Seerr fails open to All Seasons instead of blocking the request', async () => {
  CONFIG.OVERSEERR_URL = 'http://127.0.0.1:1';
  const interaction = fakeSelectInteraction({ values: ['tv:1396:Breaking Bad'] });
  await pickRequest(interaction);
  assert.equal(interaction.calls.updates.length, 1);
  assert.match(interaction.calls.updates[0].embeds[0].data.title, /Confirm Request/, 'goes straight to quality, no season menu');
  assert.match(interaction.calls.updates[0].embeds[0].data.description, /all seasons/);
});

test('mobile wizard: selecting "All Seasons" alongside specific seasons wins over the specific picks', async () => {
  const nonce = stashSelection('123', 'tv:1396:Breaking Bad');
  const interaction = fakeSelectInteraction({ values: ['all', 'season:1'], customId: `setup:request_seasons:${nonce}` });
  await pickSeasons(interaction);
  assert.match(interaction.calls.updates[0].embeds[0].data.description, /Seasons: \*\*all seasons\*\*/);
});