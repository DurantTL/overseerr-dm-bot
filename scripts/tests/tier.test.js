#!/usr/bin/env node
// Regional tiering planner: budget fill, incremental watermark LRU (evict only to admit),
// warm/fresh protection, the admission gate, access modes (open vs restricted), the atime
// demand source, master-coverage safety, manifest rendering, and plan-hash stability.
// src/tier.js is Discord- and DB-free, so it's imported directly.
const assert = require('assert');
const {
  recencyDecay, titleKey, computeUniversalCore, computeNodeValues, planNode, planTier,
  computePlanHash, renderSyncthingStignore, renderFolderStignore, renderRclone, toRelPath,
  parseAtimeMask, inAtimeMask, maskSuspectAtimes, nodeFolders, resolveTitleFolder,
  physicalTitleIds, physicalTitleBytes, computeTierActionPreview, assessApplyImpact, tierApplyConfirmCode,
  mediaIdFromGuid, indexHistory,
} = require('../../src/tier');

const GB = 1024 ** 3;
const DAY = 86400000;
const NOW = Date.parse('2026-07-01T00:00:00Z');
const daysAgo = d => NOW - d * DAY;

const title = (mediaId, sizeGb, relPath, extra = {}) => ({
  mediaId, title: mediaId, mediaType: 'movie', sizeBytes: sizeGb * GB, relPath, ...extra,
});
const node = (extra = {}) => ({
  name: 'edge', enabled: 1, usable_bytes: 100 * GB, headroom_pct: 0, full: 0,
  access: 'open', demand_source: 'tautulli', transport: 'syncthing', sticky: 0, ...extra,
});
const val = pairs => new Map(pairs.map(([id, value, lastActivity]) => [id, { value, lastActivity: lastActivity ?? null }]));
const keepIds = m => m.keep.map(e => e.mediaId).sort().join();
const dropIds = m => m.drop.map(e => e.mediaId).sort().join();

// --- primitives ---
assert.ok(Math.abs(recencyDecay(daysAgo(30), NOW, 30) - 0.5) < 1e-9, 'one half-life → 0.5');
assert.strictEqual(recencyDecay(null, NOW, 30), 0, 'no timestamp → 0');
assert.strictEqual(titleKey('The Matrix (1999)', 'movie'), titleKey('the matrix', 'movie'), 'title key normalizes year + case');
assert.notStrictEqual(titleKey('Bluey', 'tv'), titleKey('Bluey', 'movie'), 'media type separates keys');
assert.strictEqual(toRelPath('/mnt/raid/movies/X', '/mnt/raid'), 'movies/X', 'relPath strips source root');

// --- universal core: top-K by summed plays across nodes ---
const core = computeUniversalCore({
  a: [{ title: 'Hit', mediaType: 'movie', plays: 50 }, { title: 'Meh', mediaType: 'movie', plays: 2 }],
  b: [{ title: 'Hit', mediaType: 'movie', plays: 30 }, { title: 'Local Fav', mediaType: 'movie', plays: 10 }],
}, 2);
assert.deepStrictEqual(core, [titleKey('Hit', 'movie'), titleKey('Local Fav', 'movie')], 'core = top-K by global plays');

// --- budget fill correctness (first run: floor + ranked admits until budget) ---
{
  const inv = [title('A', 10, 'm/A'), title('B', 10, 'm/B'), title('C', 10, 'm/C'), title('D', 10, 'm/D')];
  const m = planNode({
    node: node({ usable_bytes: 25 * GB }), inventory: inv,
    values: val([['A', 0.9], ['B', 0.8], ['C', 0.7], ['D', 0.6]]),
    floorIds: new Set(), now: NOW,
  });
  assert.strictEqual(keepIds(m), 'A,B', 'hottest titles fill the budget');
  assert.strictEqual(dropIds(m), 'C,D', 'tail stays dropped (ignored)');
  assert.ok(m.stats.keepBytes <= m.stats.budgetBytes, 'budget respected');
  assert.strictEqual(m.receiveOnly, true, 'edge manifest marked receive-only');
}

// --- headroom: budget = usable * (1 - headroom%) ---
{
  const m = planNode({ node: node({ usable_bytes: 100 * GB, headroom_pct: 25 }), inventory: [], values: val([]), floorIds: new Set(), now: NOW });
  assert.strictEqual(m.stats.budgetBytes, 75 * GB, 'headroom removed from budget');
}

// --- graceful degradation: budget ≥ library ⇒ empty drop ---
{
  const inv = [title('A', 10, 'm/A'), title('B', 10, 'm/B')];
  const m = planNode({ node: node({ usable_bytes: 500 * GB }), inventory: inv, values: val([]), floorIds: new Set(), now: NOW });
  assert.strictEqual(m.drop.length, 0, 'nothing pruned when everything fits');
  assert.strictEqual(m.keep.length, 2, 'node holds the whole library');
}

// --- full master: never pruned, regardless of budget ---
{
  const inv = [title('A', 10, 'm/A'), title('B', 10, 'm/B')];
  const m = planNode({ node: node({ full: 1, usable_bytes: 1 * GB }), inventory: inv, values: val([]), floorIds: new Set(), now: NOW });
  assert.strictEqual(m.drop.length, 0, 'full node drops nothing even over budget');
  assert.strictEqual(m.receiveOnly, false, 'master is the sender, not receive-only');
}

// --- smaller-first tie-break on equal value ---
{
  const inv = [title('BIG', 10, 'm/BIG'), title('SMALL', 4, 'm/SMALL')];
  const m = planNode({
    node: node({ usable_bytes: 5 * GB }), inventory: inv,
    values: val([['BIG', 0.5], ['SMALL', 0.5]]), floorIds: new Set(), now: NOW,
  });
  assert.strictEqual(keepIds(m), 'SMALL', 'equal value → smaller title admitted first');
}

// --- incremental eviction: evict only enough to admit, coldest first ---
{
  const inv = [title('A', 10, 'm/A'), title('B', 10, 'm/B'), title('C', 10, 'm/C'), title('N', 10, 'm/N')];
  const m = planNode({
    node: node({ usable_bytes: 30 * GB }), inventory: inv,
    values: val([['A', 0.01, daysAgo(200)], ['B', 0.05, daysAgo(100)], ['C', 0.5, daysAgo(40)], ['N', 0.9, daysAgo(1)]]),
    floorIds: new Set(), prevKeepIds: ['A', 'B', 'C'], now: NOW,
  });
  assert.strictEqual(keepIds(m), 'B,C,N', 'hot arrival admitted');
  assert.deepStrictEqual(m.evict, ['A'], 'ONLY the coldest victim evicted — old-but-not-coldest survives');
}

// --- equal-value eviction: larger victim first, so fewer titles churn per apply ---
{
  // Two cold, equally-cold (value 0) kept titles; a hot newcomer needs ~8 GB freed. Freeing the
  // one BIG victim suffices, so only it is evicted — the SMALL one survives. (Smaller-first would
  // have shredded BOTH to reach the same bytes.)
  const inv = [title('BIG', 10, 'm/BIG'), title('SMALL', 4, 'm/SMALL'), title('N', 8, 'm/N')];
  const m = planNode({
    node: node({ usable_bytes: 14 * GB }), inventory: inv,
    values: val([['BIG', 0, daysAgo(200)], ['SMALL', 0, daysAgo(200)], ['N', 0.9, daysAgo(1)]]),
    floorIds: new Set(), prevKeepIds: ['BIG', 'SMALL'], now: NOW,
  });
  assert.strictEqual(keepIds(m), 'N,SMALL', 'tied-value eviction takes the LARGER victim → the small title stays');
  assert.deepStrictEqual(m.evict, ['BIG'], 'exactly one title churned, not two');
}

