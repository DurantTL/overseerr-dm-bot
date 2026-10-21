#!/usr/bin/env node
// Command fallback (src/command-fallback.js): the text resolver (fuzzy + fuzzy
// subcommand + positional/named assembly, gated by the bridge validator), the
// LLM tier's clamping, and the feature's message/button behavior against fakes —
// confirmation offers, author-only Run, auto-run allowlist, credential refusal,
// and strict-channel cleanup.
const { test } = require('node:test');
const assert = require('node:assert');

const { commandDefsToMetadata } = require('../../src/discord-exec');
const {
  createCommandFallbackFeature,
  resolveCommandText,
  tokenizeCommandText,
  damerauLevenshtein,
  coerceOptionValue,
  isCredentialCommand,
  CONFIRM_MIN_CONFIDENCE,
} = require('../../src/command-fallback');

// Plain-object builder JSON (commandDefsToMetadata accepts these directly).
// Types: Subcommand=1, String=3, Integer=4, User=6.
const DEFS = [
  {
    name: 'rtorrent',
    description: 'Seedbox rTorrent',
    options: [
      {
        name: 'adopt', type: 1, description: 'Adopt finished torrents',
        options: [
          { name: 'search', type: 3, description: 'Search term', required: true },
          { name: 'target', type: 3, description: 'Target arr', required: false, choices: [{ name: 'sonarr', value: 'sonarr' }, { name: 'radarr', value: 'radarr' }, { name: 'radarr-4k', value: 'radarr-4k' }] },
        ],
      },
      { name: 'list', type: 1, description: 'List torrents', options: [] },
    ],
  },
  {
    name: 'request',
    description: 'Request media',
    options: [
      { name: 'title', type: 3, description: 'Title', required: true },
      { name: 'year', type: 4, description: 'Year', required: false },
    ],
  },
  { name: 'help', description: 'Help', options: [] },
  {
    name: 'download',
    description: 'Get a download link',
    options: [{ name: 'code', type: 3, description: 'Code', required: true }],
  },
];
const METAS = commandDefsToMetadata(DEFS);

test('fallback: damerauLevenshtein counts a transposition as one edit', () => {
  assert.strictEqual(damerauLevenshtein('adpot', 'adopt'), 1, 'transposed neighbours');
  assert.strictEqual(damerauLevenshtein('adopt', 'adopt'), 0, 'identical');
  assert.strictEqual(damerauLevenshtein('kitten', 'sitting'), 3, 'classic distance');
  assert.strictEqual(damerauLevenshtein('', 'adopt'), 5, 'empty side');
});

test('fallback: tokenize honors quotes', () => {
  assert.deepStrictEqual(tokenizeCommandText('adopt "bleach thousand" year'), ['adopt', 'bleach thousand', 'year']);
  assert.deepStrictEqual(tokenizeCommandText("adopt 'bleach'"), ['adopt', 'bleach']);
  assert.deepStrictEqual(tokenizeCommandText('  '), []);
});

test('fallback: coerceOptionValue', () => {
  assert.deepStrictEqual(coerceOptionValue({ type: 6 }, '<@123456>'), { ok: true, value: '123456' }, 'mention unwraps to an id');
  assert.strictEqual(coerceOptionValue({ type: 6 }, 'bleach').ok, false, 'a word is not a user');
  assert.strictEqual(coerceOptionValue({ type: 4 }, '20x6').ok, false, 'a near-number is not an integer');
  assert.deepStrictEqual(coerceOptionValue({ type: 5 }, 'yes'), { ok: true, value: true }, 'boolean words');
});

test('fallback: exact typed command resolves exactly', () => {
  const r = resolveCommandText('/rtorrent adopt search=bleach target=sonarr', METAS);
  assert.strictEqual(r.kind, 'resolved');
  assert.strictEqual(r.exact, true);
  assert.strictEqual(r.command, 'rtorrent');
  assert.strictEqual(r.subcommand, 'adopt');
  assert.deepStrictEqual(r.options, { search: 'bleach', target: 'sonarr' });
});

