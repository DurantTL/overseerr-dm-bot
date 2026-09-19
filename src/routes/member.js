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

const MEMBER_COOKIE = 'member_session';
const MEMBER_SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CODE_MAX_ATTEMPTS = 5;
const CODE_MAX_PER_HOUR = 3;

// Extra styling on top of the shared dashboard CSS: mobile-first member layout, the
// converted command-result embeds, and the request search results.
const MEMBER_CSS = `
.member-header{background:#141414;border-bottom:1px solid #2a2a2a;position:sticky;top:0;z-index:10;}
.member-header-inner{max-width:760px;margin:0 auto;padding:10px 12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.member-brand{font-weight:700;font-size:1.05rem;}
.member-header nav{display:flex;gap:2px;flex-wrap:wrap;margin-left:auto;}
.member-header nav a{color:#ccc;text-decoration:none;padding:6px 9px;border-radius:8px;font-size:.9rem;}
.member-header nav a.active,.member-header nav a:hover{background:#2a2a2a;color:#fff;}
.member-main{max-width:760px;margin:0 auto;padding:14px 12px 48px;}
.member-nav-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin:14px 0;}
.member-nav-card{display:block;background:#1b1b1b;border:1px solid #2c2c2c;border-radius:12px;padding:14px;color:#fff;text-decoration:none;}
.member-nav-card:hover{border-color:#4a4a4a;}
.member-nav-card .icon{font-size:1.4rem;}
.member-nav-card .label{font-weight:600;margin-top:6px;}
.member-nav-card .desc{color:#999;font-size:.82rem;margin-top:4px;}
.member-result-embed{background:#1b1b1b;border:1px solid #2c2c2c;border-radius:12px;padding:14px;margin:12px 0;}
.member-result-embed h3{margin:0 0 8px;font-size:1.05rem;}
.member-result-desc{line-height:1.55;}
.member-result-fields{margin:12px 0 0;display:grid;gap:10px;}
.member-result-field dt{color:#999;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;}
.member-result-field dd{margin:2px 0 0;line-height:1.5;}
.member-result-text{line-height:1.6;}
.seerr-result{display:flex;gap:10px;align-items:center;width:100%;text-align:left;background:#1b1b1b;border:1px solid #2c2c2c;border-radius:10px;padding:10px;margin-top:8px;color:#fff;cursor:pointer;}
.seerr-result:hover{border-color:#e8823c;}
.seerr-result .t{font-weight:600;}
.seerr-result .m{color:#999;font-size:.85rem;}
.member-form label{display:block;margin:12px 0 4px;font-weight:600;}
.member-form input[type=text],.member-form input[type=search],.member-form input[type=number],.member-form textarea,.member-form select{width:100%;box-sizing:border-box;background:#111;border:1px solid #333;border-radius:10px;color:#fff;padding:10px;font-size:1rem;}
.member-form textarea{min-height:90px;resize:vertical;}
.member-form .check{display:flex;align-items:center;gap:8px;font-weight:400;}
.member-form .check input{width:auto;}
.form-row{display:flex;gap:10px;align-items:end;flex-wrap:wrap;}
.form-row>*{flex:1;min-width:120px;}
.cancel-row{display:flex;align-items:center;gap:10px;background:#1b1b1b;border:1px solid #2c2c2c;border-radius:10px;padding:10px;margin-top:8px;}
.cancel-row .t{flex:1;}
.error{background:#3a1d1d;border:1px solid #7a2e2e;color:#ffb4b4;border-radius:10px;padding:10px 12px;margin:12px 0;}
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

  function setMemberCookie(req, res, discordId) {
    const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
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

  function layout({ title, body, active, isAdmin = false }) {
    const links = [
      ['/member', '🏠', 'Home'],
      ['/member/request', '🎬', 'Request'],
      ['/member/requests', '🧾', 'My Requests'],
      ['/member/downloads', '📥', 'Downloads'],
      ['/member/report', '🛠️', 'Report'],
      ['/member/me', '👤', 'Me'],
    ];
    if (isAdmin) links.push(['/member/admin', '🛡️', 'Admin']);
    const nav = links.map(([href, icon, label]) =>
      `<a href="${href}" class="${active === href ? 'active' : ''}">${icon} ${label}</a>`).join('');
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} — Durant Media</title><style>${css}</style><style>${MEMBER_CSS}</style></head><body>`
      + `<header class="member-header"><div class="member-header-inner"><span class="member-brand">🎬 Durant Media</span><nav>${nav}</nav></div></header>`
      + `<main class="member-main">${body}`
      + `<form method="POST" action="/member/logout" style="margin-top:28px"><button class="btn" type="submit">Log out</button></form>`
      + `</main></body></html>`;
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
        <p class="muted">Enter your Discord username or user ID — the bot will DM you a one-time login code. You need to be linked first (ask Caleb).</p>
        <form class="member-form" method="POST" action="/member/login">
          <label>Discord username or ID<input type="text" name="handle" value="${escapeHtml(handle)}" required autocomplete="username" autofocus></label>
          <button class="btn primary" type="submit">Send me a code</button>
        </form>`;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Member login — Durant Media</title><style>${css}</style><style>${MEMBER_CSS}</style></head><body><main class="member-main">${body}</main></body></html>`;
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
      if (!discordId) return res.status(404).send(loginPage({ error: `Couldn't find "${handle}" in the Discord server — check the spelling or use your numeric user ID.`, handle }));
      const user = getUserByDiscordId(discordId);
      if (!user) return res.status(403).send(loginPage({ error: 'That Discord account isn\'t linked to the media server yet — ask Caleb to link it first.', handle }));
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
      ['/member/request', '🎬', 'Request', 'Ask for a movie or show.'],
      ['/member/requests', '🧾', 'My Requests', 'Status, progress, and cancel.'],
      ['/member/downloads', '📥', 'Downloads', 'Secure download links.'],
      ['/member/report', '🛠️', 'Report a Problem', 'Bad audio, subs, wrong file…'],
      ['/member/stats', '📊', 'My Stats', 'Requests and watching.'],
      ['/member/keep', '📌', 'Keep List', 'Titles safe from cleanup.'],
    ].map(([href, icon, label, desc]) =>
      `<a class="member-nav-card" href="${href}"><div class="icon">${icon}</div><div class="label">${label}</div><div class="desc">${desc}</div></a>`).join('');
    res.send(page(req, {
      title: 'Home', active: '/member',
      body: `<h1>Hey, ${escapeHtml(name)} 👋</h1><div class="member-nav-cards">${cards}</div><h2>Your recent requests</h2>${recentHtml}`,
    }));
  });

  // Request a title: search Seerr, pick a result, set options, submit.
  app.get('/member/request', requireMember, (_req, res) => {
    res.send(page(_req, {
      title: 'Request', active: '/member/request',
      body: `<h1>🎬 Request a movie or show</h1>
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
    res.send(page(req, { title: 'My Requests', active: '/member/requests', body: `<h1>🧾 My requests</h1>${listHtml}${cancelHtml}` }));
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
