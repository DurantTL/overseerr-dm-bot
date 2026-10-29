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
  return { rail, bar, sheet };
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
  .more-grab { width:40px; height:4px; border-radius:99px; background:rgba(255,255,255,.18); margin:0 auto 8px; }
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
  @keyframes panelIn { from { opacity:0; transform:translateY(8px); } }
  .card { transition:transform .25s cubic-bezier(.2,.75,.25,1), border-color .25s; }
  @media (hover:hover) { .card:hover { border-color:color-mix(in srgb, var(--accent) 35%, var(--edge)); } }
  @media (prefers-reduced-motion: reduce) {
    .live-dot, .live-enter, .panel:not([hidden]), .more-scrim, .more-panel { animation:none !important; }
    .bb-pill, .rail-item, .card { transition:none !important; }
  }
`;

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
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
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
      .then(function (j) { if (!j.ok) throw new Error(j.error || 'refresh failed'); if (!blocked()) { morph(el, j.html); syncNavCounts(); } ok(); })
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
  firstPaint = false;
})();
`;

module.exports = { ICONS, TAB_ALIASES, icon, renderShellNav, SHELL_CSS, SHELL_SCRIPT };
