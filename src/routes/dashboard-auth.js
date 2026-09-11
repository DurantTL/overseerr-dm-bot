const crypto = require('crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

function createDashboardSession({ secret, ttlHours, now = Date.now }) {
  function sign(ttlMs = ttlHours * 3600000) {
    const payload = Buffer.from(JSON.stringify({ exp: now() + ttlMs })).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  function verify(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return false;
    const [payload, signature] = token.split('.');
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return false;
    try {
      const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return typeof exp === 'number' && now() < exp;
    } catch (_err) {
      return false;
    }
  }

  function setCookie(req, res) {
    const ttlMs = ttlHours * 3600000;
    const secure = req.secure || (req.headers['x-forwarded-proto'] || '').includes('https');
    res.setHeader('Set-Cookie', `dm_session=${sign(ttlMs)}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${Math.floor(ttlMs / 1000)}${secure ? '; Secure' : ''}`);
  }

  return { sign, verify, setCookie, readCookie };
}

function dashboardActor(req) {
  return { actor: 'dashboard', actorIp: req.ip || req.socket.remoteAddress || 'unknown' };
}

function createDashboardGateActor({ sha256 }) {
  return function dashboardGateActor(req) {
    const session = readCookie(req, 'dm_session');
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const id = session ? `session:${sha256(session).slice(0, 12)}` : `header:${ip}`;
    return { kind: 'dashboard', id, label: `Dashboard operator ${id}` };
  };
}

function createDashboardAuth({ config, session, safeEqual }) {
  return function dashboardAuth(req, res, next) {
    const sessionOk = session.verify(session.readCookie(req, 'dm_session'));
    const password = req.headers['x-admin-password'];
    const token = req.headers['x-admin-token'];
    const passwordOk = config.DASHBOARD_ADMIN_PASSWORD && safeEqual(password, config.DASHBOARD_ADMIN_PASSWORD);
    const tokenOk = config.DASHBOARD_ADMIN_TOKEN && safeEqual(token, config.DASHBOARD_ADMIN_TOKEN);
    if (!sessionOk && !passwordOk && !tokenOk) {
      if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) return res.redirect('/admin/login');
      return res.status(401).send('Unauthorized');
    }

    if (config.STRICT_DASHBOARD_POST_AUTH && req.method !== 'GET') {
      const sameHost = headerValue => {
        if (!headerValue) return true;
        try { return new URL(headerValue).host === req.get('host'); } catch (_err) { return false; }
      };
      if (!sameHost(req.get('origin')) || !sameHost(req.get('referer'))) return res.status(403).send('Cross-site POST denied');
    }
    return next();
  };
}

function registerDashboardAuthRoutes(app, {
  config,
  session,
  dashboardAuth,
  httpRateLimitKey,
  renderLogin,
  listPasskeys,
  passkeyService,
  safeEqual,
  audit,
  renamePasskey,
  revokePasskey,
  passkeyClientPath,
  webauthnBrowserPath,
}) {
  const adminForm = express.urlencoded({ extended: false, limit: '16kb' });

  app.get('/admin/passkey-client.js', rateLimit({
    windowMs: 60000,
    limit: 120,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  }), (_req, res) => res.sendFile(passkeyClientPath, { headers: { 'Cache-Control': 'no-cache' } }));
  app.get('/admin/webauthn-browser.js', rateLimit({
    windowMs: 60000,
    limit: 120,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  }), (_req, res) => res.sendFile(webauthnBrowserPath, { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } }));

  app.get('/admin/login', rateLimit({
    windowMs: 60000,
    limit: 60,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  }), (req, res) => {
    if (session.verify(session.readCookie(req, 'dm_session'))) return res.redirect('/admin');
    return res.type('html').send(renderLogin(!!req.query.error, null, { passkeyEnabled: listPasskeys().length > 0 }));
  });

  app.get('/admin/passkey/authentication-options', rateLimit({
    windowMs: 15 * 60000,
    limit: 10,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' }),
  }), async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!listPasskeys().length) return res.status(404).json({ error: 'No passkeys are enrolled.' });
    const binding = crypto.randomBytes(32).toString('base64url');
    const secure = req.secure || (req.headers['x-forwarded-proto'] || '').includes('https');
    try {
      const options = await passkeyService.authenticationOptions(binding);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Set-Cookie', `dm_webauthn=${binding}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=300${secure ? '; Secure' : ''}`);
      return res.json(options);
    } catch (_err) {
      audit('dashboard_passkey_login_failed', { ip, reason: 'options_failed' });
      return res.status(400).json({ error: 'Could not start passkey sign-in.' });
    }
  });

  app.post('/admin/passkey/authenticate', rateLimit({
    windowMs: 15 * 60000,
    limit: 10,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' }),
  }), async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    try {
      await passkeyService.finishAuthentication(session.readCookie(req, 'dm_webauthn'), req.body);
      session.setCookie(req, res);
      res.append('Set-Cookie', 'dm_webauthn=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0');
      audit('dashboard_login_success', { ip, method: 'passkey' });
      return res.json({ verified: true });
    } catch (_err) {
      audit('dashboard_passkey_login_failed', { ip, reason: 'verification_failed' });
      return res.status(401).json({ verified: false, error: 'Passkey sign-in failed.' });
    }
  });

  app.post('/admin/login', adminForm, rateLimit({
    windowMs: 15 * 60000,
    limit: 5,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).type('html').send(renderLogin(
      false,
      'Too many attempts. Try again in a few minutes.',
      { passkeyEnabled: listPasskeys().length > 0 },
    )),
  }), (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const submitted = req.body?.password || '';
    const passwordOk = config.DASHBOARD_ADMIN_PASSWORD && safeEqual(submitted, config.DASHBOARD_ADMIN_PASSWORD);
    const tokenOk = config.DASHBOARD_ADMIN_TOKEN && safeEqual(submitted, config.DASHBOARD_ADMIN_TOKEN);
    if (!passwordOk && !tokenOk) {
      audit('dashboard_login_failed', { ip });
      return res.redirect('/admin/login?error=1');
    }
    session.setCookie(req, res);
    audit('dashboard_login_success', { ip, method: 'password' });
    return res.redirect('/admin');
  });

  app.post('/admin/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'dm_session=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0');
    return res.redirect('/admin/login');
  });

  app.post('/admin/passkey/registration-options', dashboardAuth, async (req, res) => {
    try {
      const options = await passkeyService.registrationOptions(session.readCookie(req, 'dm_session'), req.body?.label);
      res.setHeader('Cache-Control', 'no-store');
      return res.json(options);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });
  app.post('/admin/passkey/register', dashboardAuth, async (req, res) => {
    try {
      const passkey = await passkeyService.finishRegistration(session.readCookie(req, 'dm_session'), req.body);
      audit('dashboard_passkey_enrolled', dashboardActor(req));
      return res.json({ ok: true, label: passkey.label });
    } catch (_err) {
      audit('dashboard_passkey_enrollment_failed', { ...dashboardActor(req), reason: 'verification_failed' });
      return res.status(400).json({ error: 'Passkey enrollment failed.' });
    }
  });
  app.post('/admin/passkey/rename', dashboardAuth, (req, res) => {
    const credentialId = String(req.body?.credentialId || '');
    const label = String(req.body?.label || '').trim();
    if (!credentialId || !label || label.length > 64) return res.status(400).json({ error: 'Credential and a label of 1 to 64 characters are required.' });
    if (!renamePasskey(credentialId, label)) return res.status(404).json({ error: 'Passkey not found.' });
    audit('dashboard_passkey_renamed', dashboardActor(req));
    return res.json({ ok: true });
  });
  app.post('/admin/passkey/revoke', dashboardAuth, (req, res) => {
    const credentialId = String(req.body?.credentialId || '');
    if (listPasskeys().length === 1 && !config.DASHBOARD_ADMIN_PASSWORD && !config.DASHBOARD_ADMIN_TOKEN) {
      return res.status(409).json({ error: 'Configure the password fallback before revoking the last passkey.' });
    }
    if (!revokePasskey(credentialId)) return res.status(404).json({ error: 'Passkey not found.' });
    audit('dashboard_passkey_revoked', dashboardActor(req));
    return res.json({ ok: true });
  });
}

module.exports = {
  createDashboardSession,
  createDashboardAuth,
  createDashboardGateActor,
  dashboardActor,
  readCookie,
  registerDashboardAuthRoutes,
};
