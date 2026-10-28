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
  @import url('https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400..700&family=Instrument+Serif:ital@0;1&family=Space+Mono:wght@400;700&display=swap');
  /* Dashboard theme tokens: palette, type and liquid glass. */
  :root { --bg:#10232f; --panel:#173042; --panel2:#1d3a4e; --panel3:#24465c; --accent:#79d2d8; --accent-strong:#a9e4e8; --on-accent:#10232f;
    --text:#f3f7f8; --muted:#bdcfd7; --faint:#8fa9b5; --border:#3a5767; --line-strong:#6a90a1; --edge:rgba(137,180,200,.32);
    --glass:rgba(23,48,66,.42); --cool:#9cc27a; --ok:#5fd39a; --warn:#f2b94b; --down:#ff8a80; --skip:#8fa9b5; --focus:#79d2d8;
    --sans:"Instrument Sans","Helvetica Neue",Arial,sans-serif; --serif:"Instrument Serif",Georgia,serif; --mono:"Space Mono",ui-monospace,SFMono-Regular,monospace; }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust:100%; color-scheme:dark; }
  .skip-link { position:fixed; top:8px; left:16px; z-index:30; transform:translateY(-160%); padding:10px 14px; border-radius:8px; background:var(--accent); color:var(--on-accent); font-weight:600; }
  .skip-link:focus { transform:translateY(0); }
  body { margin:0; font-family:var(--sans); background:var(--bg); color:var(--text); line-height:1.45; padding-bottom:env(safe-area-inset-bottom); }
  button, input, select, textarea { font:inherit; }
  header.hdr { position:sticky; top:0; z-index:20; background:color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px); border-bottom:1px solid var(--border); padding-top:env(safe-area-inset-top); }
  .topbar { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:16px 24px 12px; max-width:1280px; margin:0 auto; }
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
  .container { max-width:1280px; margin:0 auto; padding:24px; }
  .container, .card, .setting-ctl, .setting-foot { min-width:0; }
  .setting-foot input[type=text] { max-width:100%; }
  #agent-token-actions { width:100%; min-width:0; }
  .btn:disabled { opacity:.5; cursor:not-allowed; }
  @media (min-width:1280px) { .nav { max-width:1232px; margin-left:auto; margin-right:auto; } }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:13px; box-shadow:0 1px 0 color-mix(in srgb, var(--text) 4%, transparent); padding:16px 18px; margin-bottom:14px; scroll-margin-top:110px; }
  .card h2 { margin:0 0 10px; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; }
  .overall { display:flex; flex-wrap:wrap; gap:6px 14px; align-items:baseline; justify-content:space-between; padding:12px 16px; border-radius:14px; margin-bottom:14px; font-size:14px; }
  .overall.ok { background:color-mix(in srgb, var(--ok) 10%, transparent); border:1px solid color-mix(in srgb, var(--ok) 50%, transparent); }
  .overall.warn { background:color-mix(in srgb, var(--warn) 10%, transparent); border:1px solid color-mix(in srgb, var(--warn) 50%, transparent); }
  .card.banner-warn { background:color-mix(in srgb, var(--warn) 8%, transparent); border:1px solid color-mix(in srgb, var(--warn) 55%, transparent); }
  .overall .updated { color:var(--muted); font-size:12px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(118px,1fr)); gap:10px; margin-bottom:14px; }
  .stat { background:var(--bg); border:1px solid var(--border); border-radius:10px; padding:14px; }
  .stat .n { display:block; font-size:22px; font-weight:600; color:var(--accent-strong); font-family:var(--mono); line-height:1.1; }
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
  .btn.primary { background:var(--accent); color:var(--on-accent); border-color:var(--accent); font-weight:600; }
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
  .error { background:color-mix(in srgb, var(--down) 12%, transparent); border:1px solid var(--down); color:var(--down); padding:10px 12px; border-radius:10px; font-size:13px; margin-bottom:16px; }
  .chip.tab { cursor:pointer; font:inherit; font-size:13px; }
  .chip.tab[aria-selected="true"] { background:var(--accent); color:var(--on-accent); font-weight:600; }
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
  .switch input:checked + .track { background:color-mix(in srgb, var(--accent) 25%, transparent); border-color:var(--accent); }
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
  .recent-strip { display:flex; gap:12px; overflow-x:auto; overscroll-behavior-x:contain; scroll-snap-type:x proximity; padding:2px 2px 8px; margin:0 -2px; -webkit-overflow-scrolling:touch; }
  .recent-item { flex:0 0 112px; min-width:0; scroll-snap-align:start; }
  .recent-poster { position:relative; aspect-ratio:2/3; border-radius:10px; overflow:hidden; border:1px solid var(--border); background:var(--bg); display:flex; align-items:flex-end; padding:8px; }
  .recent-poster .ph { font-size:12px; font-weight:650; line-height:1.25; color:var(--muted); overflow-wrap:anywhere; }
  .recent-poster img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
  .recent-title { margin-top:6px; font-size:12.5px; font-weight:650; line-height:1.3; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .recent-meta { font-size:11.5px; color:var(--muted); margin-top:2px; }
  .inbox-more summary { display:flex; align-items:center; min-height:44px; cursor:pointer; color:var(--accent); font-size:13.5px; font-weight:600; }
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
    .item-main { flex-basis:0; } /* stay beside the dot however long the subline is */
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
  .d-panel { font-family:var(--sans); }
  .d-page-lead { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:end; gap:18px; margin:2px 0 16px; }
  .d-eyebrow { color:var(--accent-strong); font:600 12px/1.2 var(--mono); letter-spacing:.02em; margin-bottom:8px; }
  .d-h1 { margin:0 0 6px; font-size:clamp(26px,4vw,36px); letter-spacing:-.03em; line-height:1.08; color:var(--text); }
  .d-lead-copy { margin:0; color:var(--muted); font-style:normal; font-size:14px; max-width:64ch; }
  .d-status { display:inline-flex; align-items:center; gap:6px; padding:6px 11px; border-radius:999px; font-size:12px; font-weight:600; white-space:nowrap; background:var(--panel2); color:var(--muted); border:1px solid var(--border); }
  .d-status::before { content:""; width:7px; height:7px; border-radius:50%; background:currentColor; }
  .d-status.ok { color:var(--ok); background:color-mix(in srgb, var(--ok) 10%, transparent); border-color:color-mix(in srgb, var(--ok) 45%, transparent); }
  .d-status.warn { color:var(--warn); background:color-mix(in srgb, var(--warn) 10%, transparent); border-color:color-mix(in srgb, var(--warn) 45%, transparent); }
  .d-status.bad { color:var(--down); background:color-mix(in srgb, var(--down) 12%, transparent); border-color:color-mix(in srgb, var(--down) 50%, transparent); }
  .d-metrics { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; margin:0 0 20px; }
  .d-metric { padding:14px; border:1px solid var(--border); background:var(--panel); border-radius:12px; }
  .d-metric strong { display:block; color:var(--accent-strong); font:600 22px/1.1 var(--mono); }
  .d-metric.attention strong { color:var(--warn); }
  .d-metric.critical strong { color:var(--down); }
  .d-grid { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(0,1fr); gap:20px; align-items:start; }
  .d-grid > .card { min-width:0; }
  .d-metric span { display:block; margin-top:6px; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.035em; }
  .d-callout { display:flex; align-items:flex-start; gap:10px; padding:12px 14px; border:1px solid color-mix(in srgb, var(--warn) 50%, transparent); border-radius:10px; background:color-mix(in srgb, var(--warn) 8%, transparent); color:var(--text); font-size:13px; margin:0 0 14px; }
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
  .d-node-dot.skip { background:var(--skip); }
  .d-node-name { font-weight:600; font-size:14px; overflow-wrap:anywhere; }
  .d-node-meta { color:var(--muted); font-size:12px; margin-top:2px; overflow-wrap:anywhere; }
  .d-node-right { font:500 12px var(--mono); color:var(--muted); text-align:right; white-space:nowrap; }
  .d-progress { height:5px; overflow:hidden; margin-top:8px; border-radius:999px; background:var(--panel2); }
  .d-progress > span { display:block; height:100%; border-radius:inherit; background:var(--accent); }
  @media (max-width:900px) { .d-grid { grid-template-columns:1fr; gap:0; } }
  @media (max-width:640px) {
    .d-page-lead { grid-template-columns:1fr; align-items:start; gap:10px; }
    .d-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .d-node-row { grid-template-columns:12px minmax(0,1fr); }
    .d-node-right { grid-column:2; text-align:left; }
  }
  /* ---- Durant skin: liquid glass over drifting light, underline tabs, quieter chrome ---- */
  body { background:var(--bg); font-family:var(--sans); }
  body::before { content:""; position:fixed; inset:0; z-index:-1; pointer-events:none;
    background: radial-gradient(520px circle at 8% 12%, rgba(121,210,216,.20), transparent 70%),
      radial-gradient(460px circle at 92% 46%, rgba(156,194,122,.12), transparent 70%),
      radial-gradient(640px circle at 46% 108%, rgba(40,87,98,.55), transparent 70%); }
  header.hdr { background:color-mix(in srgb, var(--bg) 72%, transparent); border-bottom-color:var(--edge); }
  .topbar h1 { display:flex; align-items:center; gap:10px; font-weight:700; letter-spacing:-.02em; }
  .topbar .brand { color:var(--text); }
  .brand-mark { display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px; padding-right:3px; border-radius:7px; background:var(--text); color:var(--bg); font-size:22px; font-weight:800; letter-spacing:-3px; flex:0 0 auto; }
  .brand-mark span { color:#285762; }
  .nav { background:transparent; border:0; border-radius:0; padding:0 4px; margin-bottom:0; gap:2px; }
  .chip.tab { position:relative; border-radius:0; min-height:44px; }
  .chip.tab::after { content:""; position:absolute; left:12px; right:12px; bottom:4px; height:2px; border-radius:2px; background:var(--accent); transform:scaleX(0); transform-origin:left; transition:transform .35s cubic-bezier(.2,.75,.25,1); }
  .chip.tab[aria-selected="true"] { background:transparent; color:var(--text); }
  .chip.tab[aria-selected="true"]::after, .chip.tab:hover::after { transform:scaleX(1); }
  .tab-count { min-width:19px; padding:1px 6px; border-radius:99px; background:color-mix(in srgb, var(--accent) 16%, transparent); color:var(--accent); font:700 11px/1.5 var(--mono); text-align:center; }
  .card, .stat, .d-metric, .overall, .login-card { background:linear-gradient(150deg, color-mix(in srgb, #fff 7%, transparent), transparent 46%), var(--glass); border-color:var(--edge);
    -webkit-backdrop-filter:blur(22px) saturate(1.8); backdrop-filter:blur(22px) saturate(1.8); box-shadow:inset 0 1px 0 color-mix(in srgb, #fff 18%, transparent), 0 18px 52px rgba(0,0,0,.22); }
  .card { border-radius:18px; }
  .stat, .d-metric { border-radius:14px; }
  .card h2, .stat .l, .d-metric span, th { font-family:var(--mono); font-weight:400; letter-spacing:.1em; }
  .card h2 .sub { font-family:var(--sans); letter-spacing:0; }
  .login-card h1 { display:flex; align-items:center; gap:10px; }
  .login-card h1 .brand { color:var(--text); }
  .stat .n, .d-metric strong { color:var(--text); font-weight:400; letter-spacing:-.04em; }
  .d-metric.attention strong { color:var(--warn); } .d-metric.critical strong { color:var(--down); }
  .btn { border-color:var(--line-strong); background:transparent; border-radius:10px; }
  .btn:hover { background:color-mix(in srgb, var(--accent) 10%, transparent); border-color:var(--accent); }
  .btn.primary:hover { background:var(--accent-strong); }
  .bar-fill { background:var(--accent); }
  input[type=search], input[type=text], input[type=number], input[type=password], select, textarea { border-color:var(--line-strong) !important; background:color-mix(in srgb, var(--bg) 70%, transparent) !important; }
  .d-eyebrow { color:var(--muted); font-weight:400; letter-spacing:.14em; text-transform:uppercase; display:flex; align-items:center; gap:10px; }
  .d-eyebrow::before { content:""; width:28px; height:1px; background:var(--accent); }
  .d-h1 { font-weight:500; letter-spacing:-.045em; }
  .d-progress > span.warn { background:var(--warn); } .d-progress > span.down { background:var(--down); }
  .d-healthy { border-top:1px solid var(--border); }
  .d-healthy summary { display:flex; align-items:center; gap:12px; padding:12px 0; cursor:pointer; list-style:none; color:var(--muted); font-size:13.5px; }
  .d-healthy summary::-webkit-details-marker { display:none; }
  .d-healthy summary::after { content:"+"; margin-left:auto; color:var(--accent); font:400 16px var(--mono); }
  .d-healthy[open] summary::after { content:"−"; }
  /* The global summary belongs to Overview; Director and Services carry their own. */
  body[data-tab="director"] .container > .overall, body[data-tab="director"] .container > .stats,
  body[data-tab="services"] .container > .overall, body[data-tab="services"] .container > .stats { display:none; }
  @media (prefers-reduced-motion: reduce) { .chip.tab::after { transition:none; } }
`;

// `tabs: true` turns the nav into panel switches rather than scroll anchors. The panels are all
// server-rendered and present in the DOM; the script only toggles which one is visible, so the
// page still works as one long document if scripting is unavailable (nothing is hidden until the
// script runs). The active tab lives in location.hash so the 60s auto-refresh comes back to it.
function renderPage(title, bodyHtml, { showLogout = false, showSearch = false, searchQuery = '', nav = [], autoRefresh = false, tabs = false } = {}) {
  const navHtml = nav.length
    ? `<nav class="nav" aria-label="Dashboard sections"${tabs ? ' role="tablist"' : ''}>${nav.map(([id, label, count]) => (tabs
      ? `<button class="chip tab" role="tab" type="button" data-tab="${escapeHtml(id)}" aria-selected="false">${escapeHtml(label)}${count ? ` <span class="tab-count" aria-label="${escapeHtml(String(count))} need attention">${escapeHtml(String(count))}</span>` : ''}</button>`
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
      var panels = [].slice.call(document.querySelectorAll('.panel[data-panel]'));
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
        document.body.dataset.tab = id || '';
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
  <meta name="theme-color" content="#10232f">
  <title>${escapeHtml(title)} — Durant Media Server</title>
  <style>${DASHBOARD_CSS}</style></head><body>
  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="hdr">
    <div class="topbar">
      <h1><span class="brand-mark" aria-hidden="true">d<span>l</span>.</span><span><span class="brand">Durant</span> Media Server</span></h1>
      ${showSearch ? `<form class="topbar-search" method="get" action="/admin/search"><input type="search" name="q" value="${escapeHtml(searchQuery)}" minlength="2" placeholder="Search requests, users, library, audit" aria-label="Search dashboard"><button class="btn" type="submit">Search</button></form>` : ''}
      ${showLogout ? '<form class="logout" method="post" action="/admin/logout"><button class="btn" type="submit">Log out</button></form>' : ''}
    </div>
    ${navHtml}
  </header>
  <main class="container" id="main-content" tabindex="-1">${bodyHtml}</main>
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

// Overview's recently-added strip: posters come through /admin/api/poster (Tautulli's image proxy),
// so it works without PLEX_URL. The title sits behind each poster and shows if the image fails.
function renderRecentlyAdded(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '<p class="muted">Nothing has been added recently.</p>';
  return `<div class="recent-strip" role="list">${list.map(i => {
    const label = [i.title, i.detail].filter(Boolean).join(' ');
    const meta = [i.library, i.addedAt ? fmtAgo(i.addedAt) : ''].filter(Boolean).join(' · ');
    return `<div class="recent-item" role="listitem">
      <div class="recent-poster"><span class="ph">${escapeHtml(label)}</span>${i.thumb ? `<img src="/admin/api/poster/${encodeURIComponent(i.ratingKey)}" alt="" loading="lazy" decoding="async" width="112" height="168">` : ''}</div>
      <div class="recent-title">${escapeHtml(label)}</div>
      <div class="recent-meta">${escapeHtml(meta)}</div>
    </div>`;
  }).join('')}</div>
  <script>document.addEventListener('error', function (e) { var t = e.target; if (t && t.matches && t.matches('.recent-poster img')) t.remove(); }, true);</script>`;
}

// Overview's alert inbox: service-down incidents from src/service-alerts.js alertInbox(), newest
// open ones first. Five show; the rest of the last 20 sit behind "Show N more".
function renderAlertInbox(incidents, { shown = 5 } = {}) {
  const list = Array.isArray(incidents) ? incidents : [];
  const items = list.map(inc => {
    const restart = inc.restarts ? 'restarted from Discord' : inc.restartFailed ? 'restart from Discord failed' : null;
    if (inc.open) {
      return {
        state: 'down',
        title: `${inc.name} is down`,
        sub: [
          inc.alertedAt != null ? `First alert ${fmtAgo(inc.alertedAt)}` : null,
          `${inc.alerts} alert${inc.alerts === 1 ? '' : 's'} sent`,
          inc.stoodDown ? 'reminders stopped' : null,
          restart,
        ].filter(Boolean).join(' · '),
        right: 'Open',
      };
    }
    return {
      state: 'ok',
      title: `${inc.name} is back`,
      sub: [
        inc.downForMs != null ? `Down for ${fmtDuration(inc.downForMs)}` : null,
        inc.recoveredAt != null ? `back ${fmtAgo(inc.recoveredAt)}` : null,
        restart,
      ].filter(Boolean).join(' · '),
      right: 'Resolved',
    };
  });
  const head = renderItemList(items.slice(0, shown), 'No service-down alerts yet. An alert posts after a service fails two checks in a row.');
  const rest = items.slice(shown);
  return rest.length
    ? `${head}<details class="inbox-more"><summary>Show ${rest.length} more</summary>${renderItemList(rest, '')}</details>`
    : head;
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
  const counts = { ok: 0, down: 0, warn: 0, skip: 0 };
  for (const s of list) counts[Object.hasOwn(counts, s.state) ? s.state : 'warn']++;
  const status = counts.down > 0 ? 'bad' : counts.warn > 0 ? 'warn' : overall === 'ok' ? 'ok' : 'warn';
  const statusText = counts.down > 0
    ? `${counts.down} down`
    : counts.warn > 0 ? `${counts.warn} warning${counts.warn === 1 ? '' : 's'}`
      : overall === 'ok' ? 'All systems go' : String(overall || 'unknown').toUpperCase();
  const dotClass = state => (state === 'down' ? 'down' : state === 'warn' ? 'warn' : state === 'skip' ? 'skip' : '');
  const downServices = list.filter(s => s.state === 'down');
  const callout = downServices.length ? `
      <div class="d-callout" role="alert">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 9v4m0 4h.01"/><path d="M10.3 3.7 2.2 17.8A2 2 0 0 0 4 21h16a2 2 0 0 0 1.8-3.2L13.7 3.7a2 2 0 0 0-3.4 0Z"/></svg>
        <div><strong>${downServices.length === 1 ? 'One service needs attention' : `${downServices.length} services need attention`}.</strong>
        ${downServices.map(s => `${escapeHtml(s.title)}${s.sub ? ` — ${escapeHtml(s.sub)}` : ''}`).join(' · ')}</div>
      </div>` : '';
  // Exceptions first: down, then warnings, then not configured; healthy services fold into one
  // expandable row so the one red dot isn't hiding among a column of green ones.
  const order = { down: 0, warn: 1, skip: 2, ok: 3 };
  const sorted = list.map((s, i) => [s, i]).sort((a, b) => ((order[a[0].state] ?? 1) - (order[b[0].state] ?? 1)) || a[1] - b[1]).map(([s]) => s);
  const serviceRow = s => `
        <div class="d-node-row">
          <span class="d-node-dot ${dotClass(s.state)}" aria-hidden="true"></span>
          <div><div class="d-node-name">${escapeHtml(s.title || '')}</div>${s.sub ? `<div class="d-node-meta">${escapeHtml(s.sub)}</div>` : ''}</div>
          <div class="d-node-right">${escapeHtml(s.right || '')}</div>
        </div>`;
  const healthy = sorted.filter(s => s.state === 'ok');
  const exceptions = sorted.filter(s => s.state !== 'ok');
  const serviceRows = list.length
    ? exceptions.map(serviceRow).join('') + (healthy.length
      ? (exceptions.length
        ? `<details class="d-healthy"><summary><span class="d-node-dot" aria-hidden="true"></span>${healthy.length} healthy service${healthy.length === 1 ? '' : 's'}</summary>${healthy.map(serviceRow).join('')}</details>`
        : healthy.map(serviceRow).join(''))
      : '')
    : '<p class="d-lead-copy" style="padding:12px 0">No health data yet.</p>';
  const diskRows = disks === null
    ? '<p class="d-lead-copy" style="padding:12px 0">*arr diskspace unreachable or not configured.</p>'
    : (Array.isArray(disks) && disks.length ? disks.map(d => `
        <div class="d-node-row">
          <span class="d-node-dot ${dotClass(d.state)}" aria-hidden="true"></span>
          <div><div class="d-node-name">${escapeHtml(d.title || '')}</div>${d.sub ? `<div class="d-node-meta">${escapeHtml(d.sub)}</div>` : ''}
            ${typeof d.pct === 'number' ? `<div class="d-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.max(0, Math.min(100, d.pct))}" aria-label="${escapeHtml(d.title || 'disk')} usage"><span class="${dotClass(d.state)}" style="width:${Math.max(0, Math.min(100, d.pct))}%"></span></div>` : ''}</div>
          <div class="d-node-right">${escapeHtml(d.right || '')}</div>
        </div>`).join('') : '<p class="d-lead-copy" style="padding:12px 0">No disks reported.</p>');
  return `
      <div class="d-page-lead">
        <div>
          <div class="d-eyebrow">FLEET / LIVE</div>
          <h1 class="d-h1">The whole stack, one glance.</h1>
          <p class="d-lead-copy">Service health and storage capacity, together. Refreshes every minute while you are not editing.</p>
        </div>
        <span class="d-status ${status}">${escapeHtml(statusText)}</span>
      </div>
      <div class="d-metrics">
        <div class="d-metric"><strong>${counts.ok}</strong><span>Services healthy</span></div>
        <div class="d-metric${counts.down ? ' critical' : ''}"><strong>${counts.down}</strong><span>Down</span></div>
        <div class="d-metric${counts.warn ? ' attention' : ''}"><strong>${counts.warn}</strong><span>Warnings</span></div>
        <div class="d-metric"><strong>${counts.skip}</strong><span>Not configured</span></div>
        <div class="d-metric"><strong>${totalFreeLabel ? escapeHtml(totalFreeLabel) : '—'}</strong><span>Disk free · all volumes</span></div>
      </div>
      ${callout}
      <div class="d-grid">
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
      </div>
      </div>`;
}

function renderServicesPanel() {
  // Client-rendered Services board. The server ships the shell; the browser
  // fetches /admin/api/services and renders cards from live data. Scoped
  // styles use the svc- prefix to avoid colliding with dashboard CSS.
  return `
<style>
.svc-wrap { /* Uses the dashboard theme tokens (see DASHBOARD_CSS :root). */
  --svc-accent: var(--accent); --svc-ink: var(--text); --svc-ink2: var(--muted); --svc-ink3: var(--faint);
  --svc-glass: var(--glass); --svc-line: var(--edge);
  --svc-green: var(--ok); --svc-red: var(--down); --svc-amber: var(--warn); --svc-cool: var(--cool);
  position: relative; max-width: 1060px; margin: 0 auto; }
.svc-orb { position: fixed; border-radius: 50%; filter: blur(90px); pointer-events: none; z-index: 0; opacity: .45; }
.svc-orb-1 { width: 420px; height: 420px; background: radial-gradient(circle, color-mix(in srgb, var(--svc-accent) 14%, transparent), transparent 70%); top: -120px; left: -100px; animation: svcDrift1 26s ease-in-out infinite alternate; }
.svc-orb-2 { width: 380px; height: 380px; background: radial-gradient(circle, color-mix(in srgb, var(--svc-cool) 10%, transparent), transparent 70%); bottom: -140px; right: -100px; animation: svcDrift2 32s ease-in-out infinite alternate; }
@keyframes svcDrift1 { to { transform: translate(70px, 50px) scale(1.12); } }
@keyframes svcDrift2 { to { transform: translate(-60px, -40px) scale(1.08); } }
@keyframes svcFadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
.svc-enter { opacity: 0; animation: svcFadeUp .6s ease forwards; }
.svc-head { display: flex; align-items: baseline; gap: 10px; margin: 0 0 12px; padding: 0 4px; }
.svc-hidden { margin-top: 8px; padding: 14px; border: 1px dashed var(--line-strong); border-radius: 18px; }
.svc-hidden .svc-head { margin-bottom: 6px; }
.svc-hidden-note { margin: 0 4px 12px; font-size: 13px; color: var(--muted); max-width: 60ch; }
.svc-hidden-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 148px), 1fr)); gap: 8px; }
.svc-hidden-card { display: flex; align-items: center; gap: 10px; min-height: 56px; padding: 10px 12px; border-radius: 14px; background: color-mix(in srgb, var(--panel) 70%, transparent); min-width: 0; }
.svc-hidden-card .svc-icon { opacity: .7; flex: none; }
.svc-hidden-card .grow { display: grid; gap: 1px; min-width: 0; }
.svc-hidden-card b { font-size: 14px; font-weight: 600; }
.svc-hidden-card small { font-size: 12px; color: var(--faint); }
.svc-hidden-card code { font-family: var(--mono); font-size: 11.5px; color: var(--warn); overflow-wrap: anywhere; }
@media (max-width: 520px) { .svc-hidden-card .svc-icon { display: none; } .svc-hidden-card code { font-size: 11px; } }
.svc-facts { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 8px; font-family: var(--mono); font-size: 11px; color: var(--faint); }
.svc-facts .hot { color: var(--warn); }
.svc-card.has-dl { grid-column: span 2; }
@media (max-width: 720px) { .svc-card.has-dl { grid-column: 1 / -1; } }
.svc-dl { display: grid; gap: 9px; margin-top: 10px; }
.svc-dl-row { display: grid; gap: 4px; min-width: 0; }
.svc-dl-row .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--text); }
.svc-dl-row .r { font-family: var(--mono); font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
.svc-dl-bar { height: 6px; border-radius: 99px; background: color-mix(in srgb, var(--text) 10%, transparent); overflow: hidden; }
.svc-dl-bar i { display: block; height: 100%; border-radius: 99px; background: var(--focus); }
.svc-dl-row.warn .svc-dl-bar i { background: var(--warn); }
.svc-dl-row.warn .r { color: var(--warn); }
.svc-dl-more { font-size: 12px; color: var(--faint); }
.svc-filter { display: flex; gap: 8px; align-items: center; margin: 0 0 16px; }
.svc-find { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 12px; border-radius: 14px; border: 1px solid var(--edge); background: var(--glass); color: var(--faint); }
.svc-find svg { width: 18px; height: 18px; flex: none; }
.svc-find input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--text); font: inherit; font-size: 16px; -webkit-appearance: none; appearance: none; }
.svc-find:focus-within { border-color: var(--focus); }
.svc-downonly { flex: none; min-height: 44px; display: inline-flex; align-items: center; gap: 8px; padding: 0 14px; border-radius: 14px; border: 1px solid var(--edge); background: var(--glass); color: var(--text); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
.svc-downonly .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--down); }
.svc-downonly[aria-pressed="true"] { border-color: var(--down); background: color-mix(in srgb, var(--down) 16%, transparent); color: var(--down); }
.svc-group-toggle { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; margin: -10px 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; letter-spacing: inherit; text-transform: inherit; cursor: pointer; }
.svc-group-toggle:disabled { cursor: default; }
.svc-group-toggle .chev { width: 16px; height: 16px; transition: transform .18s; }
.svc-group-toggle[aria-expanded="false"] .chev { transform: rotate(-90deg); }
.svc-group-toggle:disabled .chev { opacity: .35; }
.svc-grid[hidden] { display: none; }
.svc-empty { display: grid; justify-items: center; gap: 12px; padding: 28px 0; color: var(--muted); text-align: center; }
.svc-empty p { margin: 0; }
.svc-clear { min-height: 44px; padding: 0 16px; border-radius: 12px; border: 1px solid var(--edge); background: var(--glass); color: var(--text); font: inherit; font-weight: 600; cursor: pointer; }
@media (prefers-reduced-motion: reduce) { .svc-group-toggle .chev { transition: none; } }
.svc-gaps { margin-top: 12px; padding: 14px; border-radius: 18px; background: var(--panel); border: 1px solid var(--edge); display: grid; gap: 10px; }
.svc-gaps header { display: flex; align-items: center; gap: 10px; }
.svc-gaps h2 { margin: 0; font-size: 15px; }
.svc-admin-chip { margin-left: auto; font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--focus); border: 1px solid var(--edge); border-radius: 999px; padding: 3px 9px; }
.svc-gaps .svc-hidden-note { margin: 0; }
.svc-gap { display: flex; align-items: center; gap: 10px; padding-top: 10px; border-top: 1px solid var(--edge); }
.svc-gap .grow { display: grid; gap: 3px; min-width: 0; flex: 1; }
.svc-gap code { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.svc-gap small { font-size: 12px; color: var(--faint); }
.svc-gap-copy { flex: none; min-height: 44px; min-width: 64px; padding: 0 14px; border-radius: 12px; border: 1px solid var(--edge); background: var(--glass); color: var(--text); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.svc-head h2 { font-size: 13px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--svc-ink2); margin: 0; }
.svc-head .count { font-size: 11px; color: var(--svc-ink3); background: var(--svc-glass); border: 1px solid var(--svc-line); padding: 2px 9px; border-radius: 999px; }
.svc-head .line { flex: 1; height: 1px; background: linear-gradient(90deg, var(--svc-line), transparent); }
.svc-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 28px; }
@media (max-width: 720px) { .svc-grid { grid-template-columns: repeat(2, 1fr); } .svc-hero { grid-template-columns: repeat(2, 1fr); } }
.svc-card.wide { grid-column: span 2; }
@media (max-width: 720px) { .svc-card.wide { grid-column: span 1; } }
.svc-card { position: relative; display: block; text-decoration: none; color: inherit; background: var(--svc-glass);
  border: 1px solid var(--svc-line); border-radius: 18px; padding: 16px 14px; overflow: hidden;
  transition: transform .25s ease, border-color .25s ease, box-shadow .25s ease; cursor: pointer;
  -webkit-touch-callout: none; user-select: none; -webkit-user-select: none; }
.svc-card:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--svc-accent) 35%, transparent); box-shadow: 0 10px 30px rgba(0,0,0,.35); }
.svc-card:active { transform: translateY(-1px) scale(.99); }
.svc-dot { position: absolute; top: 12px; right: 12px; width: 8px; height: 8px; border-radius: 50%; background: var(--svc-green);
  box-shadow: none; }
.svc-dot.down { background: var(--svc-red); box-shadow: 0 0 10px color-mix(in srgb, var(--svc-red) 80%, transparent); animation: svcPulse 1.6s ease-in-out infinite; }
.svc-dot.skip { background: var(--svc-ink3); box-shadow: none; animation: none; }
@keyframes svcPulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .55; transform: scale(.8); } }
.svc-top { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.svc-icon { width: 36px; height: 36px; border-radius: 11px; display: flex; align-items: center; justify-content: center; flex: none;
  background: color-mix(in srgb, var(--svc-accent) 12%, transparent); border: 1px solid color-mix(in srgb, var(--svc-accent) 20%, transparent); color: var(--svc-accent); font-size: 18px; }
.svc-icon.cool { background: color-mix(in srgb, var(--svc-cool) 10%, transparent); border-color: color-mix(in srgb, var(--svc-cool) 20%, transparent); color: var(--svc-cool); }
.svc-icon.green { background: color-mix(in srgb, var(--svc-green) 10%, transparent); border-color: color-mix(in srgb, var(--svc-green) 20%, transparent); color: var(--svc-green); }
.svc-name { font-weight: 650; font-size: 14px; }
.svc-desc { font-size: 11.5px; color: var(--svc-ink2); margin-bottom: 6px; min-height: 16px; }
.svc-badge { display: inline-block; font-size: 10.5px; font-weight: 700; color: var(--svc-accent);
  background: color-mix(in srgb, var(--svc-accent) 12%, transparent); border: 1px solid color-mix(in srgb, var(--svc-accent) 25%, transparent); padding: 2px 8px; border-radius: 999px; margin-top: 4px; }
.svc-metrics { display: flex; gap: 14px; margin-top: 8px; }
.svc-metric .v { font-size: 19px; font-weight: 700; font-variant-numeric: tabular-nums; }
.svc-metric .v small { font-size: 11px; font-weight: 500; color: var(--svc-ink2); }
.svc-metric .l { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--svc-ink3); margin-top: 2px; }
.svc-spark { width: 100%; height: 48px; display: block; margin: 8px 0 2px; }
.svc-np { display: flex; align-items: center; gap: 14px; background: var(--svc-glass); border: 1px solid var(--svc-line);
  border-radius: 18px; padding: 14px 16px; margin-bottom: 22px; backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); }
.svc-np .np-poster { width: 52px; height: 76px; border-radius: 10px; flex: none;
  background: linear-gradient(135deg, color-mix(in srgb, var(--svc-accent) 14%, transparent), color-mix(in srgb, var(--svc-accent) 4%, transparent));
  border: 1px solid var(--svc-line); display: flex; align-items: center; justify-content: center;
  font-size: 22px; overflow: hidden; }
.svc-np .np-info { flex: 1; min-width: 0; }
.svc-np .np-kicker { font-size: 10px; letter-spacing: .14em; color: var(--svc-accent); font-weight: 700;
  margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
.svc-np .np-kicker .eq { display: inline-flex; gap: 2px; align-items: flex-end; height: 12px; }
.svc-np .np-kicker .eq i { width: 3px; background: var(--svc-accent); border-radius: 2px; animation: svcEq 1.1s ease-in-out infinite; }
.svc-np .np-kicker .eq i:nth-child(1) { height: 60%; }
.svc-np .np-kicker .eq i:nth-child(2) { height: 100%; animation-delay: .2s; }
.svc-np .np-kicker .eq i:nth-child(3) { height: 40%; animation-delay: .4s; }
.svc-np .np-title { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.svc-np .np-sub { font-size: 12px; color: var(--svc-ink2); margin-top: 2px; }
.svc-np .np-progress { height: 4px; border-radius: 99px; background: rgba(255,255,255,.08); margin-top: 9px; overflow: hidden; }
.svc-np .np-progress i { display: block; height: 100%; border-radius: 99px; background: var(--svc-accent); }
.svc-np .np-time { font-size: 10px; color: var(--svc-ink3); margin-top: 4px; font-variant-numeric: tabular-nums; }
@keyframes svcEq { 0%,100% { transform: scaleY(.5); } 50% { transform: scaleY(1); } }
.svc-netmode { display: inline-flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 700; letter-spacing: .08em;
  padding: 6px 12px; border-radius: 999px; border: 1px solid var(--svc-line); background: var(--svc-glass);
  color: var(--svc-ink2); cursor: pointer; margin-bottom: 16px; }
.svc-netmode .mdot { width: 7px; height: 7px; border-radius: 50%; background: var(--svc-cool); box-shadow: 0 0 8px color-mix(in srgb, var(--svc-cool) 90%, transparent); }
.svc-loading { color: var(--svc-ink2); font-size: 13px; padding: 24px; text-align: center; }
.svc-sheet { position: fixed; inset: 0; z-index: 60; display: none; align-items: flex-end; justify-content: center; }
.svc-sheet.open { display: flex; }
.svc-sheet .scrim { position: absolute; inset: 0; background: rgba(0,0,0,.55); backdrop-filter: blur(4px); }
.svc-sheet .svc-sheet-panel { position: relative; width: 100%; max-width: 420px; background: var(--panel); border: 1px solid var(--svc-line);
  border-bottom: none; border-radius: 20px 20px 0 0; padding: 12px 16px 28px; animation: svcSlideUp .28s cubic-bezier(.2,.9,.25,1.1); }
@keyframes svcSlideUp { from { transform: translateY(60px); opacity: 0; } }
.svc-sheet .grab { width: 40px; height: 4px; border-radius: 99px; background: rgba(255,255,255,.18); margin: 0 auto 14px; }
.svc-sheet .stitle { font-weight: 750; font-size: 16px; margin: 2px 0 2px; text-align: center; }
.svc-sheet .ssub { font-size: 12px; color: var(--svc-ink2); margin-bottom: 14px; text-align: center; word-break: break-all; }
.svc-action .a-ic { font-size: 16px; }
.svc-action span:last-child { font-size: 14px; }
.svc-action { display: flex; align-items: center; gap: 12px; width: 100%; padding: 13px 16px; margin-top: 8px;
  border: 1px solid var(--svc-line); background: rgba(255,255,255,.05); color: var(--svc-ink);
  font-size: 15px; font-weight: 600; border-radius: 14px; cursor: pointer; text-align: left; backdrop-filter: blur(8px); }
.svc-action:active { transform: scale(.98); }
.svc-action.danger { color: #fca5a5; border-color: color-mix(in srgb, var(--svc-red) 30%, transparent); }
.svc-action:disabled { opacity: .4; cursor: default; }
.svc-sheet-facts { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0 0 10px; padding: 12px 14px;
  border: 1px solid var(--svc-line); border-radius: 14px; background: rgba(255,255,255,.03); font-size: 13px; }
.svc-sheet-facts[hidden] { display: none; }
.svc-sheet-facts dt { color: var(--svc-ink2); }
.svc-sheet-facts dd { margin: 0; color: var(--svc-ink); text-align: right; min-width: 0; overflow-wrap: anywhere; }
.svc-sheet-facts dd.mono { font-family: var(--mono); font-size: 12px; }
.svc-sheet-facts dd.down { color: #fca5a5; }
.svc-sheet-facts dd.hot { color: var(--warn); }
.svc-logview[hidden], #svcSheetMain[hidden] { display: none; }
.svc-logview { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.svc-sheet .svc-sheet-panel.logs { max-width: 760px; height: 88vh; height: 88dvh; display: flex; flex-direction: column; padding-bottom: 16px; }
.svc-log-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.svc-log-meta { flex: 1; text-align: center; font-size: 12px; color: var(--svc-ink2); }
.svc-log-btn { min-height: 44px; padding: 0 14px; border: 1px solid var(--svc-line); border-radius: 12px; background: rgba(255,255,255,.05);
  color: var(--svc-ink); font-size: 14px; font-weight: 600; cursor: pointer; }
.svc-log-btn:disabled { opacity: .4; cursor: default; }
.svc-log { flex: 1; min-height: 0; overflow: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding: 10px 12px;
  border: 1px solid var(--svc-line); border-radius: 12px; background: rgba(0,0,0,.35); font-family: var(--mono); font-size: 11.5px; line-height: 1.5; }
.svc-log .ln { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--svc-ink); }
.svc-log .ln + .ln { margin-top: 4px; }
.svc-log .ln.err { color: #fca5a5; }
.svc-log .ln time { color: var(--faint); margin-right: 8px; }
.svc-log .empty { color: var(--svc-ink2); font-family: inherit; text-align: center; padding: 24px 8px; }
.svc-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(20px); background: color-mix(in srgb, var(--panel) 92%, transparent);
  border: 1px solid var(--svc-line); color: var(--svc-ink); padding: 10px 18px 10px 14px; border-radius: 999px; font-size: 13.5px;
  font-weight: 600; opacity: 0; pointer-events: none; transition: all .3s ease; z-index: 70;
  display: flex; align-items: center; gap: 9px; backdrop-filter: blur(12px); max-width: 92vw; }
.svc-toast::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--svc-green);
  box-shadow: 0 0 8px color-mix(in srgb, var(--svc-green) 90%, transparent); flex: none; }
.svc-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.svc-banner { display: flex; align-items: center; gap: 12px; background: var(--svc-glass); border: 1px solid var(--svc-line);
  border-radius: 16px; padding: 13px 16px; margin-bottom: 14px; }
.svc-banner .pulse-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--svc-green); flex: none;
  box-shadow: 0 0 12px color-mix(in srgb, var(--svc-green) 90%, transparent); animation: svcPulse 2.2s ease-in-out infinite; }
.svc-banner.warn .pulse-dot { background: var(--svc-amber); box-shadow: 0 0 12px color-mix(in srgb, var(--svc-amber) 90%, transparent); }
.svc-banner .t { font-weight: 700; font-size: 14px; }
.svc-banner .s { font-size: 12px; color: var(--svc-ink2); margin-top: 2px; }
.svc-banner .pill { margin-left: auto; flex: none; font-size: 10px; font-weight: 800; letter-spacing: .12em;
  color: var(--svc-green); background: color-mix(in srgb, var(--svc-green) 10%, transparent); border: 1px solid color-mix(in srgb, var(--svc-green) 30%, transparent);
  padding: 5px 12px; border-radius: 999px; }
.svc-banner.warn .pill { color: var(--svc-amber); background: color-mix(in srgb, var(--svc-amber) 10%, transparent); border-color: color-mix(in srgb, var(--svc-amber) 30%, transparent); }
.svc-hero { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 22px; }
.svc-hero .stat { background: var(--svc-glass); border: 1px solid var(--svc-line); border-radius: 14px; padding: 12px 8px; text-align: center; }
.svc-hero .stat .v { font-size: 20px; font-weight: 750; font-variant-numeric: tabular-nums; }
.svc-hero .stat .v small { font-size: 11px; font-weight: 500; color: var(--svc-ink2); }
.svc-hero .stat .l { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--svc-ink3); margin-top: 4px; }
.svc-hero .stat.hot .v { color: var(--svc-accent); }
.svc-card.mini { display: flex; align-items: center; gap: 10px; padding: 12px 14px; }
.svc-card.mini .svc-dot { top: 10px; right: 10px; }
.svc-card.mini .svc-icon { width: 30px; height: 30px; font-size: 15px; border-radius: 9px; }
.svc-card.mini .svc-name { font-size: 13px; }
.svc-qbadge { position: absolute; top: 10px; left: 12px; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 999px;
  background: color-mix(in srgb, var(--svc-accent) 15%, transparent); border: 1px solid color-mix(in srgb, var(--svc-accent) 35%, transparent); color: var(--svc-accent);
  font-size: 12px; font-weight: 800; display: flex; align-items: center; justify-content: center; font-variant-numeric: tabular-nums; }
.svc-widget { display: flex; gap: 6px; margin-top: 8px; }
.svc-widget .metric { flex: 1; background: rgba(0,0,0,.28); border: 1px solid rgba(255,255,255,.06); border-radius: 10px; padding: 8px 6px; text-align: center; }
.svc-widget .metric .mv { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
.svc-widget .metric .ml { font-size: 9px; color: var(--svc-ink3); letter-spacing: .08em; text-transform: uppercase; margin-top: 2px; }
.svc-widget .metric.good .mv { color: var(--svc-green); }
.svc-widget .metric.hot .mv { color: var(--svc-accent); }
.svc-bar-row { margin-top: 8px; }
.svc-bar-row .bl { display: flex; justify-content: space-between; font-size: 10px; color: var(--svc-ink2); margin-bottom: 4px; letter-spacing: .04em; }
.svc-bar-row .bl b { color: var(--svc-ink); font-variant-numeric: tabular-nums; }
.svc-bar { height: 5px; border-radius: 99px; background: rgba(255,255,255,.07); overflow: hidden; }
.svc-bar i { display: block; height: 100%; border-radius: 99px; background: linear-gradient(90deg, var(--svc-accent), var(--accent-strong)); width: 0; animation: svcFillBar 1.4s .4s cubic-bezier(.2,.8,.2,1) forwards; }
@keyframes svcFillBar { to { width: var(--w); } }
.svc-batt-wrap { display: flex; align-items: center; gap: 14px; margin-top: 8px; }
.svc-batt { width: 64px; height: 32px; border: 2px solid rgba(255,255,255,.25); border-radius: 8px; position: relative; flex: none; padding: 3px; }
.svc-batt::after { content: ""; position: absolute; right: -8px; top: 8px; width: 5px; height: 12px; border-radius: 0 3px 3px 0; background: rgba(255,255,255,.25); }
.svc-batt i { display: block; height: 100%; border-radius: 4px; background: linear-gradient(90deg, var(--svc-green), #6ee7b7); width: 0; animation: svcFillBar 1.6s .5s cubic-bezier(.2,.8,.2,1) forwards; }
.svc-batt-info .bv { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
.svc-batt-info .bl2 { font-size: 10px; color: var(--svc-ink3); letter-spacing: .08em; text-transform: uppercase; margin-top: 1px; }
.svc-mains { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: .06em; color: var(--svc-green); background: color-mix(in srgb, var(--svc-green) 10%, transparent); border: 1px solid color-mix(in srgb, var(--svc-green) 25%, transparent); padding: 5px 11px; border-radius: 999px; margin-top: 10px; }
.svc-mains.amber { color: var(--svc-amber); background: color-mix(in srgb, var(--svc-amber) 10%, transparent); border-color: color-mix(in srgb, var(--svc-amber) 30%, transparent); }
.svc-mains .mdot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; animation: svcPulse 2.2s ease-in-out infinite; }
.svc-donut-wrap { display: flex; align-items: center; gap: 14px; margin-top: 8px; }
.svc-donut { width: 74px; height: 74px; flex: none; transform: rotate(-90deg); }
.svc-donut .bg { stroke: rgba(255,255,255,.08); }
.svc-donut .fg1 { stroke: var(--svc-accent); stroke-linecap: round; }
.svc-donut .fg2 { stroke: var(--svc-cool); stroke-linecap: round; }
.svc-donut-c { font-size: 11px; color: var(--svc-ink2); }
.svc-donut-c b { color: var(--svc-ink); font-size: 15px; font-variant-numeric: tabular-nums; display: block; }
.svc-talkers { margin-top: 10px; display: flex; flex-direction: column; gap: 9px; }
.svc-talker { display: grid; grid-template-columns: 1fr auto; gap: 3px 10px; font-size: 12px; }
.svc-talker .tn { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.svc-talker .tv { color: var(--svc-ink2); font-variant-numeric: tabular-nums; font-size: 11px; }
.svc-talker .tbar { grid-column: 1 / -1; height: 4px; border-radius: 99px; background: rgba(255,255,255,.07); overflow: hidden; }
.svc-talker .tbar i { display: block; height: 100%; border-radius: 99px; background: var(--svc-accent); width: 0; animation: svcFillBar 1.4s .4s cubic-bezier(.2,.8,.2,1) forwards; }
.svc-kv { display: flex; justify-content: space-between; font-size: 11px; color: var(--svc-ink2); margin-top: 8px; }
.svc-kv b { color: var(--svc-ink); font-variant-numeric: tabular-nums; }
.svc-tput { position: relative; height: 92px; margin-top: 8px; border-radius: 12px; overflow: hidden; background: rgba(0,0,0,.25); border: 1px solid rgba(255,255,255,.05); }
.svc-tput canvas { width: 100%; height: 100%; display: block; }
.svc-tput-legend { display: flex; gap: 14px; margin-top: 8px; font-size: 11px; color: var(--svc-ink2); }
.svc-tput-legend b { color: var(--svc-ink); font-variant-numeric: tabular-nums; }
.svc-tput-legend .sw { display: inline-block; width: 8px; height: 8px; border-radius: 3px; margin-right: 5px; }
.svc-unifi-tag { font-size: 9px; font-weight: 700; letter-spacing: .1em; color: var(--svc-cool); background: color-mix(in srgb, var(--svc-cool) 10%, transparent); border: 1px solid color-mix(in srgb, var(--svc-cool) 25%, transparent); padding: 3px 8px; border-radius: 999px; }
@media (prefers-reduced-motion: reduce) {
  .svc-card, .svc-dot, .svc-np .eq i, .svc-orb, .svc-bar i, .svc-batt i, .svc-talker .tbar i, .svc-mains .mdot { animation: none !important; transition: none !important; }
  .svc-sheet .svc-sheet-panel { animation: none; }
  .svc-enter { opacity: 1 !important; }
}

/* ---- Durant redesign: liquid glass, status line, attention, pins, menu, palette ---- */
.svc-card, .svc-np, .svc-attn, .svc-pal-box { background: linear-gradient(150deg, color-mix(in srgb, #fff 8%, transparent), transparent 46%), var(--svc-glass);
  -webkit-backdrop-filter: blur(22px) saturate(1.8); backdrop-filter: blur(22px) saturate(1.8);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 20%, transparent), 0 18px 52px rgba(0,0,0,.28); }
.svc-card { padding-right: 46px; }
.svc-card.mini { padding-right: 46px; }
.svc-card:hover { border-color: color-mix(in srgb, var(--svc-accent) 45%, var(--svc-line)); }
.svc-card.pinned .svc-icon { background: var(--svc-accent); border-color: var(--svc-accent); color: var(--on-accent); }
.svc-card.is-down { border-color: color-mix(in srgb, var(--svc-red) 50%, var(--svc-line)); }
.svc-icon svg { width: 19px; height: 19px; }
.svc-card.mini .svc-icon svg { width: 16px; height: 16px; }
.svc-dot { top: 16px; right: 44px; }
.svc-card.mini .svc-dot { top: 50%; right: 44px; margin-top: -4px; }
.svc-more { position: absolute; top: 9px; right: 8px; z-index: 2; width: 30px; height: 30px; display: grid; place-items: center; border: 1px solid transparent; border-radius: 8px; background: none; color: var(--svc-ink2); cursor: pointer; }
.svc-card.mini .svc-more { top: 50%; margin-top: -15px; }
.svc-more:hover, .svc-more:focus-visible { border-color: var(--svc-line); color: var(--svc-ink); }
.svc-more svg { width: 17px; height: 17px; }
.svc-kicker { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; margin: 6px 0 10px; color: var(--svc-ink2); font: 400 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
.svc-kicker::before { content: ""; width: 28px; height: 1px; background: var(--svc-accent); }
.svc-status { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 14px 28px; align-items: end; margin-bottom: 18px; }
.svc-status h1 { margin: 0; font-size: clamp(28px, 4.4vw, 46px); font-weight: 500; letter-spacing: -.045em; line-height: 1.05; text-wrap: balance; }
.svc-status h1 em { font: italic 400 1.04em/1 var(--serif); letter-spacing: -.01em; color: var(--svc-accent); }
.svc-status .sub { margin: 8px 0 0; color: var(--svc-ink2); font-size: 13.5px; }
.svc-seg { display: inline-flex; padding: 3px; border: 1px solid var(--line-strong); border-radius: 99px; }
.svc-seg button { border: 0; background: none; padding: 6px 12px; border-radius: 99px; color: var(--svc-ink2); font: 700 10.5px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; cursor: pointer; }
.svc-seg button[aria-pressed="true"] { background: var(--svc-accent); color: var(--on-accent); }
.svc-vitals { display: flex; flex-wrap: wrap; border-block: 1px solid var(--border); margin-bottom: 22px; }
.svc-vital { padding: 11px 18px 11px 0; }
.svc-vital + .svc-vital { padding-left: 18px; border-left: 1px solid var(--border); }
.svc-vital b { display: block; font: 400 22px/1.1 var(--mono); letter-spacing: -.04em; font-variant-numeric: tabular-nums; }
.svc-vital b small { font-size: 11px; color: var(--svc-ink2); letter-spacing: 0; }
.svc-vital span { display: block; margin-top: 4px; color: var(--svc-ink3); font: 400 10px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; }
.svc-attn { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 14px 16px; margin-bottom: 12px; border: 1px solid color-mix(in srgb, var(--svc-red) 50%, var(--svc-line)); border-radius: 18px; }
.svc-attn .ai { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 12px; background: color-mix(in srgb, var(--svc-red) 16%, transparent); color: var(--svc-red); }
.svc-attn .ai svg { width: 21px; height: 21px; }
.svc-attn h2 { margin: 0; font-size: 15.5px; font-weight: 650; }
.svc-attn p { margin: 2px 0 0; color: var(--svc-ink2); font-size: 13px; overflow-wrap: anywhere; }
.svc-attn code { font: 400 12px var(--mono); color: var(--svc-red); }
.svc-attn .acts { display: flex; flex-wrap: wrap; gap: 8px; }
.svc-attn .btn svg { width: 16px; height: 16px; }
.svc-attn .btn[aria-busy="true"] svg { animation: svcSpin 1s linear infinite; }
@keyframes svcSpin { to { transform: rotate(360deg); } }
.svc-head .sum { font: 400 11.5px var(--mono); color: var(--svc-ink3); }
.svc-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
.svc-chip { padding: 1px 8px; border: 1px solid var(--svc-line); border-radius: 99px; color: var(--svc-ink2); font: 400 10.5px/1.6 var(--mono); }
.svc-chip.hot { border-color: color-mix(in srgb, var(--svc-amber) 60%, transparent); color: var(--svc-amber); }
.svc-np-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; margin-bottom: 22px; }
.svc-np-list .svc-np { margin-bottom: 0; }
.svc-np .np-poster svg { width: 24px; height: 24px; color: var(--svc-accent); }
.svc-action .a-ic svg { width: 17px; height: 17px; color: var(--svc-ink2); vertical-align: -3px; }
.svc-action.danger .a-ic svg { color: currentColor; }
@media (min-width: 721px) { .svc-sheet { align-items: center; } .svc-sheet .svc-sheet-panel { border-bottom: 1px solid var(--svc-line); border-radius: 20px; } }
.svc-jump { display: inline-flex; align-items: center; gap: 10px; min-height: 36px; padding: 0 10px 0 12px; border: 1px solid var(--line-strong); border-radius: 10px; background: none; color: var(--svc-ink2); font-size: 13px; cursor: pointer; }
.svc-jump svg { width: 15px; height: 15px; }
.svc-jump kbd { padding: 1px 6px; border: 1px solid var(--svc-line); border-radius: 5px; font: 400 11px/1.6 var(--mono); color: var(--svc-ink3); }
.svc-tools { display: grid; justify-items: end; gap: 10px; }
.svc-pal { position: fixed; inset: 0; z-index: 65; display: none; align-items: flex-start; justify-content: center; padding: 12vh 16px 16px; background: rgba(0,0,0,.45); }
.svc-pal.open { display: flex; }
.svc-pal-box { width: min(560px, 100%); padding: 8px; border: 1px solid var(--svc-line); border-radius: 18px; }
.svc-pal input { width: 100%; padding: 14px; border: 0; border-bottom: 1px solid var(--svc-line); background: none; color: var(--svc-ink); font-size: 16px; outline: none; }
.svc-pal ul { list-style: none; margin: 6px 0 0; padding: 0; max-height: 46vh; overflow: auto; }
.svc-pal li button { display: flex; align-items: center; gap: 12px; width: 100%; padding: 9px 10px; border: 0; border-radius: 10px; background: none; color: var(--svc-ink); text-align: left; cursor: pointer; }
.svc-pal li button[aria-selected="true"] { background: color-mix(in srgb, var(--svc-accent) 16%, transparent); }
.svc-pal li .svc-icon { width: 30px; height: 30px; }
.svc-pal li small { display: block; color: var(--svc-ink3); font: 400 11px var(--mono); }
.svc-pal li .grow { flex: 1; min-width: 0; }
@media (max-width: 720px) {
  .svc-status { grid-template-columns: 1fr; }
  .svc-tools { justify-items: start; }
  .svc-jump span, .svc-jump kbd { display: none; }
  .svc-vitals { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .svc-vital, .svc-vital + .svc-vital { padding: 9px 12px 9px 0; border-left: 0; }
  .svc-vital:nth-child(even) { padding-left: 12px; border-left: 1px solid var(--border); }
  .svc-attn { grid-template-columns: auto minmax(0, 1fr); }
  .svc-attn .acts { grid-column: 1 / -1; }
}
</style>
<div class="svc-wrap">
  <div class="svc-orb svc-orb-1"></div>
  <div class="svc-orb svc-orb-2"></div>
  <div class="svc-status">
    <div>
      <p class="svc-kicker">Services · live</p>
      <h1 id="svcHeadline">Checking every service…</h1>
      <p class="sub" id="svcSub">Use ⋯ on a card (or long-press it) for actions. Links use your local or Tailscale address.</p>
    </div>
    <div class="svc-tools">
      <button class="svc-jump" id="svcJump" type="button" aria-haspopup="dialog" aria-label="Jump to a service (press /)"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg><span>Jump to a service</span><kbd>/</kbd></button>
      <div class="svc-seg" role="group" aria-label="Open service links through">
        <button type="button" data-net="lan" aria-pressed="false">Local</button>
        <button type="button" data-net="tail" aria-pressed="false">Tailscale</button>
      </div>
    </div>
  </div>
  <div id="svcVitals"></div>
  <div id="svcAttention"></div>
  <div id="svcNowPlaying"></div>
  <div class="svc-filter" role="search">
    <label class="svc-find" for="svcFind"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg><input id="svcFind" type="search" placeholder="Find a service" autocomplete="off" enterkeyhint="search" aria-label="Find a service by name"></label>
    <button type="button" class="svc-downonly" id="svcDownOnly" aria-pressed="false"><span class="dot" aria-hidden="true"></span>Down only</button>
  </div>
  <div id="svcBoard"><div class="svc-loading">Loading services…</div></div>
</div>
<div class="svc-sheet" id="svcSheet" role="dialog" aria-modal="true" aria-labelledby="svcSheetTitle">
  <div class="scrim" id="svcScrim"></div>
  <div class="svc-sheet-panel">
    <div class="grab"></div>
    <div class="stitle" id="svcSheetTitle"></div>
    <div class="ssub" id="svcSheetSub"></div>
    <div id="svcSheetMain">
    <dl class="svc-sheet-facts" id="svcSheetFacts" hidden></dl>
    <button class="svc-action" id="svcOpen"><span class="a-ic" data-icon="open"></span><span>Open</span></button>
    <button class="svc-action" id="svcCopy"><span class="a-ic" data-icon="copy"></span><span>Copy link</span></button>
    <button class="svc-action" id="svcPin"><span class="a-ic" data-icon="pin"></span><span id="svcPinLabel">Pin to top of group</span></button>
    <button class="svc-action" id="svcLogs"><span class="a-ic" data-icon="logs"></span><span>View logs</span></button>
    <button class="svc-action danger" id="svcRestart"><span class="a-ic" data-icon="restart"></span><span>Restart container</span></button>
    </div>
    <div class="svc-logview" id="svcLogView" hidden>
      <div class="svc-log-bar">
        <button type="button" class="svc-log-btn" id="svcLogBack" aria-label="Back to actions">&#8249; Back</button>
        <span class="svc-log-meta" id="svcLogMeta"></span>
        <button type="button" class="svc-log-btn" id="svcLogRefresh">Refresh</button>
      </div>
      <div class="svc-log" id="svcLogBody" tabindex="0" role="log" aria-label="Container log, last 200 lines, read-only"></div>
    </div>
  </div>
</div>
<div class="svc-pal" id="svcPal">
  <div class="svc-pal-box" role="dialog" aria-modal="true" aria-label="Jump to a service">
    <input id="svcPalInput" type="text" placeholder="Jump to a service…" autocomplete="off" aria-controls="svcPalList" aria-label="Service name">
    <ul id="svcPalList" role="listbox" aria-label="Services"></ul>
  </div>
</div>
<div class="svc-toast" id="svcToast" role="status" aria-live="polite"></div>
<script>
(function () {
  var board = document.getElementById('svcBoard');
  var np = document.getElementById('svcNowPlaying');
  if (!board) return;
  var LAN = '', TAIL = '', mode = 'tail', manualMode = null;
  // Pinned services lead their group and stay put (replaces tap-count "smart sort",
  // which reordered cards under the user's thumb).
  var pins = [];
  try { pins = JSON.parse(localStorage.getItem('svcPins') || '[]'); if (!Array.isArray(pins)) pins = []; } catch (e) { pins = []; }
  function savePins() { try { localStorage.setItem('svcPins', JSON.stringify(pins)); } catch (e) {} }
  // Find, Down only and collapsed groups. Collapsed groups are remembered per browser; a search or
  // the Down only filter opens every group so a match is never hidden inside a collapsed one.
  var findTerm = '';
  var downOnly = false;
  var collapsed = [];
  try { collapsed = JSON.parse(localStorage.getItem('svcCollapsed') || '[]'); if (!Array.isArray(collapsed)) collapsed = []; } catch (e) { collapsed = []; }
  function saveCollapsed() { try { localStorage.setItem('svcCollapsed', JSON.stringify(collapsed)); } catch (e) {} }
  function filtering() { return !!findTerm || downOnly; }
  function matches(x) {
    if (downOnly && x.state !== 'down') return false;
    return !findTerm || String(x.name || '').toLowerCase().indexOf(findTerm) > -1;
  }
  var lastData = null;

  function toast(msg) {
    var t = document.getElementById('svcToast');
    t.textContent = msg; t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function detectNetwork() {
    try { manualMode = localStorage.getItem('svcNetMode'); } catch (e) {}
    if (manualMode === 'lan' || manualMode === 'tail') { setMode(manualMode); return; }
    var found = false;
    try {
      var pc = new (window.RTCPeerConnection || window.webkitRTCPeerConnection)({ iceServers: [] });
      pc.createDataChannel('x');
      pc.onicecandidate = function (e) {
        if (found || !e.candidate) return;
        var m = /([0-9]{1,3}(\\.[0-9]{1,3}){3})/.exec(e.candidate.candidate);
        if (m && /^(192\\.168\\.|10\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.)/.test(m[1])) { found = true; setMode('lan'); }
      };
      pc.createOffer().then(function (o) { pc.setLocalDescription(o); }).catch(function () {});
      setTimeout(function () { if (!found) setMode('tail'); try { pc.close(); } catch (e) {} }, 3500);
    } catch (e) { setMode('tail'); }
  }
  function setMode(m) {
    mode = m;
    document.querySelectorAll('.svc-seg [data-net]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.net === m)); });
    if (lastData) render(lastData);
  }
  document.querySelectorAll('.svc-seg [data-net]').forEach(function (b) {
    b.addEventListener('click', function () {
      var next = b.dataset.net;
      try { localStorage.setItem('svcNetMode', next); } catch (e) {}
      manualMode = next; setMode(next); toast(next === 'lan' ? 'Links now use your local network' : 'Links now use Tailscale');
    });
  });

  function svcUrl(s) {
    if (s.external) return s.external; // direct link, no network rewriting
    if (s.self) return './'; // the dashboard itself
    if (!s.port) return null;
    var host = mode === 'lan' ? LAN : TAIL;
    return 'http://' + host + ':' + s.port + (s.path || '');
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // Restart count and last start from Docker. That is all Docker keeps (no restart history), so
  // that is all the card claims. Three or more restarts is worth a second look.
  function startedAgo(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    var m = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 48) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }
  function factsHtml(s) {
    if (s.restarts == null && !s.startedAt) return '';
    var parts = [];
    if (s.restarts != null) parts.push('<span' + (s.restarts >= 3 ? ' class="hot"' : '') + '>' + s.restarts + ' restart' + (s.restarts === 1 ? '' : 's') + '</span>');
    if (s.startedAt) parts.push('<span title="' + esc(s.startedAt) + '">started ' + esc(startedAgo(s.startedAt)) + '</span>');
    return '<div class="svc-facts">' + parts.join('') + '</div>';
  }

  // Download rows on Sonarr/Radarr cards: progress, size left and time left, straight from the
  // queue the board already fetches. Time left shows only while actually downloading.
  var DL_STATE = { importing: 'Importing', paused: 'Paused', queued: 'Queued', warning: 'Needs a look' };
  function downloadsHtml(s) {
    if (!s.downloads || !s.downloads.length) return '';
    var more = (s.queue || 0) - s.downloads.length;
    return '<div class="svc-dl">' + s.downloads.map(function (d) {
      var right = d.state === 'downloading'
        ? fmtBytes(d.sizeLeft) + ' left' + (d.eta != null ? ' · ' + fmtRuntime(d.eta) : '')
        : (DL_STATE[d.state] || 'Queued') + (d.sizeLeft ? ' · ' + fmtBytes(d.sizeLeft) + ' left' : '');
      return '<div class="svc-dl-row' + (d.state === 'warning' ? ' warn' : '') + '">' +
        '<span class="t">' + esc(d.title) + '</span>' +
        '<div class="svc-dl-bar" role="progressbar" aria-label="' + esc(d.title) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + d.pct + '"><i style="width:' + d.pct + '%"></i></div>' +
        '<span class="r">' + d.pct + '% · ' + esc(right) + '</span></div>';
    }).join('') + (more > 0 ? '<div class="svc-dl-more">+ ' + more + ' more in the queue</div>' : '') + '</div>';
  }

  function fmtRuntime(sec) {
    if (sec == null) return '—';
    var m = Math.round(sec / 60);
    return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + ' min';
  }

  // Line icons (1.6 stroke), replacing emoji.
  var P = {
    bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
    disk: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
    gauge: '<path d="M4 18a8 8 0 1 1 16 0M12 18l4-6"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    tv: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="m9 3 3 3 3-3M8 21h8"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5"/>',
    download: '<path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M4 20h16"/>',
    cloud: '<path d="M7 18a4.5 4.5 0 1 1 .9-8.9A6 6 0 0 1 19.5 11 3.5 3.5 0 0 1 18 18z"/>',
    sync: '<path d="M20 7h-5m5 0V2m0 5a8 8 0 0 0-14.5 2M4 17h5m-5 0v5m0-5a8 8 0 0 0 14.5-2"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    box: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    shield: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
    wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01"/>',
    open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    pin: '<path d="M9 4h6l-1 5 3 3H7l3-3zM12 12v8"/>',
    restart: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/>',
    logs: '<path d="M5 6h14M5 10h14M5 14h10M5 18h7"/>',
    alert: '<path d="M12 9v4m0 4h.01"/><path d="M10.3 3.7 2.2 17.8A2 2 0 0 0 4 21h16a2 2 0 0 0 1.8-3.2L13.7 3.7a2 2 0 0 0-3.4 0Z"/>',
    more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
    dot: '<circle cx="12" cy="12" r="3"/>'
  };
  function svg(id) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[id] || P.dot) + '</svg>'; }
  function iconFor(id) { return svg(id); }
  document.querySelectorAll('#svcSheet [data-icon]').forEach(function (el) { el.innerHTML = svg(el.dataset.icon); });

  function cardHtml(s) {
    var url = svcUrl(s);
    var dot = s.state === 'down' ? 'down' : s.state === 'skip' ? 'skip' : '';
    var cls = (pins.indexOf(s.key) > -1 ? ' pinned' : '') + (s.state === 'down' ? ' is-down' : '') +
      (s.downloads && s.downloads.length ? ' has-dl' : ''); // room for download rows
    var more = '<button class="svc-more" type="button" aria-haspopup="dialog" aria-label="Actions for ' + esc(s.name) + '">' + svg('more') + '</button>';
    var attrs = ' data-key="' + esc(s.key) + '"' + (url ? ' data-url="' + esc(url) + '"' : '') +
      ' data-name="' + esc(s.name) + '" data-container="' + esc(s.container || '') + '" data-canrestart="' + (s.canRestart ? '1' : '') + '"';
    if (s.compact) {
      // Mini card: icon + name only, like the mockup's background-services row.
      return '<a class="svc-card mini' + cls + '"' + attrs + '><div class="svc-dot ' + dot + '"></div>' + more +
        '<div class="svc-icon">' + iconFor(s.icon) + '</div><div class="svc-name">' + esc(s.name) + '</div></a>';
    }
    var qbadge = s.queue ? '<div class="svc-qbadge">' + s.queue + '</div>' : '';
    var desc = s.detail ? esc(s.detail) : esc(s.desc || '');
    return '<a class="svc-card' + cls + '"' + attrs + '>' + qbadge +
      '<div class="svc-dot ' + dot + '"></div>' + more +
      '<div class="svc-top"><div class="svc-icon">' + iconFor(s.icon) + '</div><div class="svc-name">' + esc(s.name) + '</div></div>' +
      (desc ? '<div class="svc-desc">' + desc + '</div>' : '') + factsHtml(s) + downloadsHtml(s) + '</a>';
  }

  function specialCards(d) {
    var out = '';
    if (d.ups) {
      var u = d.ups;
      var dot = u.lowBattery ? 'down' : '';
      var onBatt = !!u.onBattery;
      var pct = u.batteryPercent != null ? Math.max(0, Math.min(100, u.batteryPercent)) : 0;
      out += '<div class="svc-card" data-key="ups" data-nosheet="1"><div class="svc-dot ' + dot + '"></div>' +
        '<div class="svc-top"><div class="svc-icon green">' + iconFor('bolt') + '</div><div class="svc-name">UPS Power</div></div>' +
        '<div class="svc-desc">' + esc(u.model || 'UPS') + '</div>' +
        '<div class="svc-batt-wrap"><div class="svc-batt"><i style="--w:' + pct + '%"></i></div>' +
        '<div class="svc-batt-info"><div class="bv">' + (u.batteryPercent != null ? u.batteryPercent + '%' : '—') + '</div><div class="bl2">Battery</div></div></div>' +
        '<div class="svc-widget">' +
        '<div class="metric"><div class="mv">' + esc(fmtRuntime(u.runtimeSeconds)) + '</div><div class="ml">Runtime</div></div>' +
        '<div class="metric"><div class="mv">' + (u.loadPercent != null ? u.loadPercent + '<small style="font-size:10px;color:var(--svc-ink2)">%</small>' : '—') + '</div><div class="ml">Load</div></div>' +
        '</div>' +
        '<div class="svc-mains' + (onBatt ? ' amber' : '') + '"><span class="mdot"></span>' + (onBatt ? 'ON BATTERY' : 'ON MAINS POWER') + '</div></div>';
    }
    if (d.zfs) {
      var z = d.zfs;
      if (z.error) {
        // Exporter unreachable: a deployment/networking problem, not a pool
        // failure — neutral dot and the reason, never a red herring.
        out += '<div class="svc-card" data-key="zfs" data-nosheet="1"><div class="svc-dot skip"></div>' +
          '<div class="svc-top"><div class="svc-icon">' + iconFor('disk') + '</div><div class="svc-name">ZFS Pool</div></div>' +
          '<div class="svc-desc">Health check unreachable: ' + esc(z.error) + '</div></div>';
      } else {
      var healthy = z.health === 'ONLINE';
      out += '<div class="svc-card" data-key="zfs" data-nosheet="1"><div class="svc-dot' + (healthy ? '' : ' down') + '"></div>' +
        '<div class="svc-top"><div class="svc-icon">' + iconFor('disk') + '</div><div class="svc-name">ZFS Pool</div></div>' +
        '<div class="svc-desc">Pool ' + esc(z.pool || '') + ' · ' + esc(z.health) + '</div>' +
        '<div class="svc-widget">' +
        '<div class="metric' + (healthy ? ' good' : '') + '"><div class="mv">' + esc(z.health) + '</div><div class="ml">Health</div></div>' +
        '<div class="metric' + (z.issueCount ? '' : ' good') + '"><div class="mv">' + (z.issueCount || 0) + '</div><div class="ml">Issues</div></div>' +
        '</div>' +
        (z.space ? '<div class="svc-bar-row"><div class="bl"><span>Pool usage</span><b>' + z.space.usedPct + '%</b></div>' +
        '<div class="svc-bar"><i style="--w:' + z.space.usedPct + '%;' + (z.space.usedPct >= 90 ? 'background:var(--svc-red);' : '') + '"></i></div></div>' +
        '<div class="svc-kv"><span>Used</span><b>' + fmtBytes(z.space.usedBytes) + ' of ' + fmtBytes(z.space.totalBytes) + '</b></div>' : '') +
        '<div class="svc-desc" style="margin-top:8px">' + (z.lastScrub && z.lastScrub !== 'unknown' ? 'Last scrub: ' + esc(z.lastScrub) : 'Last scrub: unknown') + '</div>' +
        (z.issueCount ? '<span class="svc-badge">' + z.issueCount + ' issues</span>' : '') + '</div>';
      }
    }
    if (d.speedtest) {
      var sp = d.speedtest;
      if (sp.error) {
        out += '<div class="svc-card" data-key="speedtest" data-nosheet="1"><div class="svc-dot skip"></div>' +
          '<div class="svc-top"><div class="svc-icon">' + iconFor('gauge') + '</div><div class="svc-name">Speedtest</div></div>' +
          '<div class="svc-desc">Last check failed: ' + esc(sp.error) + '</div></div>';
      } else {
        var dl = sp.downloadMbps, ul = sp.uploadMbps;
        var dlW = dl != null ? Math.min(100, Math.round(dl / 10)) : 0;
        var ulW = ul != null ? Math.min(100, Math.round(ul / 10)) : 0;
        out += '<div class="svc-card" data-key="speedtest" data-nosheet="1"><div class="svc-dot"></div>' +
          '<div class="svc-top"><div class="svc-icon">' + iconFor('gauge') + '</div><div class="svc-name">Speedtest</div></div>' +
          '<div class="svc-desc">Local connection test history' + (sp.ranAt ? ' · ' + esc(String(sp.ranAt).slice(0, 10)) : '') + '</div>' +
          '<div class="svc-bar-row"><div class="bl"><span>Download</span><b>' + (dl != null ? Math.round(dl) + ' Mbps' : '—') + '</b></div><div class="svc-bar"><i style="--w:' + dlW + '%"></i></div></div>' +
          '<div class="svc-bar-row"><div class="bl"><span>Upload</span><b>' + (ul != null ? Math.round(ul) + ' Mbps' : '—') + '</b></div><div class="svc-bar"><i style="--w:' + ulW + '%"></i></div></div>' +
          '<div class="svc-widget"><div class="metric"><div class="mv">' + (sp.pingMs != null ? Number(sp.pingMs).toFixed(1) + '<small style="font-size:10px;color:var(--svc-ink2)"> ms</small>' : '—') + '</div><div class="ml">Ping</div></div></div></div>';
      }
    }
    if (d.network && !d.network.error && d.network.wan) {
      var w = d.network.wan;
      var wUp = w.up !== false;
      out += '<div class="svc-card" data-key="internet" data-nosheet="1"><div class="svc-dot' + (wUp ? '' : ' down') + '"></div>' +
        '<div class="svc-top"><div class="svc-icon green">' + iconFor('globe') + '</div><div class="svc-name">Internet Health</div></div>' +
        '<div class="svc-desc">via UDR7' + (w.isp ? ' · ' + esc(w.isp) : '') + '</div>' +
        '<div class="svc-widget">' +
        '<div class="metric' + (wUp ? ' good' : '') + '"><div class="mv">' + (wUp ? 'Up' : 'Down') + '</div><div class="ml">Status</div></div>' +
        '<div class="metric"><div class="mv">' + (w.latencyMs != null ? Math.round(w.latencyMs) + '<small style="font-size:10px;color:var(--svc-ink2)"> ms</small>' : '—') + '</div><div class="ml">Latency</div></div>' +
        '</div></div>';
    }
    if (d.ssdTemp) {
      var st = d.ssdTemp;
      if (st.error) {
        out += '<div class="svc-card" data-key="ssd" data-nosheet="1"><div class="svc-dot skip"></div>' +
          '<div class="svc-top"><div class="svc-icon cool">' + iconFor('cpu') + '</div><div class="svc-name">System SSD</div></div>' +
          '<div class="svc-desc">Temp check failed: ' + esc(st.error) + '</div></div>';
      } else {
        var hot = st.tempC >= 60;
        out += '<div class="svc-card" data-key="ssd" data-nosheet="1"><div class="svc-dot' + (hot ? ' down' : '') + '"></div>' +
          '<div class="svc-top"><div class="svc-icon cool">' + iconFor('cpu') + '</div><div class="svc-name">System SSD</div></div>' +
          '<div class="svc-desc">Drive temperature via Prometheus' + (st.sensor ? ' · ' + esc(st.sensor) : '') + '</div>' +
          '<div class="svc-widget"><div class="metric' + (hot ? '' : ' good') + '"><div class="mv">' + st.tempC + '<small style="font-size:10px;color:var(--svc-ink2)">°C</small></div><div class="ml">Temp</div></div></div></div>';
      }
    }
    return out;
  }

  function fmtMbps(v) {
    if (v == null) return '—';
    return (Math.round(v * 10) / 10) + '<small> Mb/s</small>';
  }

  function fmtHMS(ms) {
    var t = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), sec = t % 60;
    return h + ':' + ('0' + m).slice(-2) + ':' + ('0' + sec).slice(-2);
  }

  function fmtBytes(b) {
    if (b == null) return '—';
    var units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'], i = 0, n = b;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (Math.round(n * 10) / 10) + ' ' + units[i];
  }

  // Network group: live UDR7 data in the mockup's 4-card layout — WAN status,
  // wide live-throughput graph, client donut, and top talkers with animated
  // bars. Error state renders the reason instead of fake numbers.
  function networkCards(d) {
    var out = '';
    var n = d.network;
    if (!n) return out;
    if (n.error) {
      return '<div class="svc-card" data-key="unifi" data-nosheet="1"><div class="svc-dot skip"></div>' +
        '<div class="svc-top"><div class="svc-icon">' + iconFor('wifi') + '</div><div class="svc-name">Network</div></div>' +
        '<div class="svc-desc">UDR7 unreachable: ' + esc(n.error) + '</div></div>';
    }
    var w = n.wan || {};
    out += '<div class="svc-card" data-key="unifi-wan" data-nosheet="1"><div class="svc-dot' + (w.up === false ? ' down' : '') + '"></div>' +
      '<div class="svc-top"><div class="svc-icon green">' + iconFor('globe') + '</div><div class="svc-name">WAN Status</div></div>' +
      '<div class="svc-desc">' + esc(w.isp || 'Internet uplink') + '</div>' +
      '<div class="svc-widget">' +
      '<div class="metric' + (w.up !== false ? ' good' : '') + '"><div class="mv">' + (w.latencyMs != null ? Math.round(w.latencyMs) + '<small style="font-size:10px;color:var(--svc-ink2)"> ms</small>' : '—') + '</div><div class="ml">Latency</div></div>' +
      '<div class="metric"><div class="mv">' + (w.capacityDownMbps != null ? Math.round(w.capacityDownMbps) : '—') + '</div><div class="ml">Down cap.</div></div>' +
      '</div>' +
      (w.ip ? '<div class="svc-kv"><span>WAN IP</span><b>' + esc(w.ip) + '</b></div>' : '') + '</div>';
    var t = n.throughput || {};
    out += '<div class="svc-card wide" data-key="unifi-tput" data-nosheet="1"><div class="svc-dot"></div>' +
      '<div class="svc-top"><div class="svc-icon">' + iconFor('gauge') + '</div><div class="svc-name">Live Throughput</div></div>' +
      '<div class="svc-desc">Real-time LAN bandwidth, updated every refresh</div>' +
      '<div class="svc-tput"><canvas id="netSpark"></canvas></div>' +
      '<div class="svc-tput-legend">' +
      '<span><span class="sw" style="background:var(--svc-accent)"></span>Down <b>' + fmtMbps(t.downMbps).replace(/<[^>]+>/g, '') + '</b></span>' +
      '<span><span class="sw" style="background:var(--svc-cool)"></span>Up <b>' + fmtMbps(t.upMbps).replace(/<[^>]+>/g, '') + '</b></span>' +
      '</div></div>';
    var c = n.clients || {};
    var total = c.total || 0;
    var wiredPct = total ? Math.round((c.wired || 0) / total * 100) : 0;
    var circ = 2 * Math.PI * 34;
    var wLen = (circ * wiredPct / 100).toFixed(1);
    out += '<div class="svc-card" data-key="unifi-clients" data-nosheet="1"><div class="svc-dot"></div>' +
      '<div class="svc-top"><div class="svc-icon cool">' + iconFor('wifi') + '</div><div class="svc-name">Clients</div></div>' +
      '<div class="svc-desc">Devices on the network</div>' +
      '<div class="svc-donut-wrap">' +
      '<svg class="svc-donut" viewBox="0 0 80 80"><circle class="bg" cx="40" cy="40" r="34" fill="none" stroke-width="9"/>' +
      '<circle class="fg1" cx="40" cy="40" r="34" fill="none" stroke-width="9" stroke-dasharray="' + wLen + ' ' + circ.toFixed(1) + '"/>' +
      '<circle class="fg2" cx="40" cy="40" r="34" fill="none" stroke-width="9" stroke-dasharray="' + (circ - wLen).toFixed(1) + ' ' + circ.toFixed(1) + '" stroke-dashoffset="' + (-wLen) + '"/></svg>' +
      '<div class="svc-donut-c"><b>' + total + '</b>devices online<div style="margin-top:6px">' + (c.wireless || 0) + ' WiFi · ' + (c.wired || 0) + ' wired</div></div>' +
      '</div></div>';
    var talkers = c.top || [];
    var topRate = 0;
    talkers.forEach(function (x) { topRate = Math.max(topRate, (x.downMbps || 0) + (x.upMbps || 0)); });
    out += '<div class="svc-card" data-key="unifi-talkers" data-nosheet="1"><div class="svc-dot"></div>' +
      '<div class="svc-top"><div class="svc-icon">' + iconFor('chart') + '</div><div class="svc-name">Top Talkers</div></div>' +
      '<div class="svc-desc">Bandwidth by device right now</div>' +
      '<div class="svc-talkers">' + talkers.map(function (x) {
        var rate = (x.downMbps || 0) + (x.upMbps || 0);
        var pct = topRate > 0 ? Math.max(4, Math.round(rate / topRate * 100)) : 0;
        return '<div class="svc-talker"><span class="tn">' + esc(x.name || x.ip || 'unknown') + '</span>' +
          '<span class="tv">' + fmtMbps(rate).replace(/<[^>]+>/g, '') + ' Mbps</span>' +
          '<div class="tbar"><i style="--w:' + pct + '%"></i></div></div>';
      }).join('') + '</div></div>';
    return out;
  }

  function drawSparkline(cv, hist) {
    var dpr = window.devicePixelRatio || 1;
    var W = cv.clientWidth || 260, H = cv.clientHeight || 48;
    cv.width = W * dpr; cv.height = H * dpr;
    var ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    var max = 1;
    hist.forEach(function (p) { max = Math.max(max, p.downMbps || 0, p.upMbps || 0); });
    function line(key, color) {
      ctx.beginPath();
      hist.forEach(function (p, i) {
        var x = (i / (hist.length - 1)) * W;
        var y = H - 4 - ((p[key] || 0) / max) * (H - 10);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
    }
    var cs = getComputedStyle(cv);
    line('downMbps', cs.getPropertyValue('--svc-accent').trim() || '#79d2d8');
    line('upMbps', cs.getPropertyValue('--svc-cool').trim() || '#9cc27a');
  }

  var firstRender = true;
  function render(d) {
    lastData = d;
    LAN = d.netHosts.lan; TAIL = d.netHosts.tail;
    var entCls = firstRender ? ' svc-enter' : '';
    var services = d.services || [];
    var byGroup = {};
    (d.groups || []).forEach(function (g) { byGroup[g] = []; });
    services.forEach(function (s) { (byGroup[s.group] = byGroup[s.group] || []).push(s); });
    // Down first, then pinned, then the registry's own order.
    function rank(x) { return (x.state === 'down' ? 0 : 2) + (pins.indexOf(x.key) > -1 ? 0 : 1); }
    Object.keys(byGroup).forEach(function (g) {
      byGroup[g] = byGroup[g].map(function (x, i) { return [x, i]; })
        .sort(function (a, b) { return rank(a[0]) - rank(b[0]) || a[1] - b[1]; })
        .map(function (p) { return p[0]; });
    });
    var html = '';
    // One status line instead of banner + hero + pill — real data only.
    var all = d.services || [];
    var up = all.filter(function (x) { return x.state !== 'down'; }).length;
    var downs = all.filter(function (x) { return x.state === 'down'; });
    var head = document.getElementById('svcHeadline');
    if (head) {
      head.innerHTML = esc(up + ' of ' + all.length + ' running.') + ' <em>' +
        (downs.length ? (downs.length === 1 ? 'One needs you.' : downs.length + ' need you.') : 'All clear.') + '</em>';
    }
    var subEl = document.getElementById('svcSub');
    if (subEl) {
      subEl.textContent = ['Checked ' + (d.ageSeconds != null ? d.ageSeconds + 's' : 'just now') + ' ago',
        d.ups ? (d.ups.onBattery ? 'UPS on battery' : 'UPS on mains') : '',
        d.hidden && d.hidden.length ? d.hidden.length + ' not on the board' : '',
        'links use ' + (mode === 'lan' ? 'your local network' : 'Tailscale')].filter(Boolean).join(' · ');
    }
    var sp = d.speedtest && !d.speedtest.error ? d.speedtest : {};
    var streams = (d.nowPlaying || []).length;
    var vit = document.getElementById('svcVitals');
    if (vit) {
      vit.innerHTML = '<div class="svc-vitals">' +
        '<div class="svc-vital"><b>' + up + '<small>/' + all.length + '</small></b><span>Services up</span></div>' +
        '<div class="svc-vital"><b>' + (sp.downloadMbps != null ? Math.round(sp.downloadMbps) : '—') + '<small> Mbps</small></b><span>Download</span></div>' +
        '<div class="svc-vital"><b>' + (sp.uploadMbps != null ? Math.round(sp.uploadMbps * 10) / 10 : '—') + '<small> Mbps</small></b><span>Upload</span></div>' +
        '<div class="svc-vital"><b>' + (sp.pingMs != null ? Number(sp.pingMs).toFixed(1) : '—') + '<small> ms</small></b><span>Ping</span></div>' +
        '<div class="svc-vital"><b>' + streams + '<small> stream' + (streams === 1 ? '' : 's') + '</small></b><span>On Plex now</span></div>' +
        '</div>';
    }
    // The one thing that needs you, pinned on top with its fix in reach.
    var attn = document.getElementById('svcAttention');
    if (attn) {
      attn.innerHTML = downs.map(function (x) {
        var u = svcUrl(x);
        return '<div class="svc-attn' + entCls + '" role="alert"><div class="ai">' + svg('alert') + '</div>' +
          '<div><h2>' + esc(x.name) + ' stopped responding</h2><p>' + (x.detail ? '<code>' + esc(x.detail) + '</code>' : esc(x.desc || 'Health check failed')) + '</p></div>' +
          '<div class="acts">' +
          (x.canRestart && x.container ? '<button class="btn primary" type="button" data-attn-restart="' + esc(x.container) + '" data-name="' + esc(x.name) + '">' + svg('restart') + '<span>Restart container</span></button>' : '') +
          (u ? '<a class="btn" href="' + esc(u) + '" target="_blank" rel="noopener">' + svg('open') + '<span>Open</span></a>' : '') +
          '</div></div>';
      }).join('');
    }
    var shownCount = 0;
    (d.groups || []).forEach(function (g, gi) {
      var items = (byGroup[g] || []).filter(matches);
      // Readings (UPS, ZFS, speed, network) aren't services, so a filter leaves them out.
      var special = filtering() ? '' : (g === 'System Health' ? specialCards(d) : (g === 'Network' ? networkCards(d) : ''));
      if (!items.length && !special) return;
      shownCount += items.length + (special ? 1 : 0);
      var specialCount = (d.ups ? 1 : 0) + (d.zfs ? 1 : 0) + (d.speedtest ? 1 : 0);
      var netCount = d.network ? (d.network.error ? 1 : 4) : 0;
      var groupOff = items.filter(function (x) { return x.state === 'skip'; }).length;
      var groupUp = items.filter(function (x) { return x.state !== 'down' && x.state !== 'skip'; }).length;
      var summary = items.length
        ? groupUp + ' of ' + (items.length - groupOff) + ' up' + (groupOff ? ' · ' + groupOff + ' not set up' : '')
        : (specialCount + netCount) + (specialCount + netCount === 1 ? ' reading' : ' readings');
      var isOpen = filtering() || collapsed.indexOf(g) === -1;
      var gridId = 'svcg-' + gi;
      html += '<div class="svc-head' + entCls + '"><h2><button type="button" class="svc-group-toggle" data-group="' + esc(g) + '" aria-expanded="' + isOpen + '" aria-controls="' + gridId + '"' + (filtering() ? ' disabled' : '') + '>' + esc(g) +
        '<svg class="chev" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button></h2>' +
        '<span class="sum">' + summary + '</span><div class="line"></div></div>';
      html += '<div class="svc-grid' + entCls + '" id="' + gridId + '"' + (isOpen ? '' : ' hidden') + '>' + special + items.map(cardHtml).join('') + '</div>';
    });
    // Services the board can't check yet, each with the variable that would add it.
    var hiddenShown = downOnly ? [] : (d.hidden || []).filter(function (h) { return !findTerm || String(h.name || '').toLowerCase().indexOf(findTerm) > -1; });
    shownCount += hiddenShown.length;
    if (hiddenShown.length) {
      html += '<section class="svc-hidden' + entCls + '" aria-labelledby="svcHiddenTitle">' +
        '<div class="svc-head"><h2 id="svcHiddenTitle">Not on the board yet</h2><span class="sum">' + hiddenShown.length + '</span><div class="line"></div></div>' +
        '<p class="svc-hidden-note">These have no address set, so the board can\\'t check them. Each one moves into its group as soon as its variable is added.</p>' +
        '<div class="svc-hidden-grid">' + hiddenShown.map(function (h) {
          return '<div class="svc-hidden-card"><span class="svc-icon">' + iconFor(h.icon) + '</span>' +
            '<span class="grow"><b>' + esc(h.name) + '</b><small>' + esc(h.group) + '</small>' +
            (h.missing ? '<code>' + esc(h.missing) + '</code>' : '') + '</span></div>';
        }).join('') + '</div></section>';
      // Config gaps: the fix list for the row above. The dashboard is admin-only; this card
      // shows variable names and value templates, never a configured value.
      var gaps = hiddenShown.filter(function (h) { return h.missing; });
      if (gaps.length) {
        html += '<section class="svc-gaps' + entCls + '" aria-labelledby="svcGapsTitle">' +
          '<header><h2 id="svcGapsTitle">Config gaps</h2><span class="svc-admin-chip">Admin only</span></header>' +
          '<p class="svc-hidden-note">Add these to the stack\\'s environment in Portainer, then redeploy. Each one brings its card back.</p>' +
          gaps.map(function (h) {
            var line = h.missing + '=' + (h.format || '');
            return '<div class="svc-gap"><div class="grow"><code>' + esc(line) + '</code>' +
              (h.note ? '<small>' + esc(h.note) + '</small>' : '') + '</div>' +
              '<button type="button" class="svc-gap-copy" data-copy-env="' + esc(line) + '" aria-label="Copy ' + esc(h.missing) + '">Copy</button></div>';
          }).join('') +
          '</section>';
      }
    }
    if (filtering() && !shownCount) {
      html = '<div class="svc-empty"><p>' + (downOnly && !findTerm ? 'Nothing is down.' : 'No service matches that.') + '</p>' +
        '<button type="button" class="svc-clear" data-clear-filter="1">Clear filter</button></div>';
    }
    board.innerHTML = html || '<div class="svc-loading">No services configured yet.</div>';
    var spark = document.getElementById('netSpark');
    if (spark && d.network && d.network.history && d.network.history.length > 1) {
      drawSparkline(spark, d.network.history);
    }
    // Entrance motion: staggered fade-up on banner, hero stats, and groups.
    var ents = board.querySelectorAll('.svc-enter');
    for (var ei = 0; ei < ents.length; ei++) {
      ents[ei].style.animationDelay = Math.min(ei * 60, 600) + 'ms';
    }
    if (d.nowPlaying && d.nowPlaying.length) {
      np.innerHTML = '<div class="svc-head"><h2>Now playing</h2><span class="sum">' + d.nowPlaying.length + ' stream' + (d.nowPlaying.length === 1 ? '' : 's') + '</span><div class="line"></div></div><div class="svc-np-list">' + d.nowPlaying.map(function (s) {
        var pct = s.duration > 0 ? Math.min(100, Math.round(s.viewOffset / s.duration * 100)) : 0;
        var rem = s.duration > s.viewOffset ? fmtHMS(s.duration - s.viewOffset) + ' remaining' : '';
        return '<div class="svc-np"><div class="np-poster">' + iconFor('film') + '</div><div class="np-info">' +
          '<div class="np-kicker"><span class="eq"><i></i><i></i><i></i></span>' + (s.state === 'paused' ? 'PAUSED' : 'PLAYING') + '</div>' +
          '<div class="np-title">' + esc(s.title) + '</div>' +
          '<div class="np-sub">' + esc([s.user, s.player].filter(Boolean).join(' · ')) + '</div>' +
          '<div class="svc-chips">' + (s.decision ? '<span class="svc-chip' + (s.decision === 'transcode' ? ' hot' : '') + '">' + esc(s.decision === 'transcode' ? 'Transcoding' : s.decision === 'direct stream' ? 'Direct stream' : 'Direct play') + '</span>' : '') +
            (s.quality ? '<span class="svc-chip">' + esc(String(s.quality)) + '</span>' : '') +
            (s.bandwidthKbps ? '<span class="svc-chip">' + (Math.round(s.bandwidthKbps / 100) / 10) + ' Mbps</span>' : '') + '</div>' +
          (s.duration > 0 ? '<div class="np-progress"><i style="width:' + pct + '%"></i></div>' +
            (rem ? '<div class="np-time">' + rem + '</div>' : '') : '') +
          '</div></div>';
      }).join('') + '</div>';
    } else { np.innerHTML = ''; }
    wireCards();
    firstRender = false;
  }

  var sheet = document.getElementById('svcSheet');
  var sheetKey = null, sheetUrl = null, sheetName = '', sheetContainer = '', sheetCanRestart = false;
  var pressTimer = null, suppressClick = false, sheetReturn = null;
  var sheetPanel = sheet.querySelector('.svc-sheet-panel');
  var sheetMain = document.getElementById('svcSheetMain');
  var logView = document.getElementById('svcLogView');
  var logBody = document.getElementById('svcLogBody');
  var logMeta = document.getElementById('svcLogMeta');
  var logSeq = 0;
  // How long a container has been up, from Docker's last start: 42m, 5h 12m, 3d 4h.
  function upFor(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    var m = Math.max(0, Math.floor((Date.now() - t) / 60000));
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + (m % 60) + 'm';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }
  // Status, uptime, restarts and image for the sheet, from the board data already on screen.
  // Image is the reference the container runs (name and tag); there is no update check in v1.
  function sheetFactsHtml(s) {
    if (!s) return '';
    var rows = [];
    var label = s.state === 'down' ? 'Down' : s.state === 'ok' ? 'Up' : 'Not checked';
    rows.push(['Status', label, s.state === 'down' ? 'down' : '']);
    if (s.startedAt) {
      rows.push(s.state === 'ok' ? ['Uptime', upFor(s.startedAt), ''] : ['Last started', startedAgo(s.startedAt), '']);
    }
    if (s.restarts != null) rows.push(['Restarts', String(s.restarts), s.restarts >= 3 ? 'hot' : '']);
    if (s.image) rows.push(['Image', s.image, 'mono']);
    return rows.map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd' + (r[2] ? ' class="' + r[2] + '"' : '') + '>' + esc(r[1]) + '</dd>';
    }).join('');
  }
  function showSheetMain() {
    logSeq++;
    logView.hidden = true; sheetMain.hidden = false;
    sheetPanel.classList.remove('logs');
  }
  function stampLabel(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d)) return '';
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }
  function loadLogs() {
    var seq = ++logSeq;
    var refresh = document.getElementById('svcLogRefresh');
    refresh.disabled = true;
    logMeta.textContent = 'Loading…';
    fetch('/admin/api/services/logs?container=' + encodeURIComponent(sheetContainer), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (seq !== logSeq) return;
        if (!j.ok) { logBody.innerHTML = '<div class="empty">' + esc('Could not load logs: ' + (j.error || 'unknown error')) + '</div>'; logMeta.textContent = sheetName; return; }
        var lines = j.lines || [];
        logBody.innerHTML = lines.length ? lines.map(function (l) {
          return '<div class="ln' + (l.stream === 'stderr' ? ' err' : '') + '">' + (l.at ? '<time datetime="' + esc(l.at) + '">' + esc(stampLabel(l.at)) + '</time>' : '') + esc(l.text) + '</div>';
        }).join('') : '<div class="empty">No log output yet.</div>';
        logMeta.textContent = 'Last ' + lines.length + ' line' + (lines.length === 1 ? '' : 's') + ' · read-only';
        logBody.scrollTop = logBody.scrollHeight;
      })
      .catch(function () {
        if (seq !== logSeq) return;
        logBody.innerHTML = '<div class="empty">Could not load logs: network error</div>';
        logMeta.textContent = sheetName;
      })
      .then(function () { if (seq === logSeq) refresh.disabled = false; });
  }
  function openLogs() {
    if (!sheetCanRestart || !sheetContainer) return;
    sheetMain.hidden = true; logView.hidden = false;
    sheetPanel.classList.add('logs');
    logBody.innerHTML = '';
    loadLogs();
    document.getElementById('svcLogBack').focus();
  }
  function openSheet(card) {
    sheetKey = card.dataset.key; sheetUrl = card.dataset.url || null;
    sheetName = card.dataset.name; sheetContainer = card.dataset.container || '';
    sheetCanRestart = card.dataset.canrestart === '1';
    showSheetMain();
    var rec = ((lastData && lastData.services) || []).filter(function (x) { return x.key === sheetKey; })[0];
    var factsEl = document.getElementById('svcSheetFacts');
    factsEl.innerHTML = sheetFactsHtml(rec);
    factsEl.hidden = !factsEl.innerHTML;
    document.getElementById('svcSheetTitle').textContent = sheetName;
    document.getElementById('svcSheetSub').textContent = sheetUrl || (sheetContainer ? 'container: ' + sheetContainer : '');
    document.getElementById('svcOpen').disabled = !sheetUrl;
    document.getElementById('svcRestart').disabled = !sheetCanRestart || !sheetContainer;
    document.getElementById('svcLogs').disabled = !sheetCanRestart || !sheetContainer;
    document.getElementById('svcCopy').disabled = !sheetUrl;
    document.getElementById('svcPinLabel').textContent = pins.indexOf(sheetKey) > -1 ? 'Unpin' : 'Pin to top of group';
    sheetReturn = document.activeElement;
    sheet.classList.add('open');
    var first = sheet.querySelector('.svc-action:not(:disabled)');
    if (first) first.focus();
  }
  function closeSheet() {
    if (!sheet.classList.contains('open')) return;
    sheet.classList.remove('open');
    showSheetMain();
    logBody.innerHTML = '';
    if (sheetReturn && sheetReturn.focus) sheetReturn.focus();
    // The long-press flag is consumed by the card's click handler, but the
    // sheet may cover the card by the time the finger lifts (so no click
    // fires). Reset here too so the next tap is never swallowed.
    suppressClick = false;
  }
  document.getElementById('svcScrim').addEventListener('click', closeSheet);
  document.getElementById('svcLogs').addEventListener('click', openLogs);
  document.getElementById('svcLogRefresh').addEventListener('click', loadLogs);
  document.getElementById('svcLogBack').addEventListener('click', function () {
    showSheetMain();
    logBody.innerHTML = '';
    document.getElementById('svcLogs').focus();
  });
  document.getElementById('svcOpen').addEventListener('click', function () {
    if (sheetUrl) window.open(sheetUrl, '_blank', 'noopener');
    closeSheet();
  });
  document.getElementById('svcRestart').addEventListener('click', function () {
    if (!sheetCanRestart || !sheetContainer) { closeSheet(); return; }
    var btn = this, label = btn.querySelector('span:last-child');
    btn.disabled = true; label.textContent = 'Restarting…';
    restartContainer(sheetContainer).then(function () { btn.disabled = false; label.textContent = 'Restart container'; closeSheet(); });
  });
  function restartContainer(container) {
    return fetch('/admin/api/services/restart', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: container }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      toast(j.ok ? j.message : ('Restart failed: ' + (j.error || 'unknown')));
    }).catch(function () { toast('Restart failed: network error'); });
  }
  document.getElementById('svcAttention').addEventListener('click', function (e) {
    var b = e.target.closest('[data-attn-restart]');
    if (!b || b.disabled) return;
    var label = b.querySelector('span');
    b.disabled = true; b.setAttribute('aria-busy', 'true'); label.textContent = 'Restarting…';
    toast('Restarting ' + b.dataset.name + '…');
    restartContainer(b.dataset.attnRestart).then(function () {
      b.disabled = false; b.removeAttribute('aria-busy'); label.textContent = 'Restart container'; load();
    });
  });
  document.getElementById('svcPin').addEventListener('click', function () {
    var i = pins.indexOf(sheetKey);
    if (i > -1) pins.splice(i, 1); else pins.push(sheetKey);
    savePins();
    toast(i > -1 ? sheetName + ' unpinned' : sheetName + ' pinned to the top of its group');
    closeSheet();
    if (lastData) render(lastData);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      // In the log view, Escape steps back to the actions first.
      if (sheet.classList.contains('open') && !logView.hidden) { document.getElementById('svcLogBack').click(); return; }
      closeSheet(); closePal();
    }
  });
  // navigator.clipboard needs a secure context; the dashboard is usually plain
  // http on LAN/Tailscale, so fall back to the execCommand path there.
  function copyText(t) {
    function legacy() {
      return new Promise(function (resolve, reject) {
        var ta = document.createElement('textarea');
        ta.value = t;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.top = '-9999px'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
          if (document.execCommand('copy')) resolve();
          else reject(new Error('execCommand_copy_false'));
        } catch (e) { reject(e); }
        document.body.removeChild(ta);
      });
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t).catch(function () { return legacy(); });
    }
    return legacy();
  }
  var findEl = document.getElementById('svcFind');
  var downEl = document.getElementById('svcDownOnly');
  function rerender() { if (lastData) render(lastData); }
  findEl.addEventListener('input', function () { findTerm = findEl.value.trim().toLowerCase(); rerender(); });
  downEl.addEventListener('click', function () {
    downOnly = !downOnly;
    downEl.setAttribute('aria-pressed', String(downOnly));
    rerender();
  });
  board.addEventListener('click', function (e) {
    var toggle = e.target.closest('.svc-group-toggle');
    if (toggle && !toggle.disabled) {
      var g = toggle.getAttribute('data-group');
      var at = collapsed.indexOf(g);
      if (at > -1) collapsed.splice(at, 1); else collapsed.push(g);
      saveCollapsed();
      var grid = document.getElementById(toggle.getAttribute('aria-controls'));
      var open = at > -1;
      toggle.setAttribute('aria-expanded', String(open));
      if (grid) grid.hidden = !open;
      return;
    }
    if (e.target.closest('[data-clear-filter]')) {
      findTerm = ''; findEl.value = ''; downOnly = false; downEl.setAttribute('aria-pressed', 'false');
      rerender(); findEl.focus();
    }
  });
  // Config gaps: copy one VARIABLE=template line. Delegated, since the board re-renders.
  board.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy-env]');
    if (!btn) return;
    var line = btn.getAttribute('data-copy-env');
    copyText(line).then(function () { toast('Copied ' + line.split('=')[0]); })
      .catch(function () { toast('Copy failed'); });
  });
  document.getElementById('svcCopy').addEventListener('click', function () {
    if (!sheetUrl) { closeSheet(); toast('No link for this service'); return; }
    copyText(sheetUrl).then(function () { closeSheet(); toast('Link copied'); })
      .catch(function () { closeSheet(); toast('Copy failed'); });
  });

  function wireCards() {
    // Special cards (UPS/ZFS/Speedtest) carry data-nosheet: they have no
    // actions, so a long-press must not open an empty action sheet.
    board.querySelectorAll('.svc-card[data-key]:not([data-nosheet])').forEach(function (card) {
      var sx = 0, sy = 0;
      card.addEventListener('touchstart', function (e) {
        var t = e.touches[0]; sx = t.clientX; sy = t.clientY;
        pressTimer = setTimeout(function () { pressTimer = null; suppressClick = true; openSheet(card); }, 550);
      }, { passive: true });
      card.addEventListener('touchmove', function (e) {
        if (!pressTimer) return;
        var t = e.touches[0];
        if (Math.hypot(t.clientX - sx, t.clientY - sy) > 12) { clearTimeout(pressTimer); pressTimer = null; }
      }, { passive: true });
      card.addEventListener('touchend', function () { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } });
      card.addEventListener('touchcancel', function () { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } });
      // Right-click opens the same actions on a computer (touch uses long-press).
      card.addEventListener('contextmenu', function (e) { e.preventDefault(); openSheet(card); });
      var moreBtn = card.querySelector('.svc-more');
      if (moreBtn) moreBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openSheet(card); });
      card.addEventListener('click', function () {
        // A long-press opens the action sheet; the finger lifting afterwards
        // synthesizes a click on the card — swallow it so the card's link
        // does not also open.
        if (suppressClick) { suppressClick = false; return; }
        var url = card.dataset.url;
        if (!url) { openSheet(card); return; }
        window.open(url, '_blank', 'noopener');
      });
    });
  }

  var pal = document.getElementById('svcPal'), palIn = document.getElementById('svcPalInput'), palList = document.getElementById('svcPalList');
  var palSel = 0, palRes = [], palReturn = null;
  function paintPal() {
    var q = palIn.value.trim().toLowerCase();
    var list = (lastData && lastData.services) || [];
    palRes = list.filter(function (x) { return !q || String(x.name).toLowerCase().indexOf(q) > -1 || String(x.desc || '').toLowerCase().indexOf(q) > -1; }).slice(0, 8);
    palSel = Math.min(palSel, Math.max(0, palRes.length - 1));
    palList.innerHTML = palRes.map(function (x, i) {
      return '<li><button type="button" role="option" aria-selected="' + (i === palSel) + '" data-i="' + i + '"><span class="svc-icon">' + iconFor(x.icon) + '</span>' +
        '<span class="grow">' + esc(x.name) + '<small>' + esc(x.group) + (x.port ? ' · :' + x.port : '') + '</small></span>' +
        '<span class="svc-chip' + (x.state === 'down' ? ' hot' : '') + '">' + (x.state === 'down' ? 'Down' : x.state === 'skip' ? 'Off' : 'Up') + '</span></button></li>';
    }).join('') || '<li class="svc-loading">No service matches.</li>';
  }
  function openPal() { if (!lastData) return; palReturn = document.activeElement; pal.classList.add('open'); palIn.value = ''; palSel = 0; paintPal(); palIn.focus(); }
  function closePal() { if (!pal.classList.contains('open')) return; pal.classList.remove('open'); if (palReturn && palReturn.focus) palReturn.focus(); }
  function choosePal(i) {
    var x = palRes[i]; if (!x) return;
    closePal();
    var u = svcUrl(x);
    if (u) window.open(u, '_blank', 'noopener');
    else { var c = board.querySelector('.svc-card[data-key="' + x.key + '"]'); if (c) { c.scrollIntoView({ block: 'center' }); openSheet(c); } }
  }
  document.getElementById('svcJump').addEventListener('click', openPal);
  palIn.addEventListener('input', function () { palSel = 0; paintPal(); });
  palIn.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palSel + 1, palRes.length - 1); paintPal(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(palSel - 1, 0); paintPal(); }
    else if (e.key === 'Enter') { e.preventDefault(); choosePal(palSel); }
  });
  palList.addEventListener('click', function (e) { var b = e.target.closest('[data-i]'); if (b) choosePal(+b.dataset.i); });
  pal.addEventListener('click', function (e) { if (e.target === pal) closePal(); });
  document.addEventListener('keydown', function (e) {
    var panel = board.closest('.panel');
    if (panel && panel.hidden) return;
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
    if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) { e.preventDefault(); if (pal.classList.contains('open')) closePal(); else openPal(); }
  });

  function load() {
    fetch('/admin/api/services', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.ok) render(d); else board.innerHTML = '<div class="svc-loading">Services unavailable.</div>'; })
      .catch(function () { board.innerHTML = '<div class="svc-loading">Could not reach the services API.</div>'; });
  }
  setMode(mode);
  detectNetwork();
  load();
  setInterval(load, 30000);
})();
</script>`;
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
    <h1><span class="brand-mark" aria-hidden="true">d<span>l</span>.</span><span><span class="brand">Durant</span> Media Server</span></h1>
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
    <div class="setting-foot"><input type="text" id="passkey-label" maxlength="64" placeholder="Device label, e.g. My iPhone" aria-label="New passkey label"><button class="btn primary" type="button" id="passkey-enroll" aria-describedby="passkey-note">Enroll passkey</button><span class="save-note" id="passkey-note" role="status" aria-live="polite"></span></div>
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
    <div class="setting-foot"><input type="text" id="agent-token-actions" placeholder="Discord actions, comma separated — e.g. queue, season, adopt_do" aria-label="Allowed Discord actions"></div>
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
  renderAlertInbox,
  renderRecentlyAdded,
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
  renderServicesPanel,
};
