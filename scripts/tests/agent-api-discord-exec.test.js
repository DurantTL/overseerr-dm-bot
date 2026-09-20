#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { SlashCommandBuilder } = require('discord.js');
const { ipKeyGenerator } = require('express-rate-limit');
const { createApp, listen, close } = require('../../src/app');
const { registerAgentApiRoutes } = require('../../src/routes/agent-api');
const { createDiscordExec, validateExecInput, commandDefsToMetadata } = require('../../src/discord-exec');
const { sha256, safeEqual } = require('../../src/util');

function request(port, { method = 'GET', path = '/', token, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    let payload = null;
    if (body !== null) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Canned seedbox torrents the stubbed handler "lists".
const CANNED_TORRENTS = [
  { name: 'Avatar.Fire.And.Ash.2025.2160p.WEB', complete: true },
  { name: 'Avatar.The.Way.of.Water.2022.2160p.WEB', complete: true },
  { name: 'Dune.Part.Two.2024.2160p.BluRay', complete: false },
];

// Fake dispatch standing in for index.js's handleSlashCommand: mimics the real
// /rtorrent adopt handler's option reads and reply pattern (defer + editReply),
// plus a no-subcommand /queue command. Records what it saw for plumbing assertions.
function makeStubHandler(seen) {
  return async function stubHandleSlashCommand(interaction) {
    seen.commandName = interaction.commandName;
    seen.userId = interaction.user.id;
    seen.isAdmin = interaction.memberPermissions?.has('Administrator') === true;
    seen.chatInput = interaction.isChatInputCommand();
    const n = interaction.commandName;
    if (n === 'rtorrent') {
      const sub = interaction.options.getSubcommand();
      seen.subcommand = sub;
      if (sub === 'adopt') {
        const search = interaction.options.getString('search');
        const target = interaction.options.getString('target');
        seen.options = { search, target };
        await interaction.deferReply();
        const words = String(search || '').toLowerCase().split(/\s+/).filter(Boolean);
        const matches = CANNED_TORRENTS.filter(t => words.every(w => t.name.toLowerCase().includes(w)));
        if (!matches.length) return interaction.editReply(`No rTorrent torrents matching "${search}".`);
        return interaction.editReply(
          `Adoptable — ${matches.length} match${matches.length === 1 ? '' : 'es'} for "${search}": ${matches.map(t => t.name).join(', ')}`,
        );
      }
      if (sub === 'list') {
        await interaction.deferReply({ ephemeral: true });
        return interaction.editReply({ content: `${CANNED_TORRENTS.length} torrents`, ephemeral: true });
      }
      return interaction.reply({ content: `unknown sub ${sub}`, ephemeral: true });
    }
    if (n === 'queue') {
      await interaction.deferReply();
      return interaction.editReply('Queue is empty.');
    }
    return interaction.reply({ content: `unhandled ${n}`, ephemeral: true });
  };
}

// Builder defs mirroring the real /rtorrent shape (subcommands) plus a subcommand-less /queue.
function testCommandDefs() {
  return [
    new SlashCommandBuilder().setName('rtorrent').setDescription('Seedbox rTorrent')
      .addSubcommand(s => s.setName('status').setDescription('status'))
      .addSubcommand(s => s.setName('list').setDescription('list')
        .addStringOption(o => o.setName('search').setDescription('filter')))
      .addSubcommand(s => s.setName('adopt').setDescription('adopt')
        .addStringOption(o => o.setName('search').setDescription('words').setRequired(true))
        .addStringOption(o => o.setName('target').setDescription('target').addChoices({ name: 'sonarr', value: 'sonarr' }, { name: 'radarr', value: 'radarr' }))),
    new SlashCommandBuilder().setName('queue').setDescription('Show queue'),
  ];
}

function setup({ withBridge = true, writeLimit = 1000 } = {}) {
  const tokenHash = sha256('valid-agent-token');
  const auditCalls = [];
  const seen = {};
  const discordExec = withBridge
    ? createDiscordExec({ handleSlashCommand: makeStubHandler(seen), getCommandDefs: testCommandDefs, audit: (a, d) => auditCalls.push({ action: a, details: d }) })
    : null;
  const app = createApp();
  registerAgentApiRoutes(app, {
    config: { AGENT_API_READ_MAX_PER_MINUTE: 1000, AGENT_API_WRITE_MAX_PER_MINUTE: writeLimit },
    getAgentApiTokenHashes: () => [tokenHash],
    getAgentApiTokenLabel: () => 'test-client',
    touchAgentApiTokenUse: () => {},
    sha256,
    safeEqual,
    audit: (action, details) => auditCalls.push({ action, details }),
    gatherHealth: async () => ({}),
    fetchArrQueues: async () => [],
    fetchSeerrRequests: async () => [],
    httpRateLimitKey: req => ipKeyGenerator(req.ip || 'unknown'),
    discordExec,
  });
  return { app, auditCalls, seen };
}

const EXEC = '/api/v1/discord/exec';

test('discord-exec rejects unauthenticated requests with 401', async () => {
  const { app } = setup();
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, { method: 'POST', path: EXEC, body: { command: 'rtorrent', subcommand: 'adopt', options: { search: 'avatar' } } });
    assert.strictEqual(res.statusCode, 401);
  } finally { await close(server); }
});

