#!/usr/bin/env node
'use strict';

// Deployment smoke test for the dashboard's public HTTPS origin (#191).
//
// Verifies, from outside the container: internal liveness, the public HTTPS round trip,
// certificate validity, forwarded-proto handling (Secure session cookies through the public
// origin), and passkey preconditions. Standalone by design — it reads only DASHBOARD_PUBLIC_URL,
// PORT, and SMOKE_* env vars and uses node builtins, so it runs on any machine that can reach
// the deployment without the bot's full environment.
//
//   DASHBOARD_PUBLIC_URL=https://dashboard.example.com npm run smoke
//   SMOKE_ADMIN_PASSWORD=<your-admin-password> npm run smoke
//
// Exit 0 when every check passes (or is skipped); exit 1 on any failure. Warnings print but do
// not fail the run. Set SMOKE_TIMEOUT_MS to override the default 8000ms per-probe timeout.

const http = require('http');
const https = require('https');
const { URL } = require('url');

const ORIGIN = process.env.DASHBOARD_PUBLIC_URL || '';
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const TIMEOUT_MS = Number.parseInt(process.env.SMOKE_TIMEOUT_MS || '8000', 10);
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD || '';
const UA = 'overseerr-dm-bot-smoke/1.0';

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
  const icon = status === 'ok' ? '✅' : status === 'warn' ? '⚠️' : status === 'skip' ? '⏭️' : '❌';
  console.log(`${icon} ${name} — ${detail}`);
}

