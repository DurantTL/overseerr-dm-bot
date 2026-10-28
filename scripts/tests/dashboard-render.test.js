#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { loadSandbox } = require('./extract');
const { trimTrailingSlashes, normalizeTierFolders, prepareTierNodeInstall } = require('../../src/tier-node-setup');
const {
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
  renderSettingsGroup,
  renderAutomationRegistry,
  renderDirectorPanel,
  renderServicesPanel,
} = require('../../src/dashboard-render');

test('dashboard-render: escapeHtml', () => {
  assert.strictEqual(escapeHtml(`<b>"quote" & 'apos'</b>`), '&lt;b&gt;&quot;quote&quot; &amp; &#39;apos&#39;&lt;/b&gt;');
  assert.strictEqual(escapeHtml(null), 'null');
});

test('dashboard-render: sqliteUtcMs', () => {
  assert.strictEqual(sqliteUtcMs('2026-01-01 00:00:00'), Date.parse('2026-01-01T00:00:00Z'));
  assert.strictEqual(sqliteUtcMs(12345), 12345);
  assert.strictEqual(sqliteUtcMs('not a date'), null);
});

test('dashboard-render: fmtAgo', () => {
  assert.strictEqual(fmtAgo(Date.now() - 60000).endsWith('ago'), true);
  assert.strictEqual(fmtAgo(Date.now() + 60000).startsWith('in '), true);
  assert.strictEqual(fmtAgo(null), '');
});

test('dashboard-render: renderBar', () => {
  assert.match(renderBar(150), /width:100%/);
  assert.match(renderBar(-10), /width:0%/);
  assert.match(renderBar(97), /bar-fill hot/);
  // #187: progress bars need progressbar semantics and a numeric value, not just a colored div.
  const labeled = renderBar(42, 'Some <Title>');
  assert.match(labeled, /role="progressbar"/);
  assert.match(labeled, /aria-valuenow="42"/);
  assert.match(labeled, /aria-valuemin="0"/);
  assert.match(labeled, /aria-valuemax="100"/);
  assert.match(labeled, /aria-label="Some &lt;Title&gt; progress"/);
  assert.doesNotMatch(renderBar(10), /aria-label=/, 'no label given: no empty aria-label attribute');
});

