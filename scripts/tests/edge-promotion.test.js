#!/usr/bin/env node
// California play-triggered promotion (#182): generalized identity→tier-node routing, the
// present+completion locality decision, the promotion action gate (audit-only, cooldown, viewer
// pin cap, master-coverage), durable pin computation, and the pin-aware legacy-ignore overlay
// merge. src/edge-promotion.js is DB/Discord/network-free, so it's imported directly.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  resolveEdgeTierNode, parseEdgeTierNodeMap, buildEdgeTierNodeMap, decideCaLocality,
  promotionFitsBudget, tvPromotionSizeCapped, GB_BYTES,
  planCaPlayPromotion, computePlayPin, activePlayPins, computeFinalIgnoreLines,
} = require('../../src/edge-promotion');

test('edge-promotion: parseEdgeTierNodeMap parses and validates identity:node pairs', () => {
  const { entries, errors } = parseEdgeTierNodeMap('california-plex:california, ca-4k:california, bad-entry, :missing-identity, spaced : node');
  assert.deepStrictEqual(entries, [
    { identity: 'california-plex', node: 'california' },
    { identity: 'ca-4k', node: 'california' },
    { identity: 'spaced', node: 'node' },
  ]);
  assert.strictEqual(errors.length, 2, 'bad-entry (no colon) and the empty-identity entry are both rejected');
  assert.deepStrictEqual(parseEdgeTierNodeMap(''), { entries: [], errors: [] });
});

test('edge-promotion: buildEdgeTierNodeMap merges explicit map with legacy CA_EDGE_SERVER_NAMES, explicit wins', () => {
  const { map, errors } = buildEdgeTierNodeMap('special-ca:socal', ['california-plex', 'special-ca'], 'california');
  assert.deepStrictEqual(map.find(e => e.identity === 'special-ca'), { identity: 'special-ca', node: 'socal' }, 'explicit EDGE_TIER_NODE_MAP entry wins over the legacy synthesis');
  assert.deepStrictEqual(map.find(e => e.identity === 'california-plex'), { identity: 'california-plex', node: 'california' }, 'legacy CA_EDGE_SERVER_NAMES identity still maps to the default node');
  assert.ok(errors.some(e => e.includes('special-ca')), 'the duplicate identity is reported, not silently dropped');

  // No explicit map at all → pure back-compat: every legacy identity maps to california.
  const legacyOnly = buildEdgeTierNodeMap(undefined, ['california-plex', 'california-4k'], 'california');
  assert.deepStrictEqual(legacyOnly.map, [
    { identity: 'california-plex', node: 'california' },
    { identity: 'california-4k', node: 'california' },
  ]);
  assert.deepStrictEqual(legacyOnly.errors, []);
});

test('edge-promotion: resolveEdgeTierNode fails closed', () => {
  const map = [{ identity: 'california-plex', node: 'california' }, { identity: 'nyc-plex', node: 'nyc' }];
  assert.strictEqual(resolveEdgeTierNode({ serverName: 'California-Plex' }, map), 'california', 'matches case-insensitively on serverName');
  assert.strictEqual(resolveEdgeTierNode({ machineId: 'nyc-plex' }, map), 'nyc', 'matches on machineId too');
  assert.strictEqual(resolveEdgeTierNode({ serverName: 'unknown-box' }, map), null, 'no match → null, never a guess');
  assert.strictEqual(resolveEdgeTierNode({}, map), null, 'no identity at all → null');
  assert.strictEqual(resolveEdgeTierNode({ serverName: 'california-plex' }, []), null, 'empty map → null even for a name that would otherwise match');
});

test('edge-promotion: decideCaLocality requires presence AND completion, never keep-set alone', () => {
  assert.strictEqual(decideCaLocality({ presentBytes: 0, expectedBytes: 0 }).reason, 'unknown_size');
  assert.strictEqual(decideCaLocality({ presentBytes: 0, expectedBytes: 1000 }).reason, 'absent');
  assert.strictEqual(decideCaLocality({ presentBytes: 500, expectedBytes: 1000, completionPct: 60 }).reason, 'syncthing_incomplete', 'reported Syncthing completion below 100% blocks local even if bytes look close');
  assert.strictEqual(decideCaLocality({ presentBytes: 500, expectedBytes: 1000 }).local, false, 'byte-fraction fallback: half-present is not local');
  const synced = decideCaLocality({ presentBytes: 990, expectedBytes: 1000, completionPct: 100 });
  assert.deepStrictEqual(synced, { local: true, reason: 'synced' });
  assert.strictEqual(decideCaLocality({ presentBytes: 970, expectedBytes: 1000, completeFrac: 0.98 }).local, false, 'just under the completeFrac threshold is still not local');
});

