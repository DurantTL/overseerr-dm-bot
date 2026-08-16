#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const { loadSandbox } = require('./extract');
const { classifySeasonRelease, rankSeasonReleases, chooseSeasonPack, describeRejections } = require('../../src/season-release');

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
