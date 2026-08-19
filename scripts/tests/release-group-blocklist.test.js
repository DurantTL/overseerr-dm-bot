#!/usr/bin/env node
// #211: proactive dead-release-group blocklisting. Three independent layers are tested here —
// the pure release-group extractor (src/grab.js), the sighting-tracking table/helpers
// (src/db.js, against a throwaway on-disk SQLite file), and the Sonarr Custom
// Format/quality-profile helpers (src/arr.js, extracted and run against a mock Sonarr). The
// suggest/approve Discord flow itself lives in index.js and isn't reachable from this harness —
// same deliberate scope decision as the dashboard/adoption routes touched in recent PRs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const axios = require('axios');
const { loadSandbox } = require('./extract');

const { extractReleaseGroup } = require('../../src/grab');

test('extractReleaseGroup: bracketed and dash-suffixed tags, case-insensitive', () => {
  assert.strictEqual(extractReleaseGroup('Revenge.S01E01.1080p.WEB-DL[rartv]'), 'rartv', 'bracketed tag');
  assert.strictEqual(extractReleaseGroup('Revenge.S01E01.1080p.WEB-DL[RARTV]'), 'rartv', 'bracketed tag lowercased');
  assert.strictEqual(extractReleaseGroup('Revenge.S01E01.1080p.WEB-DL-RARBG'), 'rarbg', 'dash-suffixed tag');
  assert.strictEqual(extractReleaseGroup('Revenge.S01E01.1080p.WEB-DL-RARBG.mkv'), 'rarbg', 'file extension is stripped first');
  assert.strictEqual(extractReleaseGroup('Some.Show.S01.COMPLETE.1080p'), null, 'no recognizable tag returns null');
  assert.strictEqual(extractReleaseGroup(''), null, 'empty name returns null');
  assert.strictEqual(extractReleaseGroup(null), null, 'null name returns null');
});

function freshDb() {
  const DB_MODULE = require.resolve('../../src/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-group-blocklist-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  delete require.cache[DB_MODULE];
  return { ...require('../../src/db'), dir };
}

function cleanup({ db, dir }) {
  db.close();
  delete process.env.DB_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('release_group_sightings: count climbs per sighting, suggestion/dismissal/reset state', () => {
  const handle = freshDb();
  const { runMigrations, recordDeadReleaseGroupSighting, getReleaseGroupSighting, markReleaseGroupSuggested, markReleaseGroupBlocklisted, dismissReleaseGroupSuggestion, resetReleaseGroupSighting } = handle;
  try {
    runMigrations();
    assert.strictEqual(recordDeadReleaseGroupSighting('rarbg', { sampleName: 'Show.S01E01-RARBG' }), 1, 'first sighting');
    assert.strictEqual(recordDeadReleaseGroupSighting('rarbg', { sampleName: 'Show.S01E02-RARBG' }), 2, 'second sighting increments');
    assert.strictEqual(recordDeadReleaseGroupSighting('other', { sampleName: 'Show.S01E01-OTHER' }), 1, 'a different group tracks independently');

    let row = getReleaseGroupSighting('rarbg');
    assert.strictEqual(row.dead_clear_count, 2);
    assert.strictEqual(row.sample_transfer_name, 'Show.S01E02-RARBG', 'sample name is kept current');
    assert.strictEqual(row.suggested_at, null, 'not yet suggested');
    assert.strictEqual(row.dismissed, 0);

    markReleaseGroupSuggested('rarbg', 12345);
    row = getReleaseGroupSighting('rarbg');
    assert.ok(row.suggested_at, 'suggested_at is set');

    markReleaseGroupBlocklisted('rarbg', 99);
    row = getReleaseGroupSighting('rarbg');
    assert.strictEqual(row.sonarr_custom_format_id, 99);

    dismissReleaseGroupSuggestion('other');
    row = getReleaseGroupSighting('other');
    assert.strictEqual(row.dismissed, 1);

    resetReleaseGroupSighting('rarbg');
    row = getReleaseGroupSighting('rarbg');
    assert.strictEqual(row.dead_clear_count, 0, 'reset clears the count so a recovered tracker gets another chance');
    assert.strictEqual(row.suggested_at, null);
    assert.strictEqual(row.dismissed, 0);

    assert.strictEqual(getReleaseGroupSighting('never-seen'), null, 'unknown group returns null, not a throw');
  } finally {
    cleanup(handle);
  }
});

test('Sonarr Custom Format + quality-profile helpers against a mock Sonarr', async () => {
  const app = express();
  app.use(express.json());
  const state = {
    customFormats: [{ id: 1, name: 'Existing Format' }],
    profiles: [
      { id: 5, name: 'HD-1080p', formatItems: [{ format: 1, name: '', score: 0 }] },
      { id: 6, name: '4K', formatItems: [] },
    ],
    profilePuts: [],
  };
  app.get('/api/v3/customformat', (req, res) => res.json(state.customFormats));
  app.post('/api/v3/customformat', (req, res) => {
    const created = { id: 42, ...req.body };
    state.customFormats.push(created);
    res.json(created);
  });
  app.get('/api/v3/qualityprofile', (req, res) => res.json(state.profiles));
  app.put('/api/v3/qualityprofile/:id', (req, res) => {
    state.profilePuts.push(req.body);
    const idx = state.profiles.findIndex(p => p.id === Number(req.params.id));
    state.profiles[idx] = req.body;
    res.json(req.body);
  });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const CONFIG = { SONARR_URL: base, SONARR_API_KEY: 'sk' };

  const sandbox = loadSandbox(
    ['listSonarrCustomFormats', 'createSonarrCustomFormat', 'listSonarrQualityProfiles', 'scoreSonarrCustomFormatInAllProfiles'],
    { axios, CONFIG },
  );

  const formats = await sandbox.run('listSonarrCustomFormats()');
  assert.strictEqual(formats.length, 1, 'lists existing custom formats');

  const created = await sandbox.run("createSonarrCustomFormat('Dead release group — rarbg', '\\\\brarbg\\\\b')");
  assert.strictEqual(created.id, 42, 'custom format created');
  assert.strictEqual(created.name, 'Dead release group — rarbg');
  assert.strictEqual(created.specifications[0].fields[0].value, '\\brarbg\\b', 'regex pattern sent through');

  await sandbox.run('scoreSonarrCustomFormatInAllProfiles(42, -1000)');
  assert.strictEqual(state.profilePuts.length, 2, 'every quality profile is updated');
  const hd = state.profilePuts.find(p => p.id === 5);
  assert.deepStrictEqual(hd.formatItems, [{ format: 1, name: '', score: 0 }, { format: 42, name: '', score: -1000 }], 'new format appended without disturbing the existing one');
  const fourK = state.profilePuts.find(p => p.id === 6);
  assert.deepStrictEqual(fourK.formatItems, [{ format: 42, name: '', score: -1000 }], 'profile with no formatItems gets one added');

  // Re-scoring the same format+score is a no-op — no redundant PUT.
  state.profilePuts = [];
  await sandbox.run('scoreSonarrCustomFormatInAllProfiles(42, -1000)');
  assert.strictEqual(state.profilePuts.length, 0, 'already-correct score skips the PUT');

  server.close();
});
