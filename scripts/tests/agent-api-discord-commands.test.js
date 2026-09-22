#!/usr/bin/env node
// GET /api/v1/discord/commands — the command surface, described for a machine caller.
//
// The property that matters is agreement: every command this endpoint reports as `invocable`
// must be one validateExecInput() actually accepts, and every command it reports as not
// invocable must be one validateExecInput() rejects. An endpoint that advertises a call the
// bridge then refuses is worse than no endpoint, because a client trusts it and retries.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { ApplicationCommandOptionType } = require('discord.js');
const { createApp, listen, close } = require('../../src/app');
const { registerAgentApiRoutes } = require('../../src/routes/agent-api');
const { describeCommandsForApi, commandDefsToMetadata, validateExecInput, CREDENTIAL_ACTIONS } = require('../../src/discord-exec');
const { sha256, safeEqual } = require('../../src/util');

const T = ApplicationCommandOptionType;

// Plain command definitions in the shape SlashCommandBuilder.toJSON() produces — index.js
// already passes the bridge the .toJSON()'d list, so this is the real input shape.
const DEFS = [
  {
    name: 'queue',
    description: 'Show the download queue',
    options: [],
  },
  {
    name: 'search',
    description: 'Search for a title',
    options: [
      { name: 'title', description: 'What to look for', type: T.String, required: true, autocomplete: true },
      { name: 'type', description: 'Media type', type: T.String, choices: [{ name: 'movie', value: 'movie' }, { name: 'tv', value: 'tv' }] },
      { name: 'season', description: 'Season number', type: T.Integer, min_value: 0, max_value: 99 },
      { name: 'force', description: 'Skip the cooldown', type: T.Boolean },
    ],
  },
  {
    name: 'rtorrent',
    description: 'Seedbox controls',
    options: [
      {
        name: 'adopt',
        description: 'Adopt a finished torrent',
        type: T.Subcommand,
        options: [
          { name: 'search', description: 'Torrent name', type: T.String, required: true },
          { name: 'target', description: 'Which arr', type: T.String, choices: [{ name: 'radarr', value: 'radarr' }] },
        ],
      },
      {
        name: 'upload',
        description: 'Upload a .torrent file',
        type: T.Subcommand,
        // An attachment is required here, and the bridge has no way to supply one.
        options: [{ name: 'file', description: 'The .torrent', type: T.Attachment, required: true }],
      },
    ],
  },
  {
    name: 'report',
    description: 'File a report',
    // Required attachment on a command with no subcommands: uncallable however it is phrased.
    options: [{ name: 'screenshot', description: 'Evidence', type: T.Attachment, required: true }],
  },
  {
    name: 'notify',
    description: 'Notify a channel',
    // Optional unsupported option: callable as long as the caller leaves it out.
    options: [
      { name: 'message', description: 'What to say', type: T.String, required: true },
      { name: 'channel', description: 'Where', type: T.Channel },
    ],
  },
  {
    name: 'tier',
    description: 'Tier planning',
    options: [
      {
        name: 'node',
        description: 'Node operations',
        type: T.SubcommandGroup,
        options: [{ name: 'add', description: 'Add a node', type: T.Subcommand, options: [] }],
      },
    ],
  },
];

function byName(described, name) {
  const found = described.find(c => c.name === name);
  assert.ok(found, `${name} is described`);
  return found;
}

test('describeCommandsForApi reports names, descriptions, types and constraints', () => {
  const described = describeCommandsForApi(DEFS);

  const queue = byName(described, 'queue');
  assert.strictEqual(queue.description, 'Show the download queue');
  assert.deepStrictEqual(queue.options, []);
  assert.strictEqual(queue.invocable, true);

  const search = byName(described, 'search');
  const title = search.options.find(o => o.name === 'title');
  assert.strictEqual(title.type, 'string', 'the numeric Discord type is translated');
  assert.strictEqual(title.required, true);
  assert.strictEqual(title.supported, true);
  assert.strictEqual(title.autocomplete, true, 'autocomplete is flagged: the value is free-form headless');
  assert.strictEqual(title.choices, undefined, 'and is not a choices list');

  const type = search.options.find(o => o.name === 'type');
  assert.deepStrictEqual(type.choices, ['movie', 'tv']);
  assert.strictEqual(type.required, false);

  const season = search.options.find(o => o.name === 'season');
  assert.strictEqual(season.type, 'integer');
  assert.strictEqual(season.min, 0);
  assert.strictEqual(season.max, 99);
});

