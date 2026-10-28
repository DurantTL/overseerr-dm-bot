#!/usr/bin/env node
// Container restart through the Portainer API (src/docker-control.js): the list call must use
// Docker's /containers/json endpoint (Portainer 404s on /containers), then restart by id.
const { test } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

const { restartContainer } = require('../../src/docker-control');

const PORTAINER = {
  DOCKER_SOCKET: '', // skip the socket path so the Portainer branch is taken
  PORTAINER_URL: 'https://portainer.example.test:9443/',
  PORTAINER_API_KEY: 'ptr_test',
  PORTAINER_ENDPOINT_ID: '3',
};

function stubAxios(t, { list }) {
  const calls = { get: [], post: [] };
  const realGet = axios.get;
  const realPost = axios.post;
  axios.get = async (url, opts) => { calls.get.push({ url, opts }); return { status: 200, data: list }; };
  axios.post = async (url, body, opts) => { calls.post.push({ url, opts }); return { status: 204 }; };
  t.after(() => { axios.get = realGet; axios.post = realPost; });
  return calls;
}

test('docker-control: Portainer restart lists via /containers/json, then restarts by id', async t => {
  const calls = stubAxios(t, { list: [{ Id: 'abc123def', Names: ['/radarr-4k'] }, { Id: 'fff', Names: ['/radarr'] }] });
  await restartContainer(PORTAINER, 'radarr-4k');
  assert.strictEqual(calls.get[0].url, 'https://portainer.example.test:9443/api/endpoints/3/docker/containers/json');
  assert.deepStrictEqual(calls.get[0].opts.params, { all: 1 });
  assert.strictEqual(calls.get[0].opts.headers['X-API-Key'], 'ptr_test');
  assert.strictEqual(calls.post[0].url, 'https://portainer.example.test:9443/api/endpoints/3/docker/containers/abc123def/restart', 'exact name match, not the radarr prefix');
});

test('docker-control: a container Portainer does not list fails clearly', async t => {
  stubAxios(t, { list: [{ Id: 'fff', Names: ['/radarr'] }] });
  await assert.rejects(() => restartContainer(PORTAINER, 'prowlarr'), /Container "prowlarr" not found in Portainer/);
});

const { containerFacts, inspectContainers } = require('../../src/docker-control');

test('docker-control: containerFacts keeps only restart count, start, status and image', () => {
  const facts = containerFacts({
    RestartCount: 4,
    State: { Status: 'running', StartedAt: '2026-10-28T12:02:00.000Z' },
    Config: { Image: 'lscr.io/linuxserver/radarr:5.14.0', Env: ['RADARR__API_KEY=supersecret', 'PASSWORD=hunter2'] },
    HostConfig: { Binds: ['/secret:/secret'] },
  });
  assert.deepStrictEqual(facts, { restartCount: 4, startedAt: '2026-10-28T12:02:00.000Z', status: 'running', image: 'lscr.io/linuxserver/radarr:5.14.0' });
  assert.ok(!JSON.stringify(facts).includes('supersecret') && !JSON.stringify(facts).includes('hunter2'), 'environment never leaves');
  assert.strictEqual(containerFacts({ State: { StartedAt: '0001-01-01T00:00:00Z' } }).startedAt, null, "Docker's zero time means never started");
});

test('docker-control: inspectContainers reads each named container through Portainer', async t => {
  const realGet = axios.get;
  const urls = [];
  axios.get = async url => {
    urls.push(url);
    if (url.endsWith('/containers/json')) return { status: 200, data: [{ Id: 'aaa', Names: ['/radarr'] }, { Id: 'bbb', Names: ['/sonarr'] }] };
    if (url.endsWith('/containers/aaa/json')) return { status: 200, data: { RestartCount: 2, State: { Status: 'running', StartedAt: '2026-10-28T10:00:00Z' }, Config: { Image: 'radarr:5', Env: ['KEY=secret'] } } };
    throw new Error('inspect failed');
  };
  t.after(() => { axios.get = realGet; });
  const facts = await inspectContainers(PORTAINER, ['radarr', 'sonarr', 'prowlarr']);
  assert.deepStrictEqual(facts.radarr, { restartCount: 2, startedAt: '2026-10-28T10:00:00Z', status: 'running', image: 'radarr:5' });
  assert.strictEqual(facts.sonarr, null, 'an inspect error maps to null');
  assert.strictEqual(facts.prowlarr, null, 'a container Portainer does not list maps to null');
  assert.ok(urls[0].endsWith('/api/endpoints/3/docker/containers/json'), 'one list call, then per-container inspects');
  assert.ok(!JSON.stringify(facts).includes('secret'));
});

