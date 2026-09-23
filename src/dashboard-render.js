'use strict';

const { fmtDuration, fmtSpace } = require('./util');
const { normalizeTierFolders, serializeTierFolders } = require('./tier-node-setup');
const { HEALTH_KEYS, healthLabel } = require('./health');
const { telemetrySummary } = require('./node-telemetry');

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

// ---- Dashboard rendering (dark Plex/Overseerr-style theme, all inline, no build step) ----

// Mobile-first: sticky header with a horizontally-scrolling section nav, activity rendered as
// touch-friendly item rows with progress bars, and tables that collapse into labeled cards on
// narrow screens. All inline, no build step, dark Plex/Overseerr look.
const DASHBOARD_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
  :root { --bg:#101114; --panel:#1b1d22; --panel2:#24262d; --panel3:#2d3038; --accent:#f2a617; --accent-strong:#ffc04b; --text:#f4f4f2; --muted:#a9b1bf; --border:#363942; --ok:#36d284; --warn:#f59e0b; --down:#ff6969; --skip:#818996; --focus:#79b9ff; }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; font-family:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--text); line-height:1.45; padding-bottom:env(safe-area-inset-bottom); }
  button, input, select, textarea { font:inherit; }
  header.hdr { position:sticky; top:0; z-index:20; background:color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px); border-bottom:1px solid var(--border); padding-top:env(safe-area-inset-top); }
  .topbar { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px 16px 8px; }
  .topbar h1 { margin:0; font-size:16px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .topbar .brand { color:var(--accent); }
  .topbar-search { flex:1 1 280px; max-width:480px; display:flex; gap:8px; }
  .topbar-search input { width:100%; min-width:100px; padding:9px 11px; border-radius:9px; border:1px solid var(--border); background:var(--panel); color:var(--text); font-size:14px; }
  .nav { display:flex; gap:6px; overflow-x:auto; margin:0 16px 10px; padding:4px; scrollbar-width:none; border:1px solid var(--border); background:var(--panel); border-radius:12px; }
  .nav::-webkit-scrollbar { display:none; }
  .chip { flex:0 0 auto; min-height:39px; display:inline-flex; align-items:center; gap:8px; padding:0 14px; border:0; border-radius:8px; background:transparent; color:var(--muted); font-size:13px; font-weight:600; text-decoration:none; white-space:nowrap; }
  .chip:hover, .chip:active { color:var(--text); }
  :focus-visible { outline:3px solid color-mix(in srgb, var(--focus) 65%, transparent); outline-offset:2px; }
  .chip:focus-visible { outline-offset:0; }
  .container { max-width:1100px; margin:0 auto; padding:16px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:13px; box-shadow:0 1px 0 color-mix(in srgb, var(--text) 4%, transparent); padding:16px 18px; margin-bottom:14px; scroll-margin-top:110px; }
  .card h2 { margin:0 0 10px; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; }
  .overall { display:flex; flex-wrap:wrap; gap:6px 14px; align-items:baseline; justify-content:space-between; padding:12px 16px; border-radius:14px; margin-bottom:14px; font-size:14px; }
  .overall.ok { background:rgba(34,197,94,.10); border:1px solid rgba(34,197,94,.5); }
  .overall.warn { background:rgba(245,158,11,.10); border:1px solid rgba(245,158,11,.5); }
  .card.banner-warn { background:rgba(245,158,11,.08); border:1px solid rgba(245,158,11,.55); }
  .overall .updated { color:var(--muted); font-size:12px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(118px,1fr)); gap:10px; margin-bottom:14px; }
  .stat { background:var(--bg); border:1px solid var(--border); border-radius:10px; padding:14px; }
  .stat .n { display:block; font-size:22px; font-weight:600; color:var(--accent-strong); font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,monospace; line-height:1.1; }
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
  .action-result.ok { color:var(--ok); } .action-result.bad { color:var(--down); }
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
  .btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; min-height:42px; padding:9px 14px; border-radius:8px; background:var(--panel2); color:var(--text); border:1px solid var(--border); text-decoration:none; font-size:13px; font-weight:600; cursor:pointer; }
  .btn:hover { background:var(--panel3); }
  .btn.danger { border-color:color-mix(in srgb, var(--down) 56%, var(--border)); color:var(--down); background:transparent; }
  .btn.primary { background:var(--accent); color:#191303; border-color:var(--accent); font-weight:600; }
  .btn.primary:hover { background:var(--accent-strong); border-color:var(--accent-strong); }
  form.logout { margin:0; }
  .login-wrap { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px; }
  .login-card { width:100%; max-width:360px; background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:28px; }
  .login-card h1 { margin:0 0 4px; font-size:20px; }
  .login-card h1 .brand { color:var(--accent); }
  .login-card p { margin:0 0 20px; color:var(--muted); font-size:13px; }
  .login-card label { display:block; font-size:12px; color:var(--muted); margin-bottom:6px; }
  .login-card input { width:100%; padding:12px; border-radius:10px; border:1px solid var(--border); background:var(--bg); color:var(--text); font-size:16px; margin-bottom:16px; }
  .login-card .btn.primary { width:100%; text-align:center; }
  .login-card .btn.passkey { width:100%; margin-bottom:14px; }
  .login-divider { display:flex; align-items:center; gap:10px; color:var(--muted); font-size:11px; margin:0 0 14px; }
  .login-divider::before, .login-divider::after { content:''; flex:1; border-top:1px solid var(--border); }
  .error { background:rgba(239,68,68,.12); border:1px solid var(--down); color:var(--down); padding:10px 12px; border-radius:10px; font-size:13px; margin-bottom:16px; }
  .chip.tab { cursor:pointer; font:inherit; font-size:13px; }
  .chip.tab[aria-selected="true"] { background:var(--accent); color:#191303; font-weight:600; }
  .panel[hidden] { display:none; }
  .panel-intro { color:var(--muted); font-size:13px; margin:0 0 14px; }
  .card h2 .sub { display:block; text-transform:none; letter-spacing:0; font-weight:400; color:var(--muted); font-size:12px; margin-top:4px; }
  .setting { display:flex; flex-wrap:wrap; gap:10px 14px; align-items:center; justify-content:space-between; padding:11px 0; border-bottom:1px solid var(--border); }
  .setting:last-of-type { border-bottom:none; }
  .setting-main { flex:1 1 240px; min-width:0; }
  .setting-name { font-size:14px; }
  .setting-help { font-size:12px; color:var(--muted); margin-top:3px; }
  .setting-ctl { flex:0 0 auto; display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .setting-ctl input[type=number] { width:96px; padding:9px 10px; border-radius:9px; border:1px solid var(--border); background:var(--bg); color:var(--text); font-size:15px; }
  .setting-ctl input[type=text], .setting-foot input[type=text] { min-width:180px; padding:9px 10px; border-radius:9px; border:1px solid var(--border); background:var(--bg); color:var(--text); font-size:14px; }
  .setting-ctl .unit { font-size:12px; color:var(--muted); min-width:34px; }
  /* Below the 44x44 CSS px target size guideline by design: this toggle sits inline in a settings
     row directly beside its own text label (.setting-name) with normal paragraph spacing around
     it and no other interactive control within 24px, so it qualifies for the WCAG 2.5.8 spacing
     exception rather than needing to grow into an oversized pill. */
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
  .save-note.ok { color:var(--ok); } .save-note.bad { color:var(--down); }
  .setup-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:10px; }
  .setup-grid label { display:flex; flex-direction:column; gap:5px; color:var(--muted); font-size:12px; }
  .setup-grid input, .setup-grid select { width:100%; padding:10px; border-radius:9px; border:1px solid var(--border); background:var(--bg); color:var(--text); font-size:14px; }
  .setup-subheading { margin:16px 0 4px; font-size:14px; }
  .user-actions { white-space:nowrap; }
  .user-actions .btn { margin:2px 4px 2px 0; font-size:12.5px; padding:6px 10px; }
  .user-actions .action-result { display:block; white-space:normal; margin-top:6px; }
  #tier-folder-list { display:flex; flex-direction:column; gap:8px; margin:10px 0; }
  .tier-folder-row { display:grid; grid-template-columns:minmax(150px,.7fr) minmax(240px,1.3fr) auto; gap:8px; align-items:end; }
  .tier-folder-row label { display:flex; flex-direction:column; gap:5px; color:var(--muted); font-size:12px; }
  .tier-folder-row input { width:100%; padding:10px; border-radius:9px; border:1px solid var(--border); background:var(--bg); color:var(--text); font-size:14px; }
  .tier-folder-remove { min-height:39px; padding:8px 11px; }
  .tier-plan-controls { display:flex; align-items:end; gap:10px; flex-wrap:wrap; margin-bottom:12px; }
  .tier-plan-controls label { display:flex; flex-direction:column; gap:5px; color:var(--muted); font-size:12px; }
  .tier-plan-controls select { padding:10px; border-radius:9px; border:1px solid var(--border); background:var(--bg); color:var(--text); font-size:14px; }
  .tier-plan-node { border:1px solid var(--border); border-radius:12px; padding:12px 14px; margin:10px 0; background:var(--panel2); }
  .tier-plan-node h3 { margin:0 0 6px; font-size:15px; }
  .tier-plan-node p { margin:6px 0; font-size:13px; }
  .tier-plan-node details { margin-top:8px; font-size:13px; }
  .tier-plan-node summary { cursor:pointer; color:var(--muted); }
  .tier-manage-row { margin:10px 0; font-size:13px; }
  .tier-manage-list { list-style:none; padding:0; margin:8px 0; display:flex; flex-direction:column; gap:6px; }
  .tier-manage-list li { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .tier-manage-list code { font-size:12px; }
  .setup-check { display:flex; align-items:center; gap:8px; color:var(--text); font-size:13px; margin:12px 0; }
  .setup-output { white-space:pre-wrap; overflow-wrap:anywhere; background:var(--bg); border:1px solid var(--border); border-radius:10px; padding:12px; font-size:12px; }
  .setup-warning { color:var(--down); font-size:12.5px; }
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
  /* Director tab — prototype design language (page lead, metric strip, node rows).
     Scoped to .d-panel so the rest of the dashboard is untouched. */
  .d-panel { font-family:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .d-page-lead { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:end; gap:18px; margin:2px 0 16px; }
  .d-eyebrow { color:var(--accent-strong); font:600 12px/1.2 "IBM Plex Mono",ui-monospace,SFMono-Regular,monospace; letter-spacing:.02em; margin-bottom:8px; }
  .d-h1 { margin:0 0 6px; font-size:clamp(26px,4vw,36px); letter-spacing:-.03em; line-height:1.08; color:var(--text); }
  .d-lead-copy { margin:0; color:var(--muted); font-style:normal; font-size:14px; max-width:64ch; }
  .d-status { display:inline-flex; align-items:center; gap:6px; padding:6px 11px; border-radius:999px; font-size:12px; font-weight:600; white-space:nowrap; background:var(--panel2); color:var(--muted); border:1px solid var(--border); }
  .d-status::before { content:""; width:7px; height:7px; border-radius:50%; background:currentColor; }
  .d-status.ok { color:var(--ok); background:rgba(34,197,94,.10); border-color:rgba(34,197,94,.45); }
  .d-status.warn { color:var(--warn); background:rgba(245,158,11,.10); border-color:rgba(245,158,11,.45); }
  .d-status.bad { color:var(--down); background:rgba(239,68,68,.12); border-color:rgba(239,68,68,.5); }
  .d-metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin:0 0 14px; }
  .d-metric { padding:14px; border:1px solid var(--border); background:var(--panel); border-radius:12px; }
  .d-metric strong { display:block; color:var(--accent-strong); font:600 22px/1.1 "IBM Plex Mono",ui-monospace,SFMono-Regular,monospace; }
  .d-metric span { display:block; margin-top:6px; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.035em; }
  .d-callout { display:flex; align-items:flex-start; gap:10px; padding:12px 14px; border:1px solid rgba(229,160,13,.5); border-radius:10px; background:rgba(229,160,13,.08); color:var(--text); font-size:13px; margin:0 0 14px; }
  .d-callout svg { flex:0 0 auto; width:17px; height:17px; color:var(--accent); margin-top:1px; }
  .d-card { padding:0; overflow:hidden; }
  .card.d-card .d-card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:16px 16px 13px; border-bottom:1px solid var(--border); }
  .card.d-card .d-card-head h2 { margin:0; font-size:16px; font-weight:600; color:var(--text); text-transform:none; letter-spacing:0; }
  .card.d-card .d-card-head p { margin:4px 0 0; color:var(--muted); font-size:13px; font-style:normal; }
  .d-card-body { padding:4px 16px 12px; }
  .d-node-row { display:grid; grid-template-columns:12px minmax(0,1fr) auto; align-items:center; gap:12px; padding:12px 0; border-top:1px solid var(--border); }
  .d-node-row:first-child { border-top:0; }
  .d-node-dot { width:9px; height:9px; border-radius:50%; background:var(--ok); }
  .d-node-dot.warn { background:var(--warn); }
  .d-node-dot.down { background:var(--down); }
  .d-node-dot.skip { background:#6b7280; }
  .d-node-name { font-weight:600; font-size:14px; overflow-wrap:anywhere; }
  .d-node-meta { color:var(--muted); font-size:12px; margin-top:2px; overflow-wrap:anywhere; }
  .d-node-right { font:500 12px "IBM Plex Mono",ui-monospace,SFMono-Regular,monospace; color:var(--muted); text-align:right; white-space:nowrap; }
  .d-progress { height:5px; overflow:hidden; margin-top:8px; border-radius:999px; background:var(--panel2); }
  .d-progress > span { display:block; height:100%; border-radius:inherit; background:var(--accent); }
  @media (max-width:640px) {
    .d-page-lead { grid-template-columns:1fr; align-items:start; gap:10px; }
    .d-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .d-node-row { grid-template-columns:12px minmax(0,1fr); }
    .d-node-right { grid-column:2; text-align:left; }
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
  // Full ARIA tabs pattern (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/): each tab/panel pair
  // is wired with matching ids and aria-controls/aria-labelledby, only the selected tab is in the
  // tab order (roving tabindex), and Left/Right/Home/End move focus AND activate (single-select
  // automatic-activation tabs, the simple case the pattern explicitly allows for a plain tab bar
  // like this one — no async panel content to wait on).
  const tabScript = tabs ? `<script>
    (function () {
      var tabButtons = [].slice.call(document.querySelectorAll('.chip.tab'));
      var panels = [].slice.call(document.querySelectorAll('.panel'));
      tabButtons.forEach(function (b) {
        b.id = 'tab-' + b.dataset.tab;
        b.setAttribute('aria-controls', 'panel-' + b.dataset.tab);
      });
      panels.forEach(function (p) {
        p.id = 'panel-' + p.dataset.panel;
        p.setAttribute('role', 'tabpanel');
        p.setAttribute('aria-labelledby', 'tab-' + p.dataset.panel);
        p.tabIndex = 0;
      });
      function show(id, focusTab) {
        if (!panels.some(function (p) { return p.dataset.panel === id; })) id = panels[0] && panels[0].dataset.panel;
        panels.forEach(function (p) { p.hidden = p.dataset.panel !== id; });
        tabButtons.forEach(function (b) {
          var selected = b.dataset.tab === id;
          b.setAttribute('aria-selected', String(selected));
          b.tabIndex = selected ? 0 : -1;
          if (selected && focusTab) b.focus();
        });
        if (id) history.replaceState(null, '', '#' + id);
      }
      tabButtons.forEach(function (b, index) {
        b.addEventListener('click', function () { show(b.dataset.tab); window.scrollTo(0, 0); });
        b.addEventListener('keydown', function (event) {
          var targetIndex = null;
          if (event.key === 'ArrowRight') targetIndex = (index + 1) % tabButtons.length;
          else if (event.key === 'ArrowLeft') targetIndex = (index - 1 + tabButtons.length) % tabButtons.length;
          else if (event.key === 'Home') targetIndex = 0;
          else if (event.key === 'End') targetIndex = tabButtons.length - 1;
          if (targetIndex === null) return;
          event.preventDefault();
          show(tabButtons[targetIndex].dataset.tab, true);
        });
      });
      show((location.hash || '').slice(1));
    })();
  </script>` : '';
  // Auto-refresh pauses while the tab is hidden so a backgrounded phone doesn't burn
  // battery/API calls re-checking every integration.
  const refreshScript = autoRefresh ? `<script>
    (function () {
      var t;
      // Only an actual text/number/select field mid-edit counts — a focused BUTTON (the state
      // left behind by clicking a tab or any other button) is not editing anything and must not
      // block refresh forever. window.__dirtySettings tracks unsaved form changes explicitly;
      // window.__actionsInFlight (incremented/decremented around the shared action-button fetch)
      // covers a request still in flight when the timer fires.
      function editing() {
        var el = document.activeElement;
        return !!el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
      }
      function blocked() { return editing() || window.__dirtySettings || window.__actionsInFlight > 0; }
      function arm() { t = setTimeout(function () { if (blocked()) arm(); else location.reload(); }, 60000); }
      document.addEventListener('visibilitychange', function () { if (document.hidden) clearTimeout(t); else arm(); });
      if (!document.hidden) arm();
    })();
  </script>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#101114">
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

function renderBar(pct, label = '') {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const ariaLabel = label ? ` aria-label="${escapeHtml(label)} progress"` : '';
  return `<div class="bar" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"${ariaLabel}><div class="bar-fill${p >= 95 ? ' hot' : ''}" style="width:${p}%"></div></div>`;
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
        ${typeof i.pct === 'number' ? renderBar(i.pct, i.title || '') : ''}
        ${i.actions?.length ? `<div class="item-actions">${i.actions.map(action => `<button class="btn${action.danger ? ' danger' : ''}" type="button"${action.setupNode ? ` data-setup-node="${escapeHtml(action.setupNode)}"` : ` data-post="${escapeHtml(action.url)}" data-body="${escapeHtml(JSON.stringify(action.body || {}))}"`}${action.confirm ? ` data-confirm="${escapeHtml(action.confirm)}"` : ''}${action.inline ? ' data-inline="true"' : ''}${action.disabled ? ' disabled' : ''}${action.title ? ` title="${escapeHtml(action.title)}"` : ''}>${escapeHtml(action.label)}</button>`).join('')}</div>${i.actions.some(action => action.inline) ? '<span class="action-result" aria-live="polite"></span>' : ''}` : ''}
      </div>
      ${i.right ? `<div class="item-right">${escapeHtml(i.right)}</div>` : ''}
    </div>`).join('')}</div>`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

// Director tab: the prototype's design language — page lead with eyebrow, metric
// strip, node rows with status dots, and a callout when something is down.
// `services`: [{ state: 'ok'|'down'|'skip', title, sub, right }]
// `disks`:    [{ state: 'ok'|'warn', title, sub, right, pct }] (or null when the *arr diskspace call failed)
// `totalFreeLabel`: preformatted free-space total, or null.
function renderDirectorPanel({ overall, services, disks, totalFreeLabel }) {
  const list = Array.isArray(services) ? services : [];
  const counts = { ok: 0, down: 0, skip: 0 };
  for (const s of list) counts[['ok', 'down', 'skip'].includes(s.state) ? s.state : 'skip']++;
  const status = counts.down > 0 ? 'bad' : overall === 'ok' ? 'ok' : 'warn';
  const statusText = counts.down > 0
    ? `${counts.down} down`
    : overall === 'ok' ? 'All systems go' : String(overall || 'unknown').toUpperCase();
  const dotClass = state => (state === 'down' ? 'down' : state === 'warn' ? 'warn' : state === 'skip' ? 'skip' : '');
  const downServices = list.filter(s => s.state === 'down');
  const callout = downServices.length ? `
      <div class="d-callout" role="alert">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 9v4m0 4h.01"/><path d="M10.3 3.7 2.2 17.8A2 2 0 0 0 4 21h16a2 2 0 0 0 1.8-3.2L13.7 3.7a2 2 0 0 0-3.4 0Z"/></svg>
        <div><strong>${downServices.length === 1 ? 'One service needs attention' : `${downServices.length} services need attention`}.</strong>
        ${downServices.map(s => `${escapeHtml(s.title)}${s.sub ? ` — ${escapeHtml(s.sub)}` : ''}`).join(' · ')}</div>
      </div>` : '';
  const serviceRows = list.length ? list.map(s => `
        <div class="d-node-row">
          <span class="d-node-dot ${dotClass(s.state)}" aria-hidden="true"></span>
          <div><div class="d-node-name">${escapeHtml(s.title || '')}</div>${s.sub ? `<div class="d-node-meta">${escapeHtml(s.sub)}</div>` : ''}</div>
          <div class="d-node-right">${escapeHtml(s.right || '')}</div>
        </div>`).join('') : '<p class="d-lead-copy" style="padding:12px 0">No health data yet.</p>';
  const diskRows = disks === null
    ? '<p class="d-lead-copy" style="padding:12px 0">*arr diskspace unreachable or not configured.</p>'
    : (Array.isArray(disks) && disks.length ? disks.map(d => `
        <div class="d-node-row">
          <span class="d-node-dot ${dotClass(d.state)}" aria-hidden="true"></span>
          <div><div class="d-node-name">${escapeHtml(d.title || '')}</div>${d.sub ? `<div class="d-node-meta">${escapeHtml(d.sub)}</div>` : ''}
            ${typeof d.pct === 'number' ? `<div class="d-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.max(0, Math.min(100, d.pct))}" aria-label="${escapeHtml(d.title || 'disk')} usage"><span style="width:${Math.max(0, Math.min(100, d.pct))}%"></span></div>` : ''}</div>
          <div class="d-node-right">${escapeHtml(d.right || '')}</div>
        </div>`).join('') : '<p class="d-lead-copy" style="padding:12px 0">No disks reported.</p>');
  return `
      <div class="d-page-lead">
        <div>
          <div class="d-eyebrow">FLEET / LIVE</div>
          <h1 class="d-h1">The whole stack, one glance.</h1>
          <p class="d-lead-copy">Every service the media server runs — health and disk in one place. Auto-refreshes with the page. “Not configured” means the URL or API key isn’t set; nothing is alarming.</p>
        </div>
        <span class="d-status ${status}">${escapeHtml(statusText)}</span>
      </div>
      <div class="d-metrics">
        <div class="d-metric"><strong>${counts.ok}</strong><span>Services healthy</span></div>
        <div class="d-metric"><strong>${counts.down}</strong><span>Down</span></div>
        <div class="d-metric"><strong>${counts.skip}</strong><span>Not configured</span></div>
        <div class="d-metric"><strong>${totalFreeLabel ? escapeHtml(totalFreeLabel) : '—'}</strong><span>Disk free · all volumes</span></div>
      </div>
      ${callout}
      <div class="card d-card">
        <div class="d-card-head">
          <div><h2>Fleet status</h2><p>Plex, the *arrs, downloaders, and the bot’s own vitals.</p></div>
          <span class="d-status ${status}">${escapeHtml(statusText)}</span>
        </div>
        <div class="d-card-body">${serviceRows}</div>
      </div>
      <div class="card d-card">
        <div class="d-card-head">
          <div><h2>Disk space</h2><p>Free space and usage per volume.</p></div>
        </div>
        <div class="d-card-body">${diskRows}</div>
      </div>`;
}

function tierInstallCommand({ botUrl, node, token, folders, folderRoot, syncthingApiKey, syncthingFolderId, mountRoot, mountMarker, monitorOnly = false, monitorPath }) {
  // Monitor-only nodes (backup boxes): no Syncthing, no tier plan — the installer only needs
  // the token, TIER_MONITOR_ONLY=1, and the watched path (TIER_FOLDER_ROOT).
  if (monitorOnly) {
    const env = [
      `TIER_AGENT_TOKEN=${shellQuote(token)}`,
      `TIER_MONITOR_ONLY=1`,
      `TIER_FOLDER_ROOT=${shellQuote(monitorPath || folderRoot || '/mnt/backup')}`,
    ];
    return [
      `export TIER_AGENT_TOKEN=${shellQuote(token)}`,
      `curl -fsSL -H "Authorization: Bearer $TIER_AGENT_TOKEN" ${shellQuote(`${botUrl}/agent/install/${node}`)} \\`,
      `  | sudo -E env ${env.join(' ')} sh`,
      'unset TIER_AGENT_TOKEN',
    ].join('\n');
  }
  const normalizedFolders = normalizeTierFolders(folders || [{ id: syncthingFolderId, path: folderRoot }]);
  const env = [
    `TIER_AGENT_TOKEN=${shellQuote(token)}`,
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

function tierNodeStatus(plan, report, now = Date.now(), staleDays = 14) {
  const checkIn = plan?.lastHeartbeatAt || (report ? sqliteUtcMs(report.at) : null);
  const publishedHash = plan?.published?.planHash || null;
  const convergedHash = plan?.converged?.planHash || null;
  const matches = !!publishedHash && publishedHash === convergedHash;
  const errors = plan?.lastErrors?.length ? plan.lastErrors.join('; ') : report?.errors;
  // Plan AGE, distinct from checkIn (agent liveness) above: a node can heartbeat every 15 minutes
  // for weeks while converging cleanly against a plan nobody has re-applied since — Syncthing has
  // no notion of "tier", so nothing else here surfaces that drift. "stale" below already means
  // "hasn't checked in" (agent liveness), so this uses its own wording to avoid conflating the two.
  const publishedAt = plan?.published?.publishedAt || null;
  const planAgeMs = publishedAt ? Math.max(0, now - publishedAt) : null;
  const planIsStale = planAgeMs != null && planAgeMs > staleDays * 86400000;
  const details = [
    publishedHash ? `last plan ${publishedHash}` : 'no plan published',
    publishedAt ? `applied ${fmtDuration(planAgeMs)} ago${planIsStale ? ` ⚠️ stale (>${staleDays}d, no re-apply since)` : ''}` : null,
    checkIn ? `last check-in ${fmtDuration(Math.max(0, now - checkIn))} ago` : 'never checked in',
    report?.bytesFreed ? `freed ${fmtSpace(report.bytesFreed)} last run` : 'freed 0 B last run',
    publishedHash ? `published manifest ${matches ? 'matches' : 'does not match'} last confirmed plan` : null,
    errors ? `errors: ${errors}` : null,
    plan?.errorAlert?.stoodDown ? `alerts stood down after ${plan.errorAlert.attemptCount} identical error report(s)` : null,
    plan?.lastAgentVersion ? `agent ${plan.lastAgentVersion}` : 'agent version unknown (pre-upgrade)',
    plan?.lastTelemetry ? telemetrySummary(plan.lastTelemetry, fmtSpace, { now }) : 'hardware telemetry unavailable',
  ].filter(Boolean).join(' · ');
  if (!checkIn) return { state: 'warn', status: 'never reported', details, setup: true };
  if (matches && now - checkIn > 45 * 60 * 1000) return { state: 'down', status: 'stale', details };
  if (matches) return { state: errors || planIsStale ? 'warn' : 'ok', status: errors ? 'converged with errors' : planIsStale ? 'converged, plan stale' : 'converged', details };
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
      <p class="setup-warning" id="tier-mount-guard-note">⚠️ Mount guard: <strong>NOT configured</strong> — if this node has an external/removable media drive, a failed remount after reboot will go undetected and the agent may report an empty inventory. Fill in both fields above to enable it; leave both blank only for a master/single-disk node.</p>
      <h3 class="setup-subheading">Syncthing folders</h3>
      <p class="muted">Enter every folder ID exactly as Syncthing shows it and the matching existing local path on this node. Linux paths are case-sensitive; verify capitalization before generating. Four rows are ready; add more if needed.</p>
      <div id="tier-folder-list">${folderRows}</div>
      <button class="btn" id="tier-folder-add" type="button">Add folder</button>
      <p class="setup-warning">Generating saves this complete folder list and rotates the node token immediately. Run the command as an administrator who can use sudo; any existing agent using the old token stops checking in.</p>
      <button class="btn danger" type="submit">Rotate token and generate command</button>
      <span class="save-note" id="tier-install-note"></span>
      <div id="tier-install-result" hidden><p class="setup-warning">This command is shown once. Copy it before leaving or reloading this page.</p><p class="setup-warning" id="tier-install-mount-status"></p><pre class="setup-output" id="tier-install-command"></pre><button class="btn" type="button" id="tier-copy-command">Copy command</button></div>
    </form>` : '<p class="muted">Register a node to generate its install command.</p>'}
  </div>`;
}

function renderLogin(isError, message, { passkeyEnabled = false, expectedOrigin = '' } = {}) {
  const banner = message ? `<div class="error" id="login-error">${escapeHtml(message)}</div>`
    : (isError ? '<div class="error" id="login-error">Incorrect password. Please try again.</div>' : '');
  const body = `<div class="login-wrap" data-expected-origin="${escapeHtml(expectedOrigin)}"><div class="login-card">
    <h1><span class="brand">Durant</span> Media Server</h1>
    <p>Admin dashboard login</p>
    ${banner}
    <div class="error" id="insecure-context-warning" role="alert" hidden>This page is not loaded over a secure connection (HTTPS). Do not enter your password here — it would be sent unencrypted. Open the dashboard at its HTTPS URL instead.</div>
    ${passkeyEnabled ? '<button class="btn primary passkey" type="button" id="passkey-login" aria-describedby="passkey-support">Sign in with a passkey</button><div class="error" id="passkey-support" role="status" hidden></div><div class="login-divider">password fallback</div>' : ''}
    <form method="post" action="/admin/login">
      <label for="password">Password</label>
      <input type="password" id="password" name="password"${passkeyEnabled ? '' : ' autofocus'} autocomplete="current-password webauthn" required>
      <button class="btn primary" type="submit">Log in</button>
    </form>
  </div></div><script>
    // isSecureContext is false for plain http:// (localhost is exempted by browsers and is not a
    // real risk). A password typed into this page over a genuinely insecure origin would be sent
    // in the clear — refuse to make that easy to miss the way a merely-disabled passkey button is.
    if (!window.isSecureContext) {
      var warning = document.getElementById('insecure-context-warning');
      warning.hidden = false;
      document.querySelector('form[action="/admin/login"] button[type="submit"]').disabled = true;
    }
  </script>${passkeyEnabled ? `<script src="/admin/passkey-client.js"></script><script src="/admin/webauthn-browser.js"></script><script>
    var passkeyButton = document.getElementById('passkey-login');
    var supportNote = document.getElementById('passkey-support');
    var expectedOrigin = document.querySelector('.login-wrap').dataset.expectedOrigin || '';
    var passkeyReady = !!window.PasskeyClient && window.PasskeyClient.preparePasskeyAction(passkeyButton, supportNote, window, ' Password login still works below.', expectedOrigin);
    if (!window.PasskeyClient) {
      passkeyButton.disabled = true;
      supportNote.hidden = false;
      supportNote.textContent = 'Passkey support could not be checked. Open this HTTPS dashboard in Safari, Chrome, Edge, or another WebAuthn-capable browser. Password login still works below.';
    }
    if (passkeyReady) passkeyButton.addEventListener('click', async function () {
      var button = this;
      var banner = document.getElementById('login-error');
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
        if (!banner) { banner = document.createElement('div'); banner.id = 'login-error'; banner.className = 'error'; document.querySelector('.login-card p').after(banner); }
        banner.textContent = window.PasskeyClient ? window.PasskeyClient.passkeyErrorMessage(error, window, expectedOrigin) : (error.message || String(error));
        button.disabled = false;
      }
    });
  </script>` : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login — Durant Media Server</title><style>${DASHBOARD_CSS}</style></head>
  <body>${body}</body></html>`;
}

function renderPasskeyManagement(passkeys, rpID, expectedOrigin = '') {
  const rows = passkeys.length ? passkeys.map(passkey => `<div class="setting" data-passkey="${escapeHtml(passkey.credential_id)}">
    <div class="setting-main"><div class="setting-name">${escapeHtml(passkey.label)}</div><div class="setting-help">Created ${escapeHtml(new Date(passkey.created_at).toISOString())}${passkey.last_used_at ? ` · last used ${escapeHtml(new Date(passkey.last_used_at).toISOString())}` : ' · never used'}</div></div>
    <div class="setting-ctl"><input type="text" value="${escapeHtml(passkey.label)}" maxlength="64" aria-label="Passkey label"><button class="btn" type="button" data-passkey-rename>Rename</button><button class="btn danger" type="button" data-passkey-revoke>Revoke</button></div>
  </div>`).join('') : '<p class="muted">No passkeys enrolled.</p>';
  return `<div class="card" id="passkeys" data-passkey-origin="${escapeHtml(expectedOrigin)}">
    <h2>Passkeys<span class="sub">Platform passkeys for ${escapeHtml(rpID)}, at ${escapeHtml(expectedOrigin || `https://${rpID}`)}. This exact origin is the relying party and cannot be changed without enrolling again — set DASHBOARD_PUBLIC_URL to move it.</span></h2>
    ${rows}
    <div class="setting-foot"><input type="text" id="passkey-label" maxlength="64" placeholder="Device label, e.g. Caleb's iPhone" aria-label="New passkey label"><button class="btn primary" type="button" id="passkey-enroll" aria-describedby="passkey-note">Enroll passkey</button><span class="save-note" id="passkey-note" role="status" aria-live="polite"></span></div>
  </div>`;
}

// Shown once, at the top of /admin, when this browser session signed in with the password
// fallback and no passkey is enrolled yet: the guided path from "account created" to "passkey
// enrolled", instead of hunting for the Passkeys card further down the page.
function renderPasskeySetupBanner() {
  return `<div class="card banner-warn" id="passkey-setup-banner">
    <h2>🔐 Finish securing your admin account</h2>
    <p class="muted">You signed in with the password fallback and no passkey is enrolled yet. Passkeys are the phishing-resistant way in — enroll one now; the password stays as fallback.</p>
    <button class="btn primary" type="button" id="passkey-setup-go">Enroll a passkey</button>
  </div>`;
}

// Dashboard-minted Agent API tokens: labeled machine credentials for the read-only agent API
// (e.g. Edith), created and revoked here instead of hand-generating AGENT_API_TOKEN and editing
// the container environment. Raw values are shown exactly once at creation — only hashes live
// in the database.
function renderAgentApiTokens(tokens, { legacyConfigured = false } = {}) {
  const fmtWhen = ms => (ms ? new Date(ms).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : 'never');
  const rows = tokens.length ? tokens.map(token => {
    const revoked = !!token.revoked;
    const scopes = Array.isArray(token.scopes) ? token.scopes : [];
    const actions = Array.isArray(token.discordActions) ? token.discordActions : [];
    // A wildcard is a token that predates scopes, still at full reach. Say so plainly rather
    // than printing "*" and leaving an operator to work out what it means.
    const reach = actions.includes('*')
      ? ' · Discord: <strong>every action</strong> (pre-scopes token)'
      : (actions.length ? ` · Discord: ${escapeHtml(actions.join(', '))}` : '');
    const scopeLine = `Scopes: ${escapeHtml(scopes.join(', ') || 'none')}${reach}`;
    return `<div class="setting" data-agent-token="${token.id}">
    <div class="setting-main"><div class="setting-name">${escapeHtml(token.label)}</div><div class="setting-help">${scopeLine}</div><div class="setting-help">Created ${escapeHtml(fmtWhen(token.createdAt))} · last used ${escapeHtml(fmtWhen(token.lastUsedAt))}${revoked ? ' · <strong>revoked</strong>' : ''}</div></div>
    <div class="setting-ctl">${revoked ? '<span class="muted">revoked</span>' : '<button class="btn danger" type="button" data-agent-token-revoke>Revoke</button>'}</div>
  </div>`;
  }).join('') : '<p class="muted">No API tokens yet.</p>';
  return `<div class="card" id="agent-api-tokens">
    <h2>Agent API tokens<span class="sub">Machine access for the read-only agent API. One token per client — copy it once, revoke anytime.${legacyConfigured ? ' The legacy AGENT_API_TOKEN env var stays active alongside these.' : ''}</span></h2>
    ${rows}
    <div class="setting-foot"><input type="text" id="agent-token-label" maxlength="64" placeholder="Label, e.g. Edith" aria-label="New token label"></div>
    <div class="setting-foot">
      <label><input type="checkbox" id="agent-scope-read" checked> read</label>
      <label><input type="checkbox" id="agent-scope-write"> write</label>
      <label><input type="checkbox" id="agent-scope-discord"> discord</label>
    </div>
    <div class="setting-foot"><input type="text" id="agent-token-actions" placeholder="Discord actions, comma separated — e.g. queue, season, adopt_do" aria-label="Allowed Discord actions" style="min-width:22rem;"></div>
    <p class="setting-help">A token reaches only what it is given. With the <strong>discord</strong> scope, list the slash commands and button actions it may drive — there is no "everything" shortcut, by design. <code>GET /api/v1/discord/commands</code> lists them all, and flags the three that hand out, rotate or revoke a credential.</p>
    <div class="setting-foot"><button class="btn primary" type="button" id="agent-token-create" aria-describedby="agent-token-note">Create token</button><span class="save-note" id="agent-token-note" role="status" aria-live="polite"></span></div>
    <div id="agent-token-once" hidden>
      <p><strong>Copy this token now — it will not be shown again.</strong></p>
      <p><code id="agent-token-value" style="word-break:break-all;user-select:all;"></code> <button class="btn" type="button" id="agent-token-copy">Copy</button></p>
    </div>
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
  return HEALTH_KEYS.filter(k => health[k] !== undefined)
    .map(k => {
      const age = k === 'backup' && health.backupLastSuccessfulAt ? ` · ${fmtAgo(health.backupLastSuccessfulAt)}` : '';
      return `<span class="badge"><span class="dot ${healthClass(health[k])}"></span>${escapeHtml(healthLabel(k))}: ${escapeHtml(String(health[k]))}${escapeHtml(age)}</span>`;
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

function renderAutomationRegistry(items) {
  const rows = (items || []).map(item => {
    const state = item.state || {};
    const cadence = item.cadence || {};
    const status = item.running ? 'running' : !item.enabled ? 'disabled' : state.status || 'not run';
    const outcome = state.status === 'failed'
      ? state.error || 'failed'
      : state.resultSummary || 'No completed run recorded.';
    const timing = state.finishedAt
      ? `${fmtAgo(state.finishedAt)} · ${fmtDuration(state.durationMs || 0)} · ${state.trigger || 'unknown'} · ${state.resultCount ?? 0} result(s)`
      : 'No completed run recorded.';
    const cadenceMode = cadence.mutable ? ' · live editable' : cadence.restartRequired ? ' · restart required' : '';
    const cadenceText = cadence.minutes > 0
      ? `Every ${cadence.minutes} min · ${cadence.source}${cadenceMode}`
      : `Disabled · ${cadence.source || 'compose'}${cadenceMode}`;
    const next = state.nextRunAt
      ? item.enabled ? `Next expected ${fmtAgo(state.nextRunAt)}` : `No run scheduled; eligibility rechecked ${fmtAgo(state.nextRunAt)}`
      : 'Next run not scheduled.';
    const manual = item.manual?.enabled
      ? `${item.previewable ? 'Preview and run-now available.' : 'Run-now available.'}`
      : `Manual unavailable: ${item.manual?.reason || 'scheduled execution only.'}`;
    const action = item.manual?.enabled
      ? `<button class="btn" type="button" data-post="/admin/action/sweep" data-body="${escapeHtml(JSON.stringify({ name: item.id }))}"${item.enabled ? '' : ' disabled'}>Run now</button>`
      : '';
    return `<div class="setting">
      <div class="setting-main"><div class="setting-name">${escapeHtml(item.label)} <span class="tag${item.enabled ? ' on' : ''}">${escapeHtml(status)}</span></div>
      <div class="setting-help">${escapeHtml(item.enabled ? cadenceText : `Disabled: ${item.disabledReason} · ${cadenceText}`)} · ${escapeHtml(timing)}<br>${escapeHtml(outcome)} · ${escapeHtml(next)} · ${escapeHtml(manual)}</div></div>
      <div class="setting-ctl">${action}</div>
    </div>`;
  }).join('');
  return `<div class="card" id="automation-registry"><h2>Automation registry<span class="sub">Every scheduled worker, its effective source, persisted outcome, and safe manual policy.</span></h2>${rows || '<p class="muted">Registry is starting.</p>'}</div>`;
}

module.exports = {
  renderSettingsGroup,
  renderAutomationRegistry,
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
  renderPasskeySetupBanner,
  renderAgentApiTokens,
  renderDirectorPanel,
};