function request(client, options, body) {
  return new Promise(resolve => {
    const req = client.request({ ...options, headers: { 'User-Agent': UA, ...(options.headers || {}) } }, res => {
      const socket = res.socket;
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        ok: true,
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        socket,
      }));
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${TIMEOUT_MS}ms`)));
    req.on('error', err => resolve({ ok: false, error: err.message }));
    req.setTimeout(TIMEOUT_MS);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function setCookies(headers) {
  const raw = headers['set-cookie'] || [];
  return Array.isArray(raw) ? raw : [raw];
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: DASHBOARD_PUBLIC_URL=https://dashboard.example.com [SMOKE_ADMIN_PASSWORD=...] npm run smoke');
    return 0;
  }
  if (!ORIGIN) {
    console.log('⏭️ SKIP: DASHBOARD_PUBLIC_URL is not set — there is no public origin to verify.');
    console.log('   This is expected for localhost-only deployments. Set DASHBOARD_PUBLIC_URL to run the public checks.');
    return 0;
  }
  let target;
  try { target = new URL(ORIGIN); } catch (err) {
    record('Public origin URL', 'fail', `DASHBOARD_PUBLIC_URL is not a valid URL: ${err.message}`);
    return 1;
  }

  // 1. Internal liveness — the process answers on its own port.
  const live = await request(http, { hostname: '127.0.0.1', port: PORT, path: '/live', method: 'GET' });
  if (!live.ok) {
    record('Internal liveness', 'fail', `http://127.0.0.1:${PORT}/live unreachable: ${live.error}`);
    return 1;
  }
  let liveJson = null;
  try { liveJson = JSON.parse(live.body); } catch (_err) { /* non-JSON body is fine, status is the signal */ }
  record('Internal liveness', live.statusCode === 200 ? 'ok' : 'fail',
    `http://127.0.0.1:${PORT}/live answered HTTP ${live.statusCode}${liveJson && liveJson.overall ? ` (overall: ${liveJson.overall})` : ''}`);

  // 2. Public HTTPS round trip.
  const publicPort = Number(target.port || 443);
  const pub = await request(https, {
    hostname: target.hostname, port: publicPort, path: '/live', method: 'GET', rejectUnauthorized: false,
  });
  if (!pub.ok) {
    record('Public HTTPS origin', 'fail', `https://${target.hostname}/live: ${pub.error} — is the tunnel/reverse-proxy running and routed to this container's port ${PORT}?`);
    return 1;
  }
  record('Public HTTPS origin', pub.statusCode === 200 ? 'ok' : 'warn', `https://${target.hostname}/live answered HTTP ${pub.statusCode}`);

  // 3. Certificate validity.
  const socket = pub.socket;
  const authorized = socket && typeof socket.authorized === 'boolean' ? socket.authorized : null;
  const cert = socket && socket.getPeerCertificate ? socket.getPeerCertificate() : null;
  if (authorized === false) {
    record('Public TLS certificate', 'fail', socket.authorizationError || 'certificate is not trusted');
  } else if (cert && cert.valid_to) {
    const daysLeft = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400000);
    record('Public TLS certificate', daysLeft > 7 ? 'ok' : 'warn',
      `valid for ${cert.subject?.CN || target.hostname}, expires ${cert.valid_to} (${daysLeft}d)`);
  } else {
    record('Public TLS certificate', 'warn', 'certificate presented but no expiry could be read');
  }

  // 4. Forwarded-proto handling, proven end-to-end: log in through the public origin and confirm
  // the session cookie carries `; Secure`, which only happens when the app sees the request as
  // secure (X-Forwarded-Proto honored through the proxy).
  if (!ADMIN_PASSWORD) {
    record('Secure session cookie', 'skip', 'SMOKE_ADMIN_PASSWORD not set — skipping the authenticated login probe (one login attempt is rate-limited; run again with the password to verify)');
  } else {
    const payload = `password=${encodeURIComponent(ADMIN_PASSWORD)}`;
    const login = await request(https, {
      // rejectUnauthorized:false mirrors the public-origin probe above: certificate trust is
      // reported by its own check; the login probe is about cookie behavior, not trust.
      hostname: target.hostname, port: publicPort, path: '/admin/login', method: 'POST', rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) },
    }, payload);
    if (!login.ok) {
      record('Secure session cookie', 'fail', `login request failed: ${login.error}`);
    } else if (login.statusCode === 302 && String(login.headers.location || '').includes('error=1')) {
      record('Secure session cookie', 'fail', 'the public origin rejected SMOKE_ADMIN_PASSWORD — check the password and try again (5 attempts per 15 minutes)');
    } else {
      const sessionCookie = setCookies(login.headers).find(c => c.startsWith('dm_session='));
      if (!sessionCookie) {
        record('Secure session cookie', 'fail', `login through the public origin (HTTP ${login.statusCode}) set no dm_session cookie`);
      } else if (sessionCookie.includes('; Secure')) {
        record('Secure session cookie', 'ok', 'login through the public origin set dm_session with `; Secure` — forwarded-proto is honored end-to-end');
      } else {
        record('Secure session cookie', 'fail', 'login through the public origin set dm_session WITHOUT `; Secure` — the proxy is likely dropping X-Forwarded-Proto');
      }
    }
  }

  // 5. Passkey preconditions: enrollment requires a secure context and an expected origin the
  // server validates (https-only, no port/path/IP — see src/passkeys.js).
  const isIp = /^[0-9.]+$/.test(target.hostname) || target.hostname.includes(':');
  if (target.protocol !== 'https:') {
    record('Passkey preconditions', 'fail', `public origin is ${target.protocol}// — passkeys require an https:// origin`);
  } else if (isIp) {
    record('Passkey preconditions', 'fail', 'public origin is an IP literal — passkey origin validation requires a real hostname');
  } else if (target.port) {
    record('Passkey preconditions', 'fail', `public origin carries an explicit port (${target.port}) — passkey origin validation rejects ports`);
  } else {
    record('Passkey preconditions', 'ok', 'https origin with a real hostname and no port — satisfies the server-side passkey origin checks (the browser also needs a secure context, which https:// provides)');
  }

  const failures = results.filter(r => r.status === 'fail').length;
  const warnings = results.filter(r => r.status === 'warn').length;
  console.log(`\n${failures ? '❌' : warnings ? '⚠️' : '✅'} Smoke ${failures ? `FAILED (${failures} failing)` : warnings ? `passed with ${warnings} warning(s)` : 'passed'} — ${results.length} checks.`);
  return failures ? 1 : 0;
}

main().then(code => { process.exitCode = code; }).catch(err => {
  console.error(`❌ Smoke script crashed: ${err.message}`);
  process.exitCode = 1;
});