test('edge-promotion: planCaPlayPromotion — order of skips, and the two audit-only-by-default gates', () => {
  const base = { enabled: true, hasFullCopy: true, alreadyLocal: false, auditOnly: false };
  assert.strictEqual(planCaPlayPromotion({ ...base, enabled: false }).reason, 'disabled');
  assert.strictEqual(planCaPlayPromotion({ ...base, hasFullCopy: false }).reason, 'no_full_copy', 'never promote a title the master cannot serve');
  assert.strictEqual(planCaPlayPromotion({ ...base, alreadyLocal: true }).reason, 'already_local', 'a fully-local title never re-promotes');
  assert.strictEqual(planCaPlayPromotion({ ...base, lastPromoteAt: 1000, now: 1000 + 3600000, cooldownMs: 12 * 3600000 }).reason, 'cooldown');
  assert.strictEqual(planCaPlayPromotion({ ...base, rateLimitOk: false }).reason, 'rate_limited');
  assert.strictEqual(planCaPlayPromotion({ ...base, viewerActivePins: 3, maxPinsPerViewer: 3 }).reason, 'viewer_pin_cap', 'bounded per-viewer cap — at most N simultaneous active pins');
  assert.deepStrictEqual(planCaPlayPromotion({ ...base, auditOnly: true }), { action: 'audit', reason: 'audit_only' });
  assert.deepStrictEqual(planCaPlayPromotion(base), { action: 'pin', reason: 'promote' });
});

test('edge-promotion: computePlayPin / activePlayPins — expiry restores default policy on its own', () => {
  const pin = computePlayPin({ mediaId: 'tmdb:1', viewerId: 'user-1', now: 1000, pinDays: 21 });
  assert.deepStrictEqual(pin, { mediaId: 'tmdb:1', viewerId: 'user-1', createdAt: 1000, expiresAt: 1000 + 21 * 86400000 });
  const pins = [
    { mediaId: 'tmdb:1', expiresAt: 5000 },
    { mediaId: 'tmdb:2', expiresAt: 500 }, // already expired at now=1000
  ];
  assert.deepStrictEqual(activePlayPins(pins, 1000).map(p => p.mediaId), ['tmdb:1']);
  assert.deepStrictEqual(activePlayPins(pins, 6000), [], 'both pins expired eventually');
});

test('edge-promotion: computeFinalIgnoreLines — planner∪legacy−pins, active pins override legacy ignores', () => {
  const plannerLines = ['/Movies/Cold Title'];
  const legacyLines = ['/Movies/Boku', '/Movies/Lizzie'];
  // No pins: legacy overlay stays fully in force, unioned with the planner's own drops.
  assert.deepStrictEqual(
    computeFinalIgnoreLines({ plannerLines, legacyLines, pinnedLines: [] }),
    ['/Movies/Boku', '/Movies/Cold Title', '/Movies/Lizzie'],
  );
  // Active pin on a LEGACY-ignored title removes it from the final ignore set even though the
  // planner never dropped it in the first place (it was never in plannerLines to begin with).
  assert.deepStrictEqual(
    computeFinalIgnoreLines({ plannerLines, legacyLines, pinnedLines: ['/Movies/Boku'] }),
    ['/Movies/Cold Title', '/Movies/Lizzie'],
  );
  // A pin can also override a planner drop directly.
  assert.deepStrictEqual(
    computeFinalIgnoreLines({ plannerLines, legacyLines: [], pinnedLines: ['/Movies/Cold Title'] }),
    [],
  );
  // Pin expiry (caller stops passing the mediaId's relPath in pinnedLines) restores the legacy rule.
  assert.deepStrictEqual(
    computeFinalIgnoreLines({ plannerLines, legacyLines, pinnedLines: [] }),
    ['/Movies/Boku', '/Movies/Cold Title', '/Movies/Lizzie'],
    'once a pin is no longer active, the legacy ignore reappears with no separate restore step',
  );
});

