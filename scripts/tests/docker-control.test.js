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