test('discord-exec 503 when the bridge is not wired', async () => {
  const { app } = setup({ withBridge: false });
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, { method: 'POST', path: EXEC, token: 'valid-agent-token', body: { command: 'rtorrent' } });
    assert.strictEqual(res.statusCode, 503);
    assert.match(JSON.parse(res.body).error, /unavailable/i);
  } finally { await close(server); }
});

test('discord-exec 400 on unknown command', async () => {
  const { app, auditCalls } = setup();
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, { method: 'POST', path: EXEC, token: 'valid-agent-token', body: { command: 'yeet' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /unknown command/i);
    assert.ok(auditCalls.some(c => c.action === 'agent_api_discord_exec' && c.details.reason === 'unknown_command' && c.details.ok === false));
  } finally { await close(server); }
});

test('discord-exec 400 on unknown subcommand / unknown option / missing required option', async () => {
  const { app } = setup();
  const server = await listen(app, 0);
  const port = server.address().port;
  try {
    const badSub = await request(port, { method: 'POST', path: EXEC, token: 'valid-agent-token', body: { command: 'rtorrent', subcommand: 'nope', options: {} } });
    assert.strictEqual(badSub.statusCode, 400);
    assert.match(JSON.parse(badSub.body).error, /unknown subcommand/i);

    const badOpt = await request(port, { method: 'POST', path: EXEC, token: 'valid-agent-token', body: { command: 'rtorrent', subcommand: 'adopt', options: { search: 'x', bogus: 1 } } });
    assert.strictEqual(badOpt.statusCode, 400);
    assert.match(JSON.parse(badOpt.body).error, /unknown option/i);

    const missing = await request(port, { method: 'POST', path: EXEC, token: 'valid-agent-token', body: { command: 'rtorrent', subcommand: 'adopt', options: {} } });
    assert.strictEqual(missing.statusCode, 400);
    assert.match(JSON.parse(missing.body).error, /required/i);

    const wrongType = await request(port, { method: 'POST', path: EXEC, token: 'valid-agent-token', body: { command: 'rtorrent', subcommand: 'adopt', options: { search: 123 } } });
    assert.strictEqual(wrongType.statusCode, 400);
    assert.match(JSON.parse(wrongType.body).error, /must be a string/i);

    const badChoice = await request(port, { method: 'POST', path: EXEC, token: 'valid-agent-token', body: { command: 'rtorrent', subcommand: 'adopt', options: { search: 'x', target: 'plex' } } });
    assert.strictEqual(badChoice.statusCode, 400);
    assert.match(JSON.parse(badChoice.body).error, /one of/i);
  } finally { await close(server); }
});

test('discord-exec 400 when a subcommand is required but missing, or given to a plain command', async () => {
  const { app } = setup();
  const server = await listen(app, 0);
  const port = server.address().port;
  try {
    const noSub = await request(port, { method: 'POST', path: EXEC, token: 'valid-agent-token', body: { command: 'rtorrent', options: {} } });
    assert.strictEqual(noSub.statusCode, 400);
    assert.match(JSON.parse(noSub.body).error, /requires a subcommand/i);

    const extraSub = await request(port, { method: 'POST', path: EXEC, token: 'valid-agent-token', body: { command: 'queue', subcommand: 'adopt', options: {} } });
    assert.strictEqual(extraSub.statusCode, 400);
    assert.match(JSON.parse(extraSub.body).error, /takes no subcommand/i);
  } finally { await close(server); }
});