// --- over-budget trim sheds the MINIMUM (smaller victim first), doesn't underfill ---
{
  // Carried-over keep-set busts a shrunk budget by 4 GB; two tied-cold victims (10 GB + 4 GB).
  // The trim must drop the 4 GB title (exactly enough) and keep the 10 GB one — dropping the big
  // title instead would leave the 10 GB budget holding only 4 GB, and evicted entries can't be
  // re-admitted. (Displacement uses the opposite, larger-first order — see the test above.)
  const inv = [title('BIG', 10, 'm/BIG'), title('SMALL', 4, 'm/SMALL')];
  const m = planNode({
    node: node({ usable_bytes: 10 * GB }), inventory: inv,
    values: val([['BIG', 0, daysAgo(200)], ['SMALL', 0, daysAgo(200)]]),
    floorIds: new Set(), prevKeepIds: ['BIG', 'SMALL'], now: NOW,
  });
  assert.strictEqual(keepIds(m), 'BIG', 'trim keeps the large title, cache stays full');
  assert.deepStrictEqual(m.evict, ['SMALL'], 'only the minimal victim shed to reach budget');
  assert.ok(m.stats.keepBytes <= m.stats.budgetBytes && m.stats.keepBytes === 10 * GB, 'budget filled, not underfilled');
}

// --- a missing added date is "unknown", never fresh (no bogus force-keep) ---
{
  // OLD has no addedAt at all. It must NOT get the fresh-grace protection — a hotter newcomer
  // displaces it. (The bug: the inventory loader fell back to `now`, making every date-less title
  // look brand-new and immovable.)
  const inv = [title('OLD', 10, 'm/OLD', { addedAt: null }), title('N', 10, 'm/N', { addedAt: daysAgo(400) })];
  const m = planNode({
    node: node({ usable_bytes: 10 * GB }), inventory: inv,
    values: val([['OLD', 0, daysAgo(300)], ['N', 0.99, daysAgo(1)]]),
    floorIds: new Set(), prevKeepIds: ['OLD'], now: NOW,
  });
  assert.strictEqual(keepIds(m), 'N', 'date-less title is not fresh-protected — hot newcomer wins');
  assert.strictEqual(dropIds(m), 'OLD', 'the unknown-date title is evictable');
}

// --- warm titles are never evicted ---
{
  const inv = [title('WARM', 10, 'm/W'), title('COLD', 10, 'm/C'), title('N', 10, 'm/N')];
  const m = planNode({
    node: node({ usable_bytes: 20 * GB }), inventory: inv,
    values: val([['WARM', 0.2, daysAgo(2)], ['COLD', 0.1, daysAgo(90)], ['N', 0.99, daysAgo(1)]]),
    floorIds: new Set(), prevKeepIds: ['WARM', 'COLD'], now: NOW,
  });
  assert.strictEqual(keepIds(m), 'N,WARM', 'recently-watched title protected; cold one gave way');
}

// --- fresh titles are never evicted (grace before any watch history) ---
{
  const inv = [title('FRESH', 10, 'm/F', { addedAt: daysAgo(5) }), title('N', 10, 'm/N', { addedAt: daysAgo(400) })];
  const m = planNode({
    node: node({ usable_bytes: 10 * GB }), inventory: inv,
    values: val([['N', 0.99, daysAgo(1)]]), floorIds: new Set(), prevKeepIds: ['FRESH'], now: NOW,
  });
  assert.strictEqual(keepIds(m), 'FRESH', 'newly-added title survives its grace window');
  assert.strictEqual(dropIds(m), 'N', 'even a hotter candidate cannot displace it');
}

// --- admission gate: a candidate colder than every victim is rejected ---
{
  const inv = [title('A', 10, 'm/A'), title('N', 10, 'm/N')];
  const m = planNode({
    node: node({ usable_bytes: 10 * GB }), inventory: inv,
    values: val([['A', 0.5, daysAgo(60)], ['N', 0.3, daysAgo(50)]]),
    floorIds: new Set(), prevKeepIds: ['A'], now: NOW,
  });
  assert.strictEqual(keepIds(m), 'A', 'kept title outranks the newcomer');
  assert.strictEqual(m.evict.length, 0, 'no pointless churn');
}

// --- floor (Tier 0) is never evictable, even when it busts the budget ---
{
  const inv = [title('K', 10, 'm/K'), title('N', 10, 'm/N')];
  const m = planNode({
    node: node({ usable_bytes: 10 * GB }), inventory: inv,
    values: val([['K', 0, daysAgo(300)], ['N', 0.99, daysAgo(1)]]),
    floorIds: new Set(['K']), prevKeepIds: ['K'], now: NOW,
  });
  assert.strictEqual(keepIds(m), 'K', 'keep-listed title immovable');
}

// --- sticky hysteresis: doubled warm window on old-drive nodes ---
{
  const inv = [title('S', 10, 'm/S'), title('N', 10, 'm/N')];
  const values = val([['S', 0.2, daysAgo(20)], ['N', 0.9, daysAgo(1)]]);
  const normal = planNode({ node: node({ usable_bytes: 10 * GB }), inventory: inv, values, floorIds: new Set(), prevKeepIds: ['S'], now: NOW });
  assert.strictEqual(keepIds(normal), 'N', 'non-sticky: 20d-old watch is outside the 14d warm window → evicted');
  const sticky = planNode({ node: node({ usable_bytes: 10 * GB, sticky: 1 }), inventory: inv, values, floorIds: new Set(), prevKeepIds: ['S'], now: NOW });
  assert.strictEqual(keepIds(sticky), 'S', 'sticky: same watch falls inside the doubled warm window → protected');
}

// --- planTier: access modes ---
const home = { name: 'home', enabled: 1, full: 1, usable_bytes: 10000 * GB, headroom_pct: 15, access: 'open', demand_source: 'tautulli', transport: 'syncthing' };
{
  // Open node ignores membership and never pins requests.
  const inv = [title('tmdb:1', 10, 'm/Hot'), title('tmdb:2', 10, 'm/Requested')];
  const { manifests } = planTier({
    nodes: [home, node({ name: 'cali', usable_bytes: 10 * GB, access: 'open' })],
    inventory: inv,
    historiesByNode: { cali: [{ title: 'tmdb:1', mediaType: 'movie', plays: 20, distinctUsers: 3, lastPlayed: daysAgo(3) }] },
    memberRequests: { cali: [{ mediaId: 'tmdb:2', requestedAt: daysAgo(2) }] },
    now: NOW,
  });
  assert.strictEqual(dropIds(manifests.cali), 'tmdb:2', 'open node: a member "pin" has no effect — demand wins');
  assert.strictEqual(manifests.home.drop.length, 0, 'master untouched');
}
{
  // Restricted node pins a member's request within the grace window (cold start, zero plays)...
  const inv = [title('tmdb:1', 10, 'm/PopularElsewhere'), title('tmdb:2', 10, 'm/MemberRequest')];
  const plan = reqAge => planTier({
    nodes: [home, node({ name: 'ph', usable_bytes: 10 * GB, access: 'restricted' })],
    inventory: inv,
    historiesByNode: { home: [{ title: 'tmdb:1', mediaType: 'movie', plays: 80, distinctUsers: 9, lastPlayed: daysAgo(2) }] },
    memberRequests: { ph: [{ mediaId: 'tmdb:2', requestedAt: daysAgo(reqAge) }] },
    now: NOW,
    config: { coreTopK: 1 },
  }).manifests.ph;
  assert.strictEqual(keepIds(plan(10)), 'tmdb:2', 'member request pinned over the global crowd-pleaser');
  // ...and the pin expires after the grace window.
  assert.strictEqual(keepIds(plan(100)), 'tmdb:1', 'expired pin → core/demand take over');
}
{
  // Restricted node prefers its own history over the universal core under pressure;
  // the same squeeze on an open node keeps the core title instead (core is floor there).
  const inv = [title('tmdb:own', 10, 'm/OwnFav'), title('tmdb:core', 10, 'm/GlobalHit')];
  const mk = access => planTier({
    nodes: [home, node({ name: 'x', usable_bytes: 10 * GB, access })],
    inventory: inv,
    historiesByNode: {
      home: [{ title: 'tmdb:core', mediaType: 'movie', plays: 100, distinctUsers: 10, lastPlayed: daysAgo(2) }],
      x: [{ title: 'tmdb:own', mediaType: 'movie', plays: 3, distinctUsers: 2, lastPlayed: daysAgo(4) }],
    },
    now: NOW,
    config: { coreTopK: 1 },
  }).manifests.x;
  assert.strictEqual(keepIds(mk('restricted')), 'tmdb:own', 'restricted: members\' own history outranks the global core');
  assert.strictEqual(keepIds(mk('open')), 'tmdb:core', 'open: universal core is Tier-0 floor');
}

