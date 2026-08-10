'use strict';

const { fmtDuration } = require('./util');

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

// ---- Dashboard rendering (dark Plex/Overseerr-style theme, all inline, no build step) ----

// Mobile-first: sticky header with a horizontally-scrolling section nav, activity rendered as
// touch-friendly item rows with progress bars, and tables that collapse into labeled cards on
// narrow screens. All inline, no build step, dark Plex/Overseerr look.
const DASHBOARD_CSS = `
  :root { --bg:#131316; --panel:#1d1e23; --panel2:#26272e; --accent:#e5a00d; --text:#ececf0; --muted:#9aa0a6; --border:#33343c; --ok:#22c55e; --warn:#f59e0b; --down:#ef4444; --skip:#6b7280; }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--text); padding-bottom:env(safe-area-inset-bottom); }
  header.hdr { position:sticky; top:0; z-index:20; background:rgba(19,19,22,.94); backdrop-filter:blur(10px); border-bottom:1px solid var(--border); padding-top:env(safe-area-inset-top); }
  .topbar { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px 16px 8px; }
  .topbar h1 { margin:0; font-size:16px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .topbar .brand { color:var(--accent); }
  .nav { display:flex; gap:8px; overflow-x:auto; padding:4px 16px 10px; scrollbar-width:none; }
  .nav::-webkit-scrollbar { display:none; }
  .chip { flex:0 0 auto; padding:7px 14px; border-radius:999px; background:var(--panel2); border:1px solid var(--border); color:var(--text); font-size:13px; text-decoration:none; }
  .chip:hover, .chip:active { border-color:var(--accent); }
  .container { max-width:1100px; margin:0 auto; padding:16px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:14px 16px; margin-bottom:14px; scroll-margin-top:110px; }
  .card h2 { margin:0 0 10px; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; }
  .overall { display:flex; flex-wrap:wrap; gap:6px 14px; align-items:baseline; justify-content:space-between; padding:12px 16px; border-radius:14px; margin-bottom:14px; font-size:14px; }
  .overall.ok { background:rgba(34,197,94,.10); border:1px solid rgba(34,197,94,.5); }
  .overall.warn { background:rgba(245,158,11,.10); border:1px solid rgba(245,158,11,.5); }
  .overall .updated { color:var(--muted); font-size:12px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(118px,1fr)); gap:10px; margin-bottom:14px; }
  .stat { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:12px 14px; }
  .stat .n { font-size:22px; font-weight:700; color:var(--accent); line-height:1.2; }
  .stat .l { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; margin-top:2px; }
  .badges { display:flex; flex-wrap:wrap; gap:8px; }
  .badge { display:inline-flex; align-items:center; gap:6px; padding:7px 11px; border-radius:999px; font-size:12.5px; background:var(--panel2); border:1px solid var(--border); }
  .dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; }
  .dot.ok { background:var(--ok); } .dot.warn { background:var(--warn); } .dot.down { background:var(--down); } .dot.skip { background:var(--skip); }
  .items { display:flex; flex-direction:column; }
  .item { display:flex; gap:10px; align-items:flex-start; padding:10px 0; border-bottom:1px solid var(--border); }
  .item:last-child { border-bottom:none; }
  .item > .dot { margin-top:6px; }
  .item-main { flex:1 1 auto; min-width:0; }
  .item-title { font-size:14px; font-weight:600; overflow-wrap:anywhere; }
  .item-sub { font-size:12.5px; color:var(--muted); margin-top:2px; overflow-wrap:anywhere; }
  .item-right { flex:0 0 auto; font-size:12px; color:var(--muted); text-align:right; max-width:42%; overflow-wrap:anywhere; }
  .bar { height:6px; background:var(--panel2); border-radius:999px; margin-top:7px; overflow:hidden; }
  .bar-fill { height:100%; background:var(--accent); border-radius:999px; }
  .bar-fill.hot { background:var(--ok); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border); white-space:nowrap; max-width:340px; overflow:hidden; text-overflow:ellipsis; }
  th { color:var(--muted); font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:.04em; }
  tbody tr:nth-child(odd) { background:rgba(255,255,255,.02); }
  .table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
  .muted { color:var(--muted); font-style:italic; font-size:13px; }
  .actions { display:flex; flex-wrap:wrap; gap:10px; }
  .btn { display:inline-flex; align-items:center; justify-content:center; min-height:42px; padding:10px 16px; border-radius:10px; background:var(--panel2); color:var(--text); border:1px solid var(--border); text-decoration:none; font-size:13px; cursor:pointer; }
  .btn:hover { border-color:var(--accent); }
  .btn.danger { border-color:var(--down); color:#fca5a5; }
  .btn.primary { background:var(--accent); color:#131316; border-color:var(--accent); font-weight:600; }
  form.logout { margin:0; }
  .login-wrap { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px; }
  .login-card { width:100%; max-width:360px; background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:28px; }
  .login-card h1 { margin:0 0 4px; font-size:20px; }
  .login-card h1 .brand { color:var(--accent); }
  .login-card p { margin:0 0 20px; color:var(--muted); font-size:13px; }
  .login-card label { display:block; font-size:12px; color:var(--muted); margin-bottom:6px; }
  .login-card input { width:100%; padding:12px; border-radius:10px; border:1px solid var(--border); background:#131316; color:var(--text); font-size:16px; margin-bottom:16px; }
  .login-card .btn.primary { width:100%; text-align:center; }
  .error { background:rgba(239,68,68,.12); border:1px solid var(--down); color:#fca5a5; padding:10px 12px; border-radius:10px; font-size:13px; margin-bottom:16px; }
  @media (max-width:560px) {
    .item { flex-wrap:wrap; }
    .item-right { flex-basis:100%; max-width:none; text-align:left; margin-left:19px; margin-top:2px; }
    .actions .btn { flex:1 1 45%; }
  }
  @media (max-width:640px) {
    table, tbody, tr, td { display:block; }
    thead { display:none; }
    tbody tr { border:1px solid var(--border); border-radius:12px; margin-bottom:10px; padding:8px 12px; background:var(--panel2); }
    tbody tr:nth-child(odd) { background:var(--panel2); }
    td { border:none; padding:3px 0; white-space:normal; max-width:none; display:flex; gap:10px; overflow:visible; }
    td::before { content:attr(data-label); flex:0 0 84px; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; padding-top:2px; }
  }
`;

