#!/usr/bin/env node
// The season-pack sweep as it actually ships: sweepSeasonPacks is pulled out of index.js and run
// against stubbed Sonarr/db/Discord, so the wiring (age gate, queue skip, cooldown persistence,
// per-run cap, notification) is covered without booting the bot or opening SQLite.
const assert = require('assert');
const { loadSandbox } = require('./extract');
const { assessSeriesAge, seasonSearchTargets, describeSeasonSearch } = require('../../src/season-pack');

const DAY = 86400000;
const NOW = Date.now();
const daysAgo = n => new Date(NOW - n * DAY).toISOString();
const daysAhead = n => new Date(NOW + n * DAY).toISOString();

const ep = (season, number, over = {}) => ({
  seasonNumber: season, episodeNumber: number, monitored: true, hasFile: false,
  airDateUtc: daysAgo(900), ...over,
});

// Two old shows with gaps, one airing show with the same gaps, one already-complete old show.
const SERIES = [
  { id: 1, title: 'Winter Sonata', monitored: true, status: 'ended', statistics: { episodeCount: 20, episodeFileCount: 0 } },
  { id: 2, title: 'Dormant Drama', monitored: true, status: 'continuing', previousAiring: daysAgo(900), statistics: { episodeCount: 10, episodeFileCount: 2 } },
  { id: 3, title: 'Airing Now', monitored: true, status: 'continuing', previousAiring: daysAgo(2), nextAiring: daysAhead(5), statistics: { episodeCount: 8, episodeFileCount: 1 } },
  { id: 4, title: 'Finished And Complete', monitored: true, status: 'ended', statistics: { episodeCount: 12, episodeFileCount: 12 } },
  { id: 5, title: 'Unmonitored Oldie', monitored: false, status: 'ended', statistics: { episodeCount: 12, episodeFileCount: 0 } },
];
const EPISODES = {
  1: [ep(1, 1), ep(1, 2), ep(1, 3), ep(2, 1), ep(2, 2), ep(2, 3)],
  2: [ep(1, 1), ep(1, 2), ep(1, 3)],
  3: [ep(1, 1), ep(1, 2), ep(1, 3)],
  4: [],
  5: [ep(1, 1), ep(1, 2), ep(1, 3)],
};

function build({ maxPerRun = 5, queue = [], searchedAt = {}, seasonPackFirst = true } = {}) {
  const calls = [];
  const recorded = [];
  const notices = [];
  const episodeFetches = [];
  const CONFIG = {
    SEASON_PACK_FIRST: seasonPackFirst,
    SONARR_URL: 'http://sonarr',
    SEASON_PACK_DORMANT_DAYS: 365,
    SEASON_PACK_MIN_MISSING: 3,
    SEASON_PACK_COOLDOWN_HOURS: 24,
    SEASON_PACK_MAX_PER_RUN: maxPerRun,
  };
  const sandbox = loadSandbox(['sweepSeasonPacks', 'seasonPackConfig', 'queuedSeasons'], {
    CONFIG,
    assessSeriesAge,
    seasonSearchTargets,
    describeSeasonSearch,
    listSonarrSeries: async () => SERIES,
    fetchArrQueues: async () => queue,
    getSeriesEpisodes: async id => { episodeFetches.push(id); return EPISODES[id] || []; },
    triggerSeasonSearch: async (seriesId, seasonNumber) => { calls.push(`${seriesId}:${seasonNumber}`); },
    getSeasonSearchTimes: id => searchedAt[id] || {},
    recordSeasonSearch: row => recorded.push(row),
    audit: () => {},
    notifyChannel: (channel, msg) => notices.push({ channel, msg }),
    COLORS: { INFO: 1 },
    brandedEmbed: () => ({ setTitle() { return this; }, setDescription(d) { this.description = d; return this; } }),
  });
  return { sandbox, calls, recorded, notices, episodeFetches };
}

