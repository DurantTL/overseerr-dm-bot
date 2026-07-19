#!/usr/bin/env node
// Regional tiering planner: budget fill, incremental watermark LRU (evict only to admit),
// warm/fresh protection, the admission gate, access modes (open vs restricted), the atime
// demand source, master-coverage safety, manifest rendering, and plan-hash stability.
// src/tier.js is Discord- and DB-free, so it's imported directly.
const assert = require('assert');
const {
  recencyDecay, titleKey, computeUniversalCore, computeNodeValues, planNode, planTier,
  computePlanHash, renderSyncthingStignore, renderRclone, toRelPath,
  parseAtimeMask, inAtimeMask, maskSuspectAtimes,
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

console.log('tier.test.js: all assertions passed');