// --- planTier: atime demand source (LRU by last read), floor still protected ---
{
  const inv = [title('tmdb:1', 10, 'movies/M1'), title('tmdb:2', 10, 'movies/M2'), title('tmdb:3', 10, 'movies/M3')];
  const atime = {
    cali: [
      { relPath: 'movies/M1/m1.mkv', sizeBytes: 10 * GB, atime: daysAgo(2) },
      { relPath: 'movies/M2/m2.mkv', sizeBytes: 10 * GB, atime: daysAgo(60) },
      // M3: no atime reported → no signal, ranks last (graceful fallback)
    ],
  };
  const base = { nodes: [home, node({ name: 'cali', usable_bytes: 20 * GB, demand_source: 'atime' })], inventory: inv, atimeReports: atime, now: NOW };
  const m1 = planTier(base).manifests.cali;
  assert.strictEqual(keepIds(m1), 'tmdb:1,tmdb:2', 'LRU by atime: most recently read stay');
  assert.strictEqual(dropIds(m1), 'tmdb:3', 'unreported-atime title is the eviction candidate');
  const m2 = planTier({ ...base, keepListIds: ['tmdb:3'] }).manifests.cali;
  assert.ok(m2.keep.some(e => e.mediaId === 'tmdb:3'), 'keep-list floor beats the LRU');
  assert.ok(m2.stats.keepBytes <= m2.stats.budgetBytes, 'budget still respected');
}

// --- computeNodeValues: atime rolls file atimes up to the owning title folder ---
{
  const v = computeNodeValues({
    node: { demand_source: 'atime' },
    inventory: [title('tmdb:1', 10, 'tv/Show')],
    files: [
      { relPath: 'tv/Show/Season 01/e1.mkv', atime: daysAgo(50) },
      { relPath: 'tv/Show/Season 01/e2.mkv', atime: daysAgo(30) },
    ],
    now: NOW, cfg: { halfLifeDays: 30 },
  });
  assert.ok(Math.abs(v.get('tmdb:1').value - 0.5) < 1e-9, 'newest file atime wins (nested season folder resolved)');
}

// --- master coverage invariant ---
{
  // A title with no full-node copy is never dropped, anywhere, and gets flagged.
  const inv = [title('tmdb:orphan', 10, 'm/Orphan', { onFullNode: false }), title('tmdb:x', 10, 'm/X')];
  const { manifests, warnings } = planTier({
    nodes: [home, node({ name: 'cali', usable_bytes: 10 * GB })],
    inventory: inv,
    now: NOW,
  });
  assert.ok(manifests.cali.keep.some(e => e.mediaId === 'tmdb:orphan'), 'uncovered title force-kept');
  assert.strictEqual(dropIds(manifests.cali), 'tmdb:x', 'covered title takes the drop instead');
  assert.ok(warnings.some(w => w.includes('tmdb:orphan')), 'uncovered title flagged in warnings');
}
{
  // No enabled full node at all → nothing may be dropped anywhere.
  const inv = [title('tmdb:1', 10, 'm/A'), title('tmdb:2', 10, 'm/B'), title('tmdb:3', 10, 'm/C')];
  const { manifests, warnings } = planTier({
    nodes: [{ ...home, enabled: 0 }, node({ name: 'cali', usable_bytes: 10 * GB })],
    inventory: inv,
    now: NOW,
  });
  assert.strictEqual(manifests.cali.drop.length, 0, 'no full master → force-keep everything');
  assert.strictEqual(manifests.home, undefined, 'disabled node gets no manifest');
  assert.ok(warnings.some(w => /full/.test(w)), 'missing-master warning emitted');
}

// --- disabled node history never feeds the universal core ---
{
  const inv = [title('tmdb:stale', 10, 'm/Stale'), title('tmdb:live', 10, 'm/Live')];
  const { manifests } = planTier({
    nodes: [home, { ...node({ name: 'bench', usable_bytes: 100 * GB }), enabled: 0 }, node({ name: 'cali', usable_bytes: 10 * GB })],
    inventory: inv,
    historiesByNode: {
      bench: [{ title: 'tmdb:stale', mediaType: 'movie', plays: 500, distinctUsers: 5, lastPlayed: daysAgo(3) }],
      home: [{ title: 'tmdb:live', mediaType: 'movie', plays: 5, distinctUsers: 2, lastPlayed: daysAgo(3) }],
    },
    now: NOW,
    config: { coreTopK: 1 },
  });
  assert.strictEqual(keepIds(manifests.cali), 'tmdb:live', 'stale bench history excluded from the core');
}

// --- manifest rendering ---
{
  const inv = [title('tmdb:keep', 10, 'movies/Keep Me (2020)'), title('tmdb:drop', 10, 'movies/Drop [imdb-tt1] {x}')];
  const m = planNode({
    node: node({ usable_bytes: 10 * GB }), inventory: inv,
    values: val([['tmdb:keep', 0.9], ['tmdb:drop', 0.1]]), floorIds: new Set(), now: NOW,
  });
  const stignore = renderSyncthingStignore(m);
  assert.ok(stignore.includes(`plan: ${m.planHash}`), 'header carries the plan hash');
  assert.ok(stignore.includes('/movies/Drop \\[imdb-tt1\\] \\{x\\}'), 'drop path folder-relative, special chars escaped');
  assert.ok(!stignore.includes('Keep Me'), 'kept titles are not ignored');
  assert.ok(!stignore.includes('(?d)'), 'no (?d) — pruning is the agent\'s explicit job');
  const rclone = renderRclone(m);
  assert.ok(rclone.includes('movies/Keep Me (2020)/**'), 'rclone list holds the keeps');
}

// --- plan hash: stable across ordering and timestamps, sensitive to outcome ---
{
  const mk = (keep, drop) => ({ node: 'x', keep: keep.map(p => ({ relPath: p })), drop: drop.map(p => ({ relPath: p })) });
  assert.strictEqual(computePlanHash(mk(['a', 'b'], ['c'])), computePlanHash(mk(['b', 'a'], ['c'])), 'order-insensitive');
  assert.notStrictEqual(computePlanHash(mk(['a', 'b'], ['c'])), computePlanHash(mk(['a'], ['b', 'c'])), 'outcome-sensitive');
}

