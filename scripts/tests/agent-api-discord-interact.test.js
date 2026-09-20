#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { ipKeyGenerator } = require('express-rate-limit');
const { createApp, listen, close } = require('../../src/app');
const { registerAgentApiRoutes } = require('../../src/routes/agent-api');
const { createDiscordInteract, buildHeadlessButtonInteraction, extractButtons } = require('../../src/discord-exec');
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

// Fake dispatch standing in for index.js's handleButton: mimics the real adopt_do
// handler's shape (deferUpdate + editReply) and records what it saw for assertions.
function makeStubButtonHandler(seen) {
  return async function stubHandleButton(interaction) {
    seen.customId = interaction.customId;
    seen.userId = interaction.user.id;
    seen.isAdmin = interaction.memberPermissions?.has('Administrator') === true;
    seen.isButton = interaction.isButton();
    const [action, ...parts] = String(interaction.customId || '').split(':');
    if (action === 'adopt_do') {
      await interaction.deferUpdate();
      return interaction.editReply({ content: `Adopted candidate ${parts[1]} -> ${parts[2]}` });
    }
    if (action === 'adopt_cancel') {
      return interaction.update({ content: 'Dismissed — nothing changed.' });
    }
    return interaction.reply({ content: `unknown button ${action}`, ephemeral: true });
  };
}

function setup({ withBridge = true, writeLimit = 1000, buttonHandler = null } = {}) {
  const tokenHash = sha256('valid-agent-token');
  const auditCalls = [];
  const seen = {};
  const discordInteract = withBridge
    ? createDiscordInteract({ handleButton: buttonHandler || makeStubButtonHandler(seen), audit: (a, d) => auditCalls.push({ action: a, details: d }) })
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
    discordInteract,
  });
  return { app, auditCalls, seen };
}

const INTERACT = '/api/v1/discord/interact';

test('discord-interact rejects unauthenticated requests with 401', async () => {
  const { app } = setup();
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, { method: 'POST', path: INTERACT, body: { custom_id: 'adopt_do:abc:0:radarr' } });
    assert.strictEqual(res.statusCode, 401);
  } finally { await close(server); }
});

test('discord-interact 503 when the bridge is not wired', async () => {
  const { app } = setup({ withBridge: false });
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, { method: 'POST', path: INTERACT, token: 'valid-agent-token', body: { custom_id: 'adopt_do:abc:0:radarr' } });
    assert.strictEqual(res.statusCode, 503);
    assert.match(JSON.parse(res.body).error, /unavailable/i);
  } finally { await close(server); }
});

test('discord-interact 400 on missing / empty / overlong custom_id', async () => {
  const { app, auditCalls } = setup();
  const server = await listen(app, 0);
  const port = server.address().port;
  try {
    const missing = await request(port, { method: 'POST', path: INTERACT, token: 'valid-agent-token', body: {} });
    assert.strictEqual(missing.statusCode, 400);
    assert.match(JSON.parse(missing.body).error, /custom_id is required/i);

    const empty = await request(port, { method: 'POST', path: INTERACT, token: 'valid-agent-token', body: { custom_id: '   ' } });
    assert.strictEqual(empty.statusCode, 400);

    const wrongType = await request(port, { method: 'POST', path: INTERACT, token: 'valid-agent-token', body: { custom_id: 42 } });
    assert.strictEqual(wrongType.statusCode, 400);

    const tooLong = await request(port, { method: 'POST', path: INTERACT, token: 'valid-agent-token', body: { custom_id: `adopt_do:${'x'.repeat(100)}:0:radarr` } });
    assert.strictEqual(tooLong.statusCode, 400);
    assert.match(JSON.parse(tooLong.body).error, /100 characters or fewer/i);

    assert.ok(auditCalls.some(c => c.action === 'agent_api_discord_interact' && c.details.reason === 'missing_custom_id' && c.details.ok === false));
    assert.ok(auditCalls.some(c => c.action === 'agent_api_discord_interact' && c.details.reason === 'custom_id_too_long' && c.details.ok === false));
  } finally { await close(server); }
});