function renderPage(title, bodyHtml, { showLogout = false, nav = [], autoRefresh = false } = {}) {
  const navHtml = nav.length
    ? `<nav class="nav">${nav.map(([id, label]) => `<a class="chip" href="#${escapeHtml(id)}">${escapeHtml(label)}</a>`).join('')}</nav>`
    : '';
  // Auto-refresh pauses while the tab is hidden so a backgrounded phone doesn't burn
  // battery/API calls re-checking every integration.
  const refreshScript = autoRefresh ? `<script>
    (function () {
      var t;
      function arm() { t = setTimeout(function () { location.reload(); }, 60000); }
      document.addEventListener('visibilitychange', function () { if (document.hidden) clearTimeout(t); else arm(); });
      if (!document.hidden) arm();
    })();
  </script>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#131316">
  <title>${escapeHtml(title)} — Durant Media Server</title>
  <style>${DASHBOARD_CSS}</style></head><body>
  <header class="hdr">
    <div class="topbar">
      <h1><span class="brand">Durant</span> Media Server</h1>
      ${showLogout ? '<form class="logout" method="post" action="/admin/logout"><button class="btn" type="submit">Log out</button></form>' : ''}
    </div>
    ${navHtml}
  </header>
  <div class="container">${bodyHtml}</div>
  ${refreshScript}
  </body></html>`;
}

// Epoch ms from a SQLite CURRENT_TIMESTAMP string ('YYYY-MM-DD HH:MM:SS', UTC) or anything
// Date.parse understands; null when unparseable.
function sqliteUtcMs(v) {
  if (typeof v === 'number') return v;
  const s = String(v || '');
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  return Number.isFinite(t) ? t : null;
}