test('describeCommandsForApi marks what the bridge cannot call, and why', () => {
  const described = describeCommandsForApi(DEFS);

  // A required option of a type the shim can't serve.
  const report = byName(described, 'report');
  assert.strictEqual(report.invocable, false);
  assert.match(report.reason, /attachment option \("screenshot"\)/);
  assert.strictEqual(report.options[0].supported, false);

  // An *optional* one is merely off-limits; the command still works without it.
  const notify = byName(described, 'notify');
  assert.strictEqual(notify.invocable, true);
  assert.strictEqual(notify.options.find(o => o.name === 'channel').supported, false);

  // Subcommand groups are rejected outright by the validator.
  const tier = byName(described, 'tier');
  assert.strictEqual(tier.invocable, false);
  assert.match(tier.reason, /subcommand groups/);

  // Per-subcommand: one callable, one not, and the command is callable because one is.
  const rtorrent = byName(described, 'rtorrent');
  assert.strictEqual(rtorrent.invocable, true);
  assert.strictEqual(rtorrent.subcommands.find(s => s.name === 'adopt').invocable, true);
  const upload = rtorrent.subcommands.find(s => s.name === 'upload');
  assert.strictEqual(upload.invocable, false);
  assert.match(upload.reason, /attachment option \("file"\)/);
});

test('a command carrying both subcommands and a group stays callable, like the validator', () => {
  // validateExecInput takes the subcommand path first and only rejects groups when there are
  // no subcommands, so describing this as uncallable would be a lie in the safe direction —
  // still a lie, and it would hide a working command from a client.
  const [described] = describeCommandsForApi([{
    name: 'mixed',
    description: 'Both shapes',
    options: [
      { name: 'go', description: 'Do it', type: T.Subcommand, options: [] },
      { name: 'grp', description: 'A group', type: T.SubcommandGroup, options: [] },
    ],
  }]);
  assert.strictEqual(described.invocable, true);
  const metadatas = commandDefsToMetadata([{
    name: 'mixed',
    options: [
      { name: 'go', type: T.Subcommand, options: [] },
      { name: 'grp', type: T.SubcommandGroup, options: [] },
    ],
  }]);
  assert.doesNotThrow(() => validateExecInput({ command: 'mixed', subcommand: 'go', options: {} }, metadatas));
});

// A value the described option would accept, so the claim can be tested against the validator.
function minimalValue(opt) {
  if (Array.isArray(opt.choices) && opt.choices.length) return opt.choices[0];
  switch (opt.type) {
    case 'string': return 'x';
    case 'boolean': return true;
    case 'user': return '123456789';
    case 'integer':
    case 'number': {
      if (typeof opt.min === 'number') return opt.min;
      if (typeof opt.max === 'number' && opt.max < 1) return opt.max;
      return 1;
    }
    default: return null;
  }
}

test('every command described as invocable is one the validator actually accepts', () => {
  const described = describeCommandsForApi(DEFS);
  const metadatas = commandDefsToMetadata(DEFS);
  let checkedCallable = 0;
  let checkedRefused = 0;

  for (const command of described) {
    const subs = command.subcommands || [null];
    for (const sub of subs) {
      const options = {};
      for (const opt of (sub ? sub.options : command.options) || []) {
        if (opt.required) options[opt.name] = minimalValue(opt);
      }
      const payload = { command: command.name, subcommand: sub ? sub.name : null, options };
      const callable = sub ? sub.invocable : command.invocable;
      if (callable) {
        assert.doesNotThrow(
          () => validateExecInput(payload, metadatas),
          `${command.name}${sub ? ` ${sub.name}` : ''} is described as invocable, so the validator must accept it`,
        );
        checkedCallable++;
      } else {
        assert.throws(
          () => validateExecInput(payload, metadatas),
          `${command.name}${sub ? ` ${sub.name}` : ''} is described as not invocable, so the validator must reject it`,
        );
        checkedRefused++;
      }
    }
  }
  assert.ok(checkedCallable >= 4, `exercised the callable commands (${checkedCallable})`);
  assert.ok(checkedRefused >= 3, `exercised the refused commands (${checkedRefused})`);
});

test('describeCommandsForApi tolerates builders, junk entries and an empty list', () => {
  const described = describeCommandsForApi([
    { toJSON: () => ({ name: 'Built', description: 'From a builder', options: [] }) },
    null,
    { name: '', description: 'nameless' },
    { name: '   ', description: 'blank' },
  ]);
  assert.strictEqual(described.length, 1, 'junk entries are dropped, not thrown on');
  assert.strictEqual(described[0].name, 'built', 'names are lowercased like the validator does');
  assert.deepStrictEqual(describeCommandsForApi([]), []);
  assert.deepStrictEqual(describeCommandsForApi(), []);
});

// ---- route ----

