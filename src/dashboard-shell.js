'use strict';

// The admin dashboard's app shell: navigation (a bottom bar on phones, a side rail from 721px),
// the More sheet, and the live layer that keeps every part of the page current without reloading
// it. Server-rendered parts marked data-live="name" are re-fetched from /admin/fragment/name and
// merged into the page in place (morph), so only what changed moves: an open sheet, a half-typed
// field or a running animation is never interrupted. The Services board uses the same morph for
// its JSON-driven render.

const ICONS = Object.freeze({
  home: '<path d="M4 11 12 4l8 7v9h-5v-6H9v6H4z"/>',
  requests: '<path d="M5 6h14M5 12h14M5 18h9"/>',
  network: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01"/>',
  automation: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  more: '<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>',
  fleet: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1.2-3.5 3.6-5 6.5-5s5.3 1.5 6.5 5M16 4.5a3.5 3.5 0 0 1 0 7M18 15c2 .6 3.2 2.2 3.8 5"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  services: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  plus: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v8M8 12h8"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  user: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20c1.4-3.8 4.2-5.5 7.5-5.5s6.1 1.7 7.5 5.5"/>',
  report: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8.2 7 10 4-1.8 7-5.5 7-10V6z"/>',
});

// Old tab names (bookmarks, links in DMs) still land somewhere sensible.
const TAB_ALIASES = Object.freeze({
  director: 'home', services: 'home', overview: 'home', operations: 'requests', edge: 'fleet', logs: 'activity',
});

function icon(name, size = 24) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// items: [{ id, label, icon, count?, more?, sub?, scrollTo? }]. The first non-`more` items go on
// the phone's bottom bar (at most four, then More); everything shows on the desktop rail.
function renderShellNav(items, { escapeHtml, showLogout = true } = {}) {
  const main = items.filter(i => !i.more);
  const more = items.filter(i => i.more);
  const badge = i => (i.count ? `<span class="nav-badge" data-count aria-label="${escapeHtml(String(i.count))} need attention">${escapeHtml(String(i.count))}</span>` : '');
  const target = i => `data-tab="${escapeHtml(i.id)}"${i.scrollTo ? ` data-scroll="${escapeHtml(i.scrollTo)}"` : ''}`;
  const railItem = i => `<button type="button" class="rail-item" ${target(i)}>${icon(i.icon, 20)}<span>${escapeHtml(i.label)}</span>${badge(i)}</button>`;
  const logout = showLogout ? '<form class="logout-form" method="post" action="/admin/logout"><button class="rail-item" type="submit">' + icon('logout', 20) + '<span>Log out</span></button></form>' : '';
  const rail = `<aside class="rail" aria-label="Dashboard sections">
    <div class="rail-brand"><span class="brand-mark" aria-hidden="true">d<span>l</span>.</span><span>Durant Media Server</span></div>
    <div class="rail-group">${main.map(railItem).join('')}</div>
    ${more.length ? `<div class="rail-label">More</div><div class="rail-group">${more.map(railItem).join('')}</div>` : ''}
    <div class="rail-foot"><div class="live-status" data-live-status role="status" aria-live="polite"><span class="live-dot"></span><span class="live-text">Live</span></div>${logout}</div>
  </aside>`;
  const barItem = i => `<button type="button" class="bb-item" ${target(i)}><span class="bb-pill">${icon(i.icon)}</span><span class="bb-label">${escapeHtml(i.label)}</span>${badge(i)}</button>`;
  const bar = `<nav class="bottombar" aria-label="Dashboard sections">${main.slice(0, 4).map(barItem).join('')}${
    `<button type="button" class="bb-item" data-more-open aria-haspopup="dialog" aria-controls="moreSheet"><span class="bb-pill">${icon('more')}</span><span class="bb-label">More</span></button>`}</nav>`;
  const sheetItems = [...main.slice(4), ...more];
  const sheet = `<div class="more-sheet" id="moreSheet" role="dialog" aria-modal="true" aria-label="More sections" hidden>
    <div class="more-scrim" data-more-close></div>
    <div class="more-panel"><div class="more-grab" aria-hidden="true"></div>
      ${sheetItems.map(i => `<button type="button" class="more-item" ${target(i)}><span class="more-ic">${icon(i.icon, 22)}</span><span><b>${escapeHtml(i.label)}</b>${i.sub ? `<small>${escapeHtml(i.sub)}</small>` : ''}</span>${badge(i)}</button>`).join('')}
      ${showLogout ? '<form class="logout-form" method="post" action="/admin/logout"><button class="more-item" type="submit"><span class="more-ic">' + icon('logout', 22) + '</span><span><b>Log out</b></span></button></form>' : ''}
    </div>
  </div>`;
  // Make Home yours: theme and Home's cards. Rows are built in the browser from the [data-home]
  // sections on the page, so a new card only needs the attribute to show up here.
  const homeSheet = `<div class="home-sheet" id="homeSheet" role="dialog" aria-modal="true" aria-labelledby="homeSheetTitle" hidden>
    <div class="more-scrim" data-home-close></div>
    <div class="more-panel"><div class="more-grab" aria-hidden="true"></div>
      <h2 class="he-title" id="homeSheetTitle">Make Home yours</h2>
      <div class="he-sec">Theme</div>
      <div class="he-seg" role="group" aria-label="Theme"><button type="button" data-theme-set="dark">Dark</button><button type="button" data-theme-set="light">Light</button><button type="button" data-theme-set="auto">Auto</button></div>
      <div class="he-sec">On the board</div><div id="heBoard"></div>
      <div class="he-sec">Below the board</div><div id="heMore"></div>
      <div class="he-foot"><button type="button" class="btn" data-home-reset>Reset Home</button><button type="button" class="btn primary" data-home-close>Done</button></div>
    </div>
  </div>`;
  // Detail sheet for openable rows ([data-rows-open]): a bottom sheet on the phone, a panel docked
  // on the right on wide screens. The row's own content and buttons are shown in it.
  const detailSheet = `<div class="detail-sheet" id="detailSheet" role="dialog" aria-modal="true" aria-label="Details" hidden>
    <div class="more-scrim" data-detail-close></div>
    <div class="more-panel detail-panel"><div class="more-grab" aria-hidden="true"></div>
      <button type="button" class="detail-x" data-detail-close aria-label="Close">×</button>
      <div id="detailBody"></div>
    </div>
  </div>`;
  return { rail, bar, sheet, homeSheet, detailSheet };
}