// --- atime maintenance-window mask (Plex nightly analysis must not count as watches) ---
{
  assert.deepStrictEqual(parseAtimeMask('09:00-13:00'), { startMin: 540, endMin: 780 }, 'plain window parses');
  assert.deepStrictEqual(parseAtimeMask('22:00-03:00'), { startMin: 1320, endMin: 180 }, 'midnight-wrapping window parses');
  assert.strictEqual(parseAtimeMask('garbage'), null, 'junk rejected');
  assert.strictEqual(parseAtimeMask('25:00-13:00'), null, 'invalid hour rejected');
  assert.strictEqual(parseAtimeMask('09:00-09:00'), null, 'empty window rejected');
  assert.strictEqual(parseAtimeMask(null), null, 'unset mask → null (mask disabled)');

  const at = (h, m = 0) => Date.UTC(2026, 6, 1, h, m);
  const plain = parseAtimeMask('09:00-13:00');
  assert.strictEqual(inAtimeMask(at(10), plain), true, '10:00 UTC inside 09-13');
  assert.strictEqual(inAtimeMask(at(13), plain), false, 'end is exclusive');
  assert.strictEqual(inAtimeMask(at(20), plain), false, 'evening outside');
  const wrap = parseAtimeMask('22:00-03:00');
  assert.strictEqual(inAtimeMask(at(23, 30), wrap), true, 'pre-midnight inside wrapped window');
  assert.strictEqual(inAtimeMask(at(2), wrap), true, 'post-midnight inside wrapped window');
  assert.strictEqual(inAtimeMask(at(12), wrap), false, 'midday outside wrapped window');

  const files = [
    { relPath: 'm/A/a.mkv', sizeBytes: 1, atime: at(10) },      // suspect: maintenance read
    { relPath: 'm/B/b.mkv', sizeBytes: 1, atime: at(20) },      // real evening watch
    { relPath: 'm/C/c.mkv', sizeBytes: 1, atime: at(11) },      // suspect, but never seen before
    { relPath: 'm/D/d.mkv', sizeBytes: 1, atime: null },        // no atime at all
  ];
  const prevFiles = [
    { relPath: 'm/A/a.mkv', sizeBytes: 1, atime: at(19) - 30 * 86400000 }, // last real read: a month ago
    { relPath: 'm/B/b.mkv', sizeBytes: 1, atime: at(19) - 30 * 86400000 },
  ];
  const masked = maskSuspectAtimes(files, prevFiles, plain);
  assert.strictEqual(masked[0].atime, at(19) - 30 * 86400000, 'suspect atime → previous plausible read carried forward');
  assert.strictEqual(masked[1].atime, at(20), 'real watch outside the window kept as-is');
  assert.strictEqual(masked[2].atime, at(11), 'suspect with no prior row keeps the reported value');
  assert.strictEqual(masked[3].atime, null, 'missing atime untouched');
  assert.deepStrictEqual(maskSuspectAtimes(files, prevFiles, null), files, 'no mask → passthrough');
}

// --- R2.1 multi-folder: title paths split to the correct folder, single budget pool ---
const homeFull = { name: 'home', enabled: 1, full: 1, usable_bytes: 10000 * GB, headroom_pct: 0, access: 'open', demand_source: 'tautulli' };
const caliFolders = [
  { folderId: 'mov', folderRoot: '/mnt/media/Media/Movies' },
  { folderId: 'fourk', folderRoot: '/mnt/media/Media/4k' },
  { folderId: 'tv', folderRoot: '/mnt/media/Media/TV Shows' },
];
const mfTitle = (mediaId, mediaType, absPath, sizeGb = 10) => ({
  mediaId, title: mediaId, mediaType, sizeBytes: sizeGb * GB, addedAt: daysAgo(400), path: absPath, relPath: absPath,
});
{
  // resolveTitleFolder: longest-prefix match, folder-relative path.
  const r = resolveTitleFolder({ path: '/mnt/media/Media/Movies/Alpha (2020)', relPath: 'x' }, caliFolders);
  assert.deepStrictEqual(r, { folderId: 'mov', relPath: 'Alpha (2020)' }, 'title routed to its folder, path made folder-relative');
  // A title outside every folder root falls back to the first folder + its precomputed relPath.
  const miss = resolveTitleFolder({ path: '/somewhere/else/X', relPath: 'kept' }, caliFolders);
  assert.strictEqual(miss.folderId, 'mov', 'unmatched title assigned to first folder (fallback)');
}
{
  const inv = [
    mfTitle('tmdb:1', 'movie', '/mnt/media/Media/Movies/Alpha (2020)'),
    mfTitle('tmdb:2', 'movie', '/mnt/media/Media/4k/Beta (2021)'),
    mfTitle('tvdb:3', 'tv', '/mnt/media/Media/TV Shows/Gamma'),
  ];
  const cali = { name: 'cali', enabled: 1, usable_bytes: 20 * GB, headroom_pct: 0, access: 'open', demand_source: 'atime', folders: caliFolders };
  // atime spread across two different folders — the LRU still runs over the whole node.
  const atimeReports = { cali: [
    { folderId: 'mov', relPath: 'Alpha (2020)/a.mkv', sizeBytes: 10 * GB, atime: daysAgo(2) },
    { folderId: 'tv', relPath: 'Gamma/S01/e1.mkv', sizeBytes: 10 * GB, atime: daysAgo(90) },
    // Beta (4k): no atime → coldest, evict-first.
  ] };
  const m = planTier({ nodes: [homeFull, cali], inventory: inv, atimeReports, now: NOW }).manifests.cali;
  assert.strictEqual(keepIds(m), 'tmdb:1,tvdb:3', 'single-pool LRU across folders: hottest two kept');
  assert.strictEqual(dropIds(m), 'tmdb:2', 'coldest (no-atime) title dropped regardless of which folder it is in');

  // Manifest folder split: each folder carries only its own titles, folder-relative.
  const byId = Object.fromEntries(m.folders.map(f => [f.folder_id, f]));
  assert.deepStrictEqual(byId.mov.keep.map(e => e.relPath), ['Alpha (2020)'], 'Movies folder keeps Alpha (folder-relative)');
  assert.deepStrictEqual(byId.fourk.drop.map(e => e.relPath), ['Beta (2021)'], 'the drop lands under the 4k folder');
  assert.deepStrictEqual(byId.tv.keep.map(e => e.relPath), ['Gamma'], 'TV folder keeps Gamma');
  assert.strictEqual(byId.mov.folder_root, '/mnt/media/Media/Movies', 'folder carries its root for the agent');

  // Per-folder stignore correctness: a folder ignores only its own drops, nobody else's.
  const fourkIgnore = renderFolderStignore(byId.fourk, m);
  assert.ok(fourkIgnore.includes('/Beta (2021)'), '4k stignore ignores its dropped title, folder-relative');
  assert.ok(fourkIgnore.includes('folder: fourk'), 'stignore header names the folder');
  const movIgnore = renderFolderStignore(byId.mov, m);
  assert.ok(!movIgnore.includes('Beta'), 'Movies stignore does not leak the 4k folder\'s drop');
  assert.ok(movIgnore.trim().split('\n').every(l => l.startsWith('//')), 'Movies folder drops nothing → header-only stignore');
}
{
  // Same title held in BOTH Movies and 4k (identical relPath after folder-relativization):
  // the folder id keeps them distinct in the manifest and the plan hash.
  const inv = [
    mfTitle('tmdb:1', 'movie', '/mnt/media/Media/Movies/Dune (2021)'),
    mfTitle('tmdb:2', 'movie', '/mnt/media/Media/4k/Dune (2021)'),
  ];
  const cali = { name: 'cali', enabled: 1, usable_bytes: 500 * GB, headroom_pct: 0, access: 'open', demand_source: 'atime', folders: caliFolders };
  const m = planTier({ nodes: [homeFull, cali], inventory: inv, now: NOW }).manifests.cali;
  const relOf = id => m.keep.find(e => e.mediaId === id).relPath;
  assert.strictEqual(relOf('tmdb:1'), 'Dune (2021)', 'Movies copy folder-relative');
  assert.strictEqual(relOf('tmdb:2'), 'Dune (2021)', '4k copy shares the relPath but a different folder');
  const folderOf = id => m.keep.find(e => e.mediaId === id).folderId;
  assert.notStrictEqual(folderOf('tmdb:1'), folderOf('tmdb:2'), 'same relPath disambiguated by folder id');
}

