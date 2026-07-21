#!/usr/bin/env node
// §1.1 Plan lifecycle normalization (published vs converged). normalizeTierPlan is pulled out of
// src/db.js and run in a vm sandbox so we exercise the shipped code without opening SQLite.
const assert = require('assert');
const { loadSandbox } = require('./extract');

const sb = loadSandbox(['normalizeTierPlan'], {});
// Round-trip through JSON so the returned value carries this realm's prototypes (a vm-realm array
// would fail deepStrictEqual's prototype check).
const norm = raw => JSON.parse(JSON.stringify(sb.run(`normalizeTierPlan(${JSON.stringify(raw)}) ?? null`)));

// null / junk
assert.strictEqual(norm(null), null, 'null → null');
assert.strictEqual(norm({}), null, 'empty object with no shape → null');

// Legacy shape ({planHash, keepMediaIds, appliedAt}) migrates to BOTH published and converged:
// an old immediate-apply plan was assumed-converged, so hysteresis survives the upgrade.
const legacy = norm({ planHash: 'abc123', keepMediaIds: ['tmdb:1', 'tmdb:2'], appliedAt: 1000 });
assert.strictEqual(legacy.published.planHash, 'abc123', 'legacy → published hash');
assert.strictEqual(legacy.published.publishedAt, 1000, 'legacy appliedAt → publishedAt');
assert.strictEqual(legacy.converged.planHash, 'abc123', 'legacy → converged hash (assumed-converged)');
assert.strictEqual(legacy.converged.convergedAt, 1000, 'legacy appliedAt → convergedAt');
assert.deepStrictEqual(legacy.converged.keepMediaIds, ['tmdb:1', 'tmdb:2'], 'legacy keep set carried into converged');

// New shape passes through, with missing report metadata defaulted.
const rec = norm({ published: { planHash: 'p1', keepMediaIds: ['a'], publishedAt: 5 }, converged: null });
assert.strictEqual(rec.published.planHash, 'p1', 'published preserved');
assert.strictEqual(rec.converged, null, 'unconverged stays null (never assume disk state)');
assert.deepStrictEqual(rec.lastErrors, [], 'lastErrors defaults to []');
assert.strictEqual(rec.lastAgentReportAt, null, 'lastAgentReportAt defaults to null');

console.log('tier-planstate.test.js: all assertions passed');