test('fallback: transposed subcommand resolves with the phrase intact', () => {
  const r = resolveCommandText('rtorrent adpot bleach thousand year', METAS);
  assert.strictEqual(r.kind, 'resolved');
  assert.strictEqual(r.subcommand, 'adopt', 'adpot corrected to adopt');
  assert.strictEqual(r.options.search, 'bleach thousand year', 'multi-word search stays one argument');
  assert.strictEqual(r.options.target, undefined);
  assert.ok(r.confidence >= CONFIRM_MIN_CONFIDENCE, 'confident enough to offer a confirmation');
  assert.strictEqual(r.exact, false);
});

test('fallback: trailing choice token fills the choices option, not the search', () => {
  const r = resolveCommandText('rtorrent adopt bleach sonarr', METAS);
  assert.strictEqual(r.kind, 'resolved');
  assert.strictEqual(r.options.search, 'bleach');
  assert.strictEqual(r.options.target, 'sonarr');
});

test('fallback: string option holds back a token for a later integer option', () => {
  const r = resolveCommandText('/request the dark knight 2008', METAS);
  assert.strictEqual(r.kind, 'resolved');
  assert.strictEqual(r.options.title, 'the dark knight');
  assert.strictEqual(r.options.year, 2008);
});

test('fallback: missing required option is an invalid with a named problem', () => {
  const r = resolveCommandText('/request', METAS);
  assert.strictEqual(r.kind, 'invalid');
  assert.match(r.problems.join(' '), /title/, 'the problem names the missing option');
});

test('fallback: unrelated text is not a command', () => {
  assert.strictEqual(resolveCommandText('xyzzy plover', METAS).kind, 'none');
  assert.strictEqual(resolveCommandText('https://example.com/watch?v=1', METAS).kind, 'none');
});

test('fallback: credential commands are recognized', () => {
  assert.strictEqual(isCredentialCommand('download', null), true);
  assert.strictEqual(isCredentialCommand('request', null), false);
});

// --- Feature behavior against fakes ---------------------------------------

function makeFeature({ settings = {}, llm = null, fetchImpl = null } = {}) {
  const state = {
    settings: {
      cmdfb_enabled: '1',
      cmdfb_channels: 'chan1',
      cmdfb_strict_channels: 'chan1',
      cmdfb_cleanup: 'react',
      cmdfb_autorun: '',
      ...settings,
    },
    slashCalls: [],
    audits: [],
  };
  const feature = createCommandFallbackFeature({
    config: { ADMIN_USER_ID: 'admin1' },
    getSetting: key => (key in state.settings ? state.settings[key] : null),
    getCommandDefs: () => DEFS,
    handleSlashCommand: async interaction => { state.slashCalls.push(interaction); },
    audit: (action, data) => state.audits.push({ action, data }),
    log: { error: () => {}, info: () => {} },
    llm,
    fetchImpl,
    now: () => 1_000_000,
  });
  return { feature, state };
}

function fakeMessage(content, overrides = {}) {
  const calls = { replies: [], sends: [], reacts: [], dms: [], deletes: 0 };
  const confirmMessage = { id: 'confirm1', edit: async () => confirmMessage };
  const message = {
    content,
    guild: { id: 'g1' },
    guildId: 'g1',
    channelId: 'chan1',
    author: { id: 'user1', bot: false, send: async p => { calls.dms.push(p); } },
    member: { permissions: { has: () => false } },
    channel: {
      id: 'chan1',
      isThread: () => false,
      send: async p => { calls.sends.push(p); return { id: 'note1', delete: async () => {} }; },
    },
    mentions: { users: new Map() },
    attachments: { size: 0 },
    pinned: false,
    client: { user: { id: 'bot1' } },
    reply: async p => { calls.replies.push(p); return confirmMessage; },
    react: async e => { calls.reacts.push(e); },
    delete: async () => { calls.deletes++; },
    ...overrides,
  };
  return { message, calls };
}

function offerNonce(calls) {
  const row = calls.replies[0]?.components?.[0];
  const button = row?.components?.[0];
  const customId = button?.data?.custom_id || button?.custom_id;
  return customId?.split(':')[2];
}

function fakeButton(customId, userId) {
  const calls = { replies: [], updates: [] };
  return {
    calls,
    interaction: {
      customId,
      isButton: () => true,
      user: { id: userId },
      memberPermissions: { has: () => false },
      reply: async p => { calls.replies.push(p); },
      update: async p => { calls.updates.push(p); },
    },
  };
}