// --- R2.1 single-folder fallback unchanged: legacy node yields one default folder ---
{
  const inv = [title('tmdb:1', 10, 'movies/Solo'), title('tmdb:2', 10, 'movies/Duo')];
  const legacy = node({ name: 'legacy', usable_bytes: 500 * GB, folder_root: '/mnt/raid' });
  const m = planTier({ nodes: [homeFull, legacy], inventory: inv, now: NOW }).manifests.legacy;
  assert.strictEqual(m.folders.length, 1, 'legacy node has exactly one folder');
  assert.strictEqual(m.folders[0].folder_id, '', 'legacy folder id is empty (agent uses SYNCTHING_FOLDER_ID)');
  assert.deepStrictEqual(m.keep.map(e => e.relPath).sort(), ['movies/Duo', 'movies/Solo'], 'relPaths untouched (source-root-relative)');
  assert.deepStrictEqual(nodeFolders({ folder_root: '/mnt/raid' }), [{ folderId: '', folderRoot: '/mnt/raid' }], 'nodeFolders synthesizes the single legacy folder');
}

// --- R2.2 plex demand: recencyDecay(lastViewedAt)×log1p(viewCount), per-title atime fallback ---
{
  // A title Plex has a view record for ranks above an atime-only title.
  const inv = [title('tmdb:watched', 10, 'movies/Watched'), title('tmdb:read', 10, 'movies/Read')];
  const cali = { name: 'cali', enabled: 1, usable_bytes: 10 * GB, headroom_pct: 0, access: 'open', demand_source: 'plex' };
  const m = planTier({
    nodes: [homeFull, cali], inventory: inv,
    historiesByNode: { cali: [{ title: 'tmdb:watched', mediaType: 'movie', plays: 5, distinctUsers: 2, lastPlayed: daysAgo(2) }] },
    atimeReports: { cali: [{ relPath: 'movies/Read/r.mkv', sizeBytes: 10 * GB, atime: daysAgo(40) }] },
    now: NOW, config: { coreTopK: 0 },
  }).manifests.cali;
  assert.strictEqual(keepIds(m), 'tmdb:watched', 'real Plex playback outranks an older atime-only read');
  assert.strictEqual(dropIds(m), 'tmdb:read', 'atime-only title gives way');
}
{
  // Missing Plex record falls back to atime; a title with neither is coldest (evict-first).
  const inv = [title('tmdb:plex', 10, 'movies/Plex'), title('tmdb:atime', 10, 'movies/Atime'), title('tmdb:none', 10, 'movies/None')];
  const cali = { name: 'cali', enabled: 1, usable_bytes: 20 * GB, headroom_pct: 0, access: 'open', demand_source: 'plex' };
  const m = planTier({
    nodes: [homeFull, cali], inventory: inv,
    historiesByNode: { cali: [{ title: 'tmdb:plex', mediaType: 'movie', plays: 1, distinctUsers: 1, lastPlayed: daysAgo(50) }] },
    atimeReports: { cali: [{ relPath: 'movies/Atime/a.mkv', sizeBytes: 10 * GB, atime: daysAgo(1) }] },
    now: NOW, config: { coreTopK: 0 },
  }).manifests.cali;
  assert.strictEqual(dropIds(m), 'tmdb:none', 'title with neither Plex nor atime is the eviction candidate');
  assert.ok(m.keep.some(e => e.mediaId === 'tmdb:atime'), 'missing-Plex-record title kept via its atime fallback');
}
{
  // Unreachable local Plex ⇒ empty history ⇒ the whole node falls back to atime, no failure.
  const inv = [title('tmdb:1', 10, 'movies/M1'), title('tmdb:2', 10, 'movies/M2')];
  const cali = { name: 'cali', enabled: 1, usable_bytes: 10 * GB, headroom_pct: 0, access: 'open', demand_source: 'plex' };
  const m = planTier({
    nodes: [homeFull, cali], inventory: inv,
    historiesByNode: { cali: [] }, // PMS unreachable → gatherNodeHistories returned []
    atimeReports: { cali: [
      { relPath: 'movies/M1/x.mkv', sizeBytes: 10 * GB, atime: daysAgo(3) },
      { relPath: 'movies/M2/x.mkv', sizeBytes: 10 * GB, atime: daysAgo(80) },
    ] },
    now: NOW, config: { coreTopK: 0 },
  }).manifests.cali;
  assert.strictEqual(keepIds(m), 'tmdb:1', 'unreachable Plex → node ranks purely by atime LRU');
  assert.strictEqual(dropIds(m), 'tmdb:2', 'coldest atime dropped, plan still produced');
}

// --- planner health warnings (silent degradations must be surfaced) ---
{
  // Keep-set forced over budget: keep-list floor bigger than the node ⇒ warn, don't fail.
  const inv = [title('tmdb:1', 10, 'movies/M1'), title('tmdb:2', 10, 'movies/M2')];
  const cali = { name: 'cali', enabled: 1, usable_bytes: 15 * GB, headroom_pct: 0, access: 'open', demand_source: 'tautulli' };
  const { manifests, warnings } = planTier({
    nodes: [homeFull, cali], inventory: inv, keepListIds: ['tmdb:1', 'tmdb:2'],
    historiesByNode: { cali: [] }, now: NOW, config: { coreTopK: 0 },
  });
  assert.strictEqual(keepIds(manifests.cali), 'tmdb:1,tmdb:2', 'floor is kept even over budget');
  assert.ok(warnings.some(w => w.includes('"cali"') && w.includes('exceeds its budget')), 'over-budget keep-set warned');
  assert.ok(!warnings.some(w => w.includes('"home"') && w.includes('exceeds')), 'full master never warns over-budget');
}
{
  // Dead demand signal (atime node, no report) ⇒ warn; a node WITH signal must not warn.
  const inv = [title('tmdb:1', 10, 'movies/M1'), title('tmdb:2', 10, 'movies/M2')];
  const cali = { name: 'cali', enabled: 1, usable_bytes: 10 * GB, headroom_pct: 0, access: 'open', demand_source: 'atime' };
  const dead = planTier({ nodes: [homeFull, cali], inventory: inv, now: NOW, config: { coreTopK: 0 } });
  assert.ok(dead.warnings.some(w => w.includes('"cali"') && w.includes('no demand signal')), 'missing atime report warned');
  const alive = planTier({
    nodes: [homeFull, cali], inventory: inv,
    atimeReports: { cali: [{ relPath: 'movies/M1/x.mkv', sizeBytes: 10 * GB, atime: daysAgo(2) }] },
    now: NOW, config: { coreTopK: 0 },
  });
  assert.ok(!alive.warnings.some(w => w.includes('no demand signal')), 'live signal → no warning');
}

