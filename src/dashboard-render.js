'use strict';

const { fmtDuration, fmtSpace } = require('./util');
const { normalizeTierFolders, serializeTierFolders } = require('./tier-node-setup');

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
  .topbar-search { flex:1 1 280px; max-width:480px; display:flex; gap:8px; }
  .topbar-search input { width:100%; min-width:100px; padding:9px 11px; border-radius:9px; border:1px solid var(--border); background:var(--panel); color:var(--text); font-size:14px; }
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
  .item-actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
  .item-actions .btn { min-height:34px; padding:7px 10px; font-size:12px; }
  .action-result { display:block; min-height:16px; margin-top:6px; font-size:12.5px; color:var(--muted); }
  .action-result.ok { color:var(--ok); } .action-result.bad { color:#fca5a5; }
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
  .login-card .btn.passkey { width:100%; margin-bottom:14px; }
  .login-divider { display:flex; align-items:center; gap:10px; color:var(--muted); font-size:11px; margin:0 0 14px; }
  .login-divider::before, .login-divider::after { content:''; flex:1; border-top:1px solid var(--border); }
  .error { background:rgba(239,68,68,.12); border:1px solid var(--down); color:#fca5a5; padding:10px 12px; border-radius:10px; font-size:13px; margin-bottom:16px; }
  .chip.tab { cursor:pointer; font:inherit; font-size:13px; }
  .chip.tab[aria-selected="true"] { background:var(--accent); color:#131316; border-color:var(--accent); font-weight:650; }
  .panel[hidden] { display:none; }
  .panel-intro { color:var(--muted); font-size:13px; margin:0 0 14px; }
  .card h2 .sub { display:block; text-transform:none; letter-spacing:0; font-weight:400; color:var(--muted); font-size:12px; margin-top:4px; }
  .setting { display:flex; flex-wrap:wrap; gap:10px 14px; align-items:center; justify-content:space-between; padding:11px 0; border-bottom:1px solid var(--border); }
  .setting:last-of-type { border-bottom:none; }
  .setting-main { flex:1 1 240px; min-width:0; }
  .setting-name { font-size:14px; }
  .setting-help { font-size:12px; color:var(--muted); margin-top:3px; }
  .setting-ctl { flex:0 0 auto; display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .setting-ctl input[type=number] { width:96px; padding:9px 10px; border-radius:9px; border:1px solid var(--border); background:#131316; color:var(--text); font-size:15px; }
  .setting-ctl input[type=text], .setting-foot input[type=text] { min-width:180px; padding:9px 10px; border-radius:9px; border:1px solid var(--border); background:#131316; color:var(--text); font-size:14px; }
  .setting-ctl .unit { font-size:12px; color:var(--muted); min-width:34px; }
  .switch { position:relative; width:46px; height:26px; flex:0 0 auto; }
  .switch input { opacity:0; width:100%; height:100%; margin:0; cursor:pointer; }
  .switch .track { position:absolute; inset:0; border-radius:999px; background:var(--panel2); border:1px solid var(--border); pointer-events:none; transition:background .15s; }
  .switch .track::after { content:''; position:absolute; top:3px; left:3px; width:18px; height:18px; border-radius:50%; background:var(--muted); transition:transform .15s, background .15s; }
  .switch input:checked + .track { background:rgba(229,160,13,.25); border-color:var(--accent); }
  .switch input:checked + .track::after { transform:translateX(20px); background:var(--accent); }
  .tag { font-size:10.5px; text-transform:uppercase; letter-spacing:.04em; padding:3px 7px; border-radius:999px; border:1px solid var(--border); color:var(--muted); }
  .tag.on { border-color:var(--accent); color:var(--accent); }
  .setting-foot { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-top:14px; }
  .save-note { font-size:12.5px; color:var(--muted); }
  .save-note.ok { color:var(--ok); } .save-note.bad { color:#fca5a5; }
  .setup-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:10px; }
  .setup-grid label { display:flex; flex-direction:column; gap:5px; color:var(--muted); font-size:12px; }
  .setup-grid input, .setup-grid select { width:100%; padding:10px; border-radius:9px; border:1px solid var(--border); background:#131316; color:var(--text); font-size:14px; }
  .setup-subheading { margin:16px 0 4px; font-size:14px; }
  #tier-folder-list { display:flex; flex-direction:column; gap:8px; margin:10px 0; }
  .tier-folder-row { display:grid; grid-template-columns:minmax(150px,.7fr) minmax(240px,1.3fr) auto; gap:8px; align-items:end; }
  .tier-folder-row label { display:flex; flex-direction:column; gap:5px; color:var(--muted); font-size:12px; }
  .tier-folder-row input { width:100%; padding:10px; border-radius:9px; border:1px solid var(--border); background:#131316; color:var(--text); font-size:14px; }
  .tier-folder-remove { min-height:39px; padding:8px 11px; }
  .setup-check { display:flex; align-items:center; gap:8px; color:var(--text); font-size:13px; margin:12px 0; }
  .setup-output { white-space:pre-wrap; overflow-wrap:anywhere; background:#131316; border:1px solid var(--border); border-radius:10px; padding:12px; font-size:12px; }
  .setup-warning { color:#fca5a5; font-size:12.5px; }
  @media (max-width:560px) {
    .topbar { flex-wrap:wrap; }
    .topbar-search { order:3; flex-basis:100%; max-width:none; }
    .item { flex-wrap:wrap; }
    .item-right { flex-basis:100%; max-width:none; text-align:left; margin-left:19px; margin-top:2px; }
    .actions .btn { flex:1 1 45%; }
    .tier-folder-row { grid-template-columns:1fr; padding:10px; border:1px solid var(--border); border-radius:10px; }
    .tier-folder-remove { justify-self:start; }
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

// `tabs: true` turns the nav into panel switches rather than scroll anchors. The panels are all
// server-rendered and present in the DOM; the script only toggles which one is visible, so the
// page still works as one long document if scripting is unavailable (nothing is hidden until the
// script runs). The active tab lives in location.hash so the 60s auto-refresh comes back to it.
function renderPage(title, bodyHtml, { showLogout = false, showSearch = false, searchQuery = '', nav = [], autoRefresh = false, tabs = false } = {}) {
  const navHtml = nav.length
    ? `<nav class="nav" role="tablist">${nav.map(([id, label]) => (tabs
      ? `<button class="chip tab" role="tab" type="button" data-tab="${escapeHtml(id)}" aria-selected="false">${escapeHtml(label)}</button>`
      : `<a class="chip" href="#${escapeHtml(id)}">${escapeHtml(label)}</a>`)).join('')}</nav>`
    : '';
  const tabScript = tabs ? `<script>
    (function () {
      var tabButtons = [].slice.call(document.querySelectorAll('.chip.tab'));
      var panels = [].slice.call(document.querySelectorAll('.panel'));
      function show(id) {
        if (!panels.some(function (p) { return p.dataset.panel === id; })) id = panels[0] && panels[0].dataset.panel;
        panels.forEach(function (p) { p.hidden = p.dataset.panel !== id; });
        tabButtons.forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === id)); });
        if (id) history.replaceState(null, '', '#' + id);
      }
      tabButtons.forEach(function (b) { b.addEventListener('click', function () { show(b.dataset.tab); window.scrollTo(0, 0); }); });
      show((location.hash || '').slice(1));
    })();
  </script>` : '';
  // Auto-refresh pauses while the tab is hidden so a backgrounded phone doesn't burn
  // battery/API calls re-checking every integration.
  const refreshScript = autoRefresh ? `<script>
    (function () {
      var t;
      function editing() {
        var el = document.activeElement;
        return !!el && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName);
      }
      // Never reload mid-edit — a refresh while someone is typing a threshold would discard it.
      function arm() { t = setTimeout(function () { if (editing() || window.__dirtySettings) arm(); else location.reload(); }, 60000); }
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
      ${showSearch ? `<form class="topbar-search" method="get" action="/admin/search"><input type="search" name="q" value="${escapeHtml(searchQuery)}" minlength="2" placeholder="Search requests, users, library, audit" aria-label="Search dashboard"><button class="btn" type="submit">Search</button></form>` : ''}
      ${showLogout ? '<form class="logout" method="post" action="/admin/logout"><button class="btn" type="submit">Log out</button></form>' : ''}
    </div>
    ${navHtml}
  </header>
  <div class="container">${bodyHtml}</div>
  ${tabScript}
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
        ${i.actions?.length ? `<div class="item-actions">${i.actions.map(action => `<button class="btn${action.danger ? ' danger' : ''}" type="button"${action.setupNode ? ` data-setup-node="${escapeHtml(action.setupNode)}"` : ` data-post="${escapeHtml(action.url)}" data-body="${escapeHtml(JSON.stringify(action.body || {}))}"`}${action.confirm ? ` data-confirm="${escapeHtml(action.confirm)}"` : ''}${action.inline ? ' data-inline="true"' : ''}${action.disabled ? ' disabled' : ''}${action.title ? ` title="${escapeHtml(action.title)}"` : ''}>${escapeHtml(action.label)}</button>`).join('')}</div>${i.actions.some(action => action.inline) ? '<span class="action-result" aria-live="polite"></span>' : ''}` : ''}
      </div>
      ${i.right ? `<div class="item-right">${escapeHtml(i.right)}</div>` : ''}
    </div>`).join('')}</div>`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function tierInstallCommand({ botUrl, node, token, folders, folderRoot, syncthingApiKey, syncthingFolderId, mountRoot, mountMarker }) {
  const normalizedFolders = normalizeTierFolders(folders || [{ id: syncthingFolderId, path: folderRoot }]);
  const env = [
    `TIER_AGENT_TOKEN="$TIER_AGENT_TOKEN"`,
    `SYNCTHING_API_KEY=${shellQuote(syncthingApiKey)}`,
    `TIER_FOLDERS=${shellQuote(serializeTierFolders(normalizedFolders))}`,
  ];
  if (mountRoot) env.push(`TIER_MOUNT_ROOT=${shellQuote(mountRoot)}`);
  if (mountMarker) env.push(`TIER_MOUNT_MARKER=${shellQuote(mountMarker)}`);
  return [
    `export TIER_AGENT_TOKEN=${shellQuote(token)}`,
    `curl -fsSL -H "Authorization: Bearer $TIER_AGENT_TOKEN" ${shellQuote(`${botUrl}/agent/install/${node}`)} \\`,
    `  | sudo -E env ${env.join(' ')} sh`,
    'unset TIER_AGENT_TOKEN',
  ].join('\n');
}

function tierNodeStatus(plan, report, now = Date.now()) {
  const checkIn = plan?.lastHeartbeatAt || (report ? sqliteUtcMs(report.at) : null);
  const publishedHash = plan?.published?.planHash || null;
  const convergedHash = plan?.converged?.planHash || null;
  const matches = !!publishedHash && publishedHash === convergedHash;
  const errors = plan?.lastErrors?.length ? plan.lastErrors.join('; ') : report?.errors;
  const details = [
    publishedHash ? `last plan ${publishedHash}` : 'no plan published',
    checkIn ? `last check-in ${fmtDuration(Math.max(0, now - checkIn))} ago` : 'never checked in',
    report?.bytesFreed ? `freed ${fmtSpace(report.bytesFreed)} last run` : 'freed 0 B last run',
    publishedHash ? `published manifest ${matches ? 'matches' : 'does not match'} last confirmed plan` : null,
    errors ? `errors: ${errors}` : null,
  ].filter(Boolean).join(' · ');
  if (!checkIn) return { state: 'warn', status: 'never reported', details, setup: true };
  if (matches && now - checkIn > 45 * 60 * 1000) return { state: 'down', status: 'stale', details };
  if (matches) return { state: errors ? 'warn' : 'ok', status: errors ? 'converged with errors' : 'converged', details };
  return { state: 'warn', status: 'reported, not converged', details };
}

function renderTierNodeSetup(nodes) {
  const options = nodes.map(node => `<option value="${escapeHtml(node.name)}" data-folders="${escapeHtml(JSON.stringify(node.folders || []))}">${escapeHtml(node.name)}</option>`).join('');
  const firstFolders = nodes[0]?.folders || [];
  const folderRows = Array.from({ length: Math.max(4, firstFolders.length) }, (_, index) => {
    const folder = firstFolders[index] || {};
    return `<div class="tier-folder-row">
      <label>Syncthing folder ID ${index + 1}<input name="folderId" value="${escapeHtml(folder.folderId || folder.id || '')}" placeholder="e.g. movies"></label>
      <label>Local folder path ${index + 1}<input name="folderRoot" value="${escapeHtml(folder.folderRoot || folder.path || '')}" placeholder="/mnt/media/Media/Movies"></label>
      <button class="btn tier-folder-remove" type="button" aria-label="Remove folder ${index + 1}">Remove</button>
    </div>`;
  }).join('');
  return `<div class="card" id="tier-node-setup">
    <h2>Tier Node Setup<span class="sub">Register a node, then generate its complete one-time install command.</span></h2>
    <form id="tier-register-form">
      <div class="setup-grid">
        <label>Node name<input name="name" pattern="[a-z0-9][a-z0-9_-]{0,63}" required></label>
        <label>Usable capacity (GB)<input name="usableGb" type="number" min="1" step="1" required></label>
        <label>Access<select name="access"><option value="open">Full</option><option value="restricted">Restricted</option></select></label>
        <label>Demand source<select name="demandSource"><option value="tautulli">Tautulli</option><option value="plex">Plex</option><option value="atime">File access time</option></select></label>
      </div>
      <label class="setup-check"><input name="full" type="checkbox"> Keep a full master copy on this node</label>
      <button class="btn primary" type="submit">Register node</button>
      <span class="save-note" id="tier-register-note"></span>
    </form>
    ${nodes.length ? `<form id="tier-install-form">
      <h2>Generate install command</h2>
      <div class="setup-grid">
        <label>Node<select name="node">${options}</select></label>
        <label>SYNCTHING_API_KEY<input name="syncthingApiKey" type="password" autocomplete="off" required></label>
        <label>TIER_MOUNT_ROOT (optional)<input name="mountRoot" placeholder="/mnt/media"></label>
        <label>TIER_MOUNT_MARKER (optional)<input name="mountMarker" placeholder=".tier-media-ok"></label>
      </div>
      <h3 class="setup-subheading">Syncthing folders</h3>
      <p class="muted">Enter every folder ID exactly as Syncthing shows it and the matching local path on this node. Four rows are ready; add more if needed.</p>
      <div id="tier-folder-list">${folderRows}</div>
      <button class="btn" id="tier-folder-add" type="button">Add folder</button>
      <p class="setup-warning">Generating saves this complete folder list and rotates the node token immediately. Run the command as an administrator who can use sudo; any existing agent using the old token stops checking in.</p>
      <button class="btn danger" type="submit">Rotate token and generate command</button>
      <span class="save-note" id="tier-install-note"></span>
      <div id="tier-install-result" hidden><p class="setup-warning">This command is shown once. Copy it before leaving or reloading this page.</p><pre class="setup-output" id="tier-install-command"></pre><button class="btn" type="button" id="tier-copy-command">Copy command</button></div>
    </form>` : '<p class="muted">Register a node to generate its install command.</p>'}
  </div>`;
}

function renderLogin(isError, message, { passkeyEnabled = false } = {}) {
  const banner = message ? `<div class="error">${escapeHtml(message)}</div>`
    : (isError ? '<div class="error">Incorrect password. Please try again.</div>' : '');
  const body = `<div class="login-wrap"><div class="login-card">
    <h1><span class="brand">Durant</span> Media Server</h1>
    <p>Admin dashboard login</p>
    ${banner}
    ${passkeyEnabled ? '<button class="btn primary passkey" type="button" id="passkey-login">Sign in with a passkey</button><div class="login-divider">password fallback</div>' : ''}
    <form method="post" action="/admin/login">
      <label for="password">Password</label>
      <input type="password" id="password" name="password"${passkeyEnabled ? '' : ' autofocus'} autocomplete="current-password webauthn" required>
      <button class="btn primary" type="submit">Log in</button>
    </form>
  </div></div>${passkeyEnabled ? `<script src="/admin/webauthn-browser.js"></script><script>
    document.getElementById('passkey-login').addEventListener('click', async function () {
      var button = this;
      var banner = document.querySelector('.error');
      button.disabled = true;
      try {
        var optionsResponse = await fetch('/admin/passkey/authentication-options', { cache: 'no-store' });
        var optionsJSON = await optionsResponse.json();
        if (!optionsResponse.ok) throw new Error(optionsJSON.error || 'Could not start passkey sign-in.');
        var response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: optionsJSON });
        var verificationResponse = await fetch('/admin/passkey/authenticate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(response) });
        var result = await verificationResponse.json();
        if (!verificationResponse.ok || !result.verified) throw new Error(result.error || 'Passkey sign-in failed.');
        location.assign('/admin');
      } catch (error) {
        if (!banner) { banner = document.createElement('div'); banner.className = 'error'; document.querySelector('.login-card p').after(banner); }
        banner.textContent = error.message || String(error);
        button.disabled = false;
      }
    });
  </script>` : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login — Durant Media Server</title><style>${DASHBOARD_CSS}</style></head>
  <body>${body}</body></html>`;
}

function renderPasskeyManagement(passkeys, rpID) {
  const rows = passkeys.length ? passkeys.map(passkey => `<div class="setting" data-passkey="${escapeHtml(passkey.credential_id)}">
    <div class="setting-main"><div class="setting-name">${escapeHtml(passkey.label)}</div><div class="setting-help">Created ${escapeHtml(new Date(passkey.created_at).toISOString())}${passkey.last_used_at ? ` · last used ${escapeHtml(new Date(passkey.last_used_at).toISOString())}` : ' · never used'}</div></div>
    <div class="setting-ctl"><input type="text" value="${escapeHtml(passkey.label)}" maxlength="64" aria-label="Passkey label"><button class="btn" type="button" data-passkey-rename>Rename</button><button class="btn danger" type="button" data-passkey-revoke>Revoke</button></div>
  </div>`).join('') : '<p class="muted">No passkeys enrolled.</p>';
  return `<div class="card" id="passkeys">
    <h2>Passkeys<span class="sub">Platform passkeys for ${escapeHtml(rpID)}. The tunnel hostname is the relying-party ID and cannot be changed without enrolling again.</span></h2>
    ${rows}
    <div class="setting-foot"><input type="text" id="passkey-label" maxlength="64" placeholder="Device label, e.g. Caleb's iPhone" aria-label="New passkey label"><button class="btn primary" type="button" id="passkey-enroll">Enroll passkey</button><span class="save-note" id="passkey-note"></span></div>
  </div>`;
}

function renderStat(label, value) {
  return `<div class="stat"><div class="n">${escapeHtml(String(value))}</div><div class="l">${escapeHtml(label)}</div></div>`;
}

function healthClass(v) {
  if (['ok', 'configured'].includes(v)) return 'ok';
  if (v === 'skipped' || v === 'disabled') return 'skip';
  if (v === 'down' || v === 'missing') return 'down';
  return 'warn';
}

function renderHealthBadges(health) {
  const keys = ['discord', 'sqlite', 'backup', 'plex', 'overseerr', 'radarr', 'radarr4k', 'sonarr', 'prowlarr', 'byparr', 'raidPath', 'tunnelDomain'];
  return keys.filter(k => health[k] !== undefined)
    .map(k => {
      const age = k === 'backup' && health.backupLastSuccessfulAt ? ` · ${fmtAgo(health.backupLastSuccessfulAt)}` : '';
      return `<span class="badge"><span class="dot ${healthClass(health[k])}"></span>${escapeHtml(k)}: ${escapeHtml(String(health[k]))}${escapeHtml(age)}</span>`;
    })
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

// One card per automation group: every knob shows what is in force, and whether that value came
// from compose or from an override made here. "Overridden" is called out explicitly — a value
// silently diverging from the stack file is exactly the confusion this UI could otherwise cause.
function renderSettingsGroup(group) {
  const previewable = ['stuck', 'escalation', 'season_pack', 'episode_recovery'].includes(group.id);
  const rows = group.settings.map(setting => {
    const id = `set_${escapeHtml(setting.key)}`;
    const control = setting.type === 'bool'
      ? `<label class="switch"><input type="checkbox" id="${id}" data-key="${escapeHtml(setting.key)}" data-type="bool"${setting.value ? ' checked' : ''}><span class="track"></span></label>`
      : `<input type="number" id="${id}" data-key="${escapeHtml(setting.key)}" data-type="int" value="${escapeHtml(setting.value)}" min="${setting.min}" max="${setting.max}" step="1" inputmode="numeric">
         <span class="unit">${escapeHtml(setting.unit || '')}</span>`;
    const origin = setting.overridden
      ? `<span class="tag on" title="Compose says ${escapeHtml(setting.envValue)}">overridden</span>`
      : '<span class="tag">compose</span>';
    return `<div class="setting">
      <div class="setting-main">
        <div class="setting-name"><label for="${id}">${escapeHtml(setting.label)}</label></div>
        ${setting.help ? `<div class="setting-help">${escapeHtml(setting.help)}</div>` : ''}
      </div>
      <div class="setting-ctl">${origin}${control}</div>
    </div>`;
  }).join('');
  return `<div class="card" data-group="${escapeHtml(group.id)}">
    <h2>${escapeHtml(group.title)}<span class="sub">${escapeHtml(group.blurb)}</span></h2>
    ${rows}
    <div class="setting-foot">
      <button class="btn primary" type="button" data-save="${escapeHtml(group.id)}">Save changes</button>
      ${previewable ? `<button class="btn" type="button" data-preview="${escapeHtml(group.id)}">Preview</button>` : ''}
      <button class="btn" type="button" data-reset="${escapeHtml(group.id)}">Reset to compose</button>
      <span class="save-note" data-note="${escapeHtml(group.id)}"></span>
    </div>
    ${previewable ? `<div class="setting-preview" data-preview-result="${escapeHtml(group.id)}" aria-live="polite"></div>` : ''}
  </div>`;
}

module.exports = {
  renderSettingsGroup,
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
  tierInstallCommand,
  tierNodeStatus,
  renderTierNodeSetup,
  renderPasskeyManagement,
};