test('fallback: a typoed command gets a confirmation offer, and only the author can run it', async () => {
  const { feature, state } = makeFeature();
  const { message, calls } = fakeMessage('rtorrent adpot bleach');
  await feature.handleMessage(message);
  assert.strictEqual(calls.replies.length, 1, 'one confirmation reply');
  assert.match(calls.replies[0].content, /\/rtorrent adopt/, 'the offer shows the corrected command');
  assert.strictEqual(state.slashCalls.length, 0, 'nothing ran yet');

  const nonce = offerNonce(calls);
  assert.ok(nonce, 'offer carries a nonce');

  const stranger = fakeButton(`cmdfb:run:${nonce}`, 'someoneelse');
  await feature.handleInteraction(stranger.interaction);
  assert.strictEqual(state.slashCalls.length, 0, 'a stranger cannot run it');
  assert.match(stranger.calls.replies[0].content, /Only the person who typed it/, 'denial explains itself');

  const author = fakeButton(`cmdfb:run:${nonce}`, 'user1');
  await feature.handleInteraction(author.interaction);
  assert.strictEqual(state.slashCalls.length, 1, 'the author\'s tap runs it');
  const interaction = state.slashCalls[0];
  assert.strictEqual(interaction.commandName, 'rtorrent');
  assert.strictEqual(interaction.options.getSubcommand(), 'adopt');
  assert.strictEqual(interaction.options.getString('search'), 'bleach');
  assert.strictEqual(interaction.user.id, 'user1', 'it runs as the real author, not a synthetic admin');
  assert.ok(calls.reacts.includes('✅'), 'the original message gets the done reaction');
});

test('fallback: exact parse of an auto-run command executes without an offer', async () => {
  const { feature, state } = makeFeature({ settings: { cmdfb_autorun: 'request' } });
  const { message, calls } = fakeMessage('/request title=Dune');
  await feature.handleMessage(message);
  assert.strictEqual(state.slashCalls.length, 1, 'ran immediately');
  assert.strictEqual(feature._pending.size, 0, 'no pending offer');
  assert.strictEqual(calls.replies.length, 0, 'no confirmation reply');
});

test('fallback: credential commands are hint-only, never offered or run', async () => {
  const { feature, state } = makeFeature({ settings: { cmdfb_autorun: 'download' } });
  const { message, calls } = fakeMessage('/download code=abc123');
  await feature.handleMessage(message);
  assert.strictEqual(state.slashCalls.length, 0);
  assert.strictEqual(feature._pending.size, 0);
  assert.match(calls.replies[0].content, /real slash command/, 'the hint explains why');
});

test('fallback: chatter in a strict channel gets the cleanup reaction, not an offer', async () => {
  const { feature, state } = makeFeature();
  const { message, calls } = fakeMessage('good morning everyone, movie night friday?');
  await feature.handleMessage(message);
  assert.strictEqual(state.slashCalls.length, 0);
  assert.strictEqual(feature._pending.size, 0);
  assert.ok(calls.reacts.includes('👀'), 'cleanup reaction applied');
});

test('fallback: disabled means silent', async () => {
  const { feature, state } = makeFeature({ settings: { cmdfb_enabled: '' } });
  const { message, calls } = fakeMessage('rtorrent adpot bleach');
  await feature.handleMessage(message);
  assert.strictEqual(calls.replies.length, 0);
  assert.strictEqual(state.slashCalls.length, 0);
});

test('fallback: LLM tier resolves plain language but always needs confirmation', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: '{"command":"request","subcommand":null,"options":{"title":"Dune"},"confidence":0.99}' } }],
    }),
  });
  const { feature, state } = makeFeature({
    settings: { cmdfb_autorun: 'request' },
    llm: { url: 'http://llm.local/v1/chat/completions', apiKey: '', model: 'local' },
    fetchImpl,
  });
  const { message, calls } = fakeMessage('can i get the dune movie please');
  await feature.handleMessage(message);
  assert.strictEqual(state.slashCalls.length, 0, 'an LLM guess never auto-runs, even for an allowlisted command');
  assert.strictEqual(feature._pending.size, 1, 'it becomes a confirmation offer');
  assert.match(calls.replies[0].content, /\/request/, 'the offer shows the mapped command');
  const entry = [...feature._pending.values()][0];
  assert.ok(entry.resolution.confidence <= 0.9, 'confidence clamped below the LLM\'s claim');
});