// --- fetchTierInventory: a date-less Radarr/Sonarr item loads addedAt=null, not "now" ---
async function testInventoryAddedAt() {
  const axios = require('axios');
  const realGet = axios.get;
  axios.get = async (url) => {
    if (url.includes('/movie')) return { data: [
      { tmdbId: 1, title: 'Dated', sizeOnDisk: 10 * GB, path: '/mnt/raid/movies/Dated', movieFile: { dateAdded: '2020-01-02T00:00:00Z' } },
      { tmdbId: 2, title: 'Undated', sizeOnDisk: 10 * GB, path: '/mnt/raid/movies/Undated' }, // no dateAdded/added
    ] };
    return { data: [
      { tvdbId: 3, title: 'DatedSeries', statistics: { sizeOnDisk: 10 * GB }, path: '/mnt/raid/tv/DatedSeries', added: '2019-05-05T00:00:00Z' },
      { tvdbId: 4, title: 'UndatedSeries', statistics: { sizeOnDisk: 10 * GB }, path: '/mnt/raid/tv/UndatedSeries', added: 'not-a-date' },
    ] };
  };
  try {
    const { fetchTierInventory } = require('../../src/tier');
    const { items, failedSources } = await fetchTierInventory({
      sources: [{ kind: 'movie', url: 'http://radarr', key: 'x', label: 'radarr' }, { kind: 'tv', url: 'http://sonarr', key: 'y', label: 'sonarr' }],
      remap: p => p, sourceRoot: '/mnt/raid',
    });
    assert.deepStrictEqual(failedSources, [], 'a healthy run reports no failed sources');
    const byId = Object.fromEntries(items.map(i => [i.mediaId, i]));
    assert.strictEqual(byId['tmdb:1'].addedAt, Date.parse('2020-01-02T00:00:00Z'), 'valid dateAdded parsed');
    assert.strictEqual(byId['tmdb:2'].addedAt, null, 'movie with no added date → null, not now');
    assert.strictEqual(byId['tvdb:3'].addedAt, Date.parse('2019-05-05T00:00:00Z'), 'valid series added parsed');
    assert.strictEqual(byId['tvdb:4'].addedAt, null, 'series with an invalid added date → null, not now');
  } finally {
    axios.get = realGet;
  }
}

// --- §1.4 anti-churn: a marginal candidate can't displace kept titles ---
{
  // Two cold-but-nonzero kept titles (0.20 each), budget full. A candidate barely hotter than one
  // of them (0.22) must NOT displace: it fails the 20% relative margin (0.22 < 0.20*1.2 = 0.24).
  const inv = [title('K1', 10, 'm/K1'), title('N', 10, 'm/N')];
  const marginal = planNode({
    node: node({ usable_bytes: 10 * GB }), inventory: inv,
    values: val([['K1', 0.20, daysAgo(60)], ['N', 0.22, daysAgo(55)]]),
    floorIds: new Set(), prevKeepIds: ['K1'], now: NOW,
  });
  assert.strictEqual(keepIds(marginal), 'K1', 'marginal candidate does not churn the cache');
  assert.strictEqual(marginal.evict.length, 0, 'no eviction for a sub-threshold improvement');
  // A decisively hotter candidate (0.9) clears both the absolute and relative bars → it displaces.
  const decisive = planNode({
    node: node({ usable_bytes: 10 * GB }), inventory: inv,
    values: val([['K1', 0.20, daysAgo(60)], ['N', 0.90, daysAgo(1)]]),
    floorIds: new Set(), prevKeepIds: ['K1'], now: NOW,
  });
  assert.strictEqual(keepIds(decisive), 'N', 'a decisively hotter candidate still gets in');
}

// --- §1.4 anti-churn: don't shred several titles for one that only beats them in aggregate ---
{
  // Three cold kept titles (0.10 each, 5 GB) fill a 15 GB budget. A 15 GB candidate at 0.25 would,
  // under the old gate, evict all three (each 0.10 < 0.25). But 0.25 < the SUM evicted (0.30), so
  // it's a net loss — the absolute-margin rule rejects it.
  const inv = [title('a', 5, 'm/a'), title('b', 5, 'm/b'), title('c', 5, 'm/c'), title('BIG', 15, 'm/BIG')];
  const m = planNode({
    node: node({ usable_bytes: 15 * GB }), inventory: inv,
    values: val([['a', 0.10, daysAgo(60)], ['b', 0.10, daysAgo(60)], ['c', 0.10, daysAgo(60)], ['BIG', 0.25, daysAgo(50)]]),
    floorIds: new Set(), prevKeepIds: ['a', 'b', 'c'], now: NOW,
  });
  assert.strictEqual(keepIds(m), 'a,b,c', 'aggregate-only winner does not evict the group it loses to in sum');
}

// --- §1.4 anti-churn: fall back to a lower-churn victim set instead of rejecting outright ---
{
  // Reviewer case: five 1 GB kept titles at 0.03 plus one 5 GB kept title at 0.10 fill a 10 GB
  // budget. A 5 GB candidate at 0.18 needs 5 GB freed. Coldest-first bundles the five 0.03 titles
  // (loses 0.15 → rejected), but evicting the single 5 GB / 0.10 title loses only 0.10 and clears
  // the gate — a smaller-churn, higher-net-win swap. The planner must take it, not reject.
  const inv = [
    title('s1', 1, 'm/s1'), title('s2', 1, 'm/s2'), title('s3', 1, 'm/s3'),
    title('s4', 1, 'm/s4'), title('s5', 1, 'm/s5'), title('M', 5, 'm/M'), title('C', 5, 'm/C'),
  ];
  const m = planNode({
    node: node({ usable_bytes: 10 * GB }), inventory: inv,
    values: val([
      ['s1', 0.03, daysAgo(60)], ['s2', 0.03, daysAgo(60)], ['s3', 0.03, daysAgo(60)],
      ['s4', 0.03, daysAgo(60)], ['s5', 0.03, daysAgo(60)], ['M', 0.10, daysAgo(60)], ['C', 0.18, daysAgo(50)],
    ]),
    floorIds: new Set(), prevKeepIds: ['s1', 's2', 's3', 's4', 's5', 'M'], now: NOW,
  });
  assert.strictEqual(keepIds(m), 'C,s1,s2,s3,s4,s5', 'the one-title swap is taken, the five small colds survive');
  assert.deepStrictEqual(m.evict, ['M'], 'exactly the single larger colder victim churned');
}

// --- §1.4 anti-churn: the size-scaled transfer penalty blocks a huge marginal download ---
{
  // Candidate at 0.10 vs a zero-value victim: the absolute rule alone would pass (0.10 ≥ 0.05),
  // but a 2 TB transfer penalty (0.05/TB × 2 = 0.10) drags the net gain to 0.00, below 0.05.
  const TB = 1024 ** 4;
  const inv = [title('COLD', 2048, 'm/COLD'), { mediaId: 'HUGE', title: 'HUGE', mediaType: 'movie', sizeBytes: 2 * TB, relPath: 'm/HUGE' }];
  const m = planNode({
    node: node({ usable_bytes: 2048 * GB }), inventory: inv,
    values: val([['COLD', 0, daysAgo(200)], ['HUGE', 0.10, daysAgo(50)]]),
    floorIds: new Set(), prevKeepIds: ['COLD'], now: NOW,
  });
  assert.strictEqual(keepIds(m), 'COLD', 'a huge marginal-value download is not worth the transfer');
}