function get(port, path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'GET', path,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function setup({ defs = DEFS, wired = true, readLimit = 1000 } = {}) {
  const tokenHash = sha256('valid-agent-token');
  const app = createApp();
  registerAgentApiRoutes(app, {
    config: { AGENT_API_READ_MAX_PER_MINUTE: readLimit, AGENT_API_WRITE_MAX_PER_MINUTE: 1000 },
    getAgentApiTokenHashes: () => [tokenHash],
    getAgentApiTokenLabel: hash => (hash === tokenHash ? 'test-client' : null),
    touchAgentApiTokenUse: () => {},
    sha256,
    safeEqual,
    audit: () => {},
    gatherHealth: async () => ({ overall: 'ok' }),
    fetchArrQueues: async () => [],
    fetchSeerrRequests: async () => [],
    getPlexToken: async () => 'plex-token',
    getPlexServers: async () => [],
    httpRateLimitKey: () => 'test',
    getDiscordCommandDefs: wired ? () => defs : null,
  });
  return app;
}

async function withServer(app, fn) {
  const server = await listen(app, 0);
  try {
    return await fn(server.address().port);
  } finally {
    await close(server);
  }
}

test('GET /discord/commands requires a token and returns the described surface', async () => {
  await withServer(setup(), async port => {
    const anon = await get(port, '/api/v1/discord/commands');
    assert.strictEqual(anon.statusCode, 401, 'discovery is not public');

    const res = await get(port, '/api/v1/discord/commands', 'valid-agent-token');
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.count, DEFS.length);
    assert.strictEqual(body.invocable, DEFS.length - 2, 'report and tier are not callable');
    assert.deepStrictEqual(
      body.commands.map(c => c.name),
      ['queue', 'search', 'rtorrent', 'report', 'notify', 'tier'],
    );
    // The response is the discovery contract: descriptions and the invocable flag must survive
    // JSON, since that is all a client ever sees.
    assert.strictEqual(body.commands.find(c => c.name === 'report').invocable, false);
    assert.strictEqual(body.commands.find(c => c.name === 'search').options[0].autocomplete, true);
  });
});

test('GET /discord/commands is 503 when definitions are not wired, and shares the read budget', async () => {
  await withServer(setup({ wired: false }), async port => {
    const res = await get(port, '/api/v1/discord/commands', 'valid-agent-token');
    assert.strictEqual(res.statusCode, 503);
    assert.match(JSON.parse(res.body).error, /definitions are unavailable/);
  });

  await withServer(setup({ defs: [] }), async port => {
    const res = await get(port, '/api/v1/discord/commands', 'valid-agent-token');
    assert.strictEqual(res.statusCode, 503, 'an empty definition list is unavailable, not an empty success');
  });

  await withServer(setup({ readLimit: 1 }), async port => {
    assert.strictEqual((await get(port, '/api/v1/discord/commands', 'valid-agent-token')).statusCode, 200);
    assert.strictEqual(
      (await get(port, '/api/v1/discord/commands', 'valid-agent-token')).statusCode,
      429,
      'discovery shares the read budget rather than being unbounded',
    );
  });
});

// ---- credential-touching commands ----

test('the three credential commands are flagged with an effect and a reason', () => {
  const described = describeCommandsForApi([
    { name: 'download', description: 'Get a secure download link', options: [] },
    { name: 'revoke-downloads', description: 'Revoke download links', options: [] },
    { name: 'tier-node', description: 'Tier node admin', options: [
      { name: 'token', description: 'Rotate the agent token', type: T.Subcommand, options: [] },
      { name: 'add', description: 'Add a node', type: T.Subcommand, options: [] },
    ] },
    { name: 'queue', description: 'Show the queue', options: [] },
  ]);

  const download = byName(described, 'download');
  assert.strictEqual(download.credential, true);
  assert.strictEqual(download.credentialEffect, 'mint');
  assert.match(download.credentialReason, /without a further login/);

  const revoke = byName(described, 'revoke-downloads');
  assert.strictEqual(revoke.credentialEffect, 'revoke');

  // The flag belongs to the subcommand that rotates, not to /tier-node as a whole — `add` and
  // the rest of the group are ordinary.
  const tierNode = byName(described, 'tier-node');
  assert.strictEqual(tierNode.credential, undefined, 'the parent command is not itself a credential action');
  const tokenSub = tierNode.subcommands.find(s => s.name === 'token');
  assert.strictEqual(tokenSub.credential, true);
  assert.strictEqual(tokenSub.credentialEffect, 'rotate');
  assert.match(tokenSub.credentialReason, /silently stops reporting/,
    'the reason says the sharp part: the failure shows up later as a quiet node, not as an error here');
  assert.strictEqual(tierNode.subcommands.find(s => s.name === 'add').credential, undefined);

  assert.strictEqual(byName(described, 'queue').credential, undefined, 'ordinary commands carry no flag');
});

test('the credential register lists exactly the actions that touch a credential today', () => {
  // A hand-kept register: nothing in a SlashCommandBuilder says a command mints or revokes
  // anything. This pins it so adding a credential command without registering it fails here
  // rather than going unflagged into somebody's allowlist.
  assert.deepStrictEqual(
    Object.keys(CREDENTIAL_ACTIONS).sort(),
    ['download', 'revoke-downloads', 'tier-node token'],
  );
  for (const [key, entry] of Object.entries(CREDENTIAL_ACTIONS)) {
    assert.ok(['mint', 'rotate', 'revoke'].includes(entry.effect), `${key} has a known effect`);
    assert.ok(entry.reason && entry.reason.length > 20, `${key} explains itself`);
  }
  // Agent API tokens are absent on purpose: createAgentApiToken is reachable only from the
  // dashboard, so no command or button can mint one.
  assert.ok(!Object.keys(CREDENTIAL_ACTIONS).some(k => k.includes('agent-api')));
});
