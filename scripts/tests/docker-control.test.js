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