// --- §1.5 physicalTitleIds: presence from the agent file report (folder dir-walk) ---
{
  const inv = [title('tmdb:1', 10, 'movies/M1'), title('tmdb:2', 10, 'movies/M2'), title('tmdb:3', 10, 'movies/M3')]
    .map(t => ({ ...t, folderId: '' }));
  const files = [
    { folderId: '', relPath: 'movies/M1/m1.mkv', sizeBytes: 10 * GB },
    { folderId: '', relPath: 'movies/M2/Season 1/e1.mkv', sizeBytes: 5 * GB },
  ];
  const present = physicalTitleIds({ inventory: inv, files });
  assert.ok(present.has('tmdb:1') && present.has('tmdb:2'), 'reported files mark their title present');
  assert.ok(!present.has('tmdb:3'), 'a title with no reported file is absent');
}

// --- §1.5 assessApplyImpact: real removals, new downloads, and cap flags ---
{
  const mk = (mediaId, sizeGb, rel) => ({ mediaId, title: mediaId, sizeBytes: sizeGb * GB, folderId: '', relPath: rel });
  const manifest = {
    keep: [mk('present:keep', 10, 'm/PK'), mk('new:download', 40, 'm/ND')],
    drop: [mk('present:drop', 30, 'm/PD'), mk('absent:drop', 50, 'm/AD')],
  };
  const files = [
    { folderId: '', relPath: 'm/PK/a.mkv', sizeBytes: 10 * GB },
    { folderId: '', relPath: 'm/PD/b.mkv', sizeBytes: 30 * GB },
  ];
  const imp = assessApplyImpact({ manifest, files, caps: { maxRealRemovalBytes: 20 * GB, maxRemovedTitles: 5, maxNewDownloadBytes: 100 * GB } });
  assert.strictEqual(imp.realRemovalBytes, 30 * GB, 'only the physically-present drop counts as a real removal');
  assert.strictEqual(imp.removedTitles, 1, 'exactly one local title is actually deleted');
  assert.strictEqual(imp.newDownloadBytes, 40 * GB, 'only the not-present keep is a new download');
  assert.strictEqual(imp.newDownloadTitles, 1, 'one title to fetch');
  assert.strictEqual(imp.hasReport, true, 'a non-empty file report is recorded as such');
  assert.ok(imp.exceeds.realRemovalBytes && imp.requiresConfirm, '30 GB removal over the 20 GB cap requires confirm');
  assert.ok(!imp.exceeds.newDownloadBytes, '40 GB download under the 100 GB cap does not');

  // No agent report ⇒ nothing known present ⇒ every keep is a download, no removals.
  const cold = assessApplyImpact({ manifest, files: [], caps: {} });
  assert.strictEqual(cold.newDownloadBytes, 50 * GB, 'no report → both keeps counted as downloads');
  assert.strictEqual(cold.realRemovalBytes, 0, 'no report → nothing counted as a real deletion');
  assert.strictEqual(cold.hasReport, false, 'empty report flagged');
  assert.strictEqual(cold.requiresConfirm, false, 'no caps supplied → never requires confirm');
}

// --- §1.5 tierApplyConfirmCode: deterministic per (node, planHash), moves when the plan moves ---
{
  const a = tierApplyConfirmCode('california', 'abcd1234abcd1234');
  assert.strictEqual(a, tierApplyConfirmCode('California', 'abcd1234abcd1234'), 'code is case-insensitive on node name');
  assert.notStrictEqual(a, tierApplyConfirmCode('california', 'ffff0000ffff0000'), 'a different plan hash yields a different code');
  assert.ok(/^[0-9A-F]{4}$/.test(a), 'code is a 4-char uppercase hex string');
}

// --- §1.6 mediaIdFromGuid: modern + legacy Plex guid forms, type-gated ---
{
  assert.strictEqual(mediaIdFromGuid('tmdb://603', 'tmdb'), 'tmdb:603', 'modern tmdb guid');
  assert.strictEqual(mediaIdFromGuid('tvdb://75978', 'tvdb'), 'tvdb:75978', 'modern tvdb guid');
  assert.strictEqual(mediaIdFromGuid('com.plexapp.agents.themoviedb://603?lang=en', 'tmdb'), 'tmdb:603', 'legacy themoviedb agent guid');
  assert.strictEqual(mediaIdFromGuid('com.plexapp.agents.thetvdb://75978/1/2?lang=en', 'tvdb'), 'tvdb:75978', 'legacy thetvdb agent guid');
  assert.strictEqual(mediaIdFromGuid('tvdb://75978', 'tmdb'), null, 'wrong source rejected (no cross-crediting)');
  assert.strictEqual(mediaIdFromGuid('imdb://tt0133093', 'tmdb'), null, 'unrelated source → null');
  assert.strictEqual(mediaIdFromGuid('', 'tmdb'), null, 'empty guid → null');
}

// --- §1.6 indexHistory: id-keyed and title-keyed lookups, conservative roll-up ---
{
  const hist = [
    { mediaId: 'tmdb:603', title: 'The Matrix', mediaType: 'movie', plays: 2, lastPlayed: daysAgo(3), distinctUsers: 1 },
    { mediaId: 'tmdb:603', title: 'The Matrix (1999)', mediaType: 'movie', plays: 1, lastPlayed: daysAgo(1), distinctUsers: 2 },
    { mediaId: null, title: 'No Guid Movie', mediaType: 'movie', plays: 5, lastPlayed: daysAgo(2), distinctUsers: 3 },
  ];
  const idx = indexHistory(hist);
  const byId = idx.byId.get('tmdb:603');
  assert.strictEqual(byId.plays, 3, 'same-id rows merge plays');
  assert.strictEqual(byId.distinctUsers, 2, 'distinctUsers takes the max on merge');
  assert.strictEqual(byId.lastPlayed, daysAgo(1), 'lastPlayed takes the newest');
  assert.ok(!idx.byId.has(null) && idx.byId.size === 1, 'null-id rows never enter byId');
  assert.ok(idx.byTitle.get(titleKey('No Guid Movie', 'movie')), 'unresolved row indexed by title');
  assert.ok(!idx.byTitle.has(titleKey('The Matrix', 'movie')), 'GUID-resolved rows stay out of byTitle (no namesake leak)');
}

// --- §1.6 computeNodeValues joins by GUID first, title only as fallback ---
{
  // A remake collision: inventory has two different movies whose normalized titles match, but they
  // have distinct tmdb ids. History carries the id, so demand is credited to the RIGHT one.
  const inv = [
    title('tmdb:1', 5, 'm/matrix-1999', { title: 'The Matrix', mediaType: 'movie' }),
    title('tmdb:2', 5, 'm/matrix-remake', { title: 'The Matrix', mediaType: 'movie' }),
  ];
  const history = [{ mediaId: 'tmdb:2', title: 'The Matrix', mediaType: 'movie', plays: 4, lastPlayed: daysAgo(1), distinctUsers: 2 }];
  const values = computeNodeValues({ node: node({ demand_source: 'plex' }), inventory: inv, history, files: [], now: NOW, cfg: { halfLifeDays: 30 } });
  assert.ok(values.has('tmdb:2') && !values.has('tmdb:1'), 'GUID join credits demand to the exact remake, not its namesake');

  // No GUID on the row → falls back to title match, and the diag records it.
  const diag = {};
  const histNoId = [{ mediaId: null, title: 'The Matrix', mediaType: 'movie', plays: 4, lastPlayed: daysAgo(1), distinctUsers: 2 }];
  const v2 = computeNodeValues({ node: node({ demand_source: 'plex' }), inventory: inv, history: histNoId, files: [], now: NOW, cfg: { halfLifeDays: 30 }, diag });
  assert.ok(v2.has('tmdb:1') && v2.has('tmdb:2'), 'title-only fallback matches both namesakes (the collision the warning is about)');
  assert.strictEqual(diag.titleOnlyMatches, 2, 'diag counts title-only fallbacks');
  assert.ok(!diag.idMatches, 'no id matches when the row has no GUID');
}

