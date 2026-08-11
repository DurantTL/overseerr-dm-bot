#!/usr/bin/env node
// Grouping arr import rejections so a season pack's failures are readable and correctly triaged.
const { test } = require('node:test');
const assert = require('node:assert');
const { summarizeImportRejections, renderRejectionLines, hintFor, looksLikeMappingProblem } = require('../../src/import-rejections');

// The real shape of a Sonarr /manualimport response for a partially-failing season pack.
const PREVIEW = [
  { path: '/share/seedbox-staging/Revenge.S03/Revenge.S03E05.1080p.WEB-DL.DD5.1.H.264-KiNGS.mkv', rejections: [{ reason: 'Unable to determine if file is a sample' }] },
  { path: '/share/seedbox-staging/Revenge.S03/Revenge.S03E12.1080p.WEB-DL.DD5.1.H.264-KiNGS.mkv', rejections: [{ reason: 'Failed to import episode, Destination already exists.' }] },
  { path: '/share/seedbox-staging/Revenge.S03/Revenge.S03E17.1080p.WEB-DL.DD5.1.H.264-KiNGS.mkv', rejections: [{ reason: 'Unable to determine if file is a sample' }] },
  { path: '/share/seedbox-staging/Revenge.S03/Revenge.S03E18.1080p.WEB-DL.DD5.1.H.264-KiNGS.mkv', rejections: [] },
];

test('import-rejections: reasons are grouped with the files they affected', () => {
  const groups = summarizeImportRejections(PREVIEW);
  assert.strictEqual(groups.length, 2, 'two distinct reasons');
  assert.strictEqual(groups[0].reason, 'Unable to determine if file is a sample', 'most-affected reason first');
  assert.strictEqual(groups[0].count, 2);
  assert.deepStrictEqual(groups[0].files, [
    'Revenge.S03E05.1080p.WEB-DL.DD5.1.H.264-KiNGS.mkv',
    'Revenge.S03E17.1080p.WEB-DL.DD5.1.H.264-KiNGS.mkv',
  ], 'basenames, not full paths');
  assert.strictEqual(groups[1].count, 1, 'the single destination-exists failure');
  assert.ok(!groups.some(g => g.files.includes('Revenge.S03E18.1080p.WEB-DL.DD5.1.H.264-KiNGS.mkv')), 'accepted files are absent');
});

test('import-rejections: long lists are truncated with a count of the remainder', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    path: `/staging/Show.S01E${String(i + 1).padStart(2, '0')}.mkv`,
    rejections: [{ reason: 'Unable to determine if file is a sample' }],
  }));
  const [group] = summarizeImportRejections(many);
  assert.strictEqual(group.count, 10, 'the true count is kept');
  assert.strictEqual(group.files.length, 6, 'the printed list is bounded');
  assert.strictEqual(group.more, 4);
  assert.match(renderRejectionLines([group]).join('\n'), /\+4 more/);
});

test('import-rejections: the two failures in this pack get their real remedies', () => {
  const sample = hintFor('Unable to determine if file is a sample');
  assert.match(sample, /could not read/i, 'named as a readability problem, not a matching one');
  assert.match(sample, /ffprobe/, 'gives a command that reproduces it');

  const exists = hintFor('Failed to import episode, Destination already exists.');
  assert.match(exists, /never overwrites a file it has no record of/i);
  assert.match(exists, /rescan/i, 'points at the actual fix');
});

test('import-rejections: only matching problems should offer the mapping wizard', () => {
  // The bug this guards: offering "Map to a Series…" for an unreadable file or a destination
  // collision sends the operator round a loop that cannot fix the cause.
  assert.strictEqual(looksLikeMappingProblem(summarizeImportRejections(PREVIEW)), false, 'these two are not mapping problems');
  assert.strictEqual(looksLikeMappingProblem(summarizeImportRejections([
    { path: '/staging/whatever.mkv', rejections: [{ reason: 'Unknown Series' }] },
  ])), true, 'an unmatched series is');
  assert.strictEqual(looksLikeMappingProblem(summarizeImportRejections([
    { path: '/staging/x.mkv', rejections: [{ reason: 'Unable to parse file name' }] },
  ])), true, 'as is an unparseable name');
});

test('import-rejections: unknown reasons still group, just without a hint', () => {
  const [group] = summarizeImportRejections([{ path: '/staging/x.mkv', rejections: [{ reason: 'Something new in a future release' }] }]);
  assert.strictEqual(group.hint, null);
  assert.match(renderRejectionLines([group]).join('\n'), /Something new in a future release/);
});

test('import-rejections: empty and malformed input never throws', () => {
  assert.deepStrictEqual(summarizeImportRejections([]), []);
  assert.deepStrictEqual(summarizeImportRejections(null), []);
  assert.deepStrictEqual(summarizeImportRejections([{ rejections: [{ reason: '' }] }]), [], 'blank reasons dropped');
  const [group] = summarizeImportRejections([{ rejections: ['a bare string reason'] }]);
  assert.strictEqual(group.reason, 'a bare string reason');
  assert.deepStrictEqual(group.files, ['(unnamed file)'], 'a rejection with no path still reports');
});
