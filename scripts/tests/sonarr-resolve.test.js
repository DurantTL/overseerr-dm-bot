#!/usr/bin/env node
// Sonarr series identity resolution (src/arr.js resolveSonarrSeriesIdentity), against a mock
// Sonarr API — the resolver adoption and request-grab both use to pin a grab job to a real
// seriesId instead of leaving Sonarr to guess from the release filename.
const assert = require('assert');
const express = require('express');

(async () => {
  const { CONFIG } = require('../../src/config');

  const series = [
    { id: 1, title: 'Blood Vs Duty', year: 2020, tvdbId: 111, alternateTitles: [] },
    { id: 2, title: 'Full House', year: 1987, tvdbId: 222, alternateTitles: [] },
    { id: 3, title: 'Full House', year: 2004, tvdbId: 333, alternateTitles: [{ title: 'Ppappa' }] },
    { id: 4, title: 'Old Drama', year: 2015, tvdbId: 444, alternateTitles: [] },
  ];
  const app = express();
  app.get('/api/v3/series', (req, res) => res.json(series));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  CONFIG.SONARR_URL = `http://127.0.0.1:${server.address().port}`;
  CONFIG.SONARR_API_KEY = 'x';
  const { resolveSonarrSeriesIdentity } = require('../../src/arr');

  let r = await resolveSonarrSeriesIdentity({ tvdbId: 111, title: 'anything' });
  assert.strictEqual(r.status, 'tvdb', 'a known tvdbId wins outright, ignoring the title');
  assert.strictEqual(r.series.id, 1);

  r = await resolveSonarrSeriesIdentity({ title: 'Blood Vs Duty' });
  assert.strictEqual(r.status, 'exact', 'a unique normalized-title match is exact');
  assert.strictEqual(r.series.id, 1);

  r = await resolveSonarrSeriesIdentity({ title: 'Ppappa' });
  assert.strictEqual(r.status, 'alternate', 'an alternate-title match is reported distinctly');
  assert.strictEqual(r.series.id, 3);

  r = await resolveSonarrSeriesIdentity({ title: 'Full House' });
  assert.strictEqual(r.status, 'ambiguous', 'two shows sharing an exact title, no year given, is ambiguous');
  assert.strictEqual(r.candidates.length, 2);
  assert.strictEqual(r.series, null, 'an ambiguous result never carries a single resolved series');

  r = await resolveSonarrSeriesIdentity({ title: 'Full House', year: 2004 });
  assert.strictEqual(r.status, 'exact', 'a year narrows an exact-title tie to one');
  assert.strictEqual(r.series.id, 3);

  r = await resolveSonarrSeriesIdentity({ title: 'Nothing Like This At All' });
  assert.strictEqual(r.status, 'none', 'nothing plausible in the library resolves to none');
  assert.strictEqual(r.series, null);

  r = await resolveSonarrSeriesIdentity({ title: 'Old Drama Uncut' });
  assert.strictEqual(r.status, 'ambiguous', 'even a single loose token-overlap hit still requires a click, never auto-selected');
  assert.strictEqual(r.series, null);
  assert.strictEqual(r.candidates[0].id, 4);

  server.close();
  console.log('ok - sonarr-resolve');
})().catch(err => { console.error('FAILED sonarr-resolve:', err.message); process.exit(1); });
