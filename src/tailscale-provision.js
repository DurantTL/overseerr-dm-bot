'use strict';

// Minimal Tailscale OAuth/auth-key client used by the PH guided setup flow.
// Secrets intentionally support the repo's *_FILE convention without adding them to CONFIG yet.
// Auth keys are one-off, non-ephemeral (viewer devices should persist), pre-authorized, and tagged
// so tailnet policy can restrict them to the PH Plex service only.

const fs = require('fs');
const axios = require('axios');

const OAUTH_TOKEN_URL = 'https://api.tailscale.com/api/v2/oauth/token';
const API_BASE = 'https://api.tailscale.com/api/v2';

function envValue(name, env = process.env, readFileSync = fs.readFileSync) {
  if (env[name] != null && env[`${name}_FILE`] != null) {
    throw new Error(`Configuration error: ${name} and ${name}_FILE are both set; set only one`);
  }
  if (env[name] != null) return String(env[name]).trim();
  if (env[`${name}_FILE`]) return String(readFileSync(env[`${name}_FILE`], 'utf8')).replace(/\r?\n$/, '').trim();
  return '';
}

function provisionConfig(env = process.env, readFileSync = fs.readFileSync) {
  return {
    enabled: ['1', 'true', 'yes', 'on'].includes(String(env.TAILSCALE_API_ENABLED || '').toLowerCase()),
    clientId: envValue('TAILSCALE_OAUTH_CLIENT_ID', env, readFileSync),
    clientSecret: envValue('TAILSCALE_OAUTH_CLIENT_SECRET', env, readFileSync),
    tailnet: String(env.TAILSCALE_TAILNET || '-').trim() || '-',
    viewerTag: String(env.TAILSCALE_VIEWER_TAG || 'tag:ph-viewer').trim(),
    expirySeconds: Math.max(60, Math.min(86400, Number.parseInt(env.TAILSCALE_DEVICE_KEY_TTL_SECONDS || '1800', 10) || 1800)),
  };
}

function configured(config = provisionConfig()) {
  return !!(config.enabled && config.clientId && config.clientSecret && config.viewerTag);
}

function buildAuthKeyPayload({ tag = 'tag:ph-viewer', expirySeconds = 1800, description = 'Durant Media Server PH viewer' } = {}) {
  return {
    capabilities: {
      devices: {
        create: {
          reusable: false,
          ephemeral: false,
          preauthorized: true,
          tags: [tag],
        },
      },
    },
    expirySeconds,
    description,
  };
}

async function oauthAccessToken(config, http = axios) {
  const form = new URLSearchParams();
  form.set('client_id', config.clientId);
  form.set('client_secret', config.clientSecret);
  // Request only the capability needed to mint tagged auth keys.
  form.set('scope', 'auth_keys');
  form.set('tags', config.viewerTag);
  const res = await http.post(OAUTH_TOKEN_URL, form.toString(), {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  if (!res?.data?.access_token) throw new Error('Tailscale OAuth did not return an access token');
  return res.data.access_token;
}

async function createViewerAuthKey({ discordId, device, config = provisionConfig(), http = axios } = {}) {
  if (!configured(config)) return { ok: false, configured: false, reason: 'not_configured' };
  const accessToken = await oauthAccessToken(config, http);
  const safeDevice = String(device || 'device').replace(/[^a-z0-9 _.-]/gi, '').slice(0, 40) || 'device';
  const safeDiscord = String(discordId || 'unknown').replace(/[^0-9]/g, '').slice(0, 24) || 'unknown';
  const payload = buildAuthKeyPayload({
    tag: config.viewerTag,
    expirySeconds: config.expirySeconds,
    description: `Durant PH viewer ${safeDiscord} ${safeDevice}`.slice(0, 100),
  });
  const tailnet = encodeURIComponent(config.tailnet || '-');
  const res = await http.post(`${API_BASE}/tailnet/${tailnet}/keys`, payload, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    timeout: 15000,
  });
  const key = String(res?.data?.key || '');
  if (!key) throw new Error('Tailscale created a key record but did not return the one-time key');
  return {
    ok: true,
    configured: true,
    key,
    keyId: res?.data?.id || null,
    expires: res?.data?.expires || null,
    expirySeconds: config.expirySeconds,
    tag: config.viewerTag,
  };
}

module.exports = {
  OAUTH_TOKEN_URL,
  API_BASE,
  envValue,
  provisionConfig,
  configured,
  buildAuthKeyPayload,
  oauthAccessToken,
  createViewerAuthKey,
};
