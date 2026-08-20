#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  envValue,
  provisionConfig,
  configured,
  buildAuthKeyPayload,
  createViewerAuthKey,
} = require('../../src/tailscale-provision');

test('tailscale provisioning: supports *_FILE secrets and rejects duplicate secret sources', () => {
  const env = { TAILSCALE_OAUTH_CLIENT_SECRET_FILE: '/secret' };
  assert.equal(envValue('TAILSCALE_OAUTH_CLIENT_SECRET', env, () => 'secret-from-file\n'), 'secret-from-file');
  assert.throws(() => envValue('TAILSCALE_OAUTH_CLIENT_SECRET', {
    TAILSCALE_OAUTH_CLIENT_SECRET: 'inline',
    TAILSCALE_OAUTH_CLIENT_SECRET_FILE: '/secret',
  }, () => 'file'), /both set/);
});

test('tailscale provisioning: config stays disabled until OAuth client is complete', () => {
  const cfg = provisionConfig({ TAILSCALE_API_ENABLED: 'true' }, () => '');
  assert.equal(configured(cfg), false);
  const full = provisionConfig({
    TAILSCALE_API_ENABLED: 'true',
    TAILSCALE_OAUTH_CLIENT_ID: 'id',
    TAILSCALE_OAUTH_CLIENT_SECRET: 'secret',
    TAILSCALE_VIEWER_TAG: 'tag:ph-viewer',
  });
  assert.equal(configured(full), true);
  assert.equal(full.tailnet, '-');
});

test('tailscale provisioning: auth key is one-off, persistent, preauthorized, and tagged', () => {
  const payload = buildAuthKeyPayload({ tag: 'tag:ph-viewer', expirySeconds: 1800, description: 'viewer' });
  const create = payload.capabilities.devices.create;
  assert.equal(create.reusable, false);
  assert.equal(create.ephemeral, false);
  assert.equal(create.preauthorized, true);
  assert.deepEqual(create.tags, ['tag:ph-viewer']);
  assert.equal(payload.expirySeconds, 1800);
});

test('tailscale provisioning: OAuth token is exchanged and auth key returned without logging/storing secret', async () => {
  const calls = [];
  const http = {
    async post(url, body, options) {
      calls.push({ url, body, options });
      if (url.endsWith('/oauth/token')) return { data: { access_token: 'oauth-access-token' } };
      return { data: { id: 'k123', key: 'tskey-auth-secret', expires: '2026-08-20T13:00:00Z' } };
    },
  };
  const config = {
    enabled: true,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    tailnet: '-',
    viewerTag: 'tag:ph-viewer',
    expirySeconds: 1800,
  };
  const result = await createViewerAuthKey({ discordId: '1234567890', device: 'appletv', config, http });
  assert.equal(result.ok, true);
  assert.equal(result.key, 'tskey-auth-secret');
  assert.equal(result.keyId, 'k123');
  assert.equal(calls.length, 2);
  assert.match(String(calls[0].body), /scope=auth_keys/);
  assert.match(String(calls[0].body), /tag%3Aph-viewer/);
  assert.equal(calls[1].body.capabilities.devices.create.reusable, false);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer oauth-access-token');
});