test('edge-promotion: promotionFitsBudget — opt-in node byte budget, fail-closed on unknown size', () => {
  // No budget configured (0/missing/negative) → passes open; the planner's eviction math stays
  // the real capacity guard.
  assert.deepStrictEqual(promotionFitsBudget({ nodeBudgetBytes: 0, pinBytes: 10 * GB_BYTES }), { fits: true, reason: 'budget_not_configured' });
  assert.deepStrictEqual(promotionFitsBudget({ pinBytes: 10 * GB_BYTES }), { fits: true, reason: 'budget_not_configured' });
  assert.deepStrictEqual(promotionFitsBudget({ nodeBudgetBytes: -5, pinBytes: 10 * GB_BYTES }), { fits: true, reason: 'budget_not_configured' });
  // A pin that fits, and one that doesn't.
  assert.deepStrictEqual(promotionFitsBudget({ nodeBudgetBytes: 100 * GB_BYTES, pinBytes: 40 * GB_BYTES }), { fits: true, reason: 'fits_budget' });
  assert.deepStrictEqual(promotionFitsBudget({ nodeBudgetBytes: 100 * GB_BYTES, pinBytes: 100 * GB_BYTES }), { fits: true, reason: 'fits_budget' }, 'exactly the budget still fits');
  assert.deepStrictEqual(promotionFitsBudget({ nodeBudgetBytes: 100 * GB_BYTES, pinBytes: 101 * GB_BYTES }), { fits: false, reason: 'over_budget' });
  // Unknown pin size fails closed — pinning unmeasured bytes is the blast radius this bounds.
  assert.deepStrictEqual(promotionFitsBudget({ nodeBudgetBytes: 100 * GB_BYTES, pinBytes: 0 }), { fits: false, reason: 'pin_size_unknown' });
  assert.deepStrictEqual(promotionFitsBudget({ nodeBudgetBytes: 100 * GB_BYTES }), { fits: false, reason: 'pin_size_unknown' });
});

test('edge-promotion: tvPromotionSizeCapped — interim whole-series cap until #183', () => {
  // Movies are single-unit and never capped.
  assert.deepStrictEqual(tvPromotionSizeCapped({ mediaType: 'movie', sizeBytes: 500 * GB_BYTES, maxSeriesGb: 60 }), { capped: false, reason: 'not_tv' });
  // A disabled cap passes everything open.
  assert.deepStrictEqual(tvPromotionSizeCapped({ mediaType: 'tv', sizeBytes: 500 * GB_BYTES, maxSeriesGb: 0 }), { capped: false, reason: 'cap_disabled' });
  // A modest series passes; a prestige 4K box set does not.
  assert.deepStrictEqual(tvPromotionSizeCapped({ mediaType: 'tv', sizeBytes: 25 * GB_BYTES, maxSeriesGb: 60 }), { capped: false, reason: 'tv_series_under_cap' });
  assert.deepStrictEqual(tvPromotionSizeCapped({ mediaType: 'tv', sizeBytes: 120 * GB_BYTES, maxSeriesGb: 60 }), { capped: true, reason: 'tv_series_over_cap' });
  // Unknown series size fails closed — promoting an unmeasured whole series is skipped.
  assert.deepStrictEqual(tvPromotionSizeCapped({ mediaType: 'tv', sizeBytes: 0, maxSeriesGb: 60 }), { capped: true, reason: 'tv_size_unknown' });
});

test('edge-promotion: planCaPlayPromotion — capacity and TV-cap skip reasons compose with the existing gates', () => {
  const base = { enabled: true, hasFullCopy: true, alreadyLocal: false, auditOnly: false };
  // Defaults are inert: existing callers that never pass the new params behave exactly as before.
  assert.deepStrictEqual(planCaPlayPromotion(base), { action: 'pin', reason: 'promote' });
  assert.deepStrictEqual(planCaPlayPromotion({ ...base, auditOnly: true }), { action: 'audit', reason: 'audit_only' });
  // Over budget → skip, with the caller's reason in the audit trail.
  assert.deepStrictEqual(
    planCaPlayPromotion({ ...base, fitsBudget: false, budgetReason: 'over_budget' }),
    { action: 'skip', reason: 'over_budget' },
  );
  assert.deepStrictEqual(
    planCaPlayPromotion({ ...base, fitsBudget: false }),
    { action: 'skip', reason: 'over_budget' },
    'defaults the reason when the caller passes none',
  );
  // Interim TV cap → skip.
  assert.deepStrictEqual(
    planCaPlayPromotion({ ...base, tvSizeCapped: true, tvCapReason: 'tv_series_over_cap' }),
    { action: 'skip', reason: 'tv_series_over_cap' },
  );
  // Ordering: capacity/TV-cap skips sit with the other title-level preconditions — after
  // already_local (a local title never needs a budget check) and before cooldown/rate/pin-cap.
  assert.strictEqual(planCaPlayPromotion({ ...base, alreadyLocal: true, fitsBudget: false }).reason, 'already_local');
  assert.strictEqual(planCaPlayPromotion({ ...base, fitsBudget: false, tvSizeCapped: true }).reason, 'over_budget');
  assert.strictEqual(planCaPlayPromotion({ ...base, tvSizeCapped: true, rateLimitOk: false }).reason, 'tv_series_over_cap');
});
