#!/usr/bin/env node
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `durant-request-ui-${process.pid}.db`);
process.env.DB_PATH = dbPath;

const {
  requestResultOptions,
  encodePickedResult,
  requestInteractionProxy,
  stashSelection,
  takeSelection,
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