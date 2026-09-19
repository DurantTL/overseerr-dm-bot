#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');

function freshModule(env) {
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../../src/config')];
  delete require.cache[require.resolve('../../src/public-origin-diagnostics')];
  return require('../../src/public-origin-diagnostics');
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function selfSignedCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-doctor-cert-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=127.0.0.1',
  ], { stdio: 'pipe' });
  const cert = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  fs.rmSync(dir, { recursive: true, force: true });
  return cert;
}

const BASE_ENV = {
  DASHBOARD_ENABLED: 'true', DASHBOARD_ADMIN_PASSWORD: 'p4ssword', SESSION_SECRET: 'a'.repeat(32),
  DISCORD_BOT_TOKEN: 't', DISCORD_CLIENT_ID: 'c', DISCORD_GUILD_ID: 'g',
  ADMIN_CHANNEL_ID: 'a', ADMIN_USER_ID: 'u', OVERSEERR_URL: 'http://seerr:5055', OVERSEERR_API_KEY: 'k',
  PLEX_TOKEN: 'p', RAID_PATH: '/mnt/raid', WEBHOOK_SECRET: 's', TAUTULLI_WEBHOOK_SECRET: 's',
};

test('public-origin-diagnostics: local liveness reflects the real process, not the public origin', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  const port = await listen(server);
  try {
    const { checkPublicOriginReadiness } = freshModule({ ...BASE_ENV, TUNNEL_DOMAIN: '', PORT: String(port) });
    const checks = await checkPublicOriginReadiness();
    const local = checks.find(c => c.name === 'Local process liveness');
    assert.strictEqual(local.status, 'ok');
    assert.match(local.detail, new RegExp(`127\\.0\\.0\\.1:${port}/live`));
  } finally {
    await close(server);
  }
});

test('public-origin-diagnostics: local liveness fails when nothing is listening', async () => {
  const { checkPublicOriginReadiness } = freshModule({ ...BASE_ENV, TUNNEL_DOMAIN: '', PORT: '1' });
  const checks = await checkPublicOriginReadiness({ timeoutMs: 1000 });
  const local = checks.find(c => c.name === 'Local process liveness');
  assert.strictEqual(local.status, 'fail');
});

test('public-origin-diagnostics: no configured public origin is reported, not silently skipped', async () => {
  const { checkPublicOriginReadiness } = freshModule({ ...BASE_ENV, TUNNEL_DOMAIN: '', PORT: '1' });
  const checks = await checkPublicOriginReadiness({ timeoutMs: 1000 });
  const origin = checks.find(c => c.name === 'Public HTTPS origin');
  assert.strictEqual(origin.status, 'fail');
  assert.match(origin.detail, /not configured/);
});

test('public-origin-diagnostics: an unreachable public origin fails distinctly from "not configured"', async () => {
  const { checkPublicOriginReadiness } = freshModule({ ...BASE_ENV, TUNNEL_DOMAIN: '127.0.0.1', PORT: '1' });
  const checks = await checkPublicOriginReadiness({ timeoutMs: 1000, publicPort: 1 });
  const origin = checks.find(c => c.name === 'Public HTTPS origin');
  assert.strictEqual(origin.status, 'fail');
  assert.doesNotMatch(origin.detail, /not configured/);
  assert.ok(!checks.some(c => c.name === 'Public TLS certificate'), 'no cert check when the connection itself never completed');
});

test('public-origin-diagnostics: an untrusted certificate is reported as its own distinct failure', async () => {
  const { key, cert } = selfSignedCert();
  const server = https.createServer({ key, cert }, (req, res) => { res.writeHead(200); res.end('ok'); });
  const port = await listen(server);
  try {
    const { checkPublicOriginReadiness } = freshModule({ ...BASE_ENV, TUNNEL_DOMAIN: '127.0.0.1', PORT: '1' });
    const checks = await checkPublicOriginReadiness({ timeoutMs: 2000, publicPort: port });
    const origin = checks.find(c => c.name === 'Public HTTPS origin');
    const tls = checks.find(c => c.name === 'Public TLS certificate');
    assert.strictEqual(origin.status, 'ok', 'the HTTP round trip itself succeeded');
    assert.strictEqual(tls.status, 'fail');
    assert.match(tls.detail, /self.signed|unable to verify/i);
  } finally {
    await close(server);
  }
});

