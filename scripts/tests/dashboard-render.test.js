#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { loadSandbox } = require('./extract');
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
});

test('dashboard-render: renderStat', () => {
  assert.match(renderStat('Label', 42), /<div class="n">42<\/div><div class="l">Label<\/div>/);
});

test('dashboard-render: healthClass', () => {
  assert.strictEqual(healthClass('ok'), 'ok');
  assert.strictEqual(healthClass('configured'), 'ok');
  assert.strictEqual(healthClass('skipped'), 'skip');
  assert.strictEqual(healthClass('down'), 'down');
  assert.strictEqual(healthClass('missing'), 'down');
  assert.strictEqual(healthClass('anything else'), 'warn');
});

test('dashboard-render: renderHealthBadges', () => {
  assert.match(renderHealthBadges({ discord: 'ok', plex: 'down' }), /discord: ok/);
  assert.match(renderHealthBadges({ discord: 'ok', plex: 'down' }), /plex: down/);
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

test('dashboard actions: arr response details are returned', () => {
  const sandbox = loadSandbox(['dashboardActionError']);
  assert.strictEqual(sandbox.dashboardActionError({ response: { data: { message: 'Sonarr rejected the command' } } }), 'Sonarr rejected the command');
  assert.strictEqual(sandbox.dashboardActionError(new Error('socket closed')), 'socket closed');
});
