#!/usr/bin/env node
// #182/#183: manual_exclusion / permanent_pin / temporary_play_pin policies, season/episode-level
// promotion units, and the .stignore carve-out that lets a play-promoted season download without
// pulling the whole series (docs/edge-playback-architecture.md §2.2(c) / §183).
const { test } = require('node:test');
const assert = require('node:assert');
const {
  planNode, planTier, computePlanHash, renderSyncthingStignore, stignoreBody,
  parsePromotionUnit, formatSeasonUnit, formatEpisodeUnit, resolveTvSeasonUnit,
  resolveCaLocalStatus, planCaPromotion,
} = require('../../src/tier');

const GB = 1024 ** 3;
const NOW = Date.parse('2026-07-01T00:00:00Z');

const title = (mediaId, sizeGb, relPath, extra = {}) => ({
  mediaId, title: mediaId, mediaType: 'movie', sizeBytes: sizeGb * GB, relPath, ...extra,
});
const node = (extra = {}) => ({
  name: 'edge', enabled: 1, usable_bytes: 100 * GB, headroom_pct: 0, full: 0,
  access: 'open', demand_source: 'tautulli', transport: 'syncthing', sticky: 0, ...extra,
});
const val = pairs => new Map(pairs.map(([id, value, lastActivity]) => [id, { value, lastActivity: lastActivity ?? null }]));

test('parsePromotionUnit: series/season/episode forms, unknown strings fall back to series', () => {
  assert.deepStrictEqual(parsePromotionUnit('series'), { kind: 'series' });
  assert.deepStrictEqual(parsePromotionUnit(undefined), { kind: 'series' });
  assert.deepStrictEqual(parsePromotionUnit('season:3'), { kind: 'season', season: 3 });
  assert.deepStrictEqual(parsePromotionUnit('episode:2x10'), { kind: 'episode', season: 2, episode: 10 });
  assert.deepStrictEqual(parsePromotionUnit('garbage'), { kind: 'series' });
  assert.strictEqual(formatSeasonUnit(4), 'season:4');
  assert.strictEqual(formatEpisodeUnit(4, 12), 'episode:4x12');
});

test('resolveTvSeasonUnit: resolves the on-disk sub-path and total bytes from episode files, not a naming guess', () => {
  const episodeFiles = [
    { seasonNumber: 1, path: '/mnt/raid/TV Shows/Show/Season 01/e01.mkv', size: 1 * GB },
    { seasonNumber: 1, path: '/mnt/raid/TV Shows/Show/Season 01/e02.mkv', size: 2 * GB },
    { seasonNumber: 2, path: '/mnt/raid/TV Shows/Show/Season 02/e01.mkv', size: 3 * GB },
  ];
  const s1 = resolveTvSeasonUnit({ episodeFiles, seriesPath: '/mnt/raid/TV Shows/Show', seasonNumber: 1 });
  assert.deepStrictEqual(s1.subPaths, ['Season 01']);
  assert.strictEqual(s1.sizeBytes, 3 * GB);

  const s2 = resolveTvSeasonUnit({ episodeFiles, seriesPath: '/mnt/raid/TV Shows/Show', seasonNumber: 2 });
  assert.deepStrictEqual(s2.subPaths, ['Season 02']);
  assert.strictEqual(s2.sizeBytes, 3 * GB);

  const s9 = resolveTvSeasonUnit({ episodeFiles, seriesPath: '/mnt/raid/TV Shows/Show', seasonNumber: 9 });
  assert.deepStrictEqual(s9.subPaths, [], 'no matching episodes → nothing resolved, not a guess');
  assert.strictEqual(s9.sizeBytes, 0);
});

test('resolveTvSeasonUnit: a season split across more than one on-disk directory returns every one', () => {
  const episodeFiles = [
    { seasonNumber: 1, path: '/root/Show/Season 01/e01.mkv', size: 1 * GB },
    { seasonNumber: 1, path: '/root/Show/Specials Overflow/e02.mkv', size: 1 * GB },
  ];
  const s1 = resolveTvSeasonUnit({ episodeFiles, seriesPath: '/root/Show', seasonNumber: 1 });
  assert.deepStrictEqual(s1.subPaths.sort(), ['Season 01', 'Specials Overflow']);
});