test('public-origin-diagnostics: proxy trust is only checked when a public origin is configured', async () => {
  let mod = freshModule({ ...BASE_ENV, TUNNEL_DOMAIN: '', PORT: '1', TRUST_PROXY: 'false' });
  let checks = await mod.checkPublicOriginReadiness({ timeoutMs: 500 });
  assert.strictEqual(checks.find(c => c.name === 'Proxy trust configuration').status, 'ok', 'not applicable with no public origin');

  mod = freshModule({ ...BASE_ENV, TUNNEL_DOMAIN: 'files.example.test', PORT: '1', TRUST_PROXY: 'false' });
  checks = await mod.checkPublicOriginReadiness({ timeoutMs: 500, publicPort: 1 });
  assert.strictEqual(checks.find(c => c.name === 'Proxy trust configuration').status, 'warn', 'a public origin without TRUST_PROXY misreads client IPs and req.secure');

  mod = freshModule({ ...BASE_ENV, TUNNEL_DOMAIN: 'files.example.test', PORT: '1', TRUST_PROXY: 'true' });
  checks = await mod.checkPublicOriginReadiness({ timeoutMs: 500, publicPort: 1 });
  assert.strictEqual(checks.find(c => c.name === 'Proxy trust configuration').status, 'ok');
});

// --- Forwarded-proto behavior: live probe against the real cookie logic ---

function authFixture({ trustProxy = false, passkeys = [] } = {}) {
  const { createApp, listen: listenApp, close: closeApp } = require('../../src/app');
  const { createDashboardSession, registerDashboardAuthRoutes } = require('../../src/routes/dashboard-auth');
  const config = { DASHBOARD_ADMIN_PASSWORD: 'p', DASHBOARD_ADMIN_TOKEN: '', STRICT_DASHBOARD_POST_AUTH: false };
  const session = createDashboardSession({ secret: 's'.repeat(32), ttlHours: 1 });
  const app = createApp({ trustProxy });
  registerDashboardAuthRoutes(app, {
    config,
    session,
    dashboardAuth: (_req, _res, next) => next(),
    httpRateLimitKey: () => 'forwarded-proto-probe-test',
    renderLogin: () => 'login',
    listPasskeys: () => passkeys,
    passkeyService: { authenticationOptions: async () => ({ challenge: 'c' }) },
    safeEqual: (a, b) => a === b,
    audit: () => {},
    renamePasskey: () => false,
    revokePasskey: () => false,
    passkeyClientPath: 'unused-for-this-probe',
    webauthnBrowserPath: 'unused-for-this-probe',
  });
  return { app, listenApp, closeApp };
}

test('public-origin-diagnostics: forwarded-proto behavior is ok when the header earns `; Secure`', async () => {
  // trustProxy:false proves the raw X-Forwarded-Proto fallback in the cookie logic — the exact
  // production path when the proxy forwards the header but TRUST_PROXY was never set.
  const { app, listenApp, closeApp } = authFixture({ trustProxy: false, passkeys: [{ credential_id: 'one' }] });
  const server = await listenApp(app, 0);
  try {
    const port = server.address().port;
    const { probeForwardedProtoBehavior } = freshModule({ ...BASE_ENV, TUNNEL_DOMAIN: '', PORT: String(port) });
    const result = await probeForwardedProtoBehavior({ timeoutMs: 2000, port });
    assert.strictEqual(result.status, 'ok');
    assert.match(result.detail, /honored end-to-end/);
  } finally {
    await closeApp(server);
  }
});

test('public-origin-diagnostics: forwarded-proto probe fails when the app ignores the header', async () => {
  const server = http.createServer((_req, res) => {
    // An app that drops X-Forwarded-Proto: sets the challenge cookie without `; Secure`.
    res.writeHead(200, { 'set-cookie': 'dm_webauthn=binding; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=300' });
    res.end('{}');
  });
  const port = await listen(server);
  try {
    const { probeForwardedProtoBehavior } = freshModule({ ...BASE_ENV, TUNNEL_DOMAIN: '', PORT: String(port) });
    const result = await probeForwardedProtoBehavior({ timeoutMs: 2000, port });
    assert.strictEqual(result.status, 'fail');
    assert.match(result.detail, /did NOT mark/);
  } finally {
    await close(server);
  }
});

