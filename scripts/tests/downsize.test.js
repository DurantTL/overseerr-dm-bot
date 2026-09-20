#!/usr/bin/env node
// /downsize: swap an existing movie file for a smaller staged replacement.
// Tests the pure decision logic (src/downsize.js) and the swap executor with stubbed
// Radarr API / filesystem, plus the admin gate on the new button customIds.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { formatBytes, matchScore, findStagedReplacement, buildDownsizePreview, executeDownsizeSwap } = require('../../src/downsize');

test('downsize: formatBytes', () => {
  assert.strictEqual(formatBytes(0), '0 B');
  assert.strictEqual(formatBytes(512), '512 B');
  assert.strictEqual(formatBytes(1536), '1.5 KB');
  assert.strictEqual(formatBytes(2.9 * 1024 ** 3), '2.9 GB');
  assert.strictEqual(formatBytes(15 * 1024 ** 3), '15.0 GB');
  assert.strictEqual(formatBytes(NaN), 'unknown');
  assert.strictEqual(formatBytes(-1), 'unknown');
});

test('downsize: matchScore', () => {
  assert.ok(matchScore('/staging/Dune.Part.Two.2024.2160p.WEBRip.x265-PSA.mkv', 'Dune Part Two 2024') > 0, 'exact title tokens match');
  assert.strictEqual(matchScore('/staging/Some.Other.Movie.2024.mkv', 'Dune Part Two 2024'), 0, 'no overlap scores zero');
  assert.strictEqual(matchScore('/staging/The.Movie.2024.mkv', 'Dune Part Two 2024'), 0, 'one shared token is not enough');
  assert.strictEqual(matchScore('/staging/Dune.2024.1080p.mkv', 'Dune Part Two 2024 The Extended Cut'), 0, 'partial title below the half-token threshold scores zero');
  assert.strictEqual(matchScore('/staging/x.mkv', ''), 0, 'blank movie title matches nothing');
});

test('downsize: buildDownsizePreview — happy path', () => {
  const preview = buildDownsizePreview({
    movie: { title: 'Dune: Part Two', year: 2024 },
    oldFile: { path: '/media/Movies/Dune Part Two (2024)/dune.mkv', size: 15 * 1024 ** 3, quality: { quality: { name: 'WEBRip-1080p' } } },
    newFile: { path: '/staging/Dune.Part.Two.2024.2160p.mkv', size: 2.9 * 1024 ** 3 },
  });
  assert.strictEqual(preview.ok, true);
  assert.strictEqual(preview.movieTitle, 'Dune: Part Two');
  assert.strictEqual(preview.oldQuality, 'WEBRip-1080p');
  assert.ok(Math.abs(preview.bytesSaved - (15 - 2.9) * 1024 ** 3) < 1024, 'bytes saved = old - new');
});

test('downsize: qualityName handles Radarr nested shape (B1 regression)', () => {
  const { qualityName } = require('../../src/downsize');
  assert.strictEqual(qualityName({ quality: { name: 'WEBRip-2160p' } }), 'WEBRip-2160p');
  assert.strictEqual(qualityName({ name: 'HDTV-1080p' }), 'HDTV-1080p');
  assert.strictEqual(qualityName('Bluray-2160p'), 'Bluray-2160p');
  assert.strictEqual(qualityName(null), 'unknown');
  assert.strictEqual(qualityName({}), 'unknown');
});

