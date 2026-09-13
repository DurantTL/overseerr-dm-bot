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