test('dashboard-render: renderItemList', () => {
  assert.strictEqual(renderItemList([]).includes('Nothing right now.'), true);
  assert.match(renderItemList([{ title: 'x<y', state: 'ok', pct: 50 }]), /item-title">x&lt;y</);
  // #187: the item's title carries through as the progress bar's accessible label.
  assert.match(renderItemList([{ title: 'Downloading Movie', state: 'ok', pct: 50 }]), /aria-label="Downloading Movie progress"/);
  const actions = renderItemList([{ title: 'Title', state: 'warn', actions: [{ label: 'Search <now>', url: '/admin/action/search', body: { title: 'x"y' }, confirm: 'Use allowance?' }] }]);
  assert.match(actions, /data-post="\/admin\/action\/search"/);
  assert.match(actions, /Search &lt;now&gt;/);
  assert.match(actions, /&quot;x\\&quot;y&quot;/);
  assert.match(actions, /data-confirm="Use allowance\?"/);
  const inline = renderItemList([{ title: 'Pending', actions: [{ label: 'Approve', url: '/admin/action/gate', inline: true }] }]);
  assert.match(inline, /data-inline="true"/);
  assert.match(inline, /class="action-result" aria-live="polite"/);
});

test('dashboard-render: renderLogin', () => {
  assert.match(renderLogin(false, null), /Admin dashboard login/);
  assert.match(renderLogin(true, null), /Incorrect password/);
  assert.match(renderLogin(false, 'custom msg'), /custom msg/);
  const passkey = renderLogin(false, null, { passkeyEnabled: true });
  assert.match(passkey, /Sign in with a passkey/);
  assert.match(passkey, /\/admin\/passkey-client\.js/);
  assert.match(passkey, /preparePasskeyAction/);
  assert.match(passkey, /Password login still works below/);
  assert.match(passkey, /startAuthentication/);
  assert.match(passkey, /password fallback/);
  assert.match(passkey, /<form method="post" action="\/admin\/login">/, 'password login remains available');

  const withOrigin = renderLogin(false, null, { expectedOrigin: 'https://admin.example.test' });
  assert.match(withOrigin, /data-expected-origin="https:\/\/admin\.example\.test"/);

  // #191: a password typed into the dashboard over a genuinely insecure origin is sent in the
  // clear. The check is client-side (window.isSecureContext) since the server can't tell an
  // insecure connection apart from a trusted proxy terminating TLS in front of it.
  assert.match(renderLogin(false, null), /insecure-context-warning/);
  assert.match(renderLogin(false, null), /window\.isSecureContext/);
});

test('dashboard-render: passkey management escapes credential metadata', () => {
  const html = renderPasskeyManagement([{ credential_id: 'id<1', label: 'Phone <script>', created_at: 1000, last_used_at: null }], 'admin.example.com');
  assert.match(html, /Phone &lt;script&gt;/);
  assert.match(html, /data-passkey="id&lt;1"/);
  assert.match(html, /never used/);
  assert.match(html, /admin\.example\.com/);
  assert.match(html, /id="passkey-enroll" aria-describedby="passkey-note"/);
  assert.match(html, /id="passkey-note" role="status" aria-live="polite"/);
});

test('dashboard-render: renderStat', () => {
  assert.match(renderStat('Label', 42), /<div class="n">42<\/div><div class="l">Label<\/div>/);
});

test('dashboard-render: healthClass', () => {
  assert.strictEqual(healthClass('ok'), 'ok');
  assert.strictEqual(healthClass('configured'), 'ok');
  assert.strictEqual(healthClass('skipped'), 'skip');
  assert.strictEqual(healthClass('disabled'), 'skip');
  assert.strictEqual(healthClass('down'), 'down');
  assert.strictEqual(healthClass('missing'), 'down');
  assert.strictEqual(healthClass('anything else'), 'warn');
});

test('dashboard-render: renderHealthBadges', () => {
  assert.match(renderHealthBadges({ discord: 'ok', plex: 'down' }), /discord: ok/);
  assert.match(renderHealthBadges({ discord: 'ok', plex: 'down' }), /plex\.tv account: down/);
  assert.match(renderHealthBadges({ plexFriends: 'down' }), /plex\.tv friends: down/);
  assert.match(renderHealthBadges({ backup: 'ok', backupLastSuccessfulAt: Date.now() - 60000 }), /backup: ok · 1m ago/);
});

test('dashboard-render: sweep settings expose preview without changing other groups', () => {
  const setting = { key: 'STUCK_AFTER_MINUTES', type: 'int', value: 45, min: 5, max: 10080 };
  assert.match(renderSettingsGroup({ id: 'stuck', title: 'Stuck', blurb: '', settings: [setting] }), /data-preview="stuck"/);
  assert.doesNotMatch(renderSettingsGroup({ id: 'capacity', title: 'Capacity', blurb: '', settings: [setting] }), /data-preview=/);
});

test('dashboard-render: automation registry exposes cadence, telemetry, and manual policy', () => {
  const html = renderAutomationRegistry([{
    id: 'stuck', label: 'Stuck downloads', enabled: true,
    cadence: { minutes: 15, source: 'override', mutable: true },
    running: false, manual: { enabled: true }, previewable: true,
    state: { status: 'ok', finishedAt: Date.now() - 1000, durationMs: 250, trigger: 'manual', resultCount: 2, resultSummary: 'alerted=2', nextRunAt: Date.now() + 60000 },
  }, {
    id: 'backup', label: 'Database backup', enabled: false, disabledReason: 'cadence is disabled',
    cadence: { minutes: 0, source: 'compose', restartRequired: true },
    running: false, manual: { enabled: false, reason: 'scheduled execution only' }, state: null,
  }]);
  assert.match(html, /Every 15 min · override · live editable/);
  assert.match(html, /manual · 2 result\(s\)/);
  assert.match(html, /data-post="\/admin\/action\/sweep"/);
  assert.match(html, /Disabled: cadence is disabled · Disabled · compose/);
  assert.match(html, /restart required/);
  assert.match(html, /Manual unavailable: scheduled execution only/);
});

test('dashboard-render: renderTable', () => {
  assert.strictEqual(renderTable([]), '<p class="muted">No records.</p>');
  assert.match(renderTable([{ a: 1, b: 'x' }]), /<th>a<\/th><th>b<\/th>/);
});

test('dashboard-render: renderSection', () => {
  assert.match(renderSection('Title', []), /<h2>Title<\/h2>/);
});

test('dashboard-render: renderPage', () => {
  assert.match(renderPage('Home', '<p>body</p>'), /<title>Home — Durant Media Server<\/title>/);
  assert.strictEqual(renderPage('Home', '<p>body</p>').includes('Log out'), false);
  assert.strictEqual(renderPage('Home', '<p>body</p>', { showLogout: true }).includes('Log out'), true);
  const searchable = renderPage('Home', '<p>body</p>', { showSearch: true, searchQuery: '<matrix>' });
  assert.match(searchable, /action="\/admin\/search"/);
  assert.match(searchable, /value="&lt;matrix&gt;"/);
});

test('dashboard-render: renderPage tabs implement the full ARIA tabs pattern', () => {
  const page = renderPage('Home', '<p>body</p>', { nav: [['a', 'A'], ['b', 'B']], tabs: true });
  // Each tab is wired to its panel and back (#187): aria-controls/aria-labelledby, ids assigned
  // from the shared data-tab/data-panel value, and role=tabpanel on the panel side.
  assert.match(page, /b\.id = 'tab-' \+ b\.dataset\.tab/);
  assert.match(page, /aria-controls', 'panel-' \+ b\.dataset\.tab/);
  assert.match(page, /aria-labelledby', 'tab-' \+ p\.dataset\.panel/);
  assert.match(page, /setAttribute\('role', 'tabpanel'\)/);
  // Roving tabindex: only the selected tab stays in the Tab order.
  assert.match(page, /b\.tabIndex = selected \? 0 : -1/);
  // Arrow/Home/End move focus and activate — the exact behavior #187 found missing.
  assert.match(page, /ArrowRight/);
  assert.match(page, /ArrowLeft/);
  assert.match(page, /event\.key === 'Home'/);
  assert.match(page, /event\.key === 'End'/);
  assert.match(page, /show\(tabButtons\[targetIndex\]\.dataset\.tab, true\)/);
});

test('dashboard-render: auto-refresh pauses only for real edits/dirty state/in-flight actions, not any focused button', () => {
  const page = renderPage('Home', '<p>body</p>', { autoRefresh: true });
  // #187: a focused tab or action BUTTON must not block refresh forever — only an actual
  // text/select/textarea field being edited does.
  assert.match(page, /\/\^\(INPUT\|SELECT\|TEXTAREA\)\$\//);
  assert.doesNotMatch(page, /INPUT\|SELECT\|TEXTAREA\|BUTTON/);
  assert.match(page, /window\.__dirtySettings/);
  assert.match(page, /window\.__actionsInFlight/);
});

test('dashboard-render: tier install command is complete and shell quoted', () => {
  const folders = [
    { id: 'movies', path: "/mnt/media's/Movies" },
    { id: 'tv', path: '/mnt/media/TV Shows' },
    { id: '4k', path: '/mnt/media/4k' },
    { id: 'family', path: '/mnt/media/Family Films' },
  ];
  const command = tierInstallCommand({
    botUrl: 'https://bot.example',
    node: 'edge-one',
    token: 'secret-token',
    folders,
    syncthingApiKey: 'api-key',
    mountRoot: '/mnt',
    mountMarker: '.mounted',
  });
  assert.match(command, /export TIER_AGENT_TOKEN='secret-token'/);
  assert.strictEqual(command.match(/secret-token/g).length, 2, 'token appears in both the export and the sudo env line');
  assert.match(command, /SYNCTHING_API_KEY='api-key'/);
  assert.match(command, /TIER_FOLDERS=/);
  assert.doesNotMatch(command, /TIER_FOLDER_ROOT|SYNCTHING_FOLDER_ID/);
  const encoded = command.match(/TIER_FOLDERS='((?:[^']|'"'"')+)'/)[1].replace(/'"'"'/g, "'");
  assert.deepStrictEqual(JSON.parse(encoded), folders);
  assert.match(command, /TIER_MOUNT_ROOT='\/mnt'/);
  assert.match(command, /TIER_MOUNT_MARKER='\.mounted'/);
  assert.match(command, /\| sudo -E env /, 'installer runs as root while preserving its environment');
  assert.doesNotMatch(command, /\| env /, 'installer must not run as the invoking non-root user');
  assert.doesNotMatch(command, /CHANGEME/);
});

test('dashboard-render: tier node status distinguishes lifecycle states', () => {
  const now = Date.now();
  assert.strictEqual(tierNodeStatus(null, null, now).status, 'never reported');
  assert.strictEqual(tierNodeStatus({ lastHeartbeatAt: now - 46 * 60000, published: { planHash: 'same' }, converged: { planHash: 'same' } }, null, now).status, 'stale');
  assert.strictEqual(tierNodeStatus({ lastHeartbeatAt: now, published: { planHash: 'new' }, converged: { planHash: 'old' } }, null, now).status, 'reported, not converged');
  assert.strictEqual(tierNodeStatus({ lastHeartbeatAt: now, published: { planHash: 'same' }, converged: { planHash: 'same' } }, null, now).status, 'converged');
});

test('dashboard-render: a converged node stops reading healthy once its plan is old — a node can heartbeat forever against a plan nobody re-applied', () => {
  const now = Date.now();
  const base = { lastHeartbeatAt: now, published: { planHash: 'same', publishedAt: now - 46 * 86400000 }, converged: { planHash: 'same' } };

  // Default threshold (14 days): a 46-day-old plan is flagged, even though the agent is checking
  // in cleanly and every convergence signal says "healthy" — this is exactly the case that let a
  // node's disk fill silently for 46 days in production before anything noticed.
  const stale = tierNodeStatus(base, null, now, 14);
  assert.strictEqual(stale.state, 'warn', 'a stale plan downgrades an otherwise-ok node to warn');
  assert.strictEqual(stale.status, 'converged, plan stale');
  assert.match(stale.details, /applied .* ago ⚠️ stale \(>14d, no re-apply since\)/);

  // A fresh plan under the same threshold reads as fully healthy.
  const fresh = tierNodeStatus({ ...base, published: { planHash: 'same', publishedAt: now - 2 * 86400000 } }, null, now, 14);
  assert.strictEqual(fresh.state, 'ok');
  assert.strictEqual(fresh.status, 'converged');
  assert.doesNotMatch(fresh.details, /stale/);

  // Threshold is configurable — the same 46-day-old plan reads as fine under a longer threshold.
  const relaxed = tierNodeStatus(base, null, now, 60);
  assert.strictEqual(relaxed.state, 'ok');
  assert.strictEqual(relaxed.status, 'converged');

  // The self-reported agent version surfaces in the details line when present, and says so plainly
  // when it's not (a node still running pre-upgrade code that never sent one).
  const withVersion = tierNodeStatus({ ...base, lastAgentVersion: '5b09b3f7eb8c' }, null, now, 14);
  assert.match(withVersion.details, /agent 5b09b3f7eb8c/);
  assert.match(stale.details, /agent version unknown \(pre-upgrade\)/);
});

test('dashboard-render: tier setup contains no agent token', () => {
  const html = renderTierNodeSetup([{ name: 'edge-one', folders: [
    { folderId: 'movies', folderRoot: '/mnt/media/Movies' },
    { folderId: 'tv', folderRoot: '/mnt/media/TV Shows' },
  ] }]);
  assert.match(html, /tier-install-form/);
  assert.match(html, /Set up|Generate install command/);
  assert.strictEqual((html.match(/class="tier-folder-row"/g) || []).length, 4, 'four folder rows are immediately available');
  assert.match(html, /movies/);
  assert.match(html, /\/mnt\/media\/TV Shows/);
  assert.match(html, /Add folder/);
  assert.match(html, /existing local path/);
  assert.match(html, /case-sensitive/);
  assert.doesNotMatch(html, /secret-token/);
});

test('tier node setup: validates multi-folder pairs without arbitrary single-folder assumptions', () => {
  const folders = normalizeTierFolders([
    { id: 'movies', path: '/mnt/media/Movies/' },
    { id: 'tv', path: '/mnt/media/TV Shows' },
    { id: '4k', path: '/mnt/media/4k' },
    { id: 'family', path: '/mnt/media/Family Films' },
  ]);
  assert.strictEqual(folders.length, 4);
  assert.strictEqual(folders[0].path, '/mnt/media/Movies', 'trailing slash is normalized');
  assert.throws(() => normalizeTierFolders([{ id: 'same', path: '/one' }, { id: 'same', path: '/two' }]), /listed more than once/);
  assert.throws(() => normalizeTierFolders([{ id: 'movies', path: 'relative/path' }]), /absolute Linux path/);
  assert.throws(() => normalizeTierFolders([{ id: '', path: '/mnt/media/Movies' }]), /both a Syncthing folder ID and a local path/);
  const setup = prepareTierNodeInstall({ syncthingApiKey: 'key', folders, mountRoot: '/mnt/media/', mountMarker: '.tier-media-ok' });
  assert.strictEqual(setup.mountRoot, '/mnt/media');
  assert.throws(() => prepareTierNodeInstall({ syncthingApiKey: 'key', folders, mountRoot: '/srv/other', mountMarker: '.ok' }), /parent of every/);
  assert.throws(() => prepareTierNodeInstall({ syncthingApiKey: 'key', folders, mountRoot: '/mnt/media' }), /supplied together/);
  assert.throws(() => prepareTierNodeInstall({ syncthingApiKey: 'key', folders, mountRoot: '/mnt/media', mountMarker: '../unsafe' }), /relative path/);
});

test('tier node setup: trims trailing slashes in linear time while preserving root', () => {
  assert.strictEqual(trimTrailingSlashes('/mnt/media////'), '/mnt/media');
  assert.strictEqual(trimTrailingSlashes('/'), '/');
  assert.strictEqual(trimTrailingSlashes(`/${'/'.repeat(100_000)}`), '/');
  assert.deepStrictEqual(normalizeTierFolders([{ id: 'root', path: '/' }]), [{ id: 'root', path: '/' }]);
});

test('dashboard: stood-down season alerts remain visible and re-armable', () => {
  const sandbox = loadSandbox(['seasonAlertDashboardItems'], {
    pad: n => String(n).padStart(2, '0'),
    fmtAgo: () => '2 hours ago',
  });
  const items = sandbox.seasonAlertDashboardItems([{
    seriesId: 7, seasonNumber: 2, seriesTitle: 'Revenge', attemptCount: 4,
    missingCount: 22, releaseCount: 0, lastAttemptedAt: 1000,
  }]);
  assert.strictEqual(items[0].title, 'Revenge S02');
  assert.match(items[0].sub, /stood down after 4/);
  assert.strictEqual(items[0].actions[0].url, '/admin/action/search');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(items[0].actions[0].body)), { kind: 'rearm-alert', seriesId: 7, seasonNumber: 2 });
});

test('dashboard actions: arr response details are returned', () => {
  const sandbox = loadSandbox(['dashboardActionError']);
  assert.strictEqual(sandbox.dashboardActionError({ response: { data: { message: 'Sonarr rejected the command' } } }), 'Sonarr rejected the command');
  assert.strictEqual(sandbox.dashboardActionError(new Error('socket closed')), 'socket closed');
});

test('dashboard-render: renderDirectorPanel uses prototype language and counts services', () => {
  const html = renderDirectorPanel({
    overall: 'ok',
    services: [
      { state: 'ok', title: 'Plex', sub: 'reachable', right: 'ok' },
      { state: 'down', title: 'Radarr <b>', sub: 'check failed', right: 'down' },
      { state: 'skip', title: 'Sonarr', sub: 'not configured', right: 'skipped' },
    ],
    disks: [{ state: 'ok', title: '/mnt/media', sub: '1 TB free of 8 TB', right: '88% used', pct: 88 }],
    totalFreeLabel: '1.0 TB',
  });
  assert.match(html, /d-eyebrow">FLEET \/ LIVE/);
  assert.match(html, /d-h1">The whole stack, one glance/);
  assert.match(html, /d-status bad">1 down/);
  assert.match(html, /<strong>1<\/strong><span>Services healthy<\/span>/);
  assert.match(html, /<strong>1<\/strong><span>Down<\/span>/);
  assert.match(html, /<strong>1<\/strong><span>Not configured<\/span>/);
  assert.match(html, /1\.0 TB<\/strong><span>Disk free/);
  assert.match(html, /One service needs attention/);
  assert.match(html, /Radarr &lt;b&gt; — check failed/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="88"/);
});

test('dashboard-render: renderDirectorPanel is calm when everything is healthy', () => {
  const html = renderDirectorPanel({
    overall: 'ok',
    services: [{ state: 'ok', title: 'Plex', right: 'ok' }],
    disks: null,
    totalFreeLabel: null,
  });
  assert.match(html, /d-status ok">All systems go/);
  assert.doesNotMatch(html, /needs attention/);
  assert.match(html, /\*arr diskspace unreachable/);
  assert.match(html, /—<\/strong><span>Disk free/);
});

test('dashboard-render: renderDirectorPanel handles no health data', () => {
  const html = renderDirectorPanel({ overall: 'unknown', services: [], disks: [], totalFreeLabel: null });
  assert.match(html, /No health data yet/);
  assert.match(html, /No disks reported/);
  assert.match(html, /d-status warn">UNKNOWN/);
});

// A degraded service must not disappear into the unconfigured count.
test('dashboard-render: Director distinguishes warnings from unconfigured services', () => {
  const html = renderDirectorPanel({
    overall: 'ok',
    services: [{ state: 'warn', title: 'Backup', right: 'overdue' }, { state: 'skip', title: 'Optional service' }],
    disks: [],
    totalFreeLabel: null,
  });
  assert.match(html, /<strong>1<\/strong><span>Warnings<\/span>/);
  assert.match(html, /<strong>1<\/strong><span>Not configured<\/span>/);
  assert.match(html, /d-status warn">1 warning/);
  assert.doesNotMatch(html, /All systems go/);
});

test('dashboard-render: Director leads with exceptions and folds healthy services', () => {
  const html = renderDirectorPanel({
    overall: 'ok',
    services: [
      { state: 'ok', title: 'Plex', right: 'ok' },
      { state: 'ok', title: 'Seerr', right: 'ok' },
      { state: 'down', title: 'Radarr 4K', sub: 'ECONNREFUSED', right: 'down' },
    ],
    disks: [{ state: 'warn', title: '/data', sub: 'nearly full', right: '91% used', pct: 91 }],
    totalFreeLabel: '1 TB',
  });
  assert.ok(html.indexOf('Radarr 4K') < html.indexOf('Plex'), 'the down service comes first');
  assert.match(html, /<details class="d-healthy"><summary>[\s\S]*2 healthy services<\/summary>/);
  assert.match(html, /<span class="warn" style="width:91%"/, 'a filling disk is drawn in the warning colour');
});

test('dashboard-render: Services board uses line icons, a visible actions button and pins', () => {
  const html = renderServicesPanel();
  assert.doesNotMatch(html, /&#1[0-9]{4,5};/, 'no emoji entities for icons');
  assert.match(html, /class="svc-more"/);
  assert.match(html, /svcPins/);
  assert.doesNotMatch(html, /svcTaps|SMART SORT/);
  assert.match(html, /aria-label="Open service links through"/);
  // The action sheet must not reuse the tab-panel class, or tab switching hides it.
  assert.doesNotMatch(html, /<div class="panel">/);
  assert.match(html, /<div class="svc-sheet-panel">/);
});

test('dashboard-render: tabs only manage real panels and can show an attention count', () => {
  const html = renderPage('Admin', '<section class="panel" data-panel="ops"></section>', { nav: [['ops', 'Operations', 2]], tabs: true });
  assert.match(html, /querySelectorAll\('\.panel\[data-panel\]'\)/);
  assert.match(html, /<span class="tab-count" aria-label="2 need attention">2<\/span>/);
});

test('renderServicesPanel: draws the hidden-services row from the API with the missing variable', () => {
  const html = renderServicesPanel();
  assert.match(html, /Not on the board yet/);
  assert.match(html, /hiddenShown\.map/, 'the row draws the hidden list, filtered by the search box');
  assert.match(html, /svc-hidden-card/);
  assert.match(html, /not on the board/, 'the summary line counts hidden services');
});

test('renderServicesPanel: the client script it ships parses', () => {
  // The script is built inside a template literal, so a single \' collapses to a bare quote and
  // breaks the whole Services tab in the browser while every text-matching test still passes.
  const vm = require('node:vm');
  const html = renderServicesPanel();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(scripts.length > 0);
  for (const source of scripts) assert.doesNotThrow(() => new vm.Script(source));
});

test('renderServicesPanel: draws the admin-only Config gaps card with one copy button per variable', () => {
  const html = renderServicesPanel();
  assert.match(html, /Config gaps/);
  assert.match(html, /Admin only/);
  assert.match(html, /data-copy-env/);
  assert.match(html, /copyText\(line\)/, 'reuses the existing clipboard helper');
});

test('renderServicesPanel: Services has find, Down only and collapsible groups', () => {
  const html = renderServicesPanel();
  assert.match(html, /id="svcFind"[^>]*type="search"/);
  assert.match(html, /id="svcDownOnly"[^>]*aria-pressed="false"/);
  assert.match(html, /svc-group-toggle/);
  assert.match(html, /aria-expanded/);
  assert.match(html, /svcCollapsed/, 'collapsed groups are remembered per browser');
  assert.match(html, /\.svc-grid\[hidden\] \{ display: none; \}/, 'a collapsed grid is really hidden despite display:grid');
  assert.match(html, /data-clear-filter/);
  assert.match(html, /x\.state !== 'down'/, 'Down only keeps only down services');
});

test('renderServicesPanel: download cards draw progress bars with size and time left', () => {
  const html = renderServicesPanel();
  assert.match(html, /function downloadsHtml/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /' left'/);
  assert.match(html, /more in the queue/);
  assert.match(html, /\.svc-card\.has-dl \{ grid-column: 1 \/ -1; \}/, 'download cards take the full row on a phone');
});

test('renderServicesPanel: cards show restart count and last start, nothing more', () => {
  const html = renderServicesPanel();
  assert.match(html, /function factsHtml/);
  assert.match(html, /' restart'/);
  assert.match(html, /started ' \+ esc\(startedAgo\(s\.startedAt\)\)/);
  assert.doesNotMatch(html, /restartHistory|restart-log|restarts\.map/, 'no invented restart history list');
});