test('public-origin-diagnostics: forwarded-proto probe is inconclusive (not failed) with no passkeys enrolled', async () => {
  const { app, listenApp, closeApp } = authFixture({ trustProxy: false, passkeys: [] });
  const server = await listenApp(app, 0);
  try {
    const port = server.address().port;
    const { probeForwardedProtoBehavior } = freshModule({ ...BASE_ENV, TUNNEL_DOMAIN: '', PORT: String(port) });
    const result = await probeForwardedProtoBehavior({ timeoutMs: 2000, port });
    assert.strictEqual(result.status, 'warn');
    assert.match(result.detail, /no passkeys enrolled/);
  } finally {
    await closeApp(server);
  }
});

test('public-origin-diagnostics: forwarded-proto probe warns (not fails) when nothing listens', async () => {
  const { probeForwardedProtoBehavior } = freshModule({ ...BASE_ENV, TUNNEL_DOMAIN: '', PORT: '1' });
  const result = await probeForwardedProtoBehavior({ timeoutMs: 1000, port: 1 });
  assert.strictEqual(result.status, 'warn');
});

// --- Listener-exposure guard ---

const fakeExternalIface = address => () => ({ eth0: [{ family: 'IPv4', internal: false, address }] });

test('public-origin-diagnostics: listener exposure warns when the port is reachable off-loopback with no public origin', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  try {
    const port = server.address().port;
    const { checkListenerExposure } = freshModule({ ...BASE_ENV, TUNNEL_DOMAIN: '', PORT: String(port) });
    const result = await checkListenerExposure({
      port,
      config: { DASHBOARD_PUBLIC_URL: '', TUNNEL_DOMAIN: '' },
      networkInterfaces: fakeExternalIface('127.0.0.1'),
    });
    assert.strictEqual(result.status, 'warn');
    assert.match(result.detail, /plain HTTP/);
  } finally {
    await close(server);
  }
});

test('public-origin-diagnostics: listener exposure is ok when there is no off-loopback interface to probe', async () => {
  const { checkListenerExposure } = freshModule({ ...BASE_ENV, TUNNEL_DOMAIN: '', PORT: '1' });
  const result = await checkListenerExposure({
    port: 1,
    config: { DASHBOARD_PUBLIC_URL: '', TUNNEL_DOMAIN: '' },
    networkInterfaces: () => ({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] }),
  });
  assert.strictEqual(result.status, 'ok');
  assert.match(result.detail, /no non-loopback IPv4 interface/);
});

test('public-origin-diagnostics: listener exposure is not applicable with a public origin configured', async () => {
  const { checkListenerExposure } = freshModule({ ...BASE_ENV, TUNNEL_DOMAIN: 'x.example', PORT: '1' });
  const result = await checkListenerExposure({
    port: 1,
    config: { DASHBOARD_PUBLIC_URL: 'https://x.example', TUNNEL_DOMAIN: 'x.example' },
  });
  assert.strictEqual(result.status, 'ok');
  assert.match(result.detail, /behind the tunnel\/proxy/);
});

test('public-origin-diagnostics: readiness includes the forwarded-proto and exposure checks', async () => {
  const { app, listenApp, closeApp } = authFixture({ trustProxy: false, passkeys: [{ credential_id: 'one' }] });
  const server = await listenApp(app, 0);
  try {
    const port = server.address().port;
    const { checkPublicOriginReadiness } = freshModule({ ...BASE_ENV, TUNNEL_DOMAIN: '', PORT: String(port) });
    const checks = await checkPublicOriginReadiness({ timeoutMs: 2000 });
    const names = checks.map(c => c.name);
    assert.ok(names.includes('Forwarded-proto behavior'), `got: ${names.join(', ')}`);
    assert.ok(names.includes('Listener exposure'), `got: ${names.join(', ')}`);
    assert.strictEqual(checks.find(c => c.name === 'Forwarded-proto behavior').status, 'ok');
  } finally {
    await closeApp(server);
  }
});
