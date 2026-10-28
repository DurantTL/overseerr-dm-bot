#!/usr/bin/env node
// Syncthing conflict watcher (src/sync-conflicts.js): conflict-copy names, finding them in a node
// inventory, and telling new ones from ones already reported.
const { test } = require('node:test');
const assert = require('node:assert');

const { parseConflictName, findConflicts, diffConflicts } = require('../../src/sync-conflicts');

test('sync conflicts: parses Syncthing conflict names, keeping the original name and extension', () => {
  assert.deepStrictEqual(parseConflictName('Dune (2021).sync-conflict-20261028-120501-ABCDEF7.mkv'),
    { original: 'Dune (2021).mkv', at: Date.UTC(2026, 9, 28, 12, 5, 1), device: 'ABCDEF7' });
  assert.deepStrictEqual(parseConflictName('notes.sync-conflict-20260101-000000-ZZZZZZZ'),
    { original: 'notes', at: Date.UTC(2026, 0, 1), device: 'ZZZZZZZ' });
  for (const name of ['Dune (2021).mkv', 'x.sync-conflict-2026-1028-ABCDEF7.mkv', 'x.sync-conflict-20261028-120501-abcdef7.mkv', 'x.sync-conflict-20261028-120501-ABCDEF7.part.mkv', '']) {
    assert.strictEqual(parseConflictName(name), null, name);
  }
});

test('sync conflicts: finds conflict copies in an inventory with their original path', () => {
  const found = findConflicts([
    { folderId: 'm', relPath: 'Dune (2021)/Dune (2021).mkv', sizeBytes: 10 },
    { folderId: 'm', relPath: 'Dune (2021)/Dune (2021).sync-conflict-20261028-120501-ABCDEF7.mkv', sizeBytes: 9 },
    { folderId: 't', relPath: 'top.sync-conflict-20261028-120501-ABCDEF7.mp4', sizeBytes: 1 },
    null,
  ]);
  assert.deepStrictEqual(found.map(c => [c.folderId, c.original, c.sizeBytes]), [['m', 'Dune (2021)/Dune (2021).mkv', 9], ['t', 'top.mp4', 1]]);
  assert.deepStrictEqual(findConflicts(undefined), []);
});

test('sync conflicts: only conflicts not seen last time are fresh; the stored set follows the inventory', () => {
  const a = { folderId: 'm', relPath: 'a.sync-conflict-20261028-120501-ABCDEF7.mkv' };
  const b = { folderId: 'm', relPath: 'b.sync-conflict-20261028-120501-ABCDEF7.mkv' };
  const first = diffConflicts([a], []);
  assert.deepStrictEqual(first.fresh, [a]);
  const second = diffConflicts([a, b], first.keys);
  assert.deepStrictEqual(second.fresh, [b]);
  assert.strictEqual(second.keys.length, 2);
  assert.deepStrictEqual(diffConflicts([a], 'garbage').fresh, [a], 'a bad stored value counts everything as new');
  const sameNameOtherFolder = { folderId: 't', relPath: a.relPath };
  assert.deepStrictEqual(diffConflicts([sameNameOtherFolder], first.keys).fresh, [sameNameOtherFolder]);
});