test('docker-control: inspectContainers returns nothing when the list call fails or access is not configured', async t => {
  const realGet = axios.get;
  axios.get = async () => { throw new Error('ECONNREFUSED'); };
  t.after(() => { axios.get = realGet; });
  assert.deepStrictEqual(await inspectContainers(PORTAINER, ['radarr']), {});
  assert.deepStrictEqual(await inspectContainers({ DOCKER_SOCKET: '' }, ['radarr']), {});
});

// ---- View logs: read-only, last 200 lines, redacted ----
const { containerLogs, demuxDockerLogs, parseLogLines, secretLiterals, LOG_TAIL } = require('../../src/docker-control');

function frame(kind, text) {
  const body = Buffer.from(text, 'utf8');
  const head = Buffer.alloc(8);
  head[0] = kind;
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

test('docker-control: demuxDockerLogs splits stdout/stderr frames and passes TTY text through', () => {
  const buf = Buffer.concat([frame(1, '2026-10-28T12:00:01.123456789Z started\n'), frame(2, '2026-10-28T12:00:02.5Z boom\n')]);
  assert.deepStrictEqual(demuxDockerLogs(buf).map(f => f.stream), ['stdout', 'stderr']);
  const plain = demuxDockerLogs(Buffer.from('Hello from a TTY container\n'));
  assert.deepStrictEqual(plain, [{ stream: 'stdout', text: 'Hello from a TTY container\n' }]);
});

test('docker-control: parseLogLines keeps the last 200 lines with Docker timestamps', () => {
  const text = Array.from({ length: 250 }, (_, i) => `2026-10-28T12:00:${String(i % 60).padStart(2, '0')}.000000001Z line ${i}`).join('\n') + '\n';
  const lines = parseLogLines([{ stream: 'stdout', text }], []);
  assert.strictEqual(LOG_TAIL, 200);
  assert.strictEqual(lines.length, 200);
  assert.strictEqual(lines[0].text, 'line 50');
  assert.strictEqual(lines.at(-1).text, 'line 249');
  assert.strictEqual(lines[0].at, '2026-10-28T12:00:50Z');
  assert.strictEqual(parseLogLines([{ stream: 'stdout', text: 'no stamp here\n' }], [])[0].at, null);
});

test('docker-control: log lines never carry configured secrets or credential URLs', () => {
  const config = {
    RTORRENT_URL: 'https://seeduser:s3edPa55word@seedbox.example.test/rutorrent/RPC2',
    RADARR_API_KEY: 'radarrkey1234567890',
    DISCORD_TOKEN: 'discord.token.value',
    RADARR_URL: 'http://radarr:7878',
  };
  const literals = secretLiterals(config);
  assert.ok(literals.includes('s3edPa55word') && literals.includes('seeduser') && literals.includes('radarrkey1234567890'));
  assert.ok(!literals.includes('http://radarr:7878'), 'plain URLs are not secrets');
  const raw = [
    'Connecting to https://seeduser:s3edPa55word@seedbox.example.test/rutorrent/RPC2',
    'user=seeduser pass s3edPa55word',
    'GET /api/v3/movie?apikey=radarrkey1234567890',
    'X-Api-Key radarrkey1234567890 accepted',
    'Authorization: Bearer abc.def.ghi',
    'login with discord.token.value',
  ].join('\n');
  const out = parseLogLines([{ stream: 'stdout', text: raw }], literals).map(l => l.text).join('\n');
  for (const secret of ['s3edPa55word', 'seeduser', 'radarrkey1234567890', 'abc.def.ghi', 'discord.token.value']) {
    assert.ok(!out.includes(secret), `${secret} must not appear`);
  }
  assert.match(out, /\[redacted\]/);
});

test('docker-control: containerLogs reads GET /logs (tail 200) through Portainer and redacts', async t => {
  const calls = [];
  const realGet = axios.get;
  axios.get = async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/containers/json')) return { status: 200, data: [{ Id: 'r1', Names: ['/radarr'] }] };
    return { status: 200, data: frame(1, '2026-10-28T12:00:01Z key=ptr_test_secret_value ok\n') };
  };
  t.after(() => { axios.get = realGet; });
  const lines = await containerLogs({ ...PORTAINER, PORTAINER_API_KEY: 'ptr_test_secret_value' }, 'radarr');
  assert.match(calls[1].url, /\/api\/endpoints\/3\/docker\/containers\/r1\/logs\?stdout=1&stderr=1&timestamps=1&tail=200$/);
  assert.strictEqual(calls[1].opts.responseType, 'arraybuffer');
  assert.strictEqual(lines.length, 1);
  assert.ok(!lines[0].text.includes('ptr_test_secret_value'));
  await assert.rejects(containerLogs(PORTAINER, '../etc'), /Invalid container name/);
  await assert.rejects(containerLogs({ DOCKER_SOCKET: '' }, 'radarr'), /not configured/);
});
