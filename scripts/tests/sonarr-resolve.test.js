#!/usr/bin/env node
// Sonarr series identity resolution (src/arr.js resolveSonarrSeriesIdentity) — the resolver
// adoption and TVDB-carrying request grabs use to pin a grab job to a real seriesId instead
// of leaving Sonarr to guess from the release filename. Extracted into a vm sandbox (like
// escalation.test.js) since requiring arr.js directly would open the real SQLite database via
// src/db.js; normalizeTitle is the real implementation from src/grab.js (no db dependency).
const { test } = require('node:test');
const assert = require('node:assert');
const { loadSandbox } = require('./extract');
const { normalizeTitle } = require('../../src/grab');

test('sonarr-resolve: resolveSonarrSeriesIdentity tvdb/exact/alternate/ambiguous outcomes', async () => {
  const series = [
    { id: 1, title: 'Blood Vs Duty', year: 2020, tvdbId: 111, alternateTitles: [] },
    { id: 2, title: 'Full House', year: 1987, tvdbId: 222, alternateTitles: [] },
    { id: 3, title: 'Full House', year: 2004, tvdbId: 333, alternateTitles: [{ title: 'Ppappa' }] },
    { id: 4, title: 'Old Drama', year: 2015, tvdbId: 444, alternateTitles: [] },
  ];
  const sonarrGet = async () => series;
  const sandbox = loadSandbox(['resolveSonarrSeriesIdentity'], { normalizeTitle, sonarrGet });
  const resolve = args => sandbox.run(`resolveSonarrSeriesIdentity(${JSON.stringify(args)})`);

  let r = await resolve({ tvdbId: 111, title: 'anything' });
  assert.strictEqual(r.status, 'tvdb', 'a known tvdbId wins outright, ignoring the title');
  assert.strictEqual(r.series.id, 1);

  r = await resolve({ title: 'Blood Vs Duty' });
  assert.strictEqual(r.status, 'exact', 'a unique normalized-title match is exact');
  assert.strictEqual(r.series.id, 1);

  r = await resolve({ title: 'Ppappa' });
  assert.strictEqual(r.status, 'alternate', 'an alternate-title match is reported distinctly');
  assert.strictEqual(r.series.id, 3);

  r = await resolve({ title: 'Full House' });
  assert.strictEqual(r.status, 'ambiguous', 'two shows sharing an exact title, no year given, is ambiguous');
  assert.strictEqual(r.candidates.length, 2);
  assert.strictEqual(r.series, null, 'an ambiguous result never carries a single resolved series');

  r = await resolve({ title: 'Full House', year: 2004 });
  assert.strictEqual(r.status, 'exact', 'a year narrows an exact-title tie to one');
  assert.strictEqual(r.series.id, 3);

  r = await resolve({ title: 'Nothing Like This At All' });
  assert.strictEqual(r.status, 'none', 'nothing plausible in the library resolves to none');
  assert.strictEqual(r.series, null);

  r = await resolve({ title: 'Old Drama Uncut' });
  assert.strictEqual(r.status, 'ambiguous', 'even a single loose token-overlap hit still requires a click, never auto-selected');
  assert.strictEqual(r.series, null);
  assert.strictEqual(r.candidates[0].id, 4);
});
