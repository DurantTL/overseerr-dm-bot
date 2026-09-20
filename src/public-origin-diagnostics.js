'use strict';

// Read-only diagnostics distinguishing "the Node process is alive" from "the public HTTPS
// dashboard/passkey origin actually works" (#191). Nothing here mutates state or credentials; it
// is safe to run from /doctor or the dashboard at any time.
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');

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

// Like getJson but also returns response headers and the (small) body — the forwarded-proto
// probe reads its signal off Set-Cookie and the 404 body, so it needs both.
function getWithHeaders(options, timeoutMs) {
  return new Promise(resolve => {
    const req = http.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        ok: true,
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
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

async function probePublicOrigin(originUrl, timeoutMs, port, config) {
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
    return [check('Public HTTPS origin', 'fail', `https://${target.hostname}/live: ${result.error} — verify the tunnel/reverse-proxy public hostname is active and points at this container's port ${config.PORT}`)];
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
function checkProxyTrust(config) {
  const behindAProxy = !!(config.DASHBOARD_PUBLIC_URL || config.TUNNEL_DOMAIN);
  if (!behindAProxy) return check('Proxy trust configuration', 'ok', 'no public origin configured; TRUST_PROXY is not applicable');
  return check('Proxy trust configuration', config.TRUST_PROXY ? 'ok' : 'warn',
    config.TRUST_PROXY
      ? 'TRUST_PROXY=true — X-Forwarded-For/-Proto from the tunnel/reverse-proxy are honored'
      : 'TRUST_PROXY is not set while a public origin is configured — per-IP rate limiting will see only the proxy\'s address, and req.secure will read false over HTTPS');
}

// Forwarded-proto behavior (#191 criterion 6): the Secure cookie flag is driven by the
// COOKIE_SECURE config (derived from DASHBOARD_PUBLIC_URL scheme), not by the
// client-controlled X-Forwarded-Proto header (L2). This probes the live local listener and
// verifies the passkey challenge cookie (dm_webauthn) carries `; Secure` exactly when the
// config says it should. Credential-free and read-only: authentication-options only mints a
// client-held challenge binding; it never authenticates anyone and writes no server state.
async function probeForwardedProtoBehavior({ timeoutMs = 8000, port, expectSecure = null } = {}) {
  async function challenge(headers) {
    const result = await getWithHeaders({
      hostname: '127.0.0.1', port, path: '/admin/passkey/authentication-options', method: 'GET', headers,
    }, timeoutMs);
    if (!result.ok) return { error: result.error };
    const raw = result.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    const binding = cookies.find(c => c.startsWith('dm_webauthn='));
    return {
      statusCode: result.statusCode,
      body: result.body,
      cookiePresent: !!binding,
      secure: !!binding && binding.includes('; Secure'),
    };
  }

  const withHeader = await challenge({ 'X-Forwarded-Proto': 'https' });
  if (withHeader.error) {
    return check('Forwarded-proto behavior', 'warn', `could not reach the local listener for the forwarded-proto probe: ${withHeader.error} — see 'Local process liveness'`);
  }
  if (withHeader.statusCode === 404 && withHeader.body.includes('No passkeys are enrolled')) {
    return check('Forwarded-proto behavior', 'warn', 'no passkeys enrolled, so the challenge-cookie signal is unavailable — forwarded-proto handling is unverified; enroll a passkey or run `npm run smoke` for a definitive check');
  }
  if (withHeader.statusCode === 404) {
    return check('Forwarded-proto behavior', 'warn', 'GET /admin/passkey/authentication-options answered 404 — the dashboard routes may be disabled; forwarded-proto handling is unverified');
  }
  if (withHeader.statusCode !== 200 || !withHeader.cookiePresent) {
    return check('Forwarded-proto behavior', 'warn', `challenge endpoint answered HTTP ${withHeader.statusCode} without setting dm_webauthn — forwarded-proto handling is unverified`);
  }
  // L2: Secure flag comes from COOKIE_SECURE config, not the header. If expectSecure is known,
  // verify the cookie matches; otherwise report what we see.
  if (expectSecure !== null) {
    if (withHeader.secure === expectSecure) {
      return check('Forwarded-proto behavior', 'ok', `challenge cookie Secure flag matches COOKIE_SECURE=${expectSecure} (config-driven, not header-driven)`);
    }
    return check('Forwarded-proto behavior', 'fail', `challenge cookie Secure=${withHeader.secure} but COOKIE_SECURE=${expectSecure} — config mismatch; session cookies will be wrong through the public origin`);
  }
  return check('Forwarded-proto behavior', withHeader.secure ? 'ok' : 'warn',
    withHeader.secure
      ? 'challenge cookie carries `; Secure` (COOKIE_SECURE is on — correct for HTTPS public origin)'
      : 'challenge cookie lacks `; Secure` (COOKIE_SECURE is off — correct only for plain-HTTP local use)');
}

// Listener-exposure guard (#191 criterion 3, fail-closed spirit): the dashboard port is plain
// HTTP. If the process is reachable on a non-loopback interface while no public HTTPS origin is
// configured, anyone able to reach that port gets the dashboard unencrypted. This TCP-connects
// to the dashboard port on each non-internal IPv4 interface. From inside the container it cannot
// see host port publishing, so a 'warn' here means "verify the tunnel/proxy is really in front",
// not proof of remote exposure.
async function checkListenerExposure({ timeoutMs = 1000, port, config, networkInterfaces = os.networkInterfaces } = {}) {
  if (config.DASHBOARD_PUBLIC_URL || config.TUNNEL_DOMAIN) {
    return check('Listener exposure', 'ok', 'a public HTTPS origin is configured; local plain-HTTP exposure is expected behind the tunnel/proxy');
  }
  const candidates = [];
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos) {
      // `internal` is how the OS reports loopback; only externally-visible addresses are probed.
      if (info.family === 'IPv4' && !info.internal) candidates.push(info.address);
    }
  }
  if (!candidates.length) {
    return check('Listener exposure', 'ok', 'no non-loopback IPv4 interface found to probe');
  }
  const tryConnect = address => new Promise(resolve => {
    const socket = net.createConnection({ host: address, port, timeout: timeoutMs });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
  });
  const reachable = [];
  for (const address of candidates) {
    if (await tryConnect(address)) reachable.push(address);
  }
  if (!reachable.length) {
    return check('Listener exposure', 'ok', `port ${port} is not reachable on any non-loopback interface (${candidates.join(', ')}) — localhost-only exposure`);
  }
  return check('Listener exposure', 'warn', `port ${port} is plain HTTP and reachable on non-loopback ${reachable.join(', ')} with no DASHBOARD_PUBLIC_URL configured — anyone able to reach it gets the dashboard unencrypted. Put a TLS-terminating tunnel/proxy in front (or stop publishing the port) before relying on this deployment.`);
}

// publicPort exists only so tests can point the public-origin probe at a local HTTPS test server
// on an ephemeral port; DASHBOARD_PUBLIC_URL itself is validated to never carry a port (passkeyRp
// in src/passkeys.js), and production always means the real public 443.
// config is injectable (defaulting to the real config) so the deployment smoke script can run
// these checks with a light env-only config instead of the bot's full config module.
async function checkPublicOriginReadiness({ timeoutMs = 8000, publicPort = 443, config = require('./config').CONFIG } = {}) {
  const checks = [checkProxyTrust(config)];
  checks.push(await probeLocalLiveness(config.PORT, timeoutMs));
  checks.push(await probeForwardedProtoBehavior({ timeoutMs, port: config.PORT, expectSecure: !!config.COOKIE_SECURE }));
  checks.push(await checkListenerExposure({ port: config.PORT, config }));
  if (!config.DASHBOARD_PUBLIC_URL) {
    checks.push(check('Public HTTPS origin', 'fail', 'DASHBOARD_PUBLIC_URL/TUNNEL_DOMAIN is not configured — the dashboard has no known public HTTPS origin to verify'));
    return checks;
  }
  checks.push(...await probePublicOrigin(config.DASHBOARD_PUBLIC_URL, timeoutMs, publicPort, config));
  return checks;
}

module.exports = { checkPublicOriginReadiness, probeForwardedProtoBehavior, checkListenerExposure };
