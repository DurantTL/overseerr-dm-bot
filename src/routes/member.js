'use strict';

// Member self-service dashboard (/member). Members prove who they are with a one-time code
// the bot DMs them on Discord — no new secrets or OAuth apps to configure — then get a
// signed member_session cookie scoped to /member.
//
// Every member action runs the exact same slash-command handler the Discord bot uses via
// the member-surface adapter (src/member-surface.js), so business logic (rate limits,
// duplicate detection, quotas, audits, DMs) behaves identically in both places.

const crypto = require('crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { runMemberCommand } = require('../member-surface');
const { icon: shellIcon, SHELL_CSS, THEME_HEAD_SCRIPT } = require('../dashboard-shell');

const MEMBER_COOKIE = 'member_session';
const MEMBER_SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CODE_MAX_ATTEMPTS = 5;
const CODE_MAX_PER_HOUR = 3;

// Extra styling on top of the shared dashboard CSS: mobile-first member layout, the
// converted command-result embeds, and the request search results.
const MEMBER_CSS = `
body.member-shell{padding-bottom:calc(76px + env(safe-area-inset-bottom));}
.member-header{position:sticky;top:0;z-index:20;background:color-mix(in srgb, var(--bg) 92%, transparent);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid var(--border);padding-top:env(safe-area-inset-top);}
.member-header-inner{max-width:980px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:14px;}
.member-brand{display:flex;align-items:center;gap:10px;font-weight:650;font-size:1.02rem;color:var(--text);text-decoration:none;}
.member-header nav{display:none;gap:4px;margin-left:auto;}
.member-header nav a{color:var(--muted);text-decoration:none;padding:8px 12px;border-radius:999px;font-size:.93rem;font-weight:600;}
.member-header nav a[aria-current="page"],.member-header nav a:hover{background:color-mix(in srgb, var(--accent) 18%, transparent);color:var(--text);}
.member-main{max-width:980px;margin:0 auto;padding:18px 16px 40px;}
.member-main h1{font-size:1.6rem;letter-spacing:-.02em;margin:6px 0 14px;}
.member-hero h1{font-size:1.9rem;line-height:1.15;}
.member-hero h1 em{font-family:var(--serif);font-style:italic;font-weight:400;color:var(--accent);}
.member-search{display:flex;gap:8px;margin:0 0 18px;}
.member-search input{flex:1;min-width:0;min-height:52px;padding:0 16px;border-radius:14px;border:1px solid var(--edge);background:var(--panel);color:var(--text);font-size:1rem;}
.member-search button{min-height:52px;padding:0 18px;border-radius:14px;}
.member-nav-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:14px 0 22px;}
@media (min-width:721px){.member-nav-cards{grid-template-columns:repeat(4,minmax(0,1fr));}}
.member-nav-card{display:flex;flex-direction:column;gap:4px;background:var(--glass);border:1px solid var(--edge);border-radius:16px;padding:14px;color:var(--text);text-decoration:none;min-height:44px;}
.member-nav-card:hover{border-color:var(--accent);}
.member-nav-card .icon{width:34px;height:34px;border-radius:10px;background:var(--panel2);color:var(--accent);display:flex;align-items:center;justify-content:center;}
.member-nav-card .label{font-weight:650;margin-top:4px;}
.member-nav-card .desc{color:var(--muted);font-size:.84rem;}
.member-result-embed{background:var(--glass);border:1px solid var(--edge);border-radius:16px;padding:16px;margin:12px 0;}
.member-result-embed h3{margin:0 0 8px;font-size:1.05rem;}
.member-result-desc{line-height:1.55;}
.member-result-fields{margin:12px 0 0;display:grid;gap:10px;}
.member-result-field dt{color:var(--faint);font-family:var(--mono);font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;}
.member-result-field dd{margin:2px 0 0;line-height:1.5;}
.member-result-text{line-height:1.6;}
.seerr-result{display:flex;gap:10px;align-items:center;width:100%;min-height:56px;text-align:left;background:var(--panel);border:1px solid var(--edge);border-radius:12px;padding:10px 14px;margin-top:8px;color:var(--text);cursor:pointer;font:inherit;}
.seerr-result:hover{border-color:var(--accent);}
.seerr-result .t{font-weight:600;flex:1;min-width:0;}
.seerr-result .m{color:var(--muted);font-size:.85rem;}
.member-form label{display:block;margin:14px 0 6px;font-weight:600;}
.member-form input[type=text],.member-form input[type=search],.member-form input[type=number],.member-form textarea,.member-form select{width:100%;box-sizing:border-box;min-height:48px;background:var(--panel);border:1px solid var(--edge);border-radius:12px;color:var(--text);padding:10px 14px;font-size:1rem;}
.member-form textarea{min-height:100px;resize:vertical;}
.member-form .check{display:flex;align-items:center;gap:10px;font-weight:500;min-height:44px;}
.member-form .check input{width:20px;height:20px;}
.member-form .btn{min-height:48px;margin-top:16px;}
.form-row{display:flex;gap:10px;align-items:end;flex-wrap:wrap;}
.form-row>*{flex:1;min-width:120px;}
.cancel-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--glass);border:1px solid var(--edge);border-radius:12px;padding:10px 12px;margin-top:8px;}
.cancel-row .t{flex:1;min-width:160px;}
.error{background:color-mix(in srgb, var(--down) 14%, transparent);border:1px solid color-mix(in srgb, var(--down) 45%, transparent);color:var(--text);border-radius:12px;padding:10px 12px;margin:12px 0;}
.member-logout{margin-top:28px;}
.bottombar a.bb-item{text-decoration:none;}
@media (min-width:721px){body.member-shell{padding-bottom:0;}.member-header nav{display:flex;}.member-logout{display:block;}}
`;

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

function signMemberSession(secret, discordId, ttlMs = MEMBER_SESSION_TTL_MS) {
  const payload = Buffer.from(JSON.stringify({ sub: String(discordId), exp: Date.now() + ttlMs })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyMemberSession(secret, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof sub !== 'string' || typeof exp !== 'number' || Date.now() >= exp) return null;
    return sub;
  } catch (_err) {
    return null;
  }
}

function hashLoginCode(secret, code) {
  return crypto.createHmac('sha256', secret).update(`member-login:${code}`).digest();
}

function registerMemberRoutes(app, deps) {
  const {
    CONFIG, db, audit, escapeHtml, css,
    sessionSecret, handlers, searchSeerr,
    getGuildMembers, getUserByDiscordId, getSetting, sendMemberDm,
  } = deps;

  const urlencoded = express.urlencoded({ extended: false });
  const json = express.json();
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 });
  const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 40 });
  // Blanket limiter for the whole member surface: every /member route does
  // session auth or DB work, so all of them sit behind a rate limiter. The
  // login/verify POSTs and the search API keep their stricter per-route
  // limiters layered on top.
  const memberLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300 });
  app.use('/member', memberLimiter);

  function setMemberCookie(req, res, discordId) {
    const secure = CONFIG.COOKIE_SECURE;
    const value = signMemberSession(sessionSecret, discordId);
    res.setHeader('Set-Cookie', `${MEMBER_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/member; Max-Age=${Math.floor(MEMBER_SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`);
  }

  function clearMemberCookie(res) {
    res.setHeader('Set-Cookie', `${MEMBER_COOKIE}=; HttpOnly; SameSite=Lax; Path=/member; Max-Age=0`);
  }

  // PermissionFlagsBits.Administrator as a raw bigint so this route module
  // doesn't need discord.js.
  const ADMINISTRATOR_BIT = 8n;

  // Global admin (ADMIN_USER_ID or the Discord Administrator permission) sees
  // everything in the member surface — including an all-requests admin view.
  async function isMemberAdmin(discordId) {
    if (CONFIG.ADMIN_USER_ID && discordId === String(CONFIG.ADMIN_USER_ID)) return true;
    try {
      const members = await getGuildMembers();
      const me = (members || []).find(m => m?.user?.id === discordId);
      return !!(me?.permissions?.has && me.permissions.has(ADMINISTRATOR_BIT));
    } catch (_e) {
      return false;
    }
  }

  async function requireMember(req, res, next) {
    try {
      const discordId = verifyMemberSession(sessionSecret, readCookie(req, MEMBER_COOKIE));
      const user = discordId ? getUserByDiscordId(discordId) : null;
      if (!user) {
        clearMemberCookie(res);
        return res.redirect('/member/login');
      }
      req.member = { discordId, user, isAdmin: await isMemberAdmin(discordId) };
      next();
    } catch (err) {
      next(err);
    }
  }

  function requireAdminPage(req, res, next) {
    if (req.member?.isAdmin) return next();
    return res.status(403).send(layout({
      title: 'Admins only', active: '/member', isAdmin: false,
      body: '<h1>🔒 Admins only</h1><p class="muted">This area is for the server admin.</p>',
    }));
  }

  // Same look as the admin dashboard: Durant tokens and theme, a top nav on wide screens and a
  // bottom bar on the phone (Home, Request, My requests, Downloads, Me).
  function layout({ title, body, active, isAdmin = false }) {
    const links = [
      ['/member', 'home', 'Home'],
      ['/member/request', 'plus', 'Request'],
      ['/member/requests', 'requests', 'My requests'],
      ['/member/downloads', 'download', 'Downloads'],
      ['/member/report', 'report', 'Report'],
      ['/member/me', 'user', 'Me'],
    ];
    if (isAdmin) links.push(['/member/admin', 'shield', 'Admin']);
    const current = href => (active === href ? ' aria-current="page"' : '');
    const nav = links.map(([href, , label]) => `<a href="${href}"${current(href)}>${label}</a>`).join('');
    const barLinks = links.filter(([href]) => ['/member', '/member/request', '/member/requests', '/member/downloads', '/member/me'].includes(href));
    const bar = `<nav class="bottombar" aria-label="Member sections">${barLinks.map(([href, ic, label]) =>
      `<a class="bb-item" href="${href}"${current(href)}><span class="bb-pill">${shellIcon(ic, 24)}</span><span class="bb-label">${label}</span></a>`).join('')}</nav>`;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#10232f"><title>${escapeHtml(title)} — Durant Media</title><script>${THEME_HEAD_SCRIPT}</script><style>${css}${SHELL_CSS}</style><style>${MEMBER_CSS}</style></head><body class="member-shell">`
      + `<header class="member-header"><div class="member-header-inner"><a class="member-brand" href="/member"><span class="brand-mark" aria-hidden="true">d<span>l</span>.</span><span>Durant Media</span></a><nav aria-label="Member sections">${nav}</nav></div></header>`
      + `<main class="member-main">${body}`
      + `<form class="member-logout" method="POST" action="/member/logout"><button class="btn" type="submit">Log out</button></form>`
      + `</main>${bar}</body></html>`;
  }

  // Shorthand: every member page renders through this so the admin nav link and
  // any other per-member chrome stay in one place.
  const page = (req, opts) => layout({ ...opts, isAdmin: req.member?.isAdmin === true });

  const resultPage = (req, title, active, html, backHref, backLabel) => page(req, {
    title,
    active,
    body: `<h1>${escapeHtml(title)}</h1>${html}<p style="margin-top:16px"><a class="btn" href="${backHref}">${escapeHtml(backLabel)}</a></p>`,
  });

  async function runAsMember(req, handler, options) {
    return runMemberCommand(handler, { discordId: req.member.discordId, options, escapeHtml });
  }

  // ---- Auth: prove Discord ownership with a DM'd one-time code ----

  function loginPage({ error, handle = '', verify = false }) {
    const errHtml = error ? `<div class="error">${escapeHtml(error)}</div>` : '';
    const body = verify
      ? `<h1>Check your DMs ✉️</h1>${errHtml}
        <p class="muted">The bot sent a 6-digit code to <strong>${escapeHtml(handle)}</strong> on Discord. It expires in 10 minutes.</p>
        <form class="member-form" method="POST" action="/member/verify">
          <input type="hidden" name="handle" value="${escapeHtml(handle)}">
          <label>Code<input type="text" name="code" inputmode="numeric" pattern="\\d{6}" maxlength="6" required autocomplete="one-time-code" autofocus></label>
          <button class="btn primary" type="submit">Verify &amp; log in</button>
        </form>
        <p class="muted" style="margin-top:12px">No code? <a href="/member/login">Send a new one</a>.</p>`
      : `<h1>Member login</h1>${errHtml}
        <p class="muted">Enter your Discord username or user ID — the bot will DM you a one-time login code. You need to be linked first (ask an admin).</p>
        <form class="member-form" method="POST" action="/member/login">
          <label>Discord username or ID<input type="text" name="handle" value="${escapeHtml(handle)}" required autocomplete="username" autofocus></label>
          <button class="btn primary" type="submit">Send me a code</button>
        </form>`;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Member login — Durant Media</title><script>${THEME_HEAD_SCRIPT}</script><style>${css}${SHELL_CSS}</style><style>${MEMBER_CSS}</style></head><body><main class="member-main" style="max-width:460px">${body}</main></body></html>`;
  }

  async function resolveHandle(handle) {
    const trimmed = String(handle || '').trim();
    if (/^\d{5,25}$/.test(trimmed)) return { discordId: trimmed };
    const members = await getGuildMembers().catch(() => []);
    const q = trimmed.toLowerCase().replace(/^@/, '');
    const match = members.find(m =>
      String(m?.user?.username || '').toLowerCase() === q ||
      String(m?.displayName || '').toLowerCase() === q);
    return match?.user?.id ? { discordId: String(match.user.id) } : {};
  }

  app.get('/member/login', (_req, res) => res.send(loginPage({})));

  app.post('/member/login', authLimiter, urlencoded, async (req, res) => {
    const handle = String(req.body?.handle || '');
    try {
      const { discordId } = await resolveHandle(handle);
      // L1: same generic response whether the handle resolves or not — an unauthenticated
      // caller must not be able to enumerate Discord membership / media-server linkage.
      const user = discordId ? getUserByDiscordId(discordId) : null;
      if (!discordId || !user) return res.send(loginPage({ verify: true, handle, error: 'If that account is linked, a login code was sent — check your DMs.' }));
      const recent = db.prepare("SELECT COUNT(*) AS c FROM member_login_codes WHERE discord_id = ? AND created_at > datetime('now', '-1 hour')").get(discordId).c;
      if (recent >= CODE_MAX_PER_HOUR) {
        return res.status(429).send(loginPage({ verify: true, handle, error: 'Too many codes sent — wait a bit and request a new one.' }));
      }
      const code = String(crypto.randomInt(100000, 1000000));
      db.prepare('INSERT INTO member_login_codes (discord_id, code_hash, expires_at) VALUES (?, ?, ?)')
        .run(discordId, hashLoginCode(sessionSecret, code).toString('hex'), Date.now() + CODE_TTL_MS);
      try {
        await sendMemberDm(discordId, `🎬 Your Durant Media Server login code is: ${code}\nIt expires in 10 minutes. If you didn't ask for this, just ignore it.`);
      } catch (_err) {
        return res.status(502).send(loginPage({ error: 'Couldn\'t DM you the code — make sure you allow DMs from server members, then try again.', handle }));
      }
      audit('member_login_code_sent', { actor: 'member-dashboard', targetDiscordId: discordId });
      return res.send(loginPage({ verify: true, handle }));
    } catch (err) {
      return res.status(500).send(loginPage({ error: `Something went wrong: ${err.message}`, handle }));
    }
  });

  app.get('/member/verify', (req, res) => {
    res.send(loginPage({ verify: true, handle: String(req.query?.handle || '') }));
  });

  app.post('/member/verify', authLimiter, urlencoded, async (req, res) => {
    const handle = String(req.body?.handle || '');
    const code = String(req.body?.code || '').trim();
    const fail = error => res.status(400).send(loginPage({ verify: true, handle, error }));
    try {
      const { discordId } = await resolveHandle(handle);
      if (!discordId || !/^\d{6}$/.test(code)) return fail('That code doesn\'t look right — check the DM and try again.');
      const row = db.prepare('SELECT * FROM member_login_codes WHERE discord_id = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1')
        .get(discordId, Date.now());
      if (!row) return fail('No active code for that account — request a new one.');
      if (row.attempts >= CODE_MAX_ATTEMPTS) {
        db.prepare('UPDATE member_login_codes SET used = 1 WHERE id = ?').run(row.id);
        return fail('Too many wrong tries — request a new code.');
      }
      const ok = crypto.timingSafeEqual(hashLoginCode(sessionSecret, code), Buffer.from(row.code_hash, 'hex'));
      db.prepare('UPDATE member_login_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      if (!ok) return fail('Wrong code — try again.');
      db.prepare('UPDATE member_login_codes SET used = 1 WHERE id = ?').run(row.id);
      audit('member_login', { actor: 'member-dashboard', targetDiscordId: discordId });
      setMemberCookie(req, res, discordId);
      return res.redirect('/member');
    } catch (err) {
      return res.status(500).send(loginPage({ verify: true, handle, error: `Something went wrong: ${err.message}` }));
    }
  });

  app.post('/member/logout', urlencoded, (_req, res) => {
    clearMemberCookie(res);
    res.redirect('/member/login');
  });

  // ---- Member pages ----

  app.get('/member', requireMember, async (req, res) => {
    const name = req.member.user.plex_username || req.member.user.email || 'member';
    const recentHtml = await runAsMember(req, handlers.myRequests, {}).catch(err => `<div class="error">${escapeHtml(err.message)}</div>`);
    const cards = [
      ['/member/report', 'report', 'Report a problem', 'Bad audio, subs, wrong file.'],
      ['/member/keep', 'shield', 'Keep list', 'Titles safe from cleanup.'],
      ['/member/stats', 'activity', 'My stats', 'Requests and watching.'],
      ['/member/status', 'services', 'Server status', 'Are Plex and the apps up?'],
    ].map(([href, ic, label, desc]) =>
      `<a class="member-nav-card" href="${href}"><div class="icon">${shellIcon(ic, 20)}</div><div class="label">${label}</div><div class="desc">${desc}</div></a>`).join('');
    res.send(page(req, {
      title: 'Home', active: '/member',
      body: `<div class="member-hero"><h1>Hi ${escapeHtml(name)}. <em>What do you want to watch?</em></h1></div>
        <form class="member-search" method="GET" action="/member/request" role="search"><input type="search" name="q" placeholder="Search for a movie or show" aria-label="Search for a movie or show" autocomplete="off" enterkeyhint="search"><button class="btn primary" type="submit">Search</button></form>
        <h2>Your requests</h2>${recentHtml}<div class="member-nav-cards">${cards}</div>`,
    }));
  });

  // F13: member-facing status page — which services are reachable, at a glance.
  // Best-effort snapshot with short timeouts; never blocks page render on a down service.
  app.get('/member/status', requireMember, async (req, res) => {
    const axios = require('axios');
    const services = [
      ['Plex', CONFIG.PLEX_URL, `${CONFIG.PLEX_URL}/identity`],
      ['Radarr (HD)', CONFIG.RADARR_URL, `${CONFIG.RADARR_URL}/api/v3/system/status`],
      ['Radarr 4K', CONFIG.RADARR_4K_URL, `${CONFIG.RADARR_4K_URL}/api/v3/system/status`],
      ['Sonarr', CONFIG.SONARR_URL, `${CONFIG.SONARR_URL}/api/v3/system/status`],
      ['Overseerr', CONFIG.OVERSEERR_URL, `${CONFIG.OVERSEERR_URL}/api/v1/status`],
    ].filter(([, url]) => url);
    const checks = await Promise.all(services.map(async ([label, url, pingUrl]) => {
      const started = Date.now();
      try {
        const headers = {};
        if (label.startsWith('Radarr')) headers['X-Api-Key'] = label === 'Radarr 4K' ? CONFIG.RADARR_4K_API_KEY : CONFIG.RADARR_API_KEY;
        if (label === 'Sonarr') headers['X-Api-Key'] = CONFIG.SONARR_API_KEY;
        if (label === 'Plex' && CONFIG.PLEX_TOKEN) headers['X-Plex-Token'] = CONFIG.PLEX_TOKEN;
        await axios.get(pingUrl, { headers, timeout: 4000, validateStatus: s => s < 500 });
        return { label, ok: true, ms: Date.now() - started };
      } catch (err) {
        return { label, ok: false, ms: Date.now() - started, error: err.code || err.message };
      }
    }));
    const rows = checks.map(c =>
      `<div class="member-status-row"><span class="dot ${c.ok ? 'ok' : 'down'}"></span>` +
      `<span class="name">${escapeHtml(c.label)}</span>` +
      `<span class="meta">${c.ok ? `${c.ms}ms` : `unreachable (${escapeHtml(String(c.error || 'error')).slice(0, 40)})`}</span></div>`
    ).join('');
    const allOk = checks.every(c => c.ok);
    res.send(page(req, {
      title: 'Server Status', active: '/member/status',
      body: `<h1>Server Status</h1>` +
        `<p class="${allOk ? '' : 'error'}">${allOk ? '✅ All services are reachable.' : '⚠️ Some services are unreachable — the admin has been notified.'}</p>` +
        `<div class="member-status-list">${rows}</div>` +
        `<style>.member-status-row{display:flex;align-items:center;gap:10px;padding:10px;background:#1b1b1b;border:1px solid #2c2c2c;border-radius:10px;margin-top:8px;}.member-status-row .dot{width:10px;height:10px;border-radius:50%;background:#666;}.member-status-row .dot.ok{background:#4caf50;}.member-status-row .dot.down{background:#f44336;}.member-status-row .name{font-weight:600;flex:1;}.member-status-row .meta{color:#999;font-size:.85rem;}</style>`,
    }));
  });

  // Request a title: search Seerr, pick a result, set options, submit.
  app.get('/member/request', requireMember, (_req, res) => {
    res.send(page(_req, {
      title: 'Request', active: '/member/request',
      body: `<h1>Request a movie or show</h1>
      <form class="member-form" id="request-form" method="POST" action="/member/request">
        <label>Search<input type="search" id="seerr-q" placeholder="Start typing a title…" autocomplete="off"></label>
        <div id="seerr-results"></div>
        <input type="hidden" name="title" id="req-title">
        <div id="req-picked" class="muted" style="margin-top:8px">Pick a result above — suggestions come straight from Seerr.</div>
        <label class="check"><input type="checkbox" name="is4k"> 4K version</label>
        <label>Seasons (TV only)<input type="text" name="seasons" placeholder="all"></label>
        <p class="muted" style="margin:4px 0 0">Leave blank for every season, or name seasons like <code>2</code> or <code>1,3,5</code>.</p>
        <label>Is this Asian content?<select name="asian"><option value="unsure">Not sure</option><option value="yes">Yes</option><option value="no">No</option></select></label>
        <button class="btn primary" type="submit" id="req-submit" disabled>Send request</button>
      </form>
      <script>
      (function () {
        var q = document.getElementById('seerr-q');
        var results = document.getElementById('seerr-results');
        var picked = document.getElementById('req-picked');
        var hidden = document.getElementById('req-title');
        var submit = document.getElementById('req-submit');
        var timer = null;
        // Arrived from Home's search box: start with that search.
        var initial = new URLSearchParams(location.search).get('q');
        if (initial) setTimeout(function () { q.value = initial; q.dispatchEvent(new Event('input')); }, 0);
        function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
        window.pickSeerr = function (mediaType, tmdbId, label) {
          hidden.value = mediaType + ':' + tmdbId + ':' + label;
          picked.innerHTML = 'Picked: <strong>' + esc(label) + '</strong> (' + esc(mediaType) + ')';
          submit.disabled = false;
          results.innerHTML = '';
        };
        results.addEventListener('click', function (e) {
          var btn = e.target.closest('.seerr-result');
          if (btn) pickSeerr(btn.dataset.mediaType, btn.dataset.tmdbId, btn.dataset.title);
        });
        q.addEventListener('input', function () {
          clearTimeout(timer);
          var query = q.value.trim();
          if (query.length < 2) { results.innerHTML = ''; return; }
          timer = setTimeout(function () {
            fetch('/member/api/seerr-search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: query }) })
              .then(function (r) { return r.json(); })
              .then(function (items) {
                results.innerHTML = items.map(function (it) {
                  var label = it.title + (it.year ? ' (' + it.year + ')' : '');
                  return '<button type="button" class="seerr-result" data-media-type="' + esc(it.mediaType) + '" data-tmdb-id="' + esc(String(it.tmdbId)) + '" data-title="' + esc(it.title) + '">'
                    + '<span class="t">' + esc(label) + '</span><span class="m">' + esc(it.mediaType) + '</span></button>';
                }).join('') || '<p class="muted">No matches.</p>';
              })
              .catch(function () { results.innerHTML = '<p class="muted">Search failed — try again.</p>'; });
          }, 300);
        });
      })();
      </script>`,
    }));
  });

  app.post('/member/api/seerr-search', requireMember, apiLimiter, json, async (req, res) => {
    const q = String(req.body?.q || '').trim();
    if (q.length < 2) return res.json([]);
    try {
      const hits = await searchSeerr(q);
      res.json((hits || []).slice(0, 8).map(h => ({
        mediaType: h.mediaType,
        tmdbId: h.id,
        title: h.mediaType === 'movie' ? (h.title || '') : (h.name || h.title || ''),
        year: String(h.releaseDate || h.firstAirDate || '').slice(0, 4),
      })).filter(h => h.mediaType && h.tmdbId && h.title));
    } catch (_err) {
      res.status(502).json({ error: 'Seerr search failed' });
    }
  });

  app.post('/member/request', requireMember, urlencoded, async (req, res) => {
    const asian = String(req.body?.asian || 'unsure');
    const options = {
      title: String(req.body?.title || '').trim(),
      is4k: ['on', 'true', '1'].includes(String(req.body?.is4k || '')),
      seasons: String(req.body?.seasons || '').trim() || null,
      asian_content: asian === 'yes' ? true : asian === 'no' ? false : null,
    };
    if (!options.title) return res.redirect('/member/request');
    const html = await runAsMember(req, handlers.request, options).catch(err => `<div class="error">${escapeHtml(err.message)}</div>`);
    res.send(resultPage(req, 'Request sent', '/member/request', html, '/member/request', 'Request another'));
  });

  // My requests: status list plus cancel buttons and per-title status pages.
  app.get('/member/requests', requireMember, async (req, res) => {
    const listHtml = await runAsMember(req, handlers.myRequests, {}).catch(err => `<div class="error">${escapeHtml(err.message)}</div>`);
    const cancelable = db.prepare("SELECT title, media_id, media_type, is_4k, status FROM requests WHERE requested_by_discord_id = ? AND status IN ('pending','approved') ORDER BY id DESC LIMIT 15")
      .all(req.member.discordId);
    const cancelHtml = cancelable.length
      ? `<h2>Withdraw a request</h2>` + cancelable.map(r =>
        `<div class="cancel-row"><span class="t"><strong>${escapeHtml(r.title)}</strong>${r.is_4k ? ' (4K)' : ''} <span class="muted">· ${escapeHtml(r.status)}</span></span>`
        + `<a class="btn" href="/member/requests/status?media_id=${encodeURIComponent(r.media_id)}">Status</a>`
        + `<form method="POST" action="/member/requests/cancel" onsubmit="return confirm('Withdraw your request for ${escapeHtml(r.title).replace(/'/g, '&#39;')}?')"><input type="hidden" name="media_id" value="${escapeHtml(r.media_id)}"><button class="btn danger" type="submit">Cancel</button></form></div>`).join('')
      : '';
    res.send(page(req, { title: 'My Requests', active: '/member/requests', body: `<h1>My requests</h1>${listHtml}${cancelHtml}` }));
  });

  app.get('/member/requests/status', requireMember, async (req, res) => {
    const mediaId = String(req.query?.media_id || '').trim();
    if (!/^(tmdb|tvdb):\d+$/.test(mediaId)) return res.redirect('/member/requests');
    const html = await runAsMember(req, handlers.requestStatus, { title: mediaId }).catch(err => `<div class="error">${escapeHtml(err.message)}</div>`);
    res.send(resultPage(req, 'Request status', '/member/requests', html, '/member/requests', 'Back to my requests'));
  });

  app.post('/member/requests/cancel', requireMember, urlencoded, async (req, res) => {
    const mediaId = String(req.body?.media_id || '').trim();
    if (!/^(tmdb|tvdb):\d+$/.test(mediaId)) return res.redirect('/member/requests');
    const html = await runAsMember(req, handlers.requestCancel, { title: mediaId }).catch(err => `<div class="error">${escapeHtml(err.message)}</div>`);
    res.send(resultPage(req, 'Request withdrawn', '/member/requests', html, '/member/requests', 'Back to my requests'));
  });

  // Admin: every member's requests in one place, with a status filter. Read-only —
  // approvals still happen from the main dashboard or Discord.
  app.get('/member/admin', requireMember, requireAdminPage, async (req, res) => {
    const statuses = ['pending', 'approved', 'available', 'denied'];
    const filter = statuses.includes(String(req.query?.status || '')) ? String(req.query.status) : '';
    const rows = filter
      ? db.prepare('SELECT title, media_id, media_type, is_4k, status, requested_by_discord_id, created_at FROM requests WHERE status = ? ORDER BY id DESC LIMIT 100').all(filter)
      : db.prepare('SELECT title, media_id, media_type, is_4k, status, requested_by_discord_id, created_at FROM requests ORDER BY id DESC LIMIT 100').all();
    let nameFor = () => null;
    try {
      const members = await getGuildMembers();
      const map = new Map((members || []).map(m => [m?.user?.id, m?.user?.username || m?.displayName || null]));
      nameFor = id => map.get(id) || null;
    } catch (_e) { /* names are best-effort */ }
    const filterLinks = [`<a class="btn${filter ? '' : ' primary'}" href="/member/admin">All</a>`]
      .concat(statuses.map(s => `<a class="btn${filter === s ? ' primary' : ''}" href="/member/admin?status=${s}">${s[0].toUpperCase()}${s.slice(1)}</a>`))
      .join(' ');
    const rowsHtml = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Title</th><th>Type</th><th>Requester</th><th>Status</th><th>When</th></tr></thead><tbody>${
      rows.map(r => {
        const who = nameFor(r.requested_by_discord_id)
          || getUserByDiscordId(r.requested_by_discord_id)?.email
          || r.requested_by_discord_id || '—';
        const when = String(r.created_at || '').slice(0, 16).replace('T', ' ');
        return `<tr><td data-label="Title"><strong>${escapeHtml(r.title)}</strong>${r.is_4k ? ' (4K)' : ''}</td>`
          + `<td data-label="Type">${escapeHtml(r.media_type || '—')}</td>`
          + `<td data-label="Requester">${escapeHtml(who)}</td>`
          + `<td data-label="Status">${escapeHtml(r.status || '—')}</td>`
          + `<td data-label="When">${escapeHtml(when)}</td></tr>`;
      }).join('')
    }</tbody></table></div>` : '<p class="muted">No requests yet.</p>';
    res.send(page(req, {
      title: 'Admin — All Requests', active: '/member/admin',
      body: `<h1>🛡️ All requests</h1><p class="muted">Every member's requests, newest first.</p>`
        + `<p style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">${filterLinks}</p>${rowsHtml}`,
    }));
  });

  // Downloads: active links plus a form to mint a new one.
  app.get('/member/downloads', requireMember, async (req, res) => {
    const listHtml = await runAsMember(req, handlers.downloads, {}).catch(err => `<div class="error">${escapeHtml(err.message)}</div>`);
    res.send(page(req, {
      title: 'Downloads', active: '/member/downloads',
      body: `<h1>📥 Downloads</h1>${listHtml}
      <h2>New download link</h2>
      <form class="member-form" method="POST" action="/member/downloads/new">
        <label>Movie or series title<input type="text" name="title" required placeholder="e.g. Dune: Part Two"></label>
        <div class="form-row">
          <label>Season #<input type="number" name="season" min="1" placeholder="—"></label>
          <label>Episode #<input type="number" name="episode" min="1" placeholder="—"></label>
        </div>
        <p class="muted" style="margin:4px 0 0">Leave season/episode blank for movies. For a series episode, fill both.</p>
        <label class="check"><input type="checkbox" name="one_time" checked> One-time use link</label>
        <button class="btn primary" type="submit">Create link</button>
      </form>`,
    }));
  });

  app.post('/member/downloads/new', requireMember, urlencoded, async (req, res) => {
    const intOrNull = v => {
      const n = Number(String(v || '').trim());
      return Number.isInteger(n) && n > 0 ? n : null;
    };
    const options = {
      title: String(req.body?.title || '').trim(),
      season: intOrNull(req.body?.season),
      episode: intOrNull(req.body?.episode),
      one_time: req.body?.one_time !== undefined,
    };
    if (!options.title) return res.redirect('/member/downloads');
    const html = await runAsMember(req, handlers.download, options).catch(err => `<div class="error">${escapeHtml(err.message)}</div>`);
    res.send(resultPage(req, 'Download link', '/member/downloads', html, '/member/downloads', 'Back to downloads'));
  });

  // Report a problem with something already on Plex.
  app.get('/member/report', requireMember, (_req, res) => {
    const available = db.prepare("SELECT DISTINCT title FROM requests WHERE status = 'available' ORDER BY title LIMIT 200").all();
    const dataList = available.length
      ? `<datalist id="available-titles">${available.map(r => `<option value="${escapeHtml(r.title)}">`).join('')}</datalist>` : '';
    res.send(page(_req, {
      title: 'Report a Problem', active: '/member/report',
      body: `<h1>🛠️ Report a problem</h1>
      <p class="muted">Wrong audio, missing subtitles, mislabeled file — tell us what's wrong and we'll take a look.</p>
      <form class="member-form" method="POST" action="/member/report">
        <label>Title<input type="text" name="title" list="available-titles" required placeholder="What's broken?">${dataList}</label>
        <label>Problem type<select name="type"><option value="1">Video</option><option value="2">Audio</option><option value="3">Subtitles</option><option value="4">Other</option></select></label>
        <label>Details<textarea name="details" maxlength="1000" placeholder="e.g. Episode 3 has no subtitles, the rest are fine."></textarea></label>
        <button class="btn primary" type="submit">Send report</button>
      </form>`,
    }));
  });

  app.post('/member/report', requireMember, urlencoded, async (req, res) => {
    const options = {
      title: String(req.body?.title || '').trim(),
      type: String(req.body?.type || '4'),
      details: String(req.body?.details || '').trim().slice(0, 1000),
    };
    if (!options.title) return res.redirect('/member/report');
    const html = await runAsMember(req, handlers.report, options).catch(err => `<div class="error">${escapeHtml(err.message)}</div>`);
    res.send(resultPage(req, 'Report sent', '/member/report', html, '/member/report', 'Report another'));
  });

  // Notification preferences.
  app.get('/member/notifications', requireMember, (req, res) => {
    const muted = getSetting(`request_progress_dm:${req.member.discordId}`) === '0';
    res.send(page(req, {
      title: 'Notifications', active: '/member/me',
      body: `<h1>🔔 Notifications</h1>
      <p class="muted">Approval and availability DMs always come through. This only controls the in-progress chatter.</p>
      <form class="member-form" method="POST" action="/member/notifications">
        <label class="check"><input type="radio" name="request_updates" value="on" ${muted ? '' : 'checked'}> Request progress DMs on</label>
        <label class="check"><input type="radio" name="request_updates" value="off" ${muted ? 'checked' : ''}> Mute progress DMs</label>
        <button class="btn primary" type="submit" style="margin-top:12px">Save</button>
      </form>`,
    }));
  });

  app.post('/member/notifications', requireMember, urlencoded, async (req, res) => {
    const html = await runAsMember(req, handlers.notifications, { request_updates: String(req.body?.request_updates || 'on') === 'on' })
      .catch(err => `<div class="error">${escapeHtml(err.message)}</div>`);
    res.send(resultPage(req, 'Notifications', '/member/me', html, '/member', 'Back home'));
  });

  // Profile, stats, keep list — straight through the handlers.
  app.get('/member/me', requireMember, async (req, res) => {
    const html = await runAsMember(req, handlers.me, {}).catch(err => `<div class="error">${escapeHtml(err.message)}</div>`);
    res.send(page(req, { title: 'Me', active: '/member/me', body: `<h1>👤 Me</h1>${html}<p style="margin-top:12px"><a class="btn" href="/member/notifications">🔔 Notification settings</a></p>` }));
  });

  app.get('/member/stats', requireMember, async (req, res) => {
    const html = await runAsMember(req, handlers.stats, {}).catch(err => `<div class="error">${escapeHtml(err.message)}</div>`);
    res.send(page(req, { title: 'My Stats', active: '/member/me', body: `<h1>📊 My stats</h1>${html}` }));
  });

  app.get('/member/keep', requireMember, async (req, res) => {
    const html = await runAsMember(req, handlers.keep, {}).catch(err => `<div class="error">${escapeHtml(err.message)}</div>`);
    res.send(page(req, { title: 'Keep List', active: '/member/me', body: `<h1>📌 Keep list</h1><p class="muted">Titles you chose to keep — protected from cleanup.</p>${html}` }));
  });

  // The member home links here, so it belongs in the nav's active set.
  app.get('/member/', requireMember, (_req, res) => res.redirect('/member'));
}

module.exports = { registerMemberRoutes };