test('planNode: manual_exclusion drops an otherwise-kept title, never overrides floor', () => {
  const inv = [title('tmdb:1', 10, 'A'), title('tmdb:2', 10, 'B')];
  const values = val([['tmdb:1', 0.9], ['tmdb:2', 0.9]]);
  const m = planNode({ node: node(), inventory: inv, values, floorIds: new Set(['tmdb:2']), excludeIds: new Set(['tmdb:1', 'tmdb:2']) });
  assert.deepStrictEqual(m.drop.map(e => e.mediaId), ['tmdb:1'], 'excluded, non-floor title is dropped');
  assert.deepStrictEqual(m.keep.map(e => e.mediaId), ['tmdb:2'], 'floor title survives exclusion');
});

test('planNode: an active season pin exempts the whole title from manual_exclusion', () => {
  const inv = [title('tvdb:1', 10, 'Show', { mediaType: 'tv' })];
  const values = val([['tvdb:1', 0.9]]);
  const seasonPins = new Map([['tvdb:1', new Set(['Season 01'])]]);
  const m = planNode({ node: node(), inventory: inv, values, floorIds: new Set(), excludeIds: new Set(['tvdb:1']), seasonPins });
  assert.deepStrictEqual(m.keep.map(e => e.mediaId), ['tvdb:1'], 'pin overrides the exclusion (#182 AC: active pins override legacy ignores)');
});

test('planNode: a season pin on a COLD (dropped) series produces a partial keep, without pulling the whole series into keep', () => {
  const inv = [title('tvdb:1', 200, 'TV Shows/Big Show', { mediaType: 'tv' }), title('tmdb:9', 5, 'Movies/Filler')];
  // tvdb:1 is stone cold and huge; tmdb:9 is hot and small — budget only fits the movie.
  const values = val([['tvdb:1', 0], ['tmdb:9', 0.9]]);
  const n = node({ usable_bytes: 10 * GB });
  const seasonPins = new Map([['tvdb:1', new Set(['Season 03'])]]);
  const m = planNode({ node: n, inventory: inv, values, floorIds: new Set(), seasonPins });
  assert.deepStrictEqual(m.drop.map(e => e.mediaId).sort(), ['tvdb:1'], 'the whole series stays in drop (byte accounting is still whole-title — documented limitation)');
  assert.strictEqual(m.partialKeeps.length, 1);
  // folderId is undefined here because this test calls planNode directly with bare fixture
  // entries (no folderId resolution pass) — planTier's own test below exercises the resolved ''.
  assert.deepStrictEqual(m.partialKeeps[0], { mediaId: 'tvdb:1', folderId: undefined, relPath: 'TV Shows/Big Show', subPaths: ['Season 03'] });
});

test('planNode: a KEPT title with a season pin produces no partial keep (nothing to carve out of an already-kept folder)', () => {
  const inv = [title('tvdb:1', 5, 'Show', { mediaType: 'tv' })];
  const values = val([['tvdb:1', 0.9]]);
  const seasonPins = new Map([['tvdb:1', new Set(['Season 01'])]]);
  const m = planNode({ node: node(), inventory: inv, values, floorIds: new Set(), seasonPins });
  assert.deepStrictEqual(m.keep.map(e => e.mediaId), ['tvdb:1']);
  assert.strictEqual(m.partialKeeps.length, 0);
});

test('stignoreBody: a partial keep renders the negation exception BEFORE the broader drop line', () => {
  const drop = [{ mediaId: 'tvdb:1', relPath: 'TV Shows/Big Show', folderId: '', sizeBytes: 1 }];
  const partialKeeps = [{ mediaId: 'tvdb:1', folderId: '', relPath: 'TV Shows/Big Show', subPaths: ['Season 03'] }];
  const body = stignoreBody(drop, ['// test'], partialKeeps);
  const lines = body.split('\n').filter(Boolean);
  const negIdx = lines.indexOf('!/TV Shows/Big Show/Season 03/**');
  const dropIdx = lines.indexOf('/TV Shows/Big Show/**');
  assert.ok(negIdx !== -1 && dropIdx !== -1, `both lines present: ${JSON.stringify(lines)}`);
  assert.ok(negIdx < dropIdx, 'Syncthing matches top-to-bottom — the exception MUST precede the broader ignore');
});

