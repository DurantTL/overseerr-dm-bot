#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { loadSandbox } = require('./extract');
const { classifySeasonRelease, rankSeasonReleases, chooseSeasonPack, describeRejections,
  classifyRejection, parseSizeRejection, rejectedOnlyForSizeFloor, summarizePackRejections } = require('../../src/season-release');

const GB = 1024 ** 3;
const release = (title, over = {}) => ({
  title,
  guid: `guid:${title}`,
  indexerId: 7,
  indexer: 'Public Indexer',
  size: 20 * GB,
  seeders: 12,
  approved: true,
  downloadAllowed: true,
  ...over,
});

test('season-release: classification combines Sonarr and release-name pack signals', () => {
  let result = classifySeasonRelease(release('Drama.S01.1080p.WEB-DL', { fullSeason: true, seasonNumber: 1 }), { season: 1 });
  assert.deepStrictEqual(
    { pack: result.isPack, covers: result.coversSeason, signal: result.packSignal, sizeGb: result.sizeGb },
    { pack: true, covers: true, signal: 'reported_and_name', sizeGb: 20 },
  );

  result = classifySeasonRelease(release('Drama.S01E01.1080p.WEB-DL', { fullSeason: true, seasonNumber: 1 }), { season: 1 });
  assert.deepStrictEqual({ pack: result.isPack, covers: result.coversSeason, signal: result.packSignal },
    { pack: true, covers: true, signal: 'reported_only' }, 'a Sonarr/name disagreement stays visible');

  result = classifySeasonRelease(release('Drama.S01-S03.1080p.WEB-DL', { fullSeason: false }), { season: 2 });
  assert.deepStrictEqual({ pack: result.isPack, covers: result.coversSeason, signal: result.packSignal },
    { pack: true, covers: true, signal: 'name_only' }, 'a named multi-season pack covers a season inside its range');

  result = classifySeasonRelease(release('Drama.S03.1080p.WEB-DL', { fullSeason: true, seasonNumber: 3 }), { season: 1 });
  assert.strictEqual(result.coversSeason, false, 'a pack for a different season is not eligible');
});

test('season-release: ranking prefers covering packs and reuses the grab scorer', () => {
  const ranked = rankSeasonReleases([
    release('Drama.S01E03.1080p.WEB-DL', { fullSeason: false, size: 1 * GB, seeders: 30 }),
    release('Drama.S01.720p.WEB-DL', { fullSeason: true, seasonNumber: 1, seeders: 4 }),
    release('Drama.S01.1080p.WEB-DL', { fullSeason: true, seasonNumber: 1, seeders: 12 }),
    release('Other.Show.S01.1080p.WEB-DL', { fullSeason: true, seasonNumber: 1, seeders: 50 }),
  ], { title: 'Drama', year: 2020, season: 1 });
  assert.strictEqual(ranked[0].title, 'Drama.S01.1080p.WEB-DL');
  assert.ok(ranked[0].confidence > ranked[1].confidence, 'quality and seeders break ties between packs');
  assert.ok(ranked.findIndex(row => row.isPack && row.coversSeason) < ranked.findIndex(row => !row.isPack), 'covering packs sort before episodes');
  assert.match(rankSeasonReleases([
    release('Drama.S01E01.1080p.WEB-DL', { fullSeason: true, seasonNumber: 1 }),
  ], { title: 'Drama', season: 1 })[0].notes.join(' '), /Sonarr reports a full season/, 'signal mismatch is explained');
  assert.strictEqual(rankSeasonReleases(ranked, { title: 'Drama', season: 1 }, { limit: 2 }).length, 2, 'limit is honored');
});

test('season-release: chooser enforces identity, seed, size, and confidence guard rails', () => {
  const ranked = rankSeasonReleases([
    release('Drama.S01.1080p.WEB-DL', { fullSeason: true, seasonNumber: 1, seeders: 10 }),
    release('Drama.S01.720p.WEB-DL', { fullSeason: true, seasonNumber: 1, seeders: 5 }),
  ], { title: 'Drama', season: 1 });
  let choice = chooseSeasonPack(ranked, { minConfidence: 60, minSeeders: 1, maxSizeGb: 50 });
  assert.strictEqual(choice.pick.title, 'Drama.S01.1080p.WEB-DL');
  assert.strictEqual(choice.runnersUp.length, 1);

  choice = chooseSeasonPack(ranked.map(row => ({ ...row, seeders: 0 })), { minSeeders: 1 });
  assert.strictEqual(choice.pick, null);
  assert.match(choice.why, /at least 1 seeder/);

  choice = chooseSeasonPack(ranked.map(row => ({ ...row, sizeGb: 300 })), { maxSizeGb: 200 });
  assert.match(choice.why, /size band/);
  choice = chooseSeasonPack(ranked.map(row => ({ ...row, confidence: 20 })), { minConfidence: 70 });
  assert.match(choice.why, /70% confidence/);
  choice = chooseSeasonPack(ranked.map(row => ({ ...row, guid: null })));
  assert.match(choice.why, /grab identity/);
  assert.match(chooseSeasonPack([]).why, /No releases/);
});