// '3m ago' / 'in 2h' for dashboard rows; empty string when the timestamp is unknown.
function fmtAgo(ts) {
  const t = typeof ts === 'number' ? ts : sqliteUtcMs(ts);
  if (!Number.isFinite(t) || !t) return '';
  const d = Date.now() - t;
  return d >= 0 ? `${fmtDuration(d)} ago` : `in ${fmtDuration(-d)}`;
}

function renderBar(pct) {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  return `<div class="bar"><div class="bar-fill${p >= 95 ? ' hot' : ''}" style="width:${p}%"></div></div>`;
}

// Touch-friendly activity rows: state dot, title + sub, optional right-side metric and
// progress bar. Wraps gracefully on small screens (see the 560px media query).
function renderItemList(items, emptyText = 'Nothing right now.') {
  if (!items || !items.length) return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  return `<div class="items">${items.map(i => `
    <div class="item">
      <span class="dot ${['ok', 'warn', 'down', 'skip'].includes(i.state) ? i.state : 'skip'}"></span>
      <div class="item-main">
        <div class="item-title">${escapeHtml(i.title || '')}</div>
        ${i.sub ? `<div class="item-sub">${escapeHtml(i.sub)}</div>` : ''}
        ${typeof i.pct === 'number' ? renderBar(i.pct) : ''}
      </div>
      ${i.right ? `<div class="item-right">${escapeHtml(i.right)}</div>` : ''}
    </div>`).join('')}</div>`;
}

function renderLogin(isError, message) {
  const banner = message ? `<div class="error">${escapeHtml(message)}</div>`
    : (isError ? '<div class="error">Incorrect password. Please try again.</div>' : '');
  const body = `<div class="login-wrap"><div class="login-card">
    <h1><span class="brand">Durant</span> Media Server</h1>
    <p>Admin dashboard login</p>
    ${banner}
    <form method="post" action="/admin/login">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autofocus autocomplete="current-password" required>
      <button class="btn primary" type="submit">Log in</button>
    </form>
  </div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login — Durant Media Server</title><style>${DASHBOARD_CSS}</style></head>
  <body>${body}</body></html>`;
}

function renderStat(label, value) {
  return `<div class="stat"><div class="n">${escapeHtml(String(value))}</div><div class="l">${escapeHtml(label)}</div></div>`;
}

function healthClass(v) {
  if (['ok', 'configured'].includes(v)) return 'ok';
  if (v === 'skipped') return 'skip';
  if (v === 'down' || v === 'missing') return 'down';
  return 'warn';
}

function renderHealthBadges(health) {
  const keys = ['discord', 'sqlite', 'plex', 'overseerr', 'radarr', 'radarr4k', 'sonarr', 'prowlarr', 'byparr', 'raidPath', 'tunnelDomain'];
  return keys.filter(k => health[k] !== undefined)
    .map(k => `<span class="badge"><span class="dot ${healthClass(health[k])}"></span>${escapeHtml(k)}: ${escapeHtml(String(health[k]))}</span>`)
    .join('');
}

// data-label on every cell powers the mobile collapse: under 640px the table becomes a stack
// of labeled cards (CSS-only, no JS).
function renderTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '<p class="muted">No records.</p>';
  const cols = Object.keys(rows[0]);
  const head = cols.map(c => `<th>${escapeHtml(c)}</th>`).join('');
  const bodyRows = rows.map(r => `<tr>${cols.map(c => {
    const v = r[c];
    const text = escapeHtml(v == null ? '' : String(v));
    return `<td data-label="${escapeHtml(c)}" title="${text}">${text}</td>`;
  }).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
}

function renderSection(title, rows) {
  return `<div class="card"><h2>${escapeHtml(title)}</h2>${renderTable(rows)}</div>`;
}

module.exports = {
  DASHBOARD_CSS,
  escapeHtml,
  renderPage,
  sqliteUtcMs,
  fmtAgo,
  renderBar,
  renderItemList,
  renderLogin,
  renderStat,
  healthClass,
  renderHealthBadges,
  renderTable,
  renderSection,
};
