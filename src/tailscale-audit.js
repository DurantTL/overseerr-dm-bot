'use strict';

// Service queue item 16: Tailscale key-expiry audit, report-only. Lists the tailnet's devices with a
// read-only token (OAuth scope devices:core:read) and flags headless nodes, the servers nobody is
// sitting at to re-login, whose node key expires within the warning window. Nothing is changed in
// Tailscale. Device names and expiry dates are reported; credentials, keys and IPs are not.
//
// Headless nodes: TAILSCALE_HEADLESS_NODES (comma list of machine names) when set; otherwise every
// Linux/FreeBSD device that isn't a PH viewer (the viewer tag). Tagged devices normally have key
// expiry off, so they show as "never expires".

const axios = require('axios');
const { API_BASE, oauthAccessToken, provisionConfig } = require('./tailscale-provision');

const DAY = 86400000;
const SERVER_OS = new Set(['linux', 'freebsd', 'openbsd']);

function auditConfigured(config = provisionConfig()) {
  return !!(config.enabled && config.clientId && config.clientSecret);
}

async function listDevices(config = provisionConfig(), { http = axios } = {}) {
  const token = await oauthAccessToken(config, http, { scope: 'devices:core:read', tags: '' });
  const tailnet = encodeURIComponent(config.tailnet || '-');
  const res = await http.get(`${API_BASE}/tailnet/${tailnet}/devices`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 15000,
  });
  const devices = res?.data?.devices;
  if (!Array.isArray(devices)) throw new Error('Tailscale device list had an unexpected shape');
  return devices;
}

const shortName = d => String(d.name || d.hostname || d.id || 'device').split('.')[0];

// When the node key expires, in ms, or null when it doesn't (expiry disabled, the zero date, or
// a value that can't be read).
function keyExpiryMs(device) {
  if (device.keyExpiryDisabled === true) return null;
  const t = Date.parse(device.expires || '');
  if (!Number.isFinite(t) || new Date(t).getUTCFullYear() < 2000) return null;
  return t;
}

function isHeadless(device, { names = [], viewerTag = 'tag:ph-viewer' } = {}) {
  const list = names.map(n => n.toLowerCase());
  if (list.length) return list.includes(shortName(device).toLowerCase()) || list.includes(String(device.hostname || '').toLowerCase());
  const tags = Array.isArray(device.tags) ? device.tags : [];
  return SERVER_OS.has(String(device.os || '').toLowerCase()) && !tags.includes(viewerTag);
}

// One row per headless device: { name, os, expiresAt, daysLeft, status } with status 'expired',
// 'expiring' (inside the window), 'ok', or 'never' (key expiry off). Sorted soonest first.
function auditDevices(devices, { now = Date.now(), windowDays = 30, names = [], viewerTag } = {}) {
  return devices
    .filter(d => isHeadless(d, { names, viewerTag }))
    .map(d => {
      const expiresAt = keyExpiryMs(d);
      const daysLeft = expiresAt == null ? null : Math.floor((expiresAt - now) / DAY);
      const status = expiresAt == null ? 'never' : expiresAt <= now ? 'expired' : expiresAt - now <= windowDays * DAY ? 'expiring' : 'ok';
      return { id: String(d.id || d.nodeId || shortName(d)), name: shortName(d), os: d.os || 'unknown', expiresAt, daysLeft, status };
    })
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || a.name.localeCompare(b.name));
}

// Which warning a row is in: 30 / 7 / 1 days out, or expired. The scheduled check posts once per
// stage per key, so a node gets at most four notes before its key runs out, not one a day.
function warningStage(row) {
  if (row.status === 'expired') return 'expired';
  if (row.status !== 'expiring') return null;
  if (row.daysLeft <= 1) return '1d';
  if (row.daysLeft <= 7) return '7d';
  return '30d';
}

// Pure: the rows that reached a new stage since the last check, and the state to store.
// state: { [deviceId]: { expiresAt, stage } }. A renewed key (new expiresAt) starts over.
function newWarnings(rows, state = {}) {
  const next = {};
  const fresh = [];
  for (const row of rows) {
    const stage = warningStage(row);
    if (!stage) continue;
    const prev = state[row.id];
    next[row.id] = { expiresAt: row.expiresAt, stage };
    if (!prev || prev.expiresAt !== row.expiresAt || prev.stage !== stage) fresh.push({ ...row, stage });
  }
  return { fresh, state: next };
}

module.exports = { auditConfigured, listDevices, keyExpiryMs, isHeadless, auditDevices, warningStage, newWarnings };
