'use strict';

// Read-only diagnostics distinguishing "the Node process is alive" from "the public HTTPS
// dashboard/passkey origin actually works" (#191). Nothing here mutates state or credentials; it
// is safe to run from /doctor or the dashboard at any time.
const http = require('http');
const https = require('https');
const { CONFIG } = require('./config');

function check(name, status, detail) { return { name, status, detail }; }

function getJson(client, options, timeoutMs) {
  return new Promise(resolve => {
    const req = client.request(options, res => {
      // Capture the socket now: it can be detached/pooled by the time 'end' fires, and TLS
      // metadata (authorized/getPeerCertificate) lives on the socket, not the response object.
      const socket = res.socket;
      res.on('data', () => {}); // drain the body; only status/socket metadata is needed
      res.on('end', () => resolve({ ok: true, statusCode: res.statusCode, socket }));
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on('error', err => resolve({ ok: false, error: err.message }));
    req.setTimeout(timeoutMs);
    req.end();
  });
}

async function probeLocalLiveness(port, timeoutMs) {
  const result = await getJson(http, { hostname: '127.0.0.1', port, path: '/live', method: 'GET' }, timeoutMs);
  if (!result.ok) return check('Local process liveness', 'fail', `http://127.0.0.1:${port}/live: ${result.error}`);
  return check('Local process liveness', result.statusCode === 200 ? 'ok' : 'warn',
    `http://127.0.0.1:${port}/live answered HTTP ${result.statusCode} — this only proves the process is up, not that it is reachable publicly over HTTPS`);
}

async function probePublicOrigin(originUrl, timeoutMs, port) {
  let target;
  try { target = new URL(originUrl); } catch (err) {
    return [check('Public HTTPS origin', 'fail', `DASHBOARD_PUBLIC_URL/TUNNEL_DOMAIN is not a valid URL: ${err.message}`)];
  }
  // rejectUnauthorized:false so an untrusted/expired certificate surfaces as a distinguishable
  // "Public TLS certificate: fail" check below instead of an opaque connection error indistinct
  // from the tunnel/proxy simply being down.
  const result = await getJson(https, { hostname: target.hostname, port, path: '/live', method: 'GET', rejectUnauthorized: false }, timeoutMs);
  if (!result.ok) {
    // A connection/handshake failure here is exactly the failure mode this issue exists to catch:
    // port 3000 is plain HTTP, and hitting the bare host over HTTPS with no working tunnel/proxy
    // in front of it fails the same way as a genuinely absent public origin.
    return [check('Public HTTPS origin', 'fail', `https://${target.hostname}/live: ${result.error} — verify the tunnel/reverse-proxy public hostname is active and points at this container's port ${CONFIG.PORT}`)];
  }
  const checks = [];
  checks.push(check('Public HTTPS origin', result.statusCode === 200 ? 'ok' : 'warn', `https://${target.hostname}/live answered HTTP ${result.statusCode}`));
  const socket = result.socket;
  const authorized = socket && typeof socket.authorized === 'boolean' ? socket.authorized : null;
  const cert = socket && socket.getPeerCertificate ? socket.getPeerCertificate() : null;
  if (authorized === false) {
    checks.push(check('Public TLS certificate', 'fail', socket.authorizationError || 'certificate is not trusted by this process'));
  } else if (cert && cert.valid_to) {
    const daysLeft = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400000);
    checks.push(check('Public TLS certificate', daysLeft > 7 ? 'ok' : 'warn', `valid for ${cert.subject?.CN || target.hostname}, expires ${cert.valid_to} (${daysLeft}d)`));
  } else {
    checks.push(check('Public TLS certificate', 'warn', 'certificate presented but no expiry could be read'));
  }
  return checks;
}

// TRUST_PROXY governs whether Express derives req.ip/req.secure from X-Forwarded-For/-Proto sent
// by the tunnel/reverse-proxy in front of this container. Left off behind a real proxy, every
// request appears to come from the proxy's own address (breaking per-IP rate limiting) and
// req.secure reads false even over a publicly-HTTPS request. This is a config check, not a network
// probe — it never has to guess what a header would say wearing whatever hat this request wore.
function checkProxyTrust() {
  const behindAProxy = !!(CONFIG.DASHBOARD_PUBLIC_URL || CONFIG.TUNNEL_DOMAIN);
  if (!behindAProxy) return check('Proxy trust configuration', 'ok', 'no public origin configured; TRUST_PROXY is not applicable');
  return check('Proxy trust configuration', CONFIG.TRUST_PROXY ? 'ok' : 'warn',
    CONFIG.TRUST_PROXY
      ? 'TRUST_PROXY=true — X-Forwarded-For/-Proto from the tunnel/reverse-proxy are honored'
      : 'TRUST_PROXY is not set while a public origin is configured — per-IP rate limiting will see only the proxy\'s address, and req.secure will read false over HTTPS');
}

// publicPort exists only so tests can point the public-origin probe at a local HTTPS test server
// on an ephemeral port; DASHBOARD_PUBLIC_URL itself is validated to never carry a port (passkeyRp
// in src/passkeys.js), and production always means the real public 443.
async function checkPublicOriginReadiness({ timeoutMs = 8000, publicPort = 443 } = {}) {
  const checks = [checkProxyTrust()];
  checks.push(await probeLocalLiveness(CONFIG.PORT, timeoutMs));
  if (!CONFIG.DASHBOARD_PUBLIC_URL) {
    checks.push(check('Public HTTPS origin', 'fail', 'DASHBOARD_PUBLIC_URL/TUNNEL_DOMAIN is not configured — the dashboard has no known public HTTPS origin to verify'));
    return checks;
  }
  checks.push(...await probePublicOrigin(CONFIG.DASHBOARD_PUBLIC_URL, timeoutMs, publicPort));
  return checks;
}

module.exports = { checkPublicOriginReadiness };