test('discord-interact presses adopt_do through the shim and captures update flow', async () => {
  const { app, auditCalls, seen } = setup();
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, {
      method: 'POST', path: INTERACT, token: 'valid-agent-token',
      body: { custom_id: 'adopt_do:nonce123:0:radarr' },
    });
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.custom_id, 'adopt_do:nonce123:0:radarr');
    // Plumbing: the stub saw the customId, the agent actor, and admin privileges.
    assert.strictEqual(seen.customId, 'adopt_do:nonce123:0:radarr');
    assert.strictEqual(seen.isButton, true);
    assert.ok(String(seen.userId).startsWith('agent:'), 'synthetic agent user id');
    assert.strictEqual(seen.isAdmin, true);
    // Reply capture: deferUpdate + editReply (the adopt_do handler's update flow).
    const kinds = data.replies.map(r => r.kind);
    assert.ok(kinds.includes('deferUpdate'), 'deferUpdate captured');
    const edit = data.replies.find(r => r.kind === 'editReply');
    assert.ok(edit, 'editReply captured');
    assert.match(edit.content, /Adopted candidate 0 -> radarr/);
    // Audit: one success entry as agent:<label>.
    const audits = auditCalls.filter(c => c.action === 'agent_api_discord_interact');
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(audits[0].details.actor, 'agent:test-client');
    assert.strictEqual(audits[0].details.ok, true);
    assert.strictEqual(audits[0].details.custom_id, 'adopt_do:nonce123:0:radarr');
  } finally { await close(server); }
});

test('discord-interact captures interaction.update replies (adopt_cancel path)', async () => {
  const { app } = setup();
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, {
      method: 'POST', path: INTERACT, token: 'valid-agent-token',
      body: { custom_id: 'adopt_cancel:nonce123' },
    });
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.ok, true);
    const update = data.replies.find(r => r.kind === 'update');
    assert.ok(update, 'update captured');
    assert.match(update.content, /Dismissed/);
  } finally { await close(server); }
});

test('discord-interact surfaces handler errors as ok:false with an error reply', async () => {
  const auditCalls = [];
  const tokenHash = sha256('valid-agent-token');
  const boom = createDiscordInteract({
    handleButton: async () => { throw new Error('kaput'); },
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
    discordInteract: boom,
  });
  const server = await listen(app, 0);
  try {
    const res = await request(server.address().port, { method: 'POST', path: INTERACT, token: 'valid-agent-token', body: { custom_id: 'adopt_do:abc:0:radarr' } });
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.ok, false);
    assert.match(data.replies[0].content, /kaput/);
    assert.ok(auditCalls.some(c => c.action === 'agent_api_discord_interact' && c.details.reason === 'handler_error'));
  } finally { await close(server); }
});

test('discord-interact shares the write rate limiter (429 when over budget)', async () => {
  const { app } = setup({ writeLimit: 2 });
  const server = await listen(app, 0);
  const port = server.address().port;
  try {
    const mk = () => request(port, { method: 'POST', path: INTERACT, token: 'valid-agent-token', body: { custom_id: 'adopt_cancel:x' } });
    assert.strictEqual((await mk()).statusCode, 200);
    assert.strictEqual((await mk()).statusCode, 200);
    const limited = await mk();
    assert.strictEqual(limited.statusCode, 429);
    assert.match(JSON.parse(limited.body).error, /too many/i);
  } finally { await close(server); }
});

test('extractButtons surfaces pressable buttons from discord.js component builders', () => {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('adopt_do:nonce1:0:radarr').setLabel('Adopt 1 → radarr').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('adopt_cancel:nonce1').setLabel('Dismiss').setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setLabel('Docs').setStyle(ButtonStyle.Link).setURL('https://example.com/x'),
  );
  const selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('adopt_series_pick:nonce2').setPlaceholder('Pick…').addOptions({ label: 'A', value: '1' }),
  );
  const { buttons, selects } = extractButtons([row, selectRow]);
  assert.strictEqual(buttons.length, 3);
  assert.deepStrictEqual(buttons[0], { custom_id: 'adopt_do:nonce1:0:radarr', label: 'Adopt 1 → radarr', style: 'success' });
  assert.deepStrictEqual(buttons[1], { custom_id: 'adopt_cancel:nonce1', label: 'Dismiss', style: 'secondary', disabled: true });
  assert.deepStrictEqual(buttons[2], { label: 'Docs', style: 'link', url: 'https://example.com/x' });
  assert.strictEqual(selects, 1);
});

