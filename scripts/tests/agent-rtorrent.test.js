'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRtorrentControl } = require('../../src/rtorrent-control');
const { registerAgentApiRoutes } = require('../../src/routes/agent-api');
const { createApp, listen, close } = require('../../src/app');
const { sha256, safeEqual } = require('../../src/util');
const HASH = 'A'.repeat(40);
function fixture() {
  const calls = [];
  const rows = [{ hash: HASH, name: 'Example', label: '', complete: true }];
  const service = createRtorrentControl({ configured: () => true, list: async () => rows, call: async (...args) => calls.push(args) });
  return { calls, service };
}
test('control maps only allowlisted actions and passes labels as scalar parameters', async () => {
  const { calls, service } = fixture();
  for (const [action, method] of [['start', 'd.start'], ['stop', 'd.stop'], ['pause', 'd.stop'], ['resume', 'd.start'], ['recheck', 'd.check_hash']]) {
    await service.control(HASH.toLowerCase(), action);
    assert.deepEqual(calls.pop(), [method, [HASH]]);
  }
  await service.control(HASH, 'set-label', { label: 'sonarr' });
  assert.deepEqual(calls.pop(), ['d.custom1.set', [HASH, 'sonarr']]);
  for (const [hash, action, body] of [[HASH, 'erase', {}], ['bad', 'start', {}], [HASH, 'start', { method: 'execute' }], [HASH, 'set-label', { label: 'a;execute=evil' }], [HASH, 'set-label', {}]]) {
    await assert.rejects(service.control(hash, action, body), { status: 400 });
  }
  await assert.rejects(service.control('B'.repeat(40), 'start'), { status: 404 });
  assert.equal(calls.length, 0);
});
test('magnet add rejects URLs, source parameters and command injection', async () => {
  const { calls, service } = fixture();
  const magnet = `magnet:?xt=urn:btih:${HASH}`;
  await service.add({ magnet, label: 'tv' });
  assert.deepEqual(calls.pop(), ['load.start', ['', magnet, 'd.custom1.set=tv']]);
  for (const body of [{ magnet: 'https://example.com/x.torrent' }, { magnet: `${magnet}&xs=http://localhost/` }, { magnet, label: 'tv\nexecute=bad' }, { magnet, method: 'execute' }, { magnet: 'magnet:?xt=invalid' }, { magnet: `${magnet}&xt=urn:btih:${HASH}` }]) {
    await assert.rejects(service.add(body), { status: 400 });
  }
  assert.equal(calls.length, 0);
});
test('HTTP boundaries enforce auth, scopes, validation, absence of destructive routes and redaction', async () => {
  const { calls, service } = fixture();
  const audits = [];
  const app = createApp();
  registerAgentApiRoutes(app, {
    config: { AGENT_API_READ_MAX_PER_MINUTE: 100, AGENT_API_WRITE_MAX_PER_MINUTE: 100 },
    getAgentApiTokenHashes: () => [sha256('reader'), sha256('writer')],
    getAgentApiTokenLabel: () => 'test-agent',
    getAgentApiTokenGrants: h => ({ scopes: h === sha256('reader') ? ['read'] : ['read', 'write'], discordActions: [] }),
    sha256, safeEqual, audit: (...args) => audits.push(args), httpRateLimitKey: () => 'test', rtorrentControl: service,
  });
  const server = await listen(app, 0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1/rtorrent/torrents`;
  const request = (suffix = '', token = 'writer', body) => fetch(base + suffix, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    assert.equal((await request('', 'invalid')).status, 401);
    assert.equal((await request(`/${HASH}/stop`, 'reader', {})).status, 403);
    assert.equal(calls.length, 0);
    assert.equal((await request('', 'reader')).status, 200);
    assert.equal((await request('?limit=101')).status, 400);
    assert.equal((await request('/bad')).status, 400);
    assert.equal((await request('/' + 'B'.repeat(40))).status, 404);
    assert.equal((await request(`/${HASH}/erase`, 'writer', {})).status, 404);
    assert.equal((await request(`/${HASH}/stop`, 'writer', {})).status, 200);
    assert.ok(audits.some(([event, d]) => event === 'agent_rtorrent_control' && d.actor === 'agent:test-agent'));
    service.detail = async () => { throw new Error('https://user:secret@example.com/RPC2'); };
    const failed = await request('/' + HASH);
    assert.equal(failed.status, 502);
    assert.equal((await failed.text()).includes('secret'), false);
    assert.equal(JSON.stringify(audits).includes('secret'), false);
    service.configured = () => false;
    assert.equal((await request()).status, 503);
  } finally { await close(server); }
});

test('RPC transport uses separate auth, disables redirects and rejects HTML list responses', async () => {
  const axios = require('axios');
  const { CONFIG } = require('../../src/config');
  const { rtorrentCall, listRtorrentTorrents } = require('../../src/rtorrent');
  const original = axios.post;
  const previous = { RTORRENT_URL: CONFIG.RTORRENT_URL, RTORRENT_USERNAME: CONFIG.RTORRENT_USERNAME, RTORRENT_PASSWORD: CONFIG.RTORRENT_PASSWORD };
  Object.assign(CONFIG, { RTORRENT_URL: 'https://example.com/RPC2', RTORRENT_USERNAME: 'example', RTORRENT_PASSWORD: 'test-password' });
  try {
    axios.post = async (url, body, options) => {
      assert.equal(url, 'https://example.com/RPC2');
      assert.ok(body.includes('<methodName>system.client_version</methodName>'));
      assert.deepEqual(options.auth, { username: 'example', password: 'test-password' });
      assert.equal(options.maxRedirects, 0);
      assert.equal(options.maxContentLength, 8 * 1024 * 1024);
      return { data: '<methodResponse><params><param><value><string>0.9.8</string></value></param></params></methodResponse>' };
    };
    assert.equal(await rtorrentCall('system.client_version'), '0.9.8');
    axios.post = async () => ({ data: '<html>Login required</html>' });
    await assert.rejects(listRtorrentTorrents(), /Invalid rTorrent list response/);
  } finally { axios.post = original; Object.assign(CONFIG, previous); }
});