const SHELL_CSS = `
  /* ---- App shell: side rail (desktop), bottom bar + More sheet (phone) ---- */
  .rail { display:none; }
  .bottombar { position:fixed; left:0; right:0; bottom:0; z-index:40; display:flex; padding:6px 6px calc(6px + env(safe-area-inset-bottom));
    background:color-mix(in srgb, var(--panel) 94%, transparent); -webkit-backdrop-filter:blur(16px); backdrop-filter:blur(16px); border-top:1px solid var(--edge); }
  .bb-item { flex:1; min-width:0; min-height:56px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; position:relative;
    border:0; background:transparent; color:var(--faint); font:600 12px/1.2 var(--sans); cursor:pointer; padding:0; }
  .bb-pill { width:56px; height:30px; border-radius:999px; display:flex; align-items:center; justify-content:center; transition:background .3s cubic-bezier(.2,.75,.25,1), color .3s; }
  .bb-item[aria-current="page"] { color:var(--text); }
  .bb-item[aria-current="page"] .bb-pill { background:color-mix(in srgb, var(--accent) 22%, transparent); color:var(--accent); }
  .bb-label { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .nav-badge { min-width:18px; height:18px; padding:0 5px; box-sizing:border-box; border-radius:999px; background:var(--accent); color:var(--on-accent); font:700 10px/18px var(--mono); text-align:center; }
  .bb-item .nav-badge { position:absolute; top:3px; left:calc(50% + 8px); }
  body.shell { padding-bottom:calc(84px + env(safe-area-inset-bottom)); }
  .more-sheet { position:fixed; inset:0; z-index:60; display:flex; align-items:flex-end; }
  .more-sheet[hidden] { display:none; }
  .more-scrim { position:absolute; inset:0; background:rgba(0,0,0,.55); animation:shFade .25s ease both; }
  .more-panel { position:relative; width:100%; max-height:80vh; overflow:auto; background:var(--panel); border-top:1px solid var(--edge); border-radius:20px 20px 0 0;
    padding:10px 16px calc(84px + env(safe-area-inset-bottom)); animation:shUp .32s cubic-bezier(.2,.9,.25,1.1) both; }
  .more-grab { width:40px; height:4px; border-radius:99px; background:rgb(var(--tint) / .18); margin:0 auto 8px; }
  .more-item { width:100%; min-height:56px; display:flex; align-items:center; gap:14px; padding:0 6px; border:0; border-top:1px solid var(--border); background:transparent; color:var(--text); font:inherit; font-size:16px; text-align:left; cursor:pointer; }
  .more-panel > .more-item:first-of-type { border-top:0; }
  .more-item small { display:block; font-size:13px; color:var(--muted); font-weight:400; }
  .more-item b { font-weight:600; }
  .more-item .nav-badge { margin-left:auto; }
  .more-ic { width:40px; height:40px; border-radius:12px; background:var(--panel2); color:var(--accent); display:flex; align-items:center; justify-content:center; flex:none; }
  @keyframes shUp { from { transform:translateY(100%); } }
  @keyframes shFade { from { opacity:0; } }
  .hdr-live { display:flex; }
  .hdr-search-toggle { display:inline-flex; }
  .topbar-search { display:none; }
  .hdr.search-open .topbar-search { display:flex; position:absolute; left:12px; right:12px; top:calc(100% - 4px); z-index:2; }
  header.hdr { position:sticky; }
  .topbar { position:relative; }
  .hdr .logout { display:none; }
  @media (min-width:721px) {
    body.shell { padding-left:232px; padding-bottom:0; }
    .bottombar, .more-sheet, .hdr-search-toggle { display:none !important; }
    .rail { display:flex; flex-direction:column; gap:2px; position:fixed; top:0; bottom:0; left:0; width:232px; box-sizing:border-box; z-index:30;
      padding:calc(16px + env(safe-area-inset-top)) 12px 16px; border-right:1px solid var(--edge); background:color-mix(in srgb, var(--bg) 80%, transparent);
      -webkit-backdrop-filter:blur(18px); backdrop-filter:blur(18px); overflow-y:auto; }
    .rail-brand { display:flex; align-items:center; gap:10px; padding:2px 8px 18px; font-weight:700; letter-spacing:-.02em; font-size:15px; }
    .rail-group { display:flex; flex-direction:column; gap:2px; }
    .rail-label { padding:16px 12px 6px; font:400 11px var(--mono); letter-spacing:.14em; text-transform:uppercase; color:var(--faint); }
    .rail-item { width:100%; min-height:42px; display:flex; align-items:center; gap:12px; padding:0 12px; border:0; border-radius:9px; background:transparent;
      color:var(--muted); font:500 14.5px var(--sans); cursor:pointer; text-align:left; transition:background .25s, color .25s; }
    .rail-item:hover { color:var(--text); background:color-mix(in srgb, var(--accent) 8%, transparent); }
    .rail-item[aria-current="page"] { color:var(--text); background:color-mix(in srgb, var(--accent) 16%, transparent); }
    .rail-item[aria-current="page"] svg { color:var(--accent); }
    .rail-item .nav-badge { margin-left:auto; }
    .rail-foot { margin-top:auto; display:flex; flex-direction:column; gap:6px; padding-top:16px; }
    .rail-foot .live-status { padding:0 12px; }
    .topbar h1 { display:none; }
    .topbar-search { display:flex; }
    .hdr-live { display:none; }
    .topbar { justify-content:flex-end; }
  }
  .live-status { display:inline-flex; align-items:center; gap:7px; font-size:12px; color:var(--muted); white-space:nowrap; }
  .live-dot { width:7px; height:7px; border-radius:50%; background:var(--ok); box-shadow:0 0 9px color-mix(in srgb, var(--ok) 80%, transparent); animation:livePulse 2.2s ease-in-out infinite; }
  .live-status.stale .live-dot { background:var(--warn); box-shadow:0 0 9px color-mix(in srgb, var(--warn) 80%, transparent); animation-duration:1.2s; }
  .live-status.stale { color:var(--warn); }
  @keyframes livePulse { 50% { opacity:.4; } }
  /* Home: what needs you, the overall health line, the at-a-glance numbers. */
  .needs-card { display:flex; align-items:center; gap:12px; min-height:56px; text-decoration:none; color:var(--text); font-size:15px; }
  .needs-card b { font:400 18px var(--mono); }
  .needs-chev { margin-left:auto; color:var(--faint); font-size:20px; }
  .needs-dot { width:9px; height:9px; border-radius:50%; flex:none; background:var(--accent); box-shadow:0 0 10px color-mix(in srgb, var(--accent) 70%, transparent); }
  .overall-line { display:flex; align-items:center; gap:8px; margin:0 2px 12px; font-size:13px; color:var(--muted); }
  .overall-line.ok .needs-dot { background:var(--ok); box-shadow:0 0 10px color-mix(in srgb, var(--ok) 70%, transparent); }
  .overall-line.warn .needs-dot { background:var(--warn); box-shadow:0 0 10px color-mix(in srgb, var(--warn) 70%, transparent); }
  .glance .stats { grid-template-columns:repeat(auto-fit, minmax(104px, 1fr)); margin:0; }
  .glance .stat { padding:10px 12px; }
  .glance .stat .n { font-size:19px; }
  body.shell .svc-wrap { max-width:none; }
  body.shell .container { max-width:1280px; padding:18px 16px; }
  @media (min-width:721px) { body.shell .container { padding:22px 28px; } }
  /* Live updates: new rows rise in; changed numbers count; panels cross-fade when switching. */
  .live-enter { animation:liveIn .55s cubic-bezier(.2,.75,.25,1) backwards; }
  @keyframes liveIn { from { opacity:0; transform:translateY(10px); } }
  .panel:not([hidden]) { animation:panelIn .35s cubic-bezier(.2,.75,.25,1) backwards; }
  /* backwards, not both: a transform left on the panel would trap every position:fixed sheet inside it. */
  /* ---- Theme: dark (default), light, or follow the device ---- */
  :root { color-scheme:dark; }
  html[data-theme="light"] { --bg:#f3f6f7; --panel:#ffffff; --panel2:#eef3f5; --panel3:#e2eaee; --accent:#1d7c84; --accent-strong:#15646a; --on-accent:#ffffff; --text:#10232f; --muted:#3d5866; --faint:#5c7682; --border:#d3dee3; --line-strong:#9fb3bd; --edge:rgba(16,35,47,.16); --glass:rgba(255,255,255,.72); --cool:#4f7a2c; --ok:#1c8f5a; --warn:#a86b12; --down:#c2413a; --skip:#5c7682; --focus:#1d7c84; --tint:16 35 47; --well:rgba(16,35,47,.05); --down-ink:#b3332c; color-scheme:light; }
  @media (prefers-color-scheme: light) { html[data-theme="auto"] { --bg:#f3f6f7; --panel:#ffffff; --panel2:#eef3f5; --panel3:#e2eaee; --accent:#1d7c84; --accent-strong:#15646a; --on-accent:#ffffff; --text:#10232f; --muted:#3d5866; --faint:#5c7682; --border:#d3dee3; --line-strong:#9fb3bd; --edge:rgba(16,35,47,.16); --glass:rgba(255,255,255,.72); --cool:#4f7a2c; --ok:#1c8f5a; --warn:#a86b12; --down:#c2413a; --skip:#5c7682; --focus:#1d7c84; --tint:16 35 47; --well:rgba(16,35,47,.05); --down-ink:#b3332c; color-scheme:light; } }
  html[data-theme="light"] .svc-orb, html[data-theme="auto"] .svc-orb { opacity:.35; }
  /* ---- Segments: one list at a time ---- */
  .segs { display:flex; gap:6px; overflow-x:auto; scrollbar-width:none; margin:0 0 12px; padding:2px; }
  .segs::-webkit-scrollbar { display:none; }
  .seg-btn { flex:none; min-height:40px; padding:0 14px; border-radius:999px; border:1px solid var(--border); background:transparent; color:var(--muted); font:inherit; font-size:14px; font-weight:600; cursor:pointer; white-space:nowrap; }
  .seg-btn[aria-pressed="true"] { background:var(--accent); border-color:var(--accent); color:var(--on-accent); }
  details.set-group > summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:10px; min-height:44px; }
  details.set-group > summary::-webkit-details-marker { display:none; }
  details.set-group > summary h2 { margin:0; flex:1; min-width:0; }
  details.set-group > summary::after { content:"›"; color:var(--faint); font-size:20px; transition:transform .2s; }
  details.set-group[open] > summary::after { transform:rotate(90deg); }
  details.set-group > summary .tag { flex:none; }
  details.set-group[open] > summary { margin-bottom:10px; }
  .seg-btn .seg-n { font-family:var(--mono); font-size:12px; margin-left:4px; opacity:.8; }
  /* ---- Automation jobs: one line on the phone, a table on wide screens ---- */
  .job-col, .job-headrow { display:none; }
  #detailBody .job-col { display:none; }
  @media (min-width:1100px) {
    .job-table .job-headrow, .job-table .job-row { display:grid; grid-template-columns:12px minmax(150px,1.3fr) 110px 120px minmax(0,1.8fr) 110px 84px 14px; gap:12px; align-items:center; }
    .job-table .job-headrow { font-family:var(--mono); font-size:10.5px; letter-spacing:1px; text-transform:uppercase; color:var(--faint); padding:0 4px 8px; border-bottom:1px solid var(--border); }
    .job-table .job-row .item-sub { display:none; }
    .job-table .job-row .job-col { display:block; font-size:13px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
    .job-table .job-row .job-result.bad { color:var(--down); }
    .job-table .job-row .item-right { max-width:none; text-align:left; margin:0; }
    .job-table .job-row .item-main { min-width:0; }
  }
  /* ---- Tick several ---- */
  .pick { display:inline-flex; align-items:center; justify-content:center; min-width:32px; min-height:44px; margin:-10px 0 -10px -4px; cursor:pointer; flex:none; }
  .pick input { width:18px; height:18px; accent-color:var(--accent); cursor:pointer; }
  .picks-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:6px 0 4px; padding:6px 8px; border:1px solid var(--border); border-radius:12px; }
  .picks-bar .pick-all { margin:0; gap:8px; font-size:14px; }
  .picks-n { flex:1; min-width:0; font-size:13px; color:var(--muted); white-space:nowrap; }
  .picks-bar .btn { min-height:40px; padding:0 14px; }
  @media (max-width:480px) { .picks-bar { flex-wrap:nowrap; } .picks-bar .pick-all span { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); } }
  [data-picks].picking .picks-bar { border-color:var(--accent); background:color-mix(in srgb, var(--accent) 8%, transparent); }
  #detailBody .pick { display:none; }
  /* ---- People: the linked-users table stacks into cards until it fits as a table (1366px+) ---- */
  @media (max-width:1365px) {
    .people-table, .people-table tbody, .people-table tr, .people-table td { display:block; }
    .people-table thead { display:none; }
    .people-table tbody { display:grid; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr)); gap:10px; }
    .people-table tbody tr { border:1px solid var(--border); border-radius:12px; padding:8px 12px; background:var(--panel2); }
    .people-table td { border:none; padding:3px 0; white-space:normal; max-width:none; display:flex; gap:10px; overflow:visible; }
    .people-table td::before { content:attr(data-label); flex:0 0 84px; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; padding-top:2px; }
    .people-table .act-cell { width:auto; max-width:none; flex:1; min-width:0; }
    .people-table .act-title { white-space:normal; }
    .people-table td.user-actions { flex-wrap:wrap; }
  }
  /* ---- People: Last activity cell ---- */
  .act-cell { display:block; min-width:0; width:180px; max-width:180px; }
  .act-line { display:block; overflow-wrap:anywhere; }
  .act-title { font-size:12px; color:var(--faint); font-style:italic; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  @media (max-width:720px) { .act-cell { width:auto; max-width:none; } .act-title { white-space:normal; } }
  /* ---- Activity ---- */
  .activity { list-style:none; margin:0; padding:0; }
  .act-row { display:grid; grid-template-columns:96px minmax(0,1fr); gap:2px 12px; padding:9px 0; border-top:1px solid var(--border); font-size:14px; }
  .act-row:first-child { border-top:none; }
  .act-row[hidden] { display:none; }
  .act-when { font-family:var(--mono); font-size:11px; color:var(--faint); grid-row:span 2; padding-top:2px; white-space:nowrap; }
  .act-what { font-weight:600; }
  .act-details { grid-column:2; font-family:var(--mono); font-size:11.5px; color:var(--muted); overflow-wrap:anywhere; }
  .act-more { display:block; margin:12px auto 0; }
  .act-more[hidden] { display:none; }
  /* ---- Openable rows: one line each, tap for details and buttons ---- */
  [data-rows-open] .item { cursor:pointer; align-items:center; min-height:44px; padding:10px 4px; border-radius:8px; }
  [data-rows-open] .item:hover { background:rgb(var(--tint) / .04); }
  [data-rows-open] .item-actions, [data-rows-open] .action-result, .item-more { display:none; }
  #detailBody .item-more { display:block; margin-top:12px; font-size:13.5px; color:var(--muted); }
  #detailBody .item-more p { margin:0 0 6px; overflow-wrap:anywhere; }
  #detailBody .job-row .item-right { display:none; }
  #detailBody > .card, #detailBody > details.card { margin:16px 0 0; }
  #detailBody > details.set-group > summary { pointer-events:none; }
  #detailBody > details.set-group > summary::after { display:none; }
  [data-rows-open] .item-sub { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  [data-rows-open] .item::after { content:"›"; color:var(--faint); font-size:20px; line-height:1; flex:none; }
  [data-rows-open] .item > .dot { margin-top:0; }
  @media (max-width:720px) { [data-rows-open] .item { flex-wrap:nowrap; } [data-rows-open] .item-right { flex-basis:auto; margin:0; max-width:34%; text-align:right; } }
  .detail-sheet { position:fixed; inset:0; z-index:61; display:flex; align-items:flex-end; }
  .detail-sheet[hidden] { display:none; }
  .detail-panel { padding:8px 18px calc(20px + env(safe-area-inset-bottom)); }
  .detail-x { position:absolute; top:8px; right:10px; width:44px; height:44px; border:0; background:transparent; color:var(--muted); font-size:26px; cursor:pointer; border-radius:10px; }
  #detailBody .item { display:block; border:0; padding:6px 0 0; }
  #detailBody .item > .dot { display:none; }
  #detailBody .item-title { font-size:20px; padding-right:44px; }
  #detailBody .item-sub { font-size:14px; margin-top:6px; }
  #detailBody .item-right { font-size:13px; text-align:left; max-width:none; margin:6px 0 0; color:var(--faint); }
  #detailBody .item-actions { display:grid; gap:8px; margin-top:16px; }
  #detailBody .item-actions .btn { min-height:48px; font-size:15px; }
  #detailBody .action-result { display:block; margin-top:10px; }
  @media (min-width:721px) { .detail-sheet { align-items:center; justify-content:center; } .detail-panel { max-width:460px; border-radius:20px; border:1px solid var(--edge); } }
  @media (min-width:1100px) {
    .detail-sheet { align-items:stretch; justify-content:flex-end; }
    .detail-sheet .more-scrim { background:rgba(0,0,0,.25); }
    .detail-panel { max-width:420px; max-height:none; height:100%; border-radius:0; border:0; border-left:1px solid var(--edge); padding:22px 22px 28px; animation:detailIn .28s cubic-bezier(.2,.9,.25,1); }
    .detail-panel .more-grab { display:none; }
  }
  @keyframes detailIn { from { transform:translateX(40px); opacity:0; } }
  /* ---- Make Home yours ---- */
  .home-more { display:flex; flex-direction:column; }
  /* Below the board: a sideways strip on the phone, a grid on wider screens (order and hiding from
     Make Home yours apply to both). */
  .home-more-head { display:flex; justify-content:space-between; align-items:baseline; margin:18px 2px 8px; font-family:var(--mono); font-size:11px; letter-spacing:1.4px; text-transform:uppercase; color:var(--faint); }
  .home-more > [data-home] { min-width:0; }
  .home-more > [data-home] > .card:last-child, .home-more > .card[data-home] { margin-bottom:0; }
  @media (max-width:720px) {
    .home-more { display:grid; grid-auto-flow:column; grid-auto-columns:88%; gap:12px; overflow-x:auto; scroll-snap-type:x mandatory; overscroll-behavior-x:contain; align-items:start; padding-bottom:8px; scrollbar-width:none; }
    .home-more::-webkit-scrollbar { display:none; }
    .home-more { align-items:stretch; }
    .home-more > [data-home] { scroll-snap-align:start; margin:0; }
    .home-more > [data-home]:not(.card) { display:flex; flex-direction:column; gap:12px; }
    .home-more > [data-home] > .card, .home-more > .card[data-home] { margin:0; }
    .home-more > [data-home] > .card:last-child { flex:1; }
  }
  .home-more .d-grid { grid-template-columns:1fr; gap:0; }
  .home-more .d-card-head { flex-wrap:wrap; }
  @media (min-width:721px) {
    .hm-hint { display:none; }
    /* Masonry: 8px rows, each card spans its own height (set by the shell script). */
    .home-more { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); grid-auto-rows:8px; gap:0 16px; align-items:start; }
    .home-more > [data-home] { margin:0; }
  }
  @media (min-width:1100px) { .home-more { grid-template-columns:repeat(3, minmax(0,1fr)); } }
  .home-sheet { position:fixed; inset:0; z-index:62; display:flex; align-items:flex-end; }
  .home-sheet[hidden] { display:none; }
  .home-sheet .more-panel { padding:8px 16px calc(18px + env(safe-area-inset-bottom)); }
  .he-title { margin:4px 4px 0; font-size:18px; }
  @media (min-width:721px) { .home-sheet { align-items:center; justify-content:center; } .home-sheet .more-panel { max-width:480px; border-radius:20px; border:1px solid var(--edge); } }
  .home-edit-btn { display:block; margin:6px auto 18px; }
  .he-sec { font-family:var(--mono); font-size:11px; letter-spacing:1.2px; text-transform:uppercase; color:var(--faint); margin:14px 4px 6px; }
  .he-seg { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; }
  .he-seg button, .he-row button { min-height:44px; border-radius:10px; border:1px solid var(--border); background:var(--panel2); color:var(--text); font:inherit; font-size:14px; font-weight:600; cursor:pointer; }
  .he-seg button[aria-pressed="true"] { background:color-mix(in srgb, var(--accent) 22%, transparent); border-color:var(--accent); }
  .he-row { display:flex; align-items:center; gap:6px; padding:6px 4px; border-top:1px solid var(--border); }
  .he-row:first-of-type { border-top:none; }
  .he-name { flex:1; min-width:0; font-size:15px; }
  .he-row.off .he-name { color:var(--faint); text-decoration:line-through; }
  .he-row button { min-width:44px; padding:0 10px; }
  .he-row button[data-he-toggle] { min-width:78px; }
  .he-row button:disabled { opacity:.35; cursor:default; }
  .he-foot { display:flex; justify-content:space-between; gap:8px; margin-top:14px; }
  /* ---- Edit Home: drag and resize the cards below the board ---- */
  .home-edit-pill { position:fixed; left:50%; transform:translateX(-50%); bottom:calc(84px + env(safe-area-inset-bottom)); z-index:40; display:flex; align-items:center; gap:8px;
    padding:8px 8px 8px 16px; border-radius:999px; border:1px solid var(--accent); background:var(--panel); box-shadow:0 12px 34px rgba(0,0,0,.4); font-size:13px; color:var(--muted); max-width:calc(100% - 24px); }
  .home-edit-pill[hidden] { display:none; }
  .home-edit-pill .btn { min-height:40px; white-space:nowrap; }
  @media (min-width:721px) { .home-edit-pill { bottom:24px; left:calc(50% + 116px); } }
  @media (max-width:420px) { .home-edit-pill > span { display:none; } .home-edit-pill { padding-left:8px; } }
  body.home-editing .home-more > [data-home] { position:relative; touch-action:none; cursor:grab; user-select:none; -webkit-user-select:none;
    outline:1px dashed color-mix(in srgb, var(--accent) 70%, transparent); outline-offset:3px; border-radius:16px; }
  body.home-editing .home-more > [data-home].dragging { z-index:8; cursor:grabbing; opacity:.95; box-shadow:0 22px 50px rgba(0,0,0,.45); }
  body.home-editing .home-more > [data-home]:focus-visible { outline:3px solid var(--accent); }
  /* The grip sits on the card's outside corner so it never covers what the card says. */
  .hm-grip { position:absolute; right:-12px; bottom:-12px; z-index:4; width:36px; height:36px; display:flex; align-items:center; justify-content:center;
    border-radius:50%; border:1px solid var(--accent); background:var(--accent); color:var(--on-accent); cursor:ew-resize; touch-action:none; box-shadow:0 4px 14px rgba(0,0,0,.35); }
  .hm-grip svg { width:18px; height:18px; }
  body.home-editing .home-more { padding:0 12px 12px 0; }
  body.home-editing .hm-hint { display:none; }
  .hm-move { position:absolute; top:6px; right:6px; z-index:3; width:44px; height:44px; display:flex; align-items:center; justify-content:center;
    border-radius:12px; border:1px solid var(--accent); background:var(--panel); color:var(--accent); touch-action:none; cursor:grab; }
  .hm-move svg { width:20px; height:20px; }
  @media (min-width:721px) { .hm-move { display:none; } }
  @media (max-width:720px) {
    /* Stack while editing so cards can be dragged up and down by their handle; the rest of a card
       still scrolls the page. Widths only matter on wider screens. */
    body.home-editing .home-more { display:flex; flex-direction:column; gap:12px; overflow:visible; }
    body.home-editing .home-more > [data-home] { touch-action:auto; cursor:default; }
    .hm-grip { display:none; }
  }
  /* ---- Home: What just happened, Trends ---- */
  .feed { list-style:none; margin:0; padding:0; }
  .feed-row { display:grid; grid-template-columns:10px minmax(0,1fr) auto; gap:10px; align-items:baseline; padding:9px 0; border-top:1px solid var(--border); font-size:14px; }
  /* Long release names have no spaces: break them anywhere rather than run past the card. */
  .feed-text { min-width:0; overflow-wrap:anywhere; }
  .feed-row:first-child { border-top:none; }
  .feed-dot { width:8px; height:8px; border-radius:50%; background:var(--accent); transform:translateY(-1px); }
  .tone-ok .feed-dot { background:var(--ok); } .tone-warn .feed-dot { background:var(--warn); } .tone-down .feed-dot { background:var(--down); }
  .feed-when { font-family:var(--mono); font-size:11px; color:var(--faint); white-space:nowrap; }
  .trends { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:18px; }
  .trend-h { font-family:var(--mono); font-size:11px; letter-spacing:1.2px; text-transform:uppercase; color:var(--faint); margin-bottom:8px; }
  .trend-disk + .trend-disk { margin-top:10px; }
  .trend-row { display:flex; justify-content:space-between; gap:8px; font-size:13px; }
  .trend-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted); min-width:0; }
  .trend-val { font-weight:600; white-space:nowrap; }
  .spark { display:block; width:100%; height:28px; margin:4px 0 2px; }
  .spark path { fill:none; stroke:var(--accent); stroke-width:1.6; vector-effect:non-scaling-stroke; stroke-linejoin:round; }
  .trend-sub { font-size:12px; color:var(--faint); margin-top:4px; }
  .trend-sub.down { color:var(--warn); }
  .bars { display:flex; align-items:flex-end; gap:4px; height:64px; }
  .bar-col { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%; gap:4px; min-width:0; }
  .bar-col span { font-family:var(--mono); font-size:10px; color:var(--faint); }
  .bar { width:100%; height:var(--h); border-radius:3px 3px 1px 1px; background:var(--ok); transition:height .6s cubic-bezier(.2,.75,.25,1); }
  .bar.warn { background:var(--warn); } .bar.req { background:var(--accent); } .bar.none { background:var(--border); }
  @keyframes panelIn { from { opacity:0; transform:translateY(8px); } }
  .card { transition:transform .25s cubic-bezier(.2,.75,.25,1), border-color .25s; }
  @media (hover:hover) { .card:hover { border-color:color-mix(in srgb, var(--accent) 35%, var(--edge)); } }
  @media (prefers-reduced-motion: reduce) {
    .live-dot, .live-enter, .panel:not([hidden]), .more-scrim, .more-panel { animation:none !important; }
    .bb-pill, .rail-item, .card { transition:none !important; }
  }
`;

