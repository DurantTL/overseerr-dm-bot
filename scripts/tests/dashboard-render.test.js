#!/usr/bin/env node
const assert = require('assert');
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

assert.strictEqual(escapeHtml(`<b>"quote" & 'apos'</b>`), '&lt;b&gt;&quot;quote&quot; &amp; &#39;apos&#39;&lt;/b&gt;');
assert.strictEqual(escapeHtml(null), 'null');

assert.strictEqual(sqliteUtcMs('2026-01-01 00:00:00'), Date.parse('2026-01-01T00:00:00Z'));
assert.strictEqual(sqliteUtcMs(12345), 12345);
assert.strictEqual(sqliteUtcMs('not a date'), null);

assert.strictEqual(fmtAgo(Date.now() - 60000).endsWith('ago'), true);
assert.strictEqual(fmtAgo(Date.now() + 60000).startsWith('in '), true);
assert.strictEqual(fmtAgo(null), '');

assert.match(renderBar(150), /width:100%/);
assert.match(renderBar(-10), /width:0%/);
assert.match(renderBar(97), /bar-fill hot/);

assert.strictEqual(renderItemList([]).includes('Nothing right now.'), true);
assert.match(renderItemList([{ title: 'x<y', state: 'ok', pct: 50 }]), /item-title">x&lt;y</);

assert.match(renderLogin(false, null), /Admin dashboard login/);
assert.match(renderLogin(true, null), /Incorrect password/);
assert.match(renderLogin(false, 'custom msg'), /custom msg/);

assert.match(renderStat('Label', 42), /<div class="n">42<\/div><div class="l">Label<\/div>/);

assert.strictEqual(healthClass('ok'), 'ok');
assert.strictEqual(healthClass('configured'), 'ok');
assert.strictEqual(healthClass('skipped'), 'skip');
assert.strictEqual(healthClass('down'), 'down');
assert.strictEqual(healthClass('missing'), 'down');
assert.strictEqual(healthClass('anything else'), 'warn');

assert.match(renderHealthBadges({ discord: 'ok', plex: 'down' }), /discord: ok/);
assert.match(renderHealthBadges({ discord: 'ok', plex: 'down' }), /plex: down/);

assert.strictEqual(renderTable([]), '<p class="muted">No records.</p>');
assert.match(renderTable([{ a: 1, b: 'x' }]), /<th>a<\/th><th>b<\/th>/);

assert.match(renderSection('Title', []), /<h2>Title<\/h2>/);

assert.match(renderPage('Home', '<p>body</p>'), /<title>Home — Durant Media Server<\/title>/);
assert.strictEqual(renderPage('Home', '<p>body</p>').includes('Log out'), false);
assert.strictEqual(renderPage('Home', '<p>body</p>', { showLogout: true }).includes('Log out'), true);

console.log('dashboard-render.test.js: all tests passed');