test('season-release: rejection descriptions stay short and retain the first useful reason', () => {
  assert.strictEqual(describeRejections({ approved: true }), 'Approved by Sonarr');
  assert.strictEqual(describeRejections({ approved: false }), 'No rejection reason reported');
  assert.strictEqual(describeRejections({ rejections: [{ reason: 'Wrong language' }, { message: 'Custom format score too low' }] }),
    'Wrong language (+1 more)');
  assert.ok(describeRejections({ rejections: ['x'.repeat(300)] }).length <= 240);
});

test('season-release: Sonarr interactive search and force-grab calls use the expected API contract', async () => {
  const calls = [];
  const audits = [];
  const axios = {
    get: async (url, options) => { calls.push({ method: 'GET', url, options }); return { data: [{ guid: 'one' }] }; },
    post: async (url, body, options) => { calls.push({ method: 'POST', url, body, options }); return { data: { ok: true } }; },
  };
  const sandbox = loadSandbox(['interactiveSeasonSearch', 'forceGrabRelease'], {
    axios,
    CONFIG: { SONARR_URL: 'http://sonarr', SONARR_API_KEY: 'secret' },
    audit: (action, detail) => audits.push({ action, detail }),
  });
  assert.deepStrictEqual(await sandbox.interactiveSeasonSearch(42, 3, 9001), [{ guid: 'one' }]);
  assert.deepStrictEqual(await sandbox.forceGrabRelease({ guid: 'release-guid', indexerId: 9 }), { ok: true });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls[0])), {
    method: 'GET', url: 'http://sonarr/api/v3/release',
    options: { params: { episodeId: 9001 }, headers: { 'X-Api-Key': 'secret' }, timeout: 90000 },
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls[1])), {
    method: 'POST', url: 'http://sonarr/api/v3/release', body: { guid: 'release-guid', indexerId: 9 },
    options: { headers: { 'X-Api-Key': 'secret' }, timeout: 30000 },
  });
  assert.deepStrictEqual(audits, []);
});

test('season-release: Sonarr API failures are audited and rethrown', async () => {
  const audits = [];
  const failure = new Error('indexer timeout');
  const sandbox = loadSandbox(['interactiveSeasonSearch', 'forceGrabRelease'], {
    axios: { get: async () => { throw failure; }, post: async () => { throw failure; } },
    CONFIG: { SONARR_URL: 'http://sonarr', SONARR_API_KEY: 'secret' },
    audit: (action, detail) => audits.push({ action, detail }),
  });
  await assert.rejects(sandbox.interactiveSeasonSearch(42, 3, 9001), /indexer timeout/);
  await assert.rejects(sandbox.forceGrabRelease({ guid: 'g', indexerId: 9 }), /indexer timeout/);
  assert.deepStrictEqual(audits.map(row => row.detail.action), ['interactive_season_search', 'force_grab_release']);
});

test('season-release: interactive lookup refuses to fall back to Sonarr RSS without an episode id', async () => {
  let calls = 0;
  const sandbox = loadSandbox(['interactiveSeasonSearch'], {
    axios: { get: async () => { calls += 1; return { data: [] }; } },
    CONFIG: { SONARR_URL: 'http://sonarr', SONARR_API_KEY: 'secret' },
    audit: () => {},
  });
  await assert.rejects(sandbox.interactiveSeasonSearch(42, 3), /episode id is required/);
  assert.strictEqual(calls, 0, 'an unscoped release request must never be sent');
});

test('rejection classification: buckets Sonarr prose and leaves unrecognised wording as other', () => {
  assert.strictEqual(classifyRejection('769.8 MB is smaller than minimum allowed 1.5 GB (for 45min)'), 'size_below_min');
  assert.strictEqual(classifyRejection('24.1 GB is larger than maximum allowed 20 GB (for 45min)'), 'size_above_max');
  assert.strictEqual(classifyRejection('Custom Formats [LQ] have score -50 below Minimum Custom Format Score 0'), 'custom_format_score');
  assert.strictEqual(classifyRejection('Quality for existing file on disk is of equal or higher preference'), 'cutoff_met');
  assert.strictEqual(classifyRejection('Language Korean is not wanted in profile'), 'language');
  assert.strictEqual(classifyRejection('Unknown Series'), 'unmatched_series');
  // Sonarr's wording drifts between versions; an unrecognised reason must degrade to a visible
  // "we don't know" rather than land in whichever bucket happens to be checked last.
  assert.strictEqual(classifyRejection('Something Sonarr started saying last release'), 'other');
  assert.strictEqual(classifyRejection(''), 'other');
});

