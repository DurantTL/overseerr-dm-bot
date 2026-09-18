#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox } = require('./extract');

test('normalizePlexLibrarySectionIds keeps Plex section ids and ignores empty values in JSON or XML', () => {
  const { normalizePlexLibrarySectionIds, parsePlexXmlAttributes, decodePlexXml } = loadSandbox([
    'asArray', 'decodePlexXml', 'parsePlexXmlAttributes', 'normalizePlexLibrarySectionIds',
  ]);
  const ids = Array.from(normalizePlexLibrarySectionIds({
    MediaContainer: { Directory: [{ id: 7, key: 2 }, { id: '9', key: 4 }, { id: 7 }, { key: 8 }] },
  }));
  assert.deepEqual(ids, ['7', '9']);
  const xmlIds = Array.from(normalizePlexLibrarySectionIds(`
    <MediaContainer><Directory id="2" key="1" /><Directory id="3" key="2" /><Directory id="2" /></MediaContainer>`));
  assert.deepEqual(xmlIds, ['2', '3']);
});

test('refreshPlexShare updates an existing share instead of re-inviting the user', async () => {
  const calls = [];
  const { refreshPlexShare } = loadSandbox([
    'asArray', 'findPlexFriend', 'findPlexServerShare', 'plexServersForHomeServer', 'serversForHomeServer', 'plexJsonHeaders', 'refreshPlexShare',
  ], {
    CONFIG: { PLEX_EXCLUDE_SERVERS: [], PH_SERVER_NAMES: [] },
    PLEX_CLIENT_ID: 'test-client',
    axios: {
      put: async (...args) => calls.push(['put', ...args]),
      post: async (...args) => calls.push(['post', ...args]),
    },
    audit: () => {},
    log: { warn: () => {} },
  });
  const context = {
    token: 'token',
    servers: [{ name: 'Main', clientIdentifier: 'main-id' }],
    friends: [{ id: 42, email: 'viewer@example.com', Server: [{ id: 88, machineIdentifier: 'main-id' }] }],
    librarySectionIdsByMachine: new Map([['main-id', ['2', '3']]]),
  };

  const result = await refreshPlexShare('viewer@example.com', { context });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { updatedCount: 1, createdCount: 0, failedCount: 0, total: 1, errors: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'put');
  assert.equal(calls[0][1], 'https://plex.tv/api/servers/main-id/shared_servers/88');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2])), { server_id: 'main-id', shared_server: { library_section_ids: ['2', '3'] } });
});

test('refreshPlexShare creates a share only for an assigned server that is missing', async () => {
  const calls = [];
  const { refreshPlexShare } = loadSandbox([
    'asArray', 'findPlexFriend', 'findPlexServerShare', 'plexServersForHomeServer', 'serversForHomeServer', 'plexJsonHeaders', 'refreshPlexShare',
  ], {
    CONFIG: { PLEX_EXCLUDE_SERVERS: [], PH_SERVER_NAMES: [] },
    PLEX_CLIENT_ID: 'test-client',
    axios: {
      put: async (...args) => calls.push(['put', ...args]),
      post: async (...args) => calls.push(['post', ...args]),
    },
    audit: () => {},
    log: { warn: () => {} },
  });
  const context = {
    token: 'token',
    servers: [{ name: 'Main', clientIdentifier: 'main-id' }],
    friends: [{ id: 42, email: 'viewer@example.com', Server: [] }],
    librarySectionIdsByMachine: new Map([['main-id', ['2']]]),
  };

  const result = await refreshPlexShare('viewer@example.com', { context });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { updatedCount: 0, createdCount: 1, failedCount: 0, total: 1, errors: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'post');
  assert.equal(calls[0][1], 'https://plex.tv/api/servers/main-id/shared_servers');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2])), { server_id: 'main-id', shared_server: { library_section_ids: ['2'], invited_id: 42 } });
});