test('stignoreBody: a drop entry with no partial keep is unchanged (plain folder ignore, no exception lines)', () => {
  const drop = [{ mediaId: 'tmdb:1', relPath: 'Movies/A', folderId: '', sizeBytes: 1 }];
  const body = stignoreBody(drop, ['// test']);
  const lines = body.split('\n').filter(Boolean);
  assert.ok(lines.includes('/Movies/A'), 'unaffected entries keep the original plain ignore format');
  assert.ok(!lines.some(l => l.startsWith('!')), 'no exception lines when nothing is pinned');
});

test('computePlanHash: changes when partialKeeps changes, even though keep/drop membership is identical', () => {
  const base = { node: 'edge', keep: [], drop: [{ mediaId: 'tvdb:1', relPath: 'Show', folderId: '' }] };
  const h1 = computePlanHash({ ...base, partialKeeps: [] });
  const h2 = computePlanHash({ ...base, partialKeeps: [{ mediaId: 'tvdb:1', folderId: '', relPath: 'Show', subPaths: ['Season 01'] }] });
  assert.notStrictEqual(h1, h2, 'the agent must not treat a newly-pinned season as a no-op');
});

test('planTier: a series-unit pin floors the whole title (movie promotion, or a whole-show pin)', () => {
  // tmdb:1 is stone cold and, on its own, would lose the tiny budget to the hot tmdb:2 — the pin
  // is the ONLY reason it survives (a full master node is present so noFullCopy floor doesn't
  // also force-keep it, which would make this test pass for the wrong reason).
  const inv = [title('tmdb:1', 5, 'Movies/A'), title('tmdb:2', 5, 'Movies/B')];
  const nodes = [node({ usable_bytes: 5 * GB }), node({ name: 'master', full: 1 })];
  const values = { edge: [{ title: 'tmdb:2', mediaType: 'movie', plays: 50, lastPlayed: NOW, distinctUsers: 5 }] };
  const withoutPin = planTier({ nodes, inventory: inv, historiesByNode: values, now: NOW });
  assert.deepStrictEqual(withoutPin.manifests.edge.keep.map(e => e.mediaId), ['tmdb:2'], 'sanity: without the pin, the cold title loses the budget');

  const withPin = planTier({
    nodes, inventory: inv, historiesByNode: values,
    policiesByNode: { edge: [{ mediaId: 'tmdb:1', unit: 'series', policy: 'temporary_play_pin', expiresAt: NOW + 1000, subPaths: [] }] },
    now: NOW,
  });
  assert.ok(withPin.manifests.edge.keep.some(e => e.mediaId === 'tmdb:1'), 'the pin keeps the cold title despite the budget');
});

test('planTier: manual_exclusion via policiesByNode removes a title the score model would otherwise keep', () => {
  // access:'restricted' so the title's own demand competes as a SCORE (not universal-core floor,
  // which — correctly — a manual_exclusion cannot override any more than any other safety floor).
  const inv = [title('tmdb:1', 5, 'Movies/A')];
  const nodes = [node({ usable_bytes: 100 * GB, access: 'restricted' }), node({ name: 'master', full: 1 })];
  const plan = planTier({
    nodes, inventory: inv, historiesByNode: { edge: [{ title: 'tmdb:1', mediaType: 'movie', plays: 50, lastPlayed: NOW, distinctUsers: 3 }] },
    now: NOW,
  });
  assert.deepStrictEqual(plan.manifests.edge.keep.map(e => e.mediaId), ['tmdb:1'], 'sanity: without exclusion, demand keeps it');

  const excluded = planTier({
    nodes, inventory: inv, historiesByNode: { edge: [{ title: 'tmdb:1', mediaType: 'movie', plays: 50, lastPlayed: NOW, distinctUsers: 3 }] },
    policiesByNode: { edge: [{ mediaId: 'tmdb:1', unit: 'series', policy: 'manual_exclusion' }] },
    now: NOW,
  });
  assert.deepStrictEqual(excluded.manifests.edge.drop.map(e => e.mediaId), ['tmdb:1']);
});