test('rejection classification: size rejections yield the MB-per-minute the quality definition is set in', () => {
  const parsed = parseSizeRejection('769.8 MB is smaller than minimum allowed 1.5 GB (for 45min)');
  assert.strictEqual(parsed.actualMb, 769.8);
  assert.strictEqual(parsed.limitMb, 1536);
  assert.strictEqual(parsed.runtimeMinutes, 45);
  assert.ok(Math.abs(parsed.limitMbPerMinute - 34.13) < 0.01, 'the floor is reported in the unit Sonarr configures it in');
  assert.ok(Math.abs(parsed.actualMbPerMinute - 17.11) < 0.01);
  // A reason with no runtime still yields both sizes; only the per-minute view is unavailable.
  const noRuntime = parseSizeRejection('700 MB is smaller than minimum allowed 1.5 GB');
  assert.strictEqual(noRuntime.runtimeMinutes, null);
  assert.strictEqual(noRuntime.limitMbPerMinute, null);
  assert.strictEqual(parseSizeRejection('Unknown Series'), null);
});

test('rejection classification: only a pure size-floor rejection is safe for automatic override', () => {
  assert.strictEqual(rejectedOnlyForSizeFloor({ rejections: ['769.8 MB is smaller than minimum allowed 1.5 GB (for 45min)'] }), true);
  // A second, different objection means this is not a size problem — the release may genuinely be
  // the wrong content, which is exactly what the #229 safety rail exists to catch.
  assert.strictEqual(rejectedOnlyForSizeFloor({
    rejections: ['769.8 MB is smaller than minimum allowed 1.5 GB (for 45min)', 'Language Korean is not wanted in profile'],
  }), false);
  assert.strictEqual(rejectedOnlyForSizeFloor({ rejections: [] }), false, 'an approved release is not "rejected for size"');
  assert.strictEqual(rejectedOnlyForSizeFloor({ rejections: ['Unknown Series'] }), false);
});

test('rejection classification: the pack summary ranks the setting that blocks the most packs', () => {
  const ranked = rankSeasonReleases([
    release('Winter.Sonata.S01.1080p.WEB-DL', { fullSeason: true, seasonNumber: 1, approved: false, quality: { quality: { name: 'WEBDL-1080p' } }, rejections: [{ reason: '4.2 GB is smaller than minimum allowed 9 GB (for 20min)' }] }),
    release('Winter.Sonata.S01.720p.WEB-DL', { fullSeason: true, seasonNumber: 1, approved: false, quality: { quality: { name: 'WEBDL-1080p' } }, rejections: [{ reason: '2.1 GB is smaller than minimum allowed 6 GB (for 20min)' }] }),
    release('Winter.Sonata.S01.2160p.WEB-DL', { fullSeason: true, seasonNumber: 1, approved: false, rejections: [{ reason: 'Language Korean is not wanted in profile' }] }),
    // Episode releases are not what this is trying to unblock, so they stay out of the count.
    release('Winter.Sonata.S01E01.1080p.WEB-DL', { approved: false, rejections: [{ reason: 'Language Korean is not wanted in profile' }] }),
  ], { title: 'Winter Sonata', season: 1 });

  const summary = summarizePackRejections(ranked);
  assert.strictEqual(summary.packCount, 3);
  assert.strictEqual(summary.rejectedPackCount, 3);
  assert.strictEqual(summary.primary.bucket, 'size_below_min');
  assert.strictEqual(summary.primary.count, 2, 'two packs blocked by the size floor outrank the one language rejection');
  assert.strictEqual(summary.primary.label, 'Sonarr minimum size limit');
  assert.strictEqual(summary.primary.quality, 'WEBDL-1080p', 'the floor is tied to the quality definition that set it');
  // The tightest floor is the one that has to move for a pack to pass.
  assert.strictEqual(summary.primary.size.limitMb, 9216);
  assert.deepStrictEqual(summary.buckets.map(b => b.bucket), ['size_below_min', 'language']);
  assert.deepStrictEqual(summarizePackRejections([]), { packCount: 0, rejectedPackCount: 0, buckets: [], primary: null });
});
