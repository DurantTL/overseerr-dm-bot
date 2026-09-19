#!/usr/bin/env node
// Regression test: every render helper the dashboard routes call must actually be
// wired through index.js. A default `() => ''` seam in the route module hides a
// missing wire as an empty panel (Sep 19, 2026: the Director tab rendered blank
// on the live server because renderDirectorPanel was never passed in).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const indexSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');

// Render helpers that dashboard-read.js destructures with an empty-string default.
// If one of these is missing from index.js, the corresponding dashboard section
// silently renders nothing.
const SEAM_DEFAULTS = [
  'renderAutomationRegistry',
  'renderAgentApiTokens',
  'renderDirectorPanel',
  'renderPasskeySetupBanner',
];

test('index.js wires every dashboard render seam through to the routes', () => {
  const requireLine = indexSrc.split('\n').find(l => l.includes("require('./src/dashboard-render')"));
  assert.ok(requireLine, 'expected a dashboard-render require in index.js');

  const registerCall = indexSrc.slice(indexSrc.indexOf('registerDashboardReadRoutes(app, {'));
  assert.ok(registerCall.length > 1000, 'expected registerDashboardReadRoutes(app, {...}) in index.js');

  for (const name of SEAM_DEFAULTS) {
    assert.ok(
      requireLine.includes(name),
      `${name} must be imported from ./src/dashboard-render in index.js`
    );
    assert.ok(
      new RegExp(`^\\s*${name},\\s*$`, 'm').test(registerCall),
      `${name} must be passed into registerDashboardReadRoutes(app, {...}) in index.js`
    );
  }
});