test('downsize: buildDownsizePreview — no replacement is a clean error', () => {
  const r = buildDownsizePreview({
    movie: { title: 'Dune: Part Two' },
    oldFile: { path: '/media/x.mkv', size: 100 },
    newFile: null,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_replacement');
});

test('downsize: buildDownsizePreview — no existing file is a clean error', () => {
  const r = buildDownsizePreview({
    movie: { title: 'Dune: Part Two' },
    oldFile: null,
    newFile: { path: '/staging/x.mkv', size: 100 },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_existing_file');
});

test('downsize: buildDownsizePreview — replacement that is not smaller is rejected', () => {
  const r = buildDownsizePreview({
    movie: { title: 'Dune: Part Two' },
    oldFile: { path: '/media/x.mkv', size: 100 },
    newFile: { path: '/staging/y.mkv', size: 200 },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not_smaller');
});

// --- findStagedReplacement: real temp dir as the staging folder ---

function makeStaging(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downsize-staging-'));
  for (const [name, size] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.alloc(size));
  }
  return dir;
}

test('downsize: findStagedReplacement — filename match, must be smaller', () => {
  const dir = makeStaging({ 'Dune.Part.Two.2024.2160p.WEBRip.x265-PSA.mkv': 100, 'Some.Other.Movie.mkv': 10 });
  try {
    const movie = { title: 'Dune: Part Two', year: 2024, movieFile: { size: 1000 } };
    const hit = findStagedReplacement(dir, movie, []);
    assert.ok(hit, 'finds the matching staged file');
    assert.strictEqual(hit.via, 'filename-match');
    assert.ok(hit.path.endsWith('.mkv'));

    const tooBig = findStagedReplacement(dir, { ...movie, movieFile: { size: 50 } }, []);
    assert.strictEqual(tooBig, null, 'a larger staged file is not a downsize candidate');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downsize: findStagedReplacement — nothing matching returns null', () => {
  const dir = makeStaging({ 'Unrelated.Movie.2024.mkv': 100 });
  try {
    const hit = findStagedReplacement(dir, { title: 'Dune: Part Two', year: 2024, movieFile: { size: 1000 } }, []);
    assert.strictEqual(hit, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downsize: findStagedReplacement — skips .incoming', () => {
  const dir = makeStaging({ '.incoming/Dune.Part.Two.2024.mkv': 100 });
  try {
    const hit = findStagedReplacement(dir, { title: 'Dune: Part Two', year: 2024, movieFile: { size: 1000 } }, []);
    assert.strictEqual(hit, null, 'in-flight copies are never candidates');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- executeDownsizeSwap: stubbed deps ---

function stubDeps(overrides = {}) {
  const calls = { delete: [], post: [], get: [], audits: [] };
  const files = new Map(Object.entries(overrides.files || {}));
  return {
    calls,
    deps: {
      fs: {
        statSync: p => {
          if (!files.has(p)) throw new Error('ENOENT');
          return { isFile: () => true, size: files.get(p) };
        },
        existsSync: p => files.has(p),
      },
      path,
      axios: {
        delete: async (url, opts) => { calls.delete.push({ url, opts }); return overrides.deleteResult || {}; },
        post: async (url, body, opts) => { calls.post.push({ url, body, opts }); return overrides.postResult || { data: { id: 789 } }; },
      },
      CONFIG: { GRAB_STAGING_PATH: '/staging', GRAB_IMPORT_PATH: '/import' },
      radarrGetFrom: async () => { calls.get.push(1); return overrides.movies || []; },
      audit: (action, data) => { calls.audits.push({ action, data }); },
      sleepMs: async () => {},
      ...overrides.depOverrides,
    },
  };
}

const baseOffer = {
  kind: 'downsize-swap',
  actorDiscordId: 'agent:test',
  movieId: 42,
  movieTitle: 'Dune: Part Two',
  movieYear: 2024,
  sourceLabel: 'Radarr 4K',
  sourceUrl: 'http://radarr4k',
  sourceKey: 'key',
  oldFileId: 7,
  oldPath: '/media/Dune/dune.mkv',
  oldSize: 15 * 1024 ** 3,
  newPath: '/staging/Dune.Part.Two.2024.mkv',
  newSize: 2.9 * 1024 ** 3,
  bytesSaved: (15 - 2.9) * 1024 ** 3,
};

test('downsize: executeDownsizeSwap — missing staged file aborts before any API call', async () => {
  const { calls, deps } = stubDeps({ files: {} }); // nothing staged
  const result = await executeDownsizeSwap({ offer: baseOffer, deps });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'replacement_gone');
  assert.strictEqual(calls.delete.length, 0, 'no DELETE when the replacement is gone');
  assert.strictEqual(calls.post.length, 0, 'no import scan when the replacement is gone');
  assert.ok(calls.audits.some(a => a.action === 'downsize_aborted'), 'abort is audited');
});

test('downsize: executeDownsizeSwap — happy path deletes then scans then verifies', async () => {
  const { calls, deps } = stubDeps({
    files: { '/staging/Dune.Part.Two.2024.mkv': 2.9 * 1024 ** 3 },
    movies: [{ id: 42, movieFile: { path: '/media/Movies/Dune Part Two (2024)/Dune.Part.Two.2024.mkv' } }],
  });
  const result = await executeDownsizeSwap({ offer: baseOffer, deps });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.newMoviePath, '/media/Movies/Dune Part Two (2024)/Dune.Part.Two.2024.mkv');

  assert.strictEqual(calls.delete.length, 1, 'exactly one DELETE');
  assert.ok(calls.delete[0].url.endsWith('/api/v3/moviefile/7'), 'DELETE targets the old file id');
  assert.strictEqual(calls.delete[0].opts.params.apikey, 'key');

  assert.strictEqual(calls.post.length, 1, 'import scan triggered');
  assert.strictEqual(calls.post[0].body.name, 'DownloadedMoviesScan');

  const actions = calls.audits.map(a => a.action);
  assert.ok(actions.includes('downsize_old_deleted'), 'deletion audited with path+size');
  assert.ok(actions.includes('downsize_swapped'), 'swap audited');
  const deleted = calls.audits.find(a => a.action === 'downsize_old_deleted');
  assert.strictEqual(deleted.data.oldPath, '/media/Dune/dune.mkv');
  assert.strictEqual(deleted.data.oldSize, 15 * 1024 ** 3);
});

test('downsize: executeDownsizeSwap — delete failure aborts before the scan', async () => {
  const { calls, deps } = stubDeps({
    files: { '/staging/Dune.Part.Two.2024.mkv': 2.9 * 1024 ** 3 },
    depOverrides: {},
  });
  deps.axios.delete = async () => { calls.delete.push({}); throw new Error('403 forbidden'); };
  const result = await executeDownsizeSwap({ offer: baseOffer, deps });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'delete_failed');
  assert.strictEqual(calls.post.length, 0, 'no import scan after a failed delete');
  assert.ok(calls.audits.some(a => a.action === 'downsize_delete_failed'), 'failure is audited');
});

test('downsize: executeDownsizeSwap — scan failure after delete reports oldDeleted', async () => {
  const { calls, deps } = stubDeps({ files: { '/staging/Dune.Part.Two.2024.mkv': 2.9 * 1024 ** 3 } });
  deps.axios.post = async () => { throw new Error('connection refused'); };
  const result = await executeDownsizeSwap({ offer: baseOffer, deps });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'scan_failed');
  assert.strictEqual(result.oldDeleted, true, 'caller must know the old file is already gone');
});

test('downsize: admin gate covers the downsize buttons', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
  assert.ok(src.includes("'downsize_do'"), 'downsize_do is registered');
  assert.ok(src.includes("'downsize_cancel'"), 'downsize_cancel is registered');
  // Both customIds must appear inside the admin-gated action list.
  const gate = src.match(/if \(\[(.*?)\]\.includes\(action\) && !isAdminInteraction/);
  assert.ok(gate, 'admin gate exists');
  assert.ok(gate[1].includes("'downsize_do'"), 'downsize_do is admin-gated');
  assert.ok(gate[1].includes("'downsize_cancel'"), 'downsize_cancel is admin-gated');
});

test('downsize: slash command is registered', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
  assert.ok(src.includes("setName('downsize')"), '/downsize command is registered');
  assert.ok(src.includes("if (n === 'downsize') return handleDownsizeCommand(interaction);"), '/downsize dispatch exists');
});