test('discord-exec runs /rtorrent adopt through the shim and captures replies', async () => {
  const { app, auditCalls, seen } = setup();
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, {
      method: 'POST', path: EXEC, token: 'valid-agent-token',
      body: { command: 'rtorrent', subcommand: 'adopt', options: { search: 'avatar' } },
    });
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.command, 'rtorrent');
    assert.strictEqual(data.subcommand, 'adopt');
    // Plumbing: the stub saw the right command, subcommand, options, admin actor.
    assert.strictEqual(seen.commandName, 'rtorrent');
    assert.strictEqual(seen.subcommand, 'adopt');
    assert.strictEqual(seen.options.search, 'avatar');
    assert.strictEqual(seen.chatInput, true);
    assert.ok(String(seen.userId).startsWith('agent:'), 'synthetic agent user id');
    assert.strictEqual(seen.isAdmin, true);
    // Reply capture: defer + the adopt match summary mentioning the matches.
    const kinds = data.replies.map(r => r.kind);
    assert.ok(kinds.includes('defer'), 'deferReply captured');
    const edit = data.replies.find(r => r.kind === 'editReply');
    assert.ok(edit, 'editReply captured');
    assert.match(edit.content, /2 matches/, 'reply mentions the match count');
    assert.match(edit.content, /Avatar\.Fire\.And\.Ash/, 'reply mentions a matched torrent');
    // Audit: one success entry as agent:<label>.
    const execAudits = auditCalls.filter(c => c.action === 'agent_api_discord_exec');
    assert.strictEqual(execAudits.length, 1);
    assert.strictEqual(execAudits[0].details.actor, 'agent:test-client');
    assert.strictEqual(execAudits[0].details.ok, true);
    assert.strictEqual(execAudits[0].details.command, 'rtorrent');
  } finally { await close(server); }
});

test('discord-exec supports commands without subcommands', async () => {
  const { app, seen } = setup();
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, {
      method: 'POST', path: EXEC, token: 'valid-agent-token', body: { command: 'queue' },
    });
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.ok, true);
    assert.strictEqual(seen.commandName, 'queue');
    assert.match(data.replies.find(r => r.kind === 'editReply').content, /Queue is empty/);
  } finally { await close(server); }
});

test('discord-exec surfaces handler errors as ok:false with an error reply', async () => {
  const auditCalls = [];
  const tokenHash = sha256('valid-agent-token');
  const boom = createDiscordExec({
    handleSlashCommand: async () => { throw new Error('kaput'); },
    getCommandDefs: testCommandDefs,
    audit: (a, d) => auditCalls.push({ action: a, details: d }),
  });
  const app = createApp();
  registerAgentApiRoutes(app, {
    config: { AGENT_API_READ_MAX_PER_MINUTE: 1000, AGENT_API_WRITE_MAX_PER_MINUTE: 1000 },
    getAgentApiTokenHashes: () => [tokenHash],
    getAgentApiTokenLabel: () => 'test-client',
    touchAgentApiTokenUse: () => {},
    sha256, safeEqual,
    audit: (a, d) => auditCalls.push({ action: a, details: d }),
    gatherHealth: async () => ({}), fetchArrQueues: async () => [], fetchSeerrRequests: async () => [],
    httpRateLimitKey: req => ipKeyGenerator(req.ip || 'unknown'),
    discordExec: boom,
  });
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, { method: 'POST', path: EXEC, token: 'valid-agent-token', body: { command: 'queue' } });
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.ok, false);
    assert.match(data.replies[0].content, /kaput/);
    assert.ok(auditCalls.some(c => c.action === 'agent_api_discord_exec' && c.details.reason === 'handler_error'));
  } finally { await close(server); }
});

test('discord-exec shares the write rate limiter (429 when over budget)', async () => {
  const { app } = setup({ writeLimit: 2 });
  const server = await listen(app, 0);
  const port = server.address().port;
  try {
    const mk = () => request(port, { method: 'POST', path: EXEC, token: 'valid-agent-token', body: { command: 'queue' } });
    assert.strictEqual((await mk()).statusCode, 200);
    assert.strictEqual((await mk()).statusCode, 200);
    const limited = await mk();
    assert.strictEqual(limited.statusCode, 429);
    assert.match(JSON.parse(limited.body).error, /too many/i);
  } finally { await close(server); }
});

test('validateExecInput handles builder metadata: choices, ranges, user ids', () => {
  const defs = commandDefsToMetadata([
    new SlashCommandBuilder().setName('demo').setDescription('d')
      .addSubcommand(s => s.setName('go').setDescription('g')
        .addIntegerOption(o => o.setName('n').setDescription('n').setRequired(true).setMinValue(1).setMaxValue(5))
        .addUserOption(o => o.setName('who').setDescription('w'))),
  ]);
  const ok = validateExecInput({ command: 'demo', subcommand: 'go', options: { n: 3, who: '123456789' } }, defs);
  assert.deepStrictEqual(ok, { commandName: 'demo', subcommandName: 'go', optionValues: { n: 3, who: '123456789' } });
  assert.throws(() => validateExecInput({ command: 'demo', subcommand: 'go', options: { n: 9 } }, defs), /must be <= 5/);
  assert.throws(() => validateExecInput({ command: 'demo', subcommand: 'go', options: { n: 1, who: 'abc' } }, defs), /user id/);
  // Command/subcommand names are case-insensitive, like Discord.
  const ci = validateExecInput({ command: 'DEMO', subcommand: 'GO', options: { n: 1 } }, defs);
  assert.strictEqual(ci.commandName, 'demo');
  assert.strictEqual(ci.subcommandName, 'go');
});