(async () => {
  // --- The core gate: old shows get season searches, airing shows are never touched ---
  let h = build();
  let result = await h.sandbox.sweepSeasonPacks();
  assert.deepStrictEqual(h.calls.sort(), ['1:1', '1:2', '2:1'], 'both old shows are season-searched, the airing one is not');
  assert.strictEqual(result.searched, 3, 'the sweep reports what it searched');
  assert.ok(!h.episodeFetches.includes(3), 'an airing series never costs an /episode call');
  assert.ok(!h.episodeFetches.includes(4), 'a series with no missing episodes is filtered before /episode');
  assert.ok(!h.episodeFetches.includes(5), 'an unmonitored series is skipped entirely');

  // The cooldown is what makes this safe to run every few hours — it has to be written for
  // every season actually searched, or the next sweep re-searches the whole library.
  assert.strictEqual(h.recorded.length, 3, 'every search is recorded for the cooldown');
  // Compared as JSON: objects built inside the vm carry the sandbox's own Object prototype,
  // which deepStrictEqual counts as a difference.
  assert.strictEqual(JSON.stringify(h.recorded[0]), JSON.stringify({ seriesId: 1, seasonNumber: 1, seriesTitle: 'Winter Sonata', missing: 3 }),
    'the cooldown row carries the season and its gap');
  assert.strictEqual(h.notices.length, 1, 'one summary is posted');
  assert.strictEqual(h.notices[0].channel, 'downloads', 'the summary goes to the downloads channel');
  assert.match(h.notices[0].msg.embeds[0].description, /Winter Sonata\*\* S01 — 3 of 3/, 'the summary names the seasons searched');

  // --- A season already downloading is left alone rather than raced ---
  h = build({ queue: [{ source: { kind: 'tv' }, seriesId: 1, seasonNumber: 1, episodeNumber: 2 }] });
  await h.sandbox.sweepSeasonPacks();
  assert.deepStrictEqual(h.calls.sort(), ['1:2', '2:1'], 'a season with a queue item is not re-searched');

  // --- Cooldown: a recently-searched season sits out, an expired one comes back ---
  h = build({ searchedAt: { 1: { 1: NOW - 2 * 3600000, 2: NOW - 30 * 3600000 } } });
  await h.sandbox.sweepSeasonPacks();
  assert.deepStrictEqual(h.calls.sort(), ['1:2', '2:1'], 'only the season past its cooldown is re-searched');

  // --- The per-run cap bounds a first pass over a large library ---
  h = build({ maxPerRun: 2 });
  result = await h.sandbox.sweepSeasonPacks();
  assert.strictEqual(h.calls.length, 2, 'the per-run cap stops the sweep');
  assert.strictEqual(result.searched, 2, 'the capped run reports only what it did');
  assert.strictEqual(h.recorded.length, 2, 'nothing beyond the cap is marked as searched');

  // --- Off means off: no Sonarr calls at all ---
  h = build({ seasonPackFirst: false });
  await h.sandbox.sweepSeasonPacks();
  assert.strictEqual(h.calls.length, 0, 'SEASON_PACK_FIRST=false disables the sweep completely');
  assert.strictEqual(h.notices.length, 0, 'and posts nothing');

  // --- A Sonarr failure on one series must not abort the rest of the sweep ---
  h = build();
  let first = true;
  h.sandbox.triggerSeasonSearch = async (seriesId, seasonNumber) => {
    if (first) { first = false; throw new Error('sonarr 500'); }
    h.calls.push(`${seriesId}:${seasonNumber}`);
  };
  await h.sandbox.sweepSeasonPacks();
  assert.deepStrictEqual(h.calls.sort(), ['1:2', '2:1'], 'a failed season search is skipped, the rest continue');
  assert.strictEqual(h.recorded.length, 2, 'a failed search is not recorded, so it retries next sweep instead of sitting out the cooldown');

  console.log('ok - season-pack sweep');
})().catch(err => { console.error('FAILED season-pack sweep:', err.message); process.exit(1); });
