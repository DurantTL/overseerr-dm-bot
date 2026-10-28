#!/usr/bin/env node
// Director's Fleet sync (src/fleet-sync.js): per-node, per-folder completion from the snapshot the
// tier agent already reports, with the 6-hour staleness cut-off and folder labels from the roots.
const { test } = require('node:test');
const assert = require('node:assert');

const { buildFleetSync, folderLabel, FRESH_MS } = require('../../src/fleet-sync');
const { renderFleetSync } = require('../../src/dashboard-render');

const NOW = Date.parse('2026-10-28T14:00:00Z');

test('fleet sync: folders map to labels, done is 100% with nothing to pull, stale after 6 hours', () => {
  const plans = {
    ph: { folderCompletion: { at: NOW - 5 * 60000, folders: [
      { folderId: 'm', completion: 78.4, globalBytes: 10, needBytes: 4, needItems: 3 },
      { folderId: 'f', completion: 100, globalBytes: 10, needBytes: 0, needItems: 0 },
      { folderId: 'x', completion: 100, globalBytes: 10, needBytes: 2, needItems: 1 },
    ] } },
    california: { folderCompletion: { at: NOW - FRESH_MS - 1, folders: [{ folderId: 'm', completion: 52, needBytes: 9 }] } },
  };
  const fleet = buildFleetSync([{ name: 'ph', enabled: 1 }, { name: 'california' }, { name: 'off', enabled: 0 }, { name: 'new', enabled: 1 }], {
    getTierPlan: n => plans[n] || null,
    listTierNodeFolders: n => (n === 'ph' ? [{ folderId: 'm', folderRoot: '/mnt/Movies' }, { folderId: 'f', folderRoot: '/mnt/Family Films/' }] : []),
    now: NOW,
  });
  assert.deepStrictEqual(fleet.map(n => n.node), ['ph', 'california', 'new']);
  const [ph, ca, fresh] = fleet;
  assert.strictEqual(ph.stale, false);
  assert.deepStrictEqual(ph.folders.map(f => [f.label, f.done]), [['Movies', false], ['Family Films', true], ['x', false]]);
  assert.strictEqual(ph.folders[0].needBytes, 4);
  assert.strictEqual(ca.stale, true);
  assert.strictEqual(ca.folders[0].label, 'm');
  assert.deepStrictEqual(fresh, { node: 'new', reportedAt: null, stale: false, folders: [] });
});

test('fleet sync: folderLabel falls back to the id, then a generic name', () => {
  assert.strictEqual(folderLabel('a', [{ folderId: 'a', folderRoot: '/data/TV Shows' }]), 'TV Shows');
  assert.strictEqual(folderLabel('b', []), 'b');
  assert.strictEqual(folderLabel('', []), 'Folder');
});

test('renderFleetSync: progress, bytes to go, Done, stale note, and an empty fleet', () => {
  const html = renderFleetSync([
    { node: 'ph', reportedAt: Date.now() - 6 * 60000, stale: false, folders: [
      { label: 'Movies', completion: 78.9, needBytes: 412 * 1024 ** 3, needItems: 0, done: false },
      { label: '<Family>', completion: 100, needBytes: 0, needItems: 0, done: true },
    ] },
    { node: 'california', reportedAt: Date.now() - 6 * 86400000, stale: true, folders: [{ label: 'Movies', completion: 52, needBytes: null, done: false }] },
  ]);
  assert.match(html, /aria-valuenow="78"/);
  assert.match(html, /412(\.0)? GB to go · 78%/);
  assert.match(html, /&lt;Family&gt;/);
  assert.match(html, />Done</);
  assert.match(html, /last report 6d ago/);
  assert.match(html, /No report in 6d\. These are the last numbers it sent\./);
  assert.match(html, />52%</);
  assert.match(renderFleetSync([]), /No tier nodes enabled/);
});
