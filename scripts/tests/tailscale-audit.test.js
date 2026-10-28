#!/usr/bin/env node
// Tailscale key-expiry audit (src/tailscale-audit.js): read-only token scope, which devices count
// as headless, expiry status, and posting once per warning stage per key.
const { test } = require('node:test');
const assert = require('node:assert');

const T = require('../../src/tailscale-audit');
const { createViewerAuthKey } = require('../../src/tailscale-provision');

const NOW = Date.parse('2026-10-28T12:00:00Z');
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const CONFIG = { enabled: true, clientId: 'cid', clientSecret: 'SECRET-CLIENT', tailnet: '-', viewerTag: 'tag:ph-viewer', expirySeconds: 1800 };

function fakeHttp(devices) {
  const calls = [];
  return {
    calls,
    post: async (url, body, opts) => { calls.push({ method: 'POST', url, body: String(body), opts }); return { data: { access_token: 'tok', key: 'tskey-auth-x', id: 'k1' } }; },
    get: async (url, opts) => { calls.push({ method: 'GET', url, opts }); return { data: { devices } }; },
  };
}

test('tailscale audit: device list uses a read-only devices:core:read token with no tags', async () => {
  const http = fakeHttp([{ id: '1', name: 'ph.tail1234.ts.net', os: 'linux' }]);
  const devices = await T.listDevices(CONFIG, { http });
  assert.strictEqual(devices.length, 1);
  const form = new URLSearchParams(http.calls[0].body);
  assert.strictEqual(form.get('scope'), 'devices:core:read');
  assert.strictEqual(form.get('tags'), null);
  assert.strictEqual(http.calls[1].url, 'https://api.tailscale.com/api/v2/tailnet/-/devices');
  assert.strictEqual(http.calls[1].opts.headers.Authorization, 'Bearer tok');
  await assert.rejects(T.listDevices(CONFIG, { http: { post: http.post, get: async () => ({ data: {} }) } }), /unexpected shape/);
});

test('tailscale audit: viewer key minting still asks for auth_keys with the viewer tag', async () => {
  const http = fakeHttp([]);
  await createViewerAuthKey({ discordId: '1', device: 'tv', config: CONFIG, http });
  const form = new URLSearchParams(http.calls[0].body);
  assert.deepStrictEqual([form.get('scope'), form.get('tags')], ['auth_keys', 'tag:ph-viewer']);
});

test('tailscale audit: key expiry off, the zero date or junk all read as "never"', () => {
  assert.strictEqual(T.keyExpiryMs({ keyExpiryDisabled: true, expires: iso(NOW) }), null);
  assert.strictEqual(T.keyExpiryMs({ expires: '0001-01-01T00:00:00Z' }), null);
  assert.strictEqual(T.keyExpiryMs({ expires: 'soon' }), null);
  assert.strictEqual(T.keyExpiryMs({ expires: iso(NOW + DAY) }), NOW + DAY);
});

test('tailscale audit: headless means Linux/FreeBSD that is not a PH viewer, or the named list', () => {
  const server = { name: 'southcentral.tail.ts.net', os: 'linux' };
  const viewer = { name: 'shield', os: 'linux', tags: ['tag:ph-viewer'] };
  const phone = { name: 'pixel', os: 'android' };
  assert.deepStrictEqual([server, viewer, phone].map(d => T.isHeadless(d)), [true, false, false]);
  assert.deepStrictEqual([server, viewer, phone].map(d => T.isHeadless(d, { names: ['Pixel'] })), [false, false, true]);
});

test('tailscale audit: statuses and order, soonest first', () => {
  const rows = T.auditDevices([
    { id: 'a', name: 'ph', os: 'linux', expires: iso(NOW + 12 * DAY) },
    { id: 'b', name: 'california', os: 'linux', expires: iso(NOW - DAY) },
    { id: 'c', name: 'nas', os: 'linux', expires: iso(NOW + 90 * DAY) },
    { id: 'd', name: 'tagged', os: 'linux', tags: ['tag:server'], keyExpiryDisabled: true },
    { id: 'e', name: 'laptop', os: 'macOS', expires: iso(NOW + DAY) },
  ], { now: NOW, windowDays: 30 });
  assert.deepStrictEqual(rows.map(r => [r.name, r.status, r.daysLeft]), [['california', 'expired', -1], ['ph', 'expiring', 12], ['nas', 'ok', 90], ['tagged', 'never', null]]);
});

test('tailscale audit: one note per stage per key; a renewed key starts over', () => {
  const at = days => T.auditDevices([{ id: 'a', name: 'ph', os: 'linux', expires: iso(NOW + 20 * DAY) }], { now: NOW + (20 - days) * DAY });
  let state = {};
  const step = rows => { const r = T.newWarnings(rows, state); state = r.state; return r.fresh.map(f => f.stage); };
  assert.deepStrictEqual(step(at(35)), [], 'outside the window');
  assert.deepStrictEqual(step(at(25)), ['30d']);
  assert.deepStrictEqual(step(at(15)), [], 'same stage stays quiet');
  assert.deepStrictEqual(step(at(6)), ['7d']);
  assert.deepStrictEqual(step(at(1)), ['1d']);
  assert.deepStrictEqual(step(at(-1)), ['expired']);
  assert.deepStrictEqual(step(at(-2)), []);
  const renewed = T.auditDevices([{ id: 'a', name: 'ph', os: 'linux', expires: iso(NOW + 25 * DAY) }], { now: NOW });
  assert.deepStrictEqual(step(renewed), ['30d'], 'a new expiry date is a new key');
});