// Runs in <head> before first paint so a light theme never flashes dark.
const THEME_HEAD_SCRIPT = `try{var t=localStorage.getItem('dashTheme');document.documentElement.dataset.theme=(t==='light'||t==='auto')?t:'dark';}catch(e){document.documentElement.dataset.theme='dark';}`;

// Client side: navigation, the More sheet, and the live layer. Plain ES5 so it runs anywhere the
// rest of the dashboard does.
const SHELL_SCRIPT = `
(function () {
  var ALIASES = ${JSON.stringify(TAB_ALIASES)};
  var panels = [].slice.call(document.querySelectorAll('.panel[data-panel]'));
  var sheet = document.getElementById('moreSheet');
  var sheetReturn = null;
  function navButtons() { return [].slice.call(document.querySelectorAll('[data-tab]')); }
  function show(id, opts) {
    opts = opts || {};
    id = ALIASES[id] || id;
    if (!panels.some(function (p) { return p.dataset.panel === id; })) id = panels[0] && panels[0].dataset.panel;
    panels.forEach(function (p) { p.hidden = p.dataset.panel !== id; });
    document.body.dataset.view = id || '';
    navButtons().forEach(function (b) {
      if (b.closest('.more-sheet')) { b.removeAttribute('aria-current'); return; }
      if (b.dataset.tab === id && !b.dataset.scroll) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    var moreBtn = document.querySelector('[data-more-open]');
    if (moreBtn) {
      var inMore = !!document.querySelector('.more-sheet [data-tab="' + id + '"]') && !document.querySelector('.bottombar [data-tab="' + id + '"]');
      if (inMore) moreBtn.setAttribute('aria-current', 'page'); else moreBtn.removeAttribute('aria-current');
    }
    if (id) history.replaceState(null, '', '#' + id);
    if (opts.scroll) { var t = document.getElementById(opts.scroll); if (t) setTimeout(function () { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 60); }
    else if (opts.top) window.scrollTo(0, 0);
    if (window.DashLive) window.DashLive.refreshVisible();
  }
  window.DashNav = { show: show };
  function openSheet() { if (!sheet) return; sheetReturn = document.activeElement; sheet.hidden = false; var f = sheet.querySelector('.more-item'); if (f) f.focus(); window.__actionsInFlight = (window.__actionsInFlight || 0) + 1; }
  function closeSheet() { if (!sheet || sheet.hidden) return; sheet.hidden = true; window.__actionsInFlight = Math.max(0, (window.__actionsInFlight || 0) - 1); if (sheetReturn && sheetReturn.focus) sheetReturn.focus(); }
  document.addEventListener('click', function (e) {
    var tab = e.target.closest('[data-tab]');
    if (tab) { if (tab.tagName === 'A') e.preventDefault(); closeSheet(); show(tab.dataset.tab, { scroll: tab.dataset.scroll, top: !tab.dataset.scroll }); return; }
    if (e.target.closest('[data-more-open]')) { openSheet(); return; }
    if (e.target.closest('[data-more-close]')) { closeSheet(); return; }
    var st = e.target.closest('[data-search-toggle]');
    if (st) { var h = st.closest('.hdr'); h.classList.toggle('search-open'); if (h.classList.contains('search-open')) { var i = h.querySelector('.topbar-search input'); if (i) i.focus(); } }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeSheet(); closeHome(); } });

  // ---- Segments: [data-segs] buttons ([data-seg-btn]) show one [data-seg-panel] at a time ----
  // The choice is kept on the tab's panel (outside any live region) and per browser, and re-applied
  // after each live refresh, so a refresh never flips the list under you.
  function segChoice(panel) {
    var v = panel.getAttribute('data-seg');
    if (!v) { try { v = localStorage.getItem('seg:' + panel.dataset.panel); } catch (e) {} }
    var btns = panel.querySelectorAll('[data-seg-btn]');
    var valid = [].some.call(btns, function (b) { return b.dataset.segBtn === v; });
    return valid ? v : (btns[0] && btns[0].dataset.segBtn);
  }
  function syncSegs() {
    [].forEach.call(document.querySelectorAll('.panel[data-panel]'), function (panel) {
      if (!panel.querySelector('[data-segs]')) return;
      var v = segChoice(panel);
      panel.setAttribute('data-seg', v || '');
      [].forEach.call(panel.querySelectorAll('[data-seg-btn]'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.segBtn === v)); });
      [].forEach.call(panel.querySelectorAll('[data-seg-panel]'), function (p) { p.hidden = p.dataset.segPanel !== v; });
    });
    // Filtered lists, a page at a time: the filter and how many show are kept on the tab's panel.
    [].forEach.call(document.querySelectorAll('[data-filter-list]'), function (list) {
      var panel = list.closest('.panel[data-panel]') || list.parentNode;
      var filter = panel.getAttribute('data-filter') || 'all';
      var page = Number(list.getAttribute('data-page')) || 15;
      var shown = Number(panel.getAttribute('data-shown')) || page;
      var scope = list.parentNode;
      if (!scope.querySelector('[data-filter-btn="' + filter + '"]')) filter = 'all';
      [].forEach.call(scope.querySelectorAll('[data-filter-btn]'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.filterBtn === filter)); });
      var n = 0;
      [].forEach.call(list.querySelectorAll('[data-cat]'), function (row) {
        var match = filter === 'all' || row.getAttribute('data-cat') === filter;
        if (match) n++;
        row.hidden = !match || n > shown;
      });
      var more = list.querySelector('[data-more-btn]');
      if (more) { more.hidden = n <= shown; more.textContent = 'Show ' + Math.min(page, n - shown) + ' more'; }
    });
    [].forEach.call(document.querySelectorAll('[data-rows-open] .item'), function (row) {
      if (!row.hasAttribute('tabindex')) { row.setAttribute('tabindex', '0'); row.setAttribute('role', 'button'); }
    });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-seg-btn]');
    if (!b) return;
    var panel = b.closest('.panel[data-panel]');
    if (!panel) return;
    panel.setAttribute('data-seg', b.dataset.segBtn);
    try { localStorage.setItem('seg:' + panel.dataset.panel, b.dataset.segBtn); } catch (e2) {}
    syncSegs();
    // A list that was hidden may be stale; bring it current now that it shows.
    if (window.DashLive) window.DashLive.refreshVisible();
  });
  document.addEventListener('dash:refreshed', syncSegs);

  // ---- Tick several ([data-picks]): count, enable the bar's buttons, Select all ----
  function syncPicks() {
    [].forEach.call(document.querySelectorAll('[data-picks]'), function (card) {
      var boxes = [].slice.call(card.querySelectorAll('input[data-pick]'));
      var n = boxes.filter(function (b) { return b.checked; }).length;
      var count = card.querySelector('[data-picks-count]');
      if (count) count.textContent = n ? n + ' selected' : 'None selected';
      [].forEach.call(card.querySelectorAll('[data-bulk-picked]'), function (b) { b.disabled = !n; });
      var all = card.querySelector('[data-pick-all]');
      if (all) { all.checked = n > 0 && n === boxes.length; all.indeterminate = n > 0 && n < boxes.length; }
      card.classList.toggle('picking', n > 0);
    });
  }
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.matches && t.matches('[data-pick-all]')) {
      var card = t.closest('[data-picks]');
      [].forEach.call(card.querySelectorAll('input[data-pick]'), function (b) { b.checked = t.checked; });
    }
    if (t.matches && (t.matches('[data-pick-all]') || t.matches('input[data-pick]'))) syncPicks();
  });
  document.addEventListener('dash:refreshed', syncPicks);
  document.addEventListener('click', function (e) {
    var f = e.target.closest('[data-filter-btn]'), m = e.target.closest('[data-more-btn]');
    if (!f && !m) return;
    var list = (f || m).closest('.card, .panel').querySelector('[data-filter-list]') || (f || m).closest('[data-filter-list]');
    if (!list) return;
    var panel = list.closest('.panel[data-panel]') || list.parentNode;
    var page = Number(list.getAttribute('data-page')) || 15;
    if (f) { panel.setAttribute('data-filter', f.dataset.filterBtn); panel.setAttribute('data-shown', String(page)); }
    else panel.setAttribute('data-shown', String((Number(panel.getAttribute('data-shown')) || page) + page));
    syncSegs();
  });

  // ---- Openable rows ----
  var detail = document.getElementById('detailSheet'), detailBody = document.getElementById('detailBody'), detailReturn = null, detailMoved = [];
  function openDetail(row) {
    if (!detail) return;
    detailReturn = row;
    var copy = row.cloneNode(true);
    copy.removeAttribute('tabindex'); copy.removeAttribute('role');
    var right = copy.querySelector('.item-right'), anchor = copy.querySelector('.item-sub') || copy.querySelector('.item-title');
    if (right && anchor && anchor.parentNode) anchor.parentNode.insertBefore(right, anchor.nextSibling);
    detailBody.innerHTML = '';
    detailBody.appendChild(copy);
    // data-detail-move: real elements (for example a job's settings form) shown in the sheet and
    // put back on close, so their own listeners and the one set of inputs keep working.
    var sel = row.getAttribute('data-detail-move');
    if (sel) {
      [].forEach.call(document.querySelectorAll(sel), function (el) {
        if (detailBody.contains(el)) return;
        var ph = document.createComment('detail-move');
        el.parentNode.insertBefore(ph, el);
        detailMoved.push({ el: el, ph: ph, open: el.open });
        if (el.tagName === 'DETAILS') el.open = true;
        detailBody.appendChild(el);
      });
    }
    var t = copy.querySelector('.item-title');
    detail.setAttribute('aria-label', t ? t.textContent.trim() : 'Details');
    detail.hidden = false;
    var f = detailBody.querySelector('.item-actions .btn:not(:disabled)') || detail.querySelector('.detail-x');
    if (f) f.focus();
    window.__actionsInFlight = (window.__actionsInFlight || 0) + 1;
  }
  function closeDetail() {
    if (!detail || detail.hidden) return;
    detail.hidden = true;
    detailMoved.forEach(function (m) {
      if (m.ph.parentNode) m.ph.parentNode.replaceChild(m.el, m.ph);
      if (m.el.tagName === 'DETAILS') m.el.open = !!m.open;
    });
    detailMoved = [];
    detailBody.innerHTML = '';
    window.__actionsInFlight = Math.max(0, (window.__actionsInFlight || 0) - 1);
    if (detailReturn && document.contains(detailReturn)) detailReturn.focus();
    if (window.DashLive) window.DashLive.refreshVisible();
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-detail-close]')) { closeDetail(); return; }
    var row = e.target.closest('[data-rows-open] .item');
    if (!row || e.target.closest('button, a, input, select, textarea, label')) return;
    openDetail(row);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeDetail(); return; }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-rows-open] .item')) { e.preventDefault(); openDetail(e.target); }
  });
  // A finished action that is not an inline one has done its job; close and show the updated list.
  document.addEventListener('dash:action', function (e) { if (e.detail && e.detail.ok && !e.detail.inline && detail && !detail.hidden) closeDetail(); });
  syncSegs();
  syncPicks();

  // ---- Make Home yours: theme, and which Home cards show in what order (this browser only) ----
  var homeSheet = document.getElementById('homeSheet'), homeReturn = null;
  var homeStyle = document.createElement('style');
  homeStyle.id = 'homePrefs';
  document.head.appendChild(homeStyle);
  function safeKey(k) { return /^[a-z][a-z0-9-]{0,30}$/.test(k) ? k : null; }
  function homePrefs() {
    try {
      var p = JSON.parse(localStorage.getItem('dashHome') || '{}') || {};
      var size = {};
      if (p.size && typeof p.size === 'object') Object.keys(p.size).forEach(function (k) { var n = Number(p.size[k]); if (safeKey(k) && (n === 1 || n === 2 || n === 3)) size[k] = n; });
      return { hidden: (Array.isArray(p.hidden) ? p.hidden : []).filter(safeKey), order: (Array.isArray(p.order) ? p.order : []).filter(safeKey), size: size };
    } catch (e) { return { hidden: [], order: [], size: {} }; }
  }
  var DEFAULT_SIZE = { recent: 3 };
  function cardSize(p, key) { return p.size[key] || DEFAULT_SIZE[key] || 1; }
  function saveHome(p) { try { localStorage.setItem('dashHome', JSON.stringify(p)); } catch (e) {} applyHome(); paintHome(); }
  // Prefs live in a style element, not on the cards, so a live refresh that morphs the cards keeps them.
  function applyHome() {
    var p = homePrefs(), css = '';
    p.hidden.forEach(function (k) { css += '[data-panel="home"] [data-home="' + k + '"]{display:none !important}'; });
    // Cards missing from a saved order (new ones) go after the ordered ones, as in the editor.
    if (p.order.length) css += '.home-more > [data-home]{order:999}';
    p.order.forEach(function (k, i) { css += '.home-more > [data-home="' + k + '"]{order:' + (i + 1) + '}'; });
    // Card widths on wider screens: 1, 2 or 3 columns (3 = the whole row). Recently added starts
    // full width; everything else one column, until resized.
    var two = '', three = '';
    homeSections('more').forEach(function (x) {
      var n = cardSize(p, x.key);
      if (n >= 2) two += '.home-more > [data-home="' + x.key + '"]{grid-column:1 / -1}';
      if (n === 2) three += '.home-more > [data-home="' + x.key + '"]{grid-column:span 2}';
    });
    css += '@media (min-width:721px){' + two + '}@media (min-width:1100px){' + three + '}';
    homeStyle.textContent = css;
    document.dispatchEvent(new CustomEvent('dash:home-prefs'));
  }
  function homeSections(group) {
    var home = document.querySelector('[data-panel="home"]');
    if (!home) return [];
    return [].slice.call(home.querySelectorAll('[data-home]')).filter(function (el) {
      return group === 'board' ? el.getAttribute('data-home-group') === 'board' : !!el.parentElement && el.parentElement.classList.contains('home-more');
    }).map(function (el) { return { key: el.getAttribute('data-home'), label: el.getAttribute('data-home-label') || el.getAttribute('data-home') }; })
      .filter(function (x) { return safeKey(x.key); });
  }
  function orderedMore() {
    var p = homePrefs(), list = homeSections('more');
    var rank = function (k) { var i = p.order.indexOf(k); return i === -1 ? 1000 : i; };
    return list.map(function (x, i) { return [x, i]; }).sort(function (a, b) { return (rank(a[0].key) - rank(b[0].key)) || (a[1] - b[1]); }).map(function (x) { return x[0]; });
  }
  function rowHtml(x, i, n, movable, hidden) {
    var off = hidden.indexOf(x.key) > -1;
    return '<div class="he-row' + (off ? ' off' : '') + '"><span class="he-name">' + x.label.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }) + '</span>' +
      (movable ? '<button type="button" data-he-move="-1" data-key="' + x.key + '" aria-label="Move ' + x.key + ' up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" data-he-move="1" data-key="' + x.key + '" aria-label="Move ' + x.key + ' down"' + (i === n - 1 ? ' disabled' : '') + '>↓</button>' : '') +
      '<button type="button" data-he-toggle="' + x.key + '" aria-pressed="' + !off + '">' + (off ? 'Hidden' : 'Shown') + '</button></div>';
  }
  function paintHome() {
    if (!homeSheet) return;
    var p = homePrefs();
    var board = homeSections('board'), more = orderedMore();
    document.getElementById('heBoard').innerHTML = board.map(function (x, i) { return rowHtml(x, i, board.length, false, p.hidden); }).join('');
    document.getElementById('heMore').innerHTML = more.map(function (x, i) { return rowHtml(x, i, more.length, true, p.hidden); }).join('');
    var theme = document.documentElement.dataset.theme || 'dark';
    [].forEach.call(homeSheet.querySelectorAll('[data-theme-set]'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.themeSet === theme)); });
  }
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('dashTheme', t); } catch (e) {}
    syncThemeColor();
    paintHome();
  }
  function syncThemeColor() {
    var t = document.documentElement.dataset.theme;
    var light = t === 'light' || (t === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', light ? '#f3f6f7' : '#10232f');
  }
  function openHome() { if (!homeSheet) return; closeSheet(); homeReturn = document.activeElement; paintHome(); homeSheet.hidden = false; var f = homeSheet.querySelector('[data-theme-set]'); if (f) f.focus(); window.__actionsInFlight = (window.__actionsInFlight || 0) + 1; }
  function closeHome() { if (!homeSheet || homeSheet.hidden) return; homeSheet.hidden = true; window.__actionsInFlight = Math.max(0, (window.__actionsInFlight || 0) - 1); if (homeReturn && homeReturn.focus) homeReturn.focus(); }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t.closest('[data-home-edit]')) { openHome(); return; }
    if (!homeSheet || homeSheet.hidden) return;
    if (t.closest('[data-home-close]')) { closeHome(); return; }
    var th = t.closest('[data-theme-set]');
    if (th) { setTheme(th.dataset.themeSet); return; }
    var p = homePrefs();
    var tog = t.closest('[data-he-toggle]');
    if (tog) {
      var k = tog.getAttribute('data-he-toggle'), at = p.hidden.indexOf(k);
      if (at > -1) p.hidden.splice(at, 1); else p.hidden.push(k);
      saveHome(p); return;
    }
    var mv = t.closest('[data-he-move]');
    if (mv && !mv.disabled) {
      var keys = orderedMore().map(function (x) { return x.key; });
      var from = keys.indexOf(mv.dataset.key), to = from + Number(mv.dataset.heMove);
      if (from < 0 || to < 0 || to >= keys.length) return;
      keys.splice(to, 0, keys.splice(from, 1)[0]);
      p.order = keys;
      saveHome(p);
      var again = homeSheet.querySelector('[data-he-move="' + mv.dataset.heMove + '"][data-key="' + mv.dataset.key + '"]');
      if (again && !again.disabled) again.focus();
      return;
    }
    if (t.closest('[data-home-reset]')) { try { localStorage.removeItem('dashHome'); } catch (e) {} applyHome(); paintHome(); }
  });
  applyHome();
  syncThemeColor();

  // Home's lower cards on wide screens: each spans as many 8px rows as it is tall, so short cards
  // pack under each other instead of leaving gaps (CSS order from Make Home yours still applies).
  var masonryQueued = false;
  function masonry() {
    masonryQueued = false;
    var hm = document.querySelector('.home-more');
    if (!hm) return;
    var cs = getComputedStyle(hm);
    var on = cs.display === 'grid' && cs.gridAutoFlow.indexOf('column') === -1 && cs.gridTemplateColumns.split(' ').length > 1;
    [].forEach.call(hm.children, function (el) {
      if (!on) { el.style.gridRowEnd = ''; return; }
      var inner = el.scrollHeight || el.getBoundingClientRect().height;
      el.style.gridRowEnd = inner ? 'span ' + Math.ceil((inner + 16) / 8) : '';
    });
  }
  function queueMasonry() { if (!masonryQueued) { masonryQueued = true; requestAnimationFrame(masonry); } }
  var masonryObserver = window.ResizeObserver ? new ResizeObserver(queueMasonry) : null;
  function watchMasonry() {
    var hm = document.querySelector('.home-more');
    if (!hm || !masonryObserver) return;
    masonryObserver.disconnect();
    [].forEach.call(hm.children, function (el) { masonryObserver.observe(el); });
  }
  window.addEventListener('resize', queueMasonry);
  document.addEventListener('dash:refreshed', function () { masonry(); watchMasonry(); });
  document.addEventListener('dash:home-prefs', queueMasonry);
  watchMasonry();
  queueMasonry();

  // ---- Edit Home: drag the cards below the board, and resize them ----
  // The board's pencil (or Make Home yours on Home) turns this on together with tile dragging. Each
  // card gets a resize grip; drag it sideways to 1, 2 or 3 columns, or tap it to step through
  // them. On the phone the cards stack while editing so they can be dragged up and down.
  var homeEditing = false, cardDrag = null, sizeDrag = null;
  var donePill = document.createElement('div');
  donePill.className = 'home-edit-pill';
  donePill.hidden = true;
  donePill.innerHTML = '<span>Editing Home</span><button type="button" class="btn" data-home-edit-sheet>Theme and hiding</button><button type="button" class="btn primary" data-home-edit-done>Done</button>';
  document.body.appendChild(donePill);
  function cols() {
    var hm = document.querySelector('.home-more');
    return hm ? Math.max(1, getComputedStyle(hm).gridTemplateColumns.split(' ').length) : 1;
  }
  function cardsInOrder() { return orderedMore().map(function (x) { return document.querySelector('.home-more > [data-home="' + x.key + '"]'); }).filter(Boolean); }
  function addGrips() {
    homeSections('more').forEach(function (x) {
      var el = document.querySelector('.home-more > [data-home="' + x.key + '"]');
      if (!el || el.querySelector(':scope > .hm-grip')) return;
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-roledescription', 'movable card');
      var g = document.createElement('button');
      g.type = 'button';
      g.className = 'hm-grip';
      g.setAttribute('data-hm-size', x.key);
      g.setAttribute('data-hm-label', x.label);
      g.setAttribute('aria-label', 'Resize ' + x.label + ': ' + cardSize(homePrefs(), x.key) + ' of 3 columns');
      g.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 20 20 9M14 20l6-6M19 20h1v-1"/></svg>';
      el.appendChild(g);
      // On a phone the card itself scrolls the page; this handle is what drags it.
      var mv = document.createElement('span');
      mv.className = 'hm-move';
      mv.setAttribute('aria-hidden', 'true');
      mv.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 9h14M5 15h14"/></svg>';
      el.appendChild(mv);
    });
  }
  function removeGrips() {
    [].forEach.call(document.querySelectorAll('.hm-grip, .hm-move'), function (g) { g.remove(); });
    [].forEach.call(document.querySelectorAll('.home-more > [data-home]'), function (el) { el.removeAttribute('tabindex'); el.removeAttribute('aria-roledescription'); el.style.transform = ''; el.classList.remove('dragging'); });
  }
  function setHomeEditing(on) {
    if (on === homeEditing) return;
    homeEditing = on;
    document.body.classList.toggle('home-editing', on);
    donePill.hidden = !on;
    window.__actionsInFlight = Math.max(0, (window.__actionsInFlight || 0) + (on ? 1 : -1));
    if (on) addGrips(); else { removeGrips(); if (window.DashLive) window.DashLive.refreshVisible(); }
    queueMasonry();
  }
  document.addEventListener('dash:board-edit', function (e) { setHomeEditing(!!(e.detail && e.detail.on)); });
  function setBoth(on) { if (window.__setBoardEdit) window.__setBoardEdit(on); else setHomeEditing(on); }
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-home-edit-done]')) { setBoth(false); return; }
    if (e.target.closest('[data-home-edit-sheet]')) { openHome(); return; }
    if (e.target.closest('[data-home-edit-start]')) {
      setBoth(true);
      var hm = document.querySelector('.home-more-head');
      if (hm) hm.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    // While editing, a tap inside a card never follows its links or buttons (except the grip).
    if (homeEditing && e.target.closest('.home-more > [data-home]') && !e.target.closest('.hm-grip')) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  function moveKey(key, targetKey, after) {
    var p = homePrefs();
    var keys = orderedMore().map(function (x) { return x.key; });
    keys.splice(keys.indexOf(key), 1);
    var at = keys.indexOf(targetKey) + (after ? 1 : 0);
    keys.splice(at, 0, key);
    p.order = keys;
    try { localStorage.setItem('dashHome', JSON.stringify(p)); } catch (err) {}
    applyHome();
    masonry();
  }
  function setSize(key, n) {
    var p = homePrefs();
    p.size[key] = Math.max(1, Math.min(3, n));
    try { localStorage.setItem('dashHome', JSON.stringify(p)); } catch (err) {}
    applyHome();
    masonry();
    var g = document.querySelector('.hm-grip[data-hm-size="' + key + '"]');
    if (g) g.setAttribute('aria-label', 'Resize ' + g.getAttribute('data-hm-label') + ': ' + p.size[key] + ' of 3 columns');
  }
  document.addEventListener('pointerdown', function (e) {
    if (!homeEditing || cardDrag || sizeDrag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    var grip = e.target.closest('.hm-grip');
    if (grip) {
      e.preventDefault();
      var card = grip.parentElement;
      sizeDrag = { key: grip.getAttribute('data-hm-size'), card: card, id: e.pointerId, x: e.clientX, moved: false };
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}
      return;
    }
    var el = e.target.closest('.home-more > [data-home]');
    if (!el) return;
    if (e.pointerType === 'touch' && !e.target.closest('.hm-move')) return;
    e.preventDefault();
    cardDrag = { el: el, key: el.getAttribute('data-home'), id: e.pointerId, x: e.clientX, y: e.clientY };
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    el.classList.add('dragging');
  });
  document.addEventListener('pointermove', function (e) {
    if (sizeDrag && e.pointerId === sizeDrag.id) {
      e.preventDefault();
      if (Math.abs(e.clientX - sizeDrag.x) > 6) sizeDrag.moved = true;
      if (!sizeDrag.moved || cols() < 2) return;
      var hm = document.querySelector('.home-more');
      var hr = hm.getBoundingClientRect(), cr = sizeDrag.card.getBoundingClientRect();
      var colW = hr.width / cols();
      var want = Math.max(1, Math.min(cols(), Math.round((e.clientX - cr.left) / colW)));
      var n = want >= cols() ? 3 : want;
      if (n !== cardSize(homePrefs(), sizeDrag.key)) setSize(sizeDrag.key, n);
      return;
    }
    if (!cardDrag || e.pointerId !== cardDrag.id) return;
    e.preventDefault();
    var el = cardDrag.el;
    el.style.transform = 'translate(' + (e.clientX - cardDrag.x) + 'px,' + (e.clientY - cardDrag.y) + 'px)';
    var over = null;
    cardsInOrder().forEach(function (c) {
      if (c === el) return;
      var r = c.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) over = c;
    });
    if (over) {
      var list = cardsInOrder();
      var before = el.getBoundingClientRect();
      moveKey(cardDrag.key, over.getAttribute('data-home'), list.indexOf(over) > list.indexOf(el));
      el.style.transform = '';
      var after = el.getBoundingClientRect();
      cardDrag.x = e.clientX - (before.left - after.left);
      cardDrag.y = e.clientY - (before.top - after.top);
      el.style.transform = 'translate(' + (e.clientX - cardDrag.x) + 'px,' + (e.clientY - cardDrag.y) + 'px)';
    }
    if (e.clientY < 90) window.scrollBy(0, -14); else if (e.clientY > window.innerHeight - 120) window.scrollBy(0, 14);
  });
  function endHomeDrag(e) {
    if (sizeDrag && (!e || e.pointerId === sizeDrag.id)) {
      // A tap on the grip steps through the widths.
      if (!sizeDrag.moved) setSize(sizeDrag.key, cardSize(homePrefs(), sizeDrag.key) % 3 + 1);
      sizeDrag = null;
      return;
    }
    if (!cardDrag || (e && e.pointerId !== cardDrag.id)) return;
    cardDrag.el.classList.remove('dragging');
    cardDrag.el.style.transform = '';
    cardDrag = null;
    paintHome();
  }
  document.addEventListener('pointerup', endHomeDrag);
  document.addEventListener('pointercancel', endHomeDrag);
  // Keyboard: arrows move a focused card; on its grip, left and right resize.
  document.addEventListener('keydown', function (e) {
    if (!homeEditing) return;
    var grip = e.target.closest && e.target.closest('.hm-grip');
    if (grip && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      var k = grip.getAttribute('data-hm-size');
      setSize(k, cardSize(homePrefs(), k) + (e.key === 'ArrowRight' ? 1 : -1));
      grip.focus();
      return;
    }
    var card = e.target.matches && e.target.matches('.home-more > [data-home]') ? e.target : null;
    var step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (!card || !step) return;
    e.preventDefault();
    var list = cardsInOrder(), i = list.indexOf(card), j = i + step;
    if (j < 0 || j >= list.length) return;
    moveKey(card.getAttribute('data-home'), list[j].getAttribute('data-home'), step > 0);
    card.focus();
  });
  if (window.matchMedia) { var mq = matchMedia('(prefers-color-scheme: light)'); if (mq.addEventListener) mq.addEventListener('change', syncThemeColor); }
  panels.forEach(function (p) { p.setAttribute('role', 'region'); p.setAttribute('aria-label', p.dataset.label || p.dataset.panel); });

  // ---- Live layer ----
  var lastOk = Date.now(), failures = 0;
  function editing() { var el = document.activeElement; return !!el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName); }
  function blocked() { return editing() || window.__dirtySettings || window.__actionsInFlight > 0; }
  function keyOf(n) { return n.nodeType === 1 ? (n.getAttribute('data-key') || n.id || null) : null; }
  function same(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType !== 1) return true;
    return a.tagName === b.tagName && keyOf(a) === keyOf(b);
  }
  function countTo(el, from, to) {
    if (!isFinite(from) || !isFinite(to) || from === to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = String(to); return; }
    var start = performance.now(), dur = 1100;
    (function step(now) {
      var p = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - p, 4);
      el.textContent = String(Math.round(from + (to - from) * e));
      if (p < 1) requestAnimationFrame(step);
    })(start);
  }
  function syncAttrs(a, b) {
    var keepValue = a === document.activeElement;
    for (var i = a.attributes.length - 1; i >= 0; i--) {
      var n = a.attributes[i].name;
      if (n === 'open' && a.tagName === 'DETAILS') continue;
      if (!b.hasAttribute(n)) a.removeAttribute(n);
    }
    for (var j = 0; j < b.attributes.length; j++) {
      var at = b.attributes[j];
      if (at.name === 'open' && a.tagName === 'DETAILS') continue;
      if (at.name === 'value' && keepValue) continue;
      if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
    }
    if ((a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && !keepValue && 'value' in b && a.value !== b.value && b.hasAttribute('value')) a.value = b.value;
  }
  function morphNode(a, b) {
    if (a.nodeType === 3 || a.nodeType === 8) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
    if (a.hasAttribute('data-live-keep')) return;
    if (a.hasAttribute('data-count') && a.childNodes.length <= 1 && b.childNodes.length <= 1) {
      syncAttrs(a, b);
      var from = parseFloat(a.textContent), to = parseFloat(b.textContent);
      if (a.textContent !== b.textContent) { if (String(to) === b.textContent.trim()) countTo(a, from, to); else a.textContent = b.textContent; }
      return;
    }
    syncAttrs(a, b);
    morphChildren(a, b);
  }
  function morphChildren(from, to) {
    var keyed = {};
    [].forEach.call(from.childNodes, function (c) { var k = keyOf(c); if (k) keyed[k] = c; });
    var toKids = [].slice.call(to.childNodes);
    for (var i = 0; i < toKids.length; i++) {
      var t = toKids[i], cur = from.childNodes[i] || null, k = keyOf(t), use = null;
      if (k && keyed[k] && same(keyed[k], t)) use = keyed[k];
      else if (cur && !keyOf(cur) && same(cur, t)) use = cur;
      if (use) {
        if (use !== cur) from.insertBefore(use, cur);
        morphNode(use, t);
      } else {
        var fresh = document.importNode(t, true);
        if (fresh.nodeType === 1 && !firstPaint) fresh.classList.add('live-enter');
        from.insertBefore(fresh, cur);
      }
    }
    while (from.childNodes.length > toKids.length) from.removeChild(from.lastChild);
  }
  var firstPaint = true;
  function morph(el, html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    morphChildren(el, tpl.content);
  }
  function paintStatus() {
    var age = Math.round((Date.now() - lastOk) / 1000), stale = failures >= 2 || age > 120;
    [].forEach.call(document.querySelectorAll('[data-live-status]'), function (s) {
      s.classList.toggle('stale', stale);
      var t = s.querySelector('.live-text');
      if (t) t.textContent = stale ? 'Reconnecting · last update ' + (age < 90 ? age + 's' : Math.round(age / 60) + 'm') + ' ago' : 'Live' + (age > 4 ? ' · updated ' + age + 's ago' : '');
    });
  }
  // Fragments carry <span data-nav-count="requests" data-value="6">; mirror them onto the menu
  // badges (bottom bar, rail, More sheet) so a count changes everywhere at once.
  function syncNavCounts() {
    [].forEach.call(document.querySelectorAll('[data-nav-count]'), function (m) {
      var name = m.getAttribute('data-nav-count'), n = parseInt(m.getAttribute('data-value'), 10) || 0;
      [].forEach.call(document.querySelectorAll('.rail [data-tab="' + name + '"], .bottombar [data-tab="' + name + '"], .more-sheet [data-tab="' + name + '"]'), function (b) {
        if (b.dataset.scroll) return;
        var badge = b.querySelector('.nav-badge');
        if (!n) { if (badge) badge.remove(); return; }
        if (!badge) { badge = document.createElement('span'); badge.className = 'nav-badge live-enter'; badge.textContent = '0'; b.appendChild(badge); }
        badge.setAttribute('aria-label', n + ' need attention');
        countTo(badge, parseInt(badge.textContent, 10) || 0, n);
      });
    });
  }
  function ok() { lastOk = Date.now(); failures = 0; paintStatus(); }
  function fail() { failures++; paintStatus(); }
  function visible(el) { var p = el.closest('.panel'); return !p || !p.hidden; }
  var inflight = {};
  function refresh(el) {
    var name = el.getAttribute('data-live');
    if (inflight[name] || blocked()) return;
    inflight[name] = true;
    fetch('/admin/fragment/' + encodeURIComponent(name), { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { if (r.status === 401) { location.href = '/admin/login'; throw new Error('signed out'); } return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || 'refresh failed'); if (!blocked()) { morph(el, j.html); syncNavCounts(); document.dispatchEvent(new CustomEvent('dash:refreshed', { detail: { name: name } })); } ok(); })
      .catch(function () { fail(); })
      .then(function () { inflight[name] = false; });
  }
  function refreshVisible() {
    if (document.hidden) return;
    [].forEach.call(document.querySelectorAll('[data-live]'), function (el) { if (visible(el)) refresh(el); });
  }
  window.DashLive = { morph: morph, ok: ok, fail: fail, refreshVisible: refreshVisible, countTo: countTo };
  setInterval(refreshVisible, 30000);
  setInterval(paintStatus, 5000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshVisible(); });
  show((location.hash || '').slice(1));
  // Links to #tab (and the back button) switch tabs without a reload.
  window.addEventListener('hashchange', function () {
    var id = (location.hash || '').slice(1);
    if (id && id !== document.body.dataset.view) show(id, { top: true });
  });
  firstPaint = false;
})();
`;

module.exports = { ICONS, TAB_ALIASES, icon, renderShellNav, SHELL_CSS, SHELL_SCRIPT, THEME_HEAD_SCRIPT };