// --- §1.3 physicalTitleBytes + computeTierActionPreview ---
{
  const manifest = {
    keep: [
      { mediaId: 'tmdb:1', title: 'Present Full', folderId: '', relPath: 'Movies/full', sizeBytes: 10 * GB },
      { mediaId: 'tmdb:2', title: 'Half Downloaded', folderId: '', relPath: 'Movies/half', sizeBytes: 10 * GB },
      { mediaId: 'tmdb:3', title: 'Not Yet', folderId: '', relPath: 'Movies/missing', sizeBytes: 4 * GB },
    ],
    drop: [
      { mediaId: 'tmdb:4', title: 'On Disk To Remove', folderId: '', relPath: 'Movies/remove', sizeBytes: 7 * GB },
      { mediaId: 'tmdb:5', title: 'Already Gone', folderId: '', relPath: 'Movies/gone', sizeBytes: 3 * GB },
    ],
  };
  const files = [
    { folderId: '', relPath: 'Movies/full/movie.mkv', sizeBytes: 10 * GB },
    { folderId: '', relPath: 'Movies/half/movie.mkv', sizeBytes: 4 * GB },   // < 10GB expected → still syncing
    { folderId: '', relPath: 'Movies/remove/movie.mkv', sizeBytes: 7 * GB },
  ];
  const bytes = physicalTitleBytes({ inventory: [...manifest.keep, ...manifest.drop], files });
  assert.strictEqual(bytes.get('tmdb:1'), 10 * GB, 'present-full bytes summed to the owning title');
  assert.ok(!bytes.has('tmdb:3'), 'a title with no files on disk is absent from the byte map');

  const p = computeTierActionPreview({ manifest, files });
  assert.deepStrictEqual(p.downloadLocally.map(e => e.mediaId), ['tmdb:3'], 'keep ∧ absent → download');
  assert.deepStrictEqual(p.keptSynced.map(e => e.mediaId), ['tmdb:1'], 'keep ∧ complete → synced');
  assert.deepStrictEqual(p.keptDownloading.map(e => e.mediaId), ['tmdb:2'], 'keep ∧ partial → still downloading');
  assert.deepStrictEqual(p.removeLocal.map(e => e.mediaId), ['tmdb:4'], 'drop ∧ present → remove');
  assert.deepStrictEqual(p.alreadyAbsent.map(e => e.mediaId), ['tmdb:5'], 'drop ∧ absent → already gone');
  assert.strictEqual(p.totals.downloadLocally.bytes, 4 * GB, 'download bytes total');
  assert.strictEqual(p.totals.removeLocal.bytes, 7 * GB, 'remove bytes total');
  assert.strictEqual(p.hasReport, true, 'report present flagged');

  const empty = computeTierActionPreview({ manifest, files: [] });
  assert.strictEqual(empty.downloadLocally.length, 3, 'no report → every keep is a download');
  assert.strictEqual(empty.removeLocal.length, 0, 'no report → nothing counted as a local removal');
  assert.strictEqual(empty.alreadyAbsent.length, 2, 'no report → every drop is already absent');
  assert.strictEqual(empty.hasReport, false, 'empty report flagged');
}

// --- A failing media source must be reported, because a partial inventory blanks the .stignore ---
// This is the failure the apply block exists for: an arr that doesn't answer contributes no titles,
// those titles land in neither keep nor drop, and the folder's .stignore renders EMPTY — so the node
// re-downloads everything the previous plan was holding back. The apply-impact caps can't catch it
// (the titles aren't in the keep set either), so fetchTierInventory has to name the failure and the
// caller has to refuse. Both halves are asserted here.
async function testPartialInventoryIsReportedAndDangerous() {
  const axios = require('axios');
  const realGet = axios.get;
  axios.get = async (url) => {
    if (url.includes('/movie')) throw new Error('connect ECONNREFUSED radarr:7878');
    return { data: [{ tvdbId: 3, title: 'A Series', statistics: { sizeOnDisk: 10 * GB }, path: '/mnt/raid/tv/A Series', added: '2019-05-05T00:00:00Z' }] };
  };
  try {
    const { fetchTierInventory } = require('../../src/tier');
    const { items, failedSources } = await fetchTierInventory({
      sources: [{ kind: 'movie', url: 'http://radarr', key: 'x', label: 'radarr' }, { kind: 'tv', url: 'http://sonarr', key: 'y', label: 'sonarr' }],
      remap: p => p, sourceRoot: '/mnt/raid',
    });
    assert.strictEqual(items.length, 1, 'only the source that answered contributed titles');
    assert.strictEqual(failedSources.length, 1, 'the failed source is reported, not swallowed');
    assert.strictEqual(failedSources[0].label, 'radarr', 'the failed source is named');
    assert.match(failedSources[0].error, /ECONNREFUSED/, 'the failure reason is carried through');
  } finally {
    axios.get = realGet;
  }

  // The consequence, so the reason for the block is pinned down and not just asserted in prose:
  // the same node planned with and without the movie source. Every ignore line disappears.
  const { planTier, renderFolderStignore } = require('../../src/tier');
  const master = { name: 'master', enabled: 1, full: 1, usable_bytes: 100 * GB * 1024, folders: [{ folderId: 'm', folderRoot: '/src' }] };
  const node = {
    name: 'edge', enabled: 1, usable_bytes: 300 * GB, headroom_pct: 15, demand_source: 'atime',
    folders: [{ folderId: 'mov-1', folderRoot: '/mnt/media/Movies' }, { folderId: 'tv-1', folderRoot: '/mnt/media/TV' }],
  };
  const title = (id, type, folderId, relPath, sizeGb) => ({
    mediaId: id, title: id, mediaType: type, sizeBytes: sizeGb * GB, addedAt: null,
    path: `/src/${relPath}`, relPath, folderId,
  });
  const complete = [
    ...Array.from({ length: 10 }, (_, i) => title(`tmdb:${i}`, 'movie', 'mov-1', `Movies/M${i}/M${i}.mkv`, 50)),
    ...Array.from({ length: 2 }, (_, i) => title(`tvdb:${i}`, 'tv', 'tv-1', `TV/S${i}`, 20)),
  ];
  const ignoreLines = inventory => {
    const m = planTier({ nodes: [master, node], inventory, atimeReports: { edge: [] } }).manifests.edge;
    const folder = m.folders.find(f => f.folder_id === 'mov-1');
    return renderFolderStignore(folder, m).trim().split('\n').filter(l => l && !l.startsWith('//')).length;
  };
  const healthy = ignoreLines(complete);
  assert.ok(healthy > 0, `a complete inventory produces ignore patterns (got ${healthy})`);
  assert.strictEqual(ignoreLines(complete.filter(t => t.mediaType === 'tv')), 0,
    'a partial inventory blanks the Movies .stignore entirely — which is why apply must refuse to publish it');
}

testInventoryAddedAt()
  .then(testPartialInventoryIsReportedAndDangerous)
  .then(() => {
    console.log('tier.test.js: all assertions passed');
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
