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
});

test('dashboard-render: renderItemList', () => {
  assert.strictEqual(renderItemList([]).includes('Nothing right now.'), true);
  assert.match(renderItemList([{ title: 'x<y', state: 'ok', pct: 50 }]), /item-title">x&lt;y</);
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
  assert.match(passkey, /startAuthentication/);
  assert.match(passkey, /password fallback/);
});

test('dashboard-render: passkey management escapes credential metadata', () => {
  const html = renderPasskeyManagement([{ credential_id: 'id<1', label: 'Phone <script>', created_at: 1000, last_used_at: null }], 'admin.example.com');
  assert.match(html, /Phone &lt;script&gt;/);
  assert.match(html, /data-passkey="id&lt;1"/);
  assert.match(html, /never used/);
  assert.match(html, /admin\.example\.com/);
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
  assert.match(renderHealthBadges({ discord: 'ok', plex: 'down' }), /plex: down/);
  assert.match(renderHealthBadges({ backup: 'ok', backupLastSuccessfulAt: Date.now() - 60000 }), /backup: ok · 1m ago/);
});

test('dashboard-render: sweep settings expose preview without changing other groups', () => {
  const setting = { key: 'STUCK_AFTER_MINUTES', type: 'int', value: 45, min: 5, max: 10080 };
  assert.match(renderSettingsGroup({ id: 'stuck', title: 'Stuck', blurb: '', settings: [setting] }), /data-preview="stuck"/);
  assert.doesNotMatch(renderSettingsGroup({ id: 'capacity', title: 'Capacity', blurb: '', settings: [setting] }), /data-preview=/);
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
  assert.strictEqual(command.match(/secret-token/g).length, 1);
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