test('planTier: a season-unit temporary_play_pin carves out a season without floor-pinning the whole series', () => {
  const inv = [
    title('tvdb:1', 200, 'TV Shows/Big Show', { mediaType: 'tv' }),
    title('tmdb:9', 5, 'Movies/Filler'),
  ];
  const nodes = [node({ usable_bytes: 10 * GB }), node({ name: 'master', full: 1 })];
  const plan = planTier({
    nodes, inventory: inv,
    historiesByNode: { edge: [{ title: 'tmdb:9', mediaType: 'movie', plays: 10, lastPlayed: NOW, distinctUsers: 2 }] },
    policiesByNode: {
      edge: [{ mediaId: 'tvdb:1', unit: formatSeasonUnit(3), policy: 'temporary_play_pin', expiresAt: NOW + 1000, subPaths: ['Season 03'] }],
    },
    now: NOW,
  });
  const m = plan.manifests.edge;
  assert.deepStrictEqual(m.drop.map(e => e.mediaId), ['tvdb:1'], 'the series is NOT floor-pinned as a whole');
  assert.deepStrictEqual(m.partialKeeps, [{ mediaId: 'tvdb:1', folderId: '', relPath: 'TV Shows/Big Show', subPaths: ['Season 03'] }]);
  const stignore = renderSyncthingStignore(m);
  assert.ok(stignore.includes('!/TV Shows/Big Show/Season 03/**'));
});

test('resolveCaLocalStatus: absent, partial (mid-pull), and fully-synced from real reported bytes — never the keep-set', () => {
  const files = [{ folderId: '', relPath: 'TV Shows/Show/Season 01/e01.mkv', sizeBytes: 1 * GB }];
  const absent = resolveCaLocalStatus({ relPath: 'TV Shows/Show/Season 02', expectedBytes: 2 * GB, files });
  assert.deepStrictEqual(absent, { present: false, complete: false, bytes: 0 });

  const partial = resolveCaLocalStatus({ relPath: 'TV Shows/Show/Season 01', expectedBytes: 5 * GB, files });
  assert.strictEqual(partial.present, true);
  assert.strictEqual(partial.complete, false, 'mid-pull: present but far short of expected bytes');

  const full = resolveCaLocalStatus({ relPath: 'TV Shows/Show/Season 01', expectedBytes: 1 * GB, files });
  assert.strictEqual(full.complete, true);
});

test('resolveCaLocalStatus: completeFrac tolerates arr-vs-disk size drift', () => {
  const files = [{ folderId: '', relPath: 'Movies/A/movie.mkv', sizeBytes: Math.floor(0.99 * GB) }];
  const status = resolveCaLocalStatus({ relPath: 'Movies/A', expectedBytes: 1 * GB, files, completeFrac: 0.98 });
  assert.strictEqual(status.complete, true, '99% of expected clears the default 98% tolerance');
});

test('planCaPromotion: mirrors staging.planPlayPromotion\'s skip/audit/enqueue vocabulary', () => {
  assert.deepStrictEqual(planCaPromotion({ enabled: false, isLocal: false }), { action: 'skip', reason: 'disabled' });
  assert.deepStrictEqual(planCaPromotion({ enabled: true, isLocal: false, hasFullCopy: false }), { action: 'skip', reason: 'no_full_copy' });
  assert.deepStrictEqual(planCaPromotion({ enabled: true, isLocal: true }), { action: 'skip', reason: 'already_local' });
  assert.deepStrictEqual(planCaPromotion({ enabled: true, isLocal: false, lastPromoteAt: 1000, now: 1500, cooldownMs: 1000 }), { action: 'skip', reason: 'cooldown' });
  assert.deepStrictEqual(planCaPromotion({ enabled: true, isLocal: false, rateLimitOk: false }), { action: 'skip', reason: 'rate_limited' });
  assert.deepStrictEqual(planCaPromotion({ enabled: true, isLocal: false, auditOnly: true }), { action: 'audit', reason: 'audit_only' });
  assert.deepStrictEqual(planCaPromotion({ enabled: true, isLocal: false }), { action: 'enqueue', reason: 'promote' });
});