test('buildHeadlessButtonInteraction exposes the button shim surface', () => {
  const { interaction, replies } = buildHeadlessButtonInteraction({ customId: 'adopt_do:n:1:sonarr', actorLabel: 'cli' });
  assert.strictEqual(interaction.customId, 'adopt_do:n:1:sonarr');
  assert.strictEqual(interaction.isButton(), true);
  assert.strictEqual(interaction.isChatInputCommand(), false);
  assert.strictEqual(interaction.user.id, 'agent:cli');
  assert.strictEqual(interaction.memberPermissions.has('Administrator'), true);
  assert.deepStrictEqual(interaction.message, { components: [], embeds: [] });
  return (async () => {
    await interaction.deferUpdate();
    await interaction.update({ content: 'u' });
    await interaction.editReply({ content: 'e' });
    await interaction.followUp({ content: 'f' });
    await interaction.reply({ content: 'r' });
    assert.deepStrictEqual(replies.map(r => r.kind), ['deferUpdate', 'update', 'editReply', 'followUp', 'reply']);
  })();
});

test('full adopt flow: /discord/exec lists buttons, /discord/interact presses one', async () => {
  // The exec side: a stubbed /rtorrent adopt handler posting real discord.js buttons.
  const { createDiscordExec } = require('../../src/discord-exec');
  const pressed = [];
  const discordExec = createDiscordExec({
    handleSlashCommand: async interaction => {
      const nonce = 'offer42';
      await interaction.reply({
        content: '1 match for "avatar"',
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`adopt_do:${nonce}:0:radarr`).setLabel('Adopt 1 → radarr').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`adopt_cancel:${nonce}`).setLabel('Dismiss').setStyle(ButtonStyle.Secondary),
        )],
      });
    },
    getCommandDefs: () => [{ name: 'rtorrent', options: [] }],
    audit: () => {},
  });
  const discordInteract = createDiscordInteract({
    handleButton: async interaction => { pressed.push(interaction.customId); await interaction.update({ content: 'done' }); },
    audit: () => {},
  });
  const tokenHash = sha256('valid-agent-token');
  const app = createApp();
  registerAgentApiRoutes(app, {
    config: { AGENT_API_READ_MAX_PER_MINUTE: 1000, AGENT_API_WRITE_MAX_PER_MINUTE: 1000 },
    getAgentApiTokenHashes: () => [tokenHash],
    getAgentApiTokenLabel: () => 'test-client',
    touchAgentApiTokenUse: () => {},
    sha256, safeEqual,
    audit: () => {},
    gatherHealth: async () => ({}), fetchArrQueues: async () => [], fetchSeerrRequests: async () => [],
    httpRateLimitKey: req => ipKeyGenerator(req.ip || 'unknown'),
    discordExec,
    discordInteract,
  });
  const server = await listen(app, 0);
  try {
    const port = server.address().port;
    const execRes = await request(port, { method: 'POST', path: '/api/v1/discord/exec', token: 'valid-agent-token', body: { command: 'rtorrent' } });
    assert.strictEqual(execRes.statusCode, 200);
    const execData = JSON.parse(execRes.body);
    const reply = execData.replies.find(r => r.kind === 'reply');
    assert.ok(reply, 'reply captured');
    assert.ok(Array.isArray(reply.buttons), 'buttons discovered on the reply');
    assert.strictEqual(reply.buttons.length, 2);
    assert.strictEqual(reply.buttons[0].custom_id, 'adopt_do:offer42:0:radarr');
    assert.strictEqual(reply.buttons[0].style, 'success');

    const pressRes = await request(port, { method: 'POST', path: INTERACT, token: 'valid-agent-token', body: { custom_id: reply.buttons[0].custom_id } });
    assert.strictEqual(pressRes.statusCode, 200);
    const pressData = JSON.parse(pressRes.body);
    assert.strictEqual(pressData.ok, true);
    assert.deepStrictEqual(pressed, ['adopt_do:offer42:0:radarr']);
    assert.match(pressData.replies.find(r => r.kind === 'update').content, /done/);
  } finally { await close(server); }
});
