#!/usr/bin/env node
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `durant-request-ui-${process.pid}.db`);
process.env.DB_PATH = dbPath;

const {
  createSetupRequestUiFeature,
  requestResultOptions,
  encodePickedResult,
  requestInteractionProxy,
  stashSelection,
  takeSelection,
  seasonSelectOptions,
  owns,
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

test('a stashed season selection round-trips as { raw, seasonsRaw }, distinct from the bare-string shape', () => {
  const nonce = stashSelection('123', 'tv:1396:Breaking Bad', '2,5');
  assert.deepEqual(takeSelection(nonce, '123'), { raw: 'tv:1396:Breaking Bad', seasonsRaw: '2,5' });
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

test('owns() claims only the wizard\'s own button/modal/select ids', () => {
  assert.equal(owns({ isButton: () => true, customId: 'setup:quick:request' }), true);
  assert.equal(owns({ isButton: () => true, customId: 'setup:request_confirm:abc:hd' }), true);
  assert.equal(owns({ isButton: () => true, customId: 'setup:open' }), false);
  assert.equal(owns({ isButton: () => false, isModalSubmit: () => true, customId: 'setup:request_modal' }), true);
  assert.equal(owns({ isButton: () => false, isModalSubmit: () => false, isStringSelectMenu: () => true, customId: 'setup:request_results' }), true);
  assert.equal(owns({ isButton: () => false, isModalSubmit: () => false, isStringSelectMenu: () => true, customId: 'setup:request_seasons:abc123' }), true);
  assert.equal(owns({ isButton: () => false, isModalSubmit: () => false, isStringSelectMenu: () => false }), false);
});

function feature(overrides = {}) {
  const calls = { forwarded: [], warned: [] };
  const instance = createSetupRequestUiFeature({
    getUserByDiscordId: () => ({ discord_id: 'member' }),
    searchSeerr: async () => [{ mediaType: 'movie', id: 1, title: 'Example Movie', mediaInfo: {} }],
    fetchSeerrTvSeasonInfo: async () => ({ eligible: [], covered: [] }),
    log: { warn: (...a) => calls.warned.push(a), error: () => {} },
    forwardSlashCommand: async interaction => calls.forwarded.push({
      commandName: interaction.commandName,
      title: interaction.options.getString('title'),
      is4k: interaction.options.getBoolean('is4k'),
      seasons: interaction.options.getString('seasons'),
    }),
    ...overrides,
  });
  return { instance, calls };
}

function button(customId, overrides = {}) {
  return {
    customId,
    user: { id: 'member' },
    isChatInputCommand: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    showModal: async () => {},
    reply: async () => {},
    ...overrides,
  };
}

function select(customId, values, overrides = {}) {
  return {
    customId,
    user: { id: 'member' },
    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => true,
    values,
    update: async () => {},
    reply: async () => {},
    ...overrides,
  };
}

test('createSetupRequestUiFeature requires all its dependencies, including the season-info lookup', () => {
  assert.throws(() => createSetupRequestUiFeature({
    getUserByDiscordId: () => {},
    searchSeerr: async () => [],
    log: { warn() {}, error() {} },
    forwardSlashCommand: async () => {},
  }), TypeError);
});

test('explicit handler ignores interactions it does not own', async () => {
  const { instance, calls } = feature();
  const handled = await instance.handleInteraction(button('setup:open'));
  assert.equal(handled, false);
  assert.deepEqual(calls.forwarded, []);
});

test('quick-request button shows the modal for a linked account', async () => {
  let shown = null;
  const { instance } = feature();
  const handled = await instance.handleInteraction(button('setup:quick:request', {
    showModal: async modal => { shown = modal; },
  }));
  assert.equal(handled, true);
  assert.equal(shown.data.custom_id, 'setup:request_modal');
});

test('quick-request button asks an unlinked account to finish setup first', async () => {
  let replied = null;
  const { instance } = feature({ getUserByDiscordId: () => null });
  const handled = await instance.handleInteraction(button('setup:quick:request', {
    reply: async payload => { replied = payload; },
  }));
  assert.equal(handled, true);
  assert.match(replied.content, /not linked yet/);
});

test('modal submit searches Seerr and offers a select menu of results', async () => {
  let edited = null;
  const { instance } = feature();
  const modal = {
    customId: 'setup:request_modal',
    user: { id: 'member' },
    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => true,
    isStringSelectMenu: () => false,
    fields: { getTextInputValue: () => 'Example Movie' },
    deferReply: async () => {},
    editReply: async payload => { edited = payload; },
  };
  const handled = await instance.handleInteraction(modal);
  assert.equal(handled, true);
  assert.ok(edited.components[0].components[0].data.custom_id === 'setup:request_results');
});

test('modal submit reports no matches with a search-again button', async () => {
  let edited = null;
  const { instance } = feature({ searchSeerr: async () => [] });
  const modal = {
    customId: 'setup:request_modal',
    user: { id: 'member' },
    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => true,
    isStringSelectMenu: () => false,
    fields: { getTextInputValue: () => 'Nothing Matches' },
    deferReply: async () => {},
    editReply: async payload => { edited = payload; },
  };
  const handled = await instance.handleInteraction(modal);
  assert.equal(handled, true);
  assert.match(edited.embeds[0].data.title, /No Matches Found/);
});

test('modal submit surfaces a Seerr search failure instead of throwing', async () => {
  let edited = null;
  const { instance, calls } = feature({ searchSeerr: async () => { throw new Error('boom'); } });
  const modal = {
    customId: 'setup:request_modal',
    user: { id: 'member' },
    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => true,
    isStringSelectMenu: () => false,
    fields: { getTextInputValue: () => 'Example Movie' },
    deferReply: async () => {},
    editReply: async payload => { edited = payload; },
  };
  const handled = await instance.handleInteraction(modal);
  assert.equal(handled, true);
  assert.match(edited, /could not search Seerr/);
  assert.equal(calls.warned.length, 1);
});

test('select menu picking a movie skips the season step entirely and goes straight to quality', async () => {
  let updated = null;
  const { instance } = feature();
  const handled = await instance.handleInteraction(select('setup:request_results', ['movie:100:Example Movie'], {
    update: async payload => { updated = payload; },
  }));
  assert.equal(handled, true);
  assert.match(updated.embeds[0].data.title, /Confirm Request/);
  const ids = updated.components[0].components.map(c => c.data.custom_id);
  assert.equal(ids.length, 3);
  assert.match(ids[0], /^setup:request_confirm:.+:hd$/);
  assert.match(ids[1], /^setup:request_confirm:.+:4k$/);
});

test('select menu picking a TV result with eligible seasons offers a season step instead of requesting everything', async () => {
  let updated = null;
  const { instance } = feature({
    fetchSeerrTvSeasonInfo: async () => ({ eligible: [1, 2], covered: [] }),
  });
  const handled = await instance.handleInteraction(select('setup:request_results', ['tv:1396:Breaking Bad'], {
    update: async payload => { updated = payload; },
  }));
  assert.equal(handled, true);
  assert.match(updated.embeds[0].data.title, /Choose Seasons/);
  const menu = updated.components[0].components[0];
  assert.match(menu.data.custom_id, /^setup:request_seasons:[0-9a-z]{8}$/);
  const values = menu.toJSON().options.map(o => o.value);
  assert.deepEqual(values, ['all', 'season:1', 'season:2']);
});

test('an unreachable/empty Seerr season lookup fails open to All Seasons instead of blocking the request', async () => {
  let updated = null;
  const { instance } = feature({
    fetchSeerrTvSeasonInfo: async () => { throw new Error('ECONNREFUSED'); },
  });
  const handled = await instance.handleInteraction(select('setup:request_results', ['tv:1396:Breaking Bad'], {
    update: async payload => { updated = payload; },
  }));
  assert.equal(handled, true);
  assert.match(updated.embeds[0].data.title, /Confirm Request/, 'goes straight to quality, no season menu');
  assert.match(updated.embeds[0].data.description, /all seasons/);
});

test('full round trip: picking specific seasons lands on the quality-confirm step with that selection stashed under a fresh nonce', async () => {
  const { instance } = feature({
    fetchSeerrTvSeasonInfo: async () => ({ eligible: [1, 2], covered: [] }),
  });
  let firstUpdate = null;
  await instance.handleInteraction(select('setup:request_results', ['tv:1396:Breaking Bad'], {
    update: async payload => { firstUpdate = payload; },
  }));
  const menu = firstUpdate.components[0].components[0];
  const nonce = menu.data.custom_id.split(':')[2];

  let seasonsUpdate = null;
  const handled = await instance.handleInteraction(select(menu.data.custom_id, ['season:2'], {
    update: async payload => { seasonsUpdate = payload; },
  }));
  assert.equal(handled, true);
  assert.match(seasonsUpdate.embeds[0].data.description, /Seasons: \*\*season 2\*\*/);
  const confirmRow = seasonsUpdate.components[0];
  const confirmNonce = confirmRow.components[0].data.custom_id.split(':')[2];
  assert.notEqual(confirmNonce, nonce, 'season step consumes the first nonce and mints a new one');
  assert.equal(takeSelection(nonce, 'member'), null, 'the pre-season-pick nonce is single-use');
  const picked = takeSelection(confirmNonce, 'member');
  assert.deepEqual(picked, { raw: 'tv:1396:Breaking Bad', seasonsRaw: '2' });
});

test('selecting "All Seasons" alongside specific seasons wins over the specific picks', async () => {
  let updated = null;
  const { instance } = feature();
  const nonce = stashSelection('member', 'tv:1396:Breaking Bad');
  const handled = await instance.handleInteraction(select(`setup:request_seasons:${nonce}`, ['all', 'season:1'], {
    update: async payload => { updated = payload; },
  }));
  assert.equal(handled, true);
  assert.match(updated.embeds[0].data.description, /Seasons: \*\*all seasons\*\*/);
});

test('season picker on an expired/unknown nonce asks the member to search again instead of throwing', async () => {
  let updated = null;
  const { instance } = feature();
  const handled = await instance.handleInteraction(select('setup:request_seasons:missing-nonce', ['all'], {
    update: async payload => { updated = payload; },
  }));
  assert.equal(handled, true);
  assert.match(updated.content, /expired/);
});

test('confirm button forwards a synthetic /request interaction with the stashed title and quality (no season pick made)', async () => {
  const { instance, calls } = feature();
  const nonce = stashSelection('member', 'tv:321:Example Show');
  const handled = await instance.handleInteraction(button(`setup:request_confirm:${nonce}:4k`));
  assert.equal(handled, true);
  assert.deepEqual(calls.forwarded, [{ commandName: 'request', title: 'tv:321:Example Show', is4k: true, seasons: null }]);
});

test('confirm button threads a stashed season selection through to the forwarded /request "seasons" option', async () => {
  const { instance, calls } = feature();
  const nonce = stashSelection('member', 'tv:1396:Breaking Bad', '2,5');
  const handled = await instance.handleInteraction(button(`setup:request_confirm:${nonce}:hd`));
  assert.equal(handled, true);
  assert.deepEqual(calls.forwarded, [{ commandName: 'request', title: 'tv:1396:Breaking Bad', is4k: false, seasons: '2,5' }]);
});

test('confirm button tells the user to search again once the selection has expired', async () => {
  let replied = null;
  const { instance, calls } = feature();
  const handled = await instance.handleInteraction(button('setup:request_confirm:missing-nonce:hd', {
    reply: async payload => { replied = payload; },
  }));
  assert.equal(handled, true);
  assert.deepEqual(calls.forwarded, []);
  assert.match(replied.content, /expired/);
});

test('setup request UI no longer intercepts Discord prototypes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/setup-request-ui.js'), 'utf8');
  assert.doesNotMatch(source, /Client\.prototype\.emit|REST\.prototype\.put/);
  const discordImport = source.match(/const\s*\{([^}]*)\}\s*=\s*require\(['"]discord\.js['"]\)/)[1];
  assert.doesNotMatch(discordImport, /\bClient\b/, 'no longer needs the Discord Client to patch its prototype');
  assert.doesNotMatch(discordImport, /\bREST\b/, 'no longer needs the Discord REST client to patch its prototype');
});

test('bootstrap no longer installs a prototype-patching layer for the request wizard', () => {
  const bootstrap = fs.readFileSync(path.join(__dirname, '..', '..', 'bootstrap.js'), 'utf8');
  assert.doesNotMatch(bootstrap, /installSetupRequestUi/);
});

test('setup-discord-extension defers to the request wizard\'s owned ids ahead of its catch-all', () => {
  const { isOwnedInteraction } = require('../../src/setup-discord-extension');
  assert.equal(isOwnedInteraction({ isButton: () => true, customId: 'setup:quick:request' }), false);
  assert.equal(isOwnedInteraction({ isButton: () => true, customId: 'setup:request_confirm:abc:hd' }), false);
  // Its own buttons remain owned as before.
  assert.equal(isOwnedInteraction({ isButton: () => true, customId: 'setup:open' }), true);
});
