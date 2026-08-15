#!/usr/bin/env node
// The season-pack sweep as it actually ships: sweepSeasonPacks is pulled out of index.js and run
// against stubbed Sonarr/db/Discord, so the wiring (age gate, queue skip, cooldown persistence,
// per-run cap, notification) is covered without booting the bot or opening SQLite.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadSandbox } = require('./extract');
const { assessSeriesAge, seasonSearchTargets, describeSeasonSearch } = require('../../src/season-pack');
const runtimeSettings = require('../../src/runtime-settings');
const { priorityKey, orderByPriority, isPinned } = require('../../src/priority');

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
  { id: 1, tvdbId: 101, title: 'Winter Sonata', monitored: true, status: 'ended', statistics: { episodeCount: 20, episodeFileCount: 0 } },
  { id: 2, tvdbId: 102, title: 'Dormant Drama', monitored: true, status: 'continuing', previousAiring: daysAgo(900), statistics: { episodeCount: 10, episodeFileCount: 2 } },
  { id: 3, tvdbId: 103, title: 'Airing Now', monitored: true, status: 'continuing', previousAiring: daysAgo(2), nextAiring: daysAhead(5), statistics: { episodeCount: 8, episodeFileCount: 1 } },
  { id: 4, tvdbId: 104, title: 'Finished And Complete', monitored: true, status: 'ended', statistics: { episodeCount: 12, episodeFileCount: 12 } },
  { id: 5, tvdbId: 105, title: 'Unmonitored Oldie', monitored: false, status: 'ended', statistics: { episodeCount: 12, episodeFileCount: 0 } },
];
const EPISODES = {
  1: [ep(1, 1), ep(1, 2), ep(1, 3), ep(2, 1), ep(2, 2), ep(2, 3)],
  2: [ep(1, 1), ep(1, 2), ep(1, 3)],
  3: [ep(1, 1), ep(1, 2), ep(1, 3)],
  4: [],
  5: [ep(1, 1), ep(1, 2), ep(1, 3)],
};

function build({ maxPerRun = 5, queue = [], searchedAt = {}, seasonPackFirst = true, requestedTvdbIds = [], seasonPackRequested = true, overrides = {}, pinned = {} } = {}) {
  const calls = [];
  const recorded = [];
  const notices = [];
  const episodeFetches = [];
  const monitored = [];
  const CONFIG = {
    SEASON_PACK_FIRST: seasonPackFirst,
    SONARR_URL: 'http://sonarr',
    SEASON_PACK_DORMANT_DAYS: 365,
    SEASON_PACK_MIN_MISSING: 3,
    SEASON_PACK_COOLDOWN_HOURS: 24,
    SEASON_PACK_MAX_PER_RUN: maxPerRun,
    SEASON_PACK_REQUESTED: seasonPackRequested,
  };
  // The sweep reads its knobs through tunable() so dashboard overrides apply mid-flight. Wire the
  // real resolver with no override store: every value comes straight from the CONFIG above, which
  // is exactly the behavior when nothing has been overridden.
  const store = { get: key => overrides[key.replace(runtimeSettings.OVERRIDE_PREFIX, '')] ?? null };
  const sandbox = loadSandbox(['sweepSeasonPacks', 'seasonPackConfig', 'queuedSeasons'], {
    CONFIG,
    tunable: key => runtimeSettings.resolveRuntime(key, { config: CONFIG, store }),
    // Pinning reorders the candidate list; `pinned` maps tvdbId → rank.
    priorityKey,
    orderByPriority,
    isPinned,
    mediaPriorityMap: () => new Map(Object.entries(pinned).map(([tvdbId, rank]) => [`tvdb:${tvdbId}`, rank])),
    assessSeriesAge,
    seasonSearchTargets,
    describeSeasonSearch,
    listSonarrSeries: async () => SERIES,
    fetchArrQueues: async () => queue,
    getSeriesEpisodes: async id => { episodeFetches.push(id); return EPISODES[id] || []; },
    triggerSeasonSearch: async (seriesId, seasonNumber) => { calls.push(`${seriesId}:${seasonNumber}`); return { id: seriesId * 100 + seasonNumber }; },
    monitorSeasonSearch: row => { monitored.push(row); },
    getSeasonSearchTimes: id => searchedAt[id] || {},
    listRequestedTvdbIds: () => new Set(requestedTvdbIds),
    recordSeasonSearch: row => recorded.push(row),
    audit: () => {},
    notifyChannel: (channel, msg) => notices.push({ channel, msg }),
    COLORS: { INFO: 1 },
    brandedEmbed: () => ({ setTitle() { return this; }, setDescription(d) { this.description = d; return this; } }),
  });
  return { sandbox, calls, recorded, notices, episodeFetches, monitored };
}

test('season-pack-sweep: old shows get season searches, airing shows are never touched', async () => {
  const h = build();
  const result = await h.sandbox.sweepSeasonPacks();
  assert.deepStrictEqual(h.calls.sort(), ['1:1', '1:2', '2:1'], 'both old shows are season-searched, the airing one is not');
  assert.strictEqual(result.searched, 3, 'the sweep reports what it searched');
  assert.ok(!h.episodeFetches.includes(3), 'an airing series never costs an /episode call');
  assert.ok(!h.episodeFetches.includes(4), 'a series with no missing episodes is filtered before /episode');
  assert.ok(!h.episodeFetches.includes(5), 'an unmonitored series is skipped entirely');

  // The cooldown is what makes this safe to run every few hours — it has to be written for
  // every season actually searched, or the next sweep re-searches the whole library.
  assert.strictEqual(h.recorded.length, 3, 'every search is recorded for the cooldown');
  assert.strictEqual(h.monitored.length, 3, 'every accepted command is monitored through completion');
  assert.strictEqual(h.monitored[0].commandId, 101, 'the Sonarr command id is retained for verification');
  // Compared as JSON: objects built inside the vm carry the sandbox's own Object prototype,
  // which deepStrictEqual counts as a difference.
  assert.strictEqual(JSON.stringify(h.recorded[0]), JSON.stringify({ seriesId: 1, seasonNumber: 1, seriesTitle: 'Winter Sonata', missing: 3 }),
    'the cooldown row carries the season and its gap');
  assert.strictEqual(h.notices.length, 1, 'one summary is posted');
  assert.strictEqual(h.notices[0].channel, 'downloads', 'the summary goes to the downloads channel');
  assert.match(h.notices[0].msg.embeds[0].description, /Winter Sonata\*\* S01 — 3 of 3/, 'the summary names the seasons searched');
});

test('season-pack-sweep: a requested show gets packs even while it is still airing', async () => {
  // Most releases are an "S01" pack whatever the show's age, and somebody is waiting on this one.
  let h = build({ requestedTvdbIds: [103] });
  await h.sandbox.sweepSeasonPacks();
  assert.deepStrictEqual(h.calls.sort(), ['1:1', '1:2', '2:1', '3:1'], 'the requested airing show is season-searched too');
  assert.match(h.notices[0].msg.embeds[0].description, /Airing Now\*\* S01 .*_\(requested\)_/, 'the summary says why an airing show was included');
  assert.match(h.notices[0].msg.embeds[0].description, /Winter Sonata\*\* S01 .*_\(series has ended\)_/, 'an old show still reports its age');

  h = build({ requestedTvdbIds: [103], seasonPackRequested: false });
  await h.sandbox.sweepSeasonPacks();
  assert.deepStrictEqual(h.calls.sort(), ['1:1', '1:2', '2:1'], 'SEASON_PACK_REQUESTED=false restores the age-only gate');

  // A requested show that is complete is still filtered before costing an /episode call.
  h = build({ requestedTvdbIds: [104] });
  await h.sandbox.sweepSeasonPacks();
  assert.ok(!h.episodeFetches.includes(4), 'being requested does not override the has-everything filter');
});

test('season-pack-sweep: a season already downloading is left alone rather than raced', async () => {
  const h = build({ queue: [{ source: { kind: 'tv' }, seriesId: 1, seasonNumber: 1, episodeNumber: 2 }] });
  await h.sandbox.sweepSeasonPacks();
  assert.deepStrictEqual(h.calls.sort(), ['1:2', '2:1'], 'a season with a queue item is not re-searched');
});

test('season-pack-sweep: cooldown — a recently-searched season sits out, an expired one comes back', async () => {
  const h = build({ searchedAt: { 1: { 1: NOW - 2 * 3600000, 2: NOW - 30 * 3600000 } } });
  await h.sandbox.sweepSeasonPacks();
  assert.deepStrictEqual(h.calls.sort(), ['1:2', '2:1'], 'only the season past its cooldown is re-searched');
});

test('season-pack-sweep: the per-run cap bounds a first pass over a large library', async () => {
  const h = build({ maxPerRun: 2 });
  const result = await h.sandbox.sweepSeasonPacks();
  assert.strictEqual(h.calls.length, 2, 'the per-run cap stops the sweep');
  assert.strictEqual(result.searched, 2, 'the capped run reports only what it did');
  assert.strictEqual(h.recorded.length, 2, 'nothing beyond the cap is marked as searched');
});

test('season-pack-sweep: off means off — no Sonarr calls at all', async () => {
  const h = build({ seasonPackFirst: false });
  await h.sandbox.sweepSeasonPacks();
  assert.strictEqual(h.calls.length, 0, 'SEASON_PACK_FIRST=false disables the sweep completely');
  assert.strictEqual(h.notices.length, 0, 'and posts nothing');
});

test('season-pack-sweep: a Sonarr failure on one series must not abort the rest of the sweep', async () => {
  const h = build();
  let first = true;
  h.sandbox.triggerSeasonSearch = async (seriesId, seasonNumber) => {
    if (first) { first = false; throw new Error('sonarr 500'); }
    h.calls.push(`${seriesId}:${seasonNumber}`);
  };
  await h.sandbox.sweepSeasonPacks();
  assert.deepStrictEqual(h.calls.sort(), ['1:2', '2:1'], 'a failed season search is skipped, the rest continue');
  assert.strictEqual(h.recorded.length, 2, 'a failed search is not recorded, so it retries next sweep instead of sitting out the cooldown');
});

test('season-pack-sweep: a runtime override beats the compose value without a restart', async () => {
  // CONFIG says the sweep is on and may search 5 seasons; the stored overrides say 1, then off.
  const capped = build({ maxPerRun: 5, overrides: { SEASON_PACK_MAX_PER_RUN: '1' } });
  await capped.sandbox.run('sweepSeasonPacks()');
  assert.strictEqual(capped.calls.length, 1, `override caps the run, got: ${JSON.stringify(capped.calls)}`);

  const disabled = build({ seasonPackFirst: true, overrides: { SEASON_PACK_FIRST: '0' } });
  await disabled.sandbox.run('sweepSeasonPacks()');
  assert.deepStrictEqual(disabled.calls, [], 'override switches the sweep off entirely');

  const invalid = build({ maxPerRun: 5, overrides: { SEASON_PACK_MAX_PER_RUN: 'banana' } });
  await invalid.sandbox.run('sweepSeasonPacks()');
  assert.ok(invalid.calls.length > 1, 'an unparseable override is ignored, not obeyed as 0');
});

test('season-pack-sweep: a pinned show is searched first when the per-run cap bites', async () => {
  // Cap of 1. Without a pin, Sonarr's order puts 'Winter Sonata' (tvdb 101) first; pinning the
  // dormant show (tvdb 102) promotes it instead. The cap is unchanged — position, not exemption.
  const unpinned = build({ maxPerRun: 1 });
  await unpinned.sandbox.run('sweepSeasonPacks()');
  assert.deepStrictEqual(unpinned.recorded.map(r => r.seriesTitle), ['Winter Sonata'], 'default order');

  const withPin = build({ maxPerRun: 1, pinned: { 102: 1 } });
  await withPin.sandbox.run('sweepSeasonPacks()');
  assert.deepStrictEqual(withPin.recorded.map(r => r.seriesTitle), ['Dormant Drama'], 'pinned show jumps the queue');
  assert.strictEqual(withPin.calls.length, 1, 'and the cap still holds at 1');
});

test('season-pack-sweep: pinning marks the notification so the reason is visible', async () => {
  const { sandbox, notices } = build({ maxPerRun: 1, pinned: { 102: 1 } });
  await sandbox.run('sweepSeasonPacks()');
  assert.match(notices[0].msg.embeds[0].description, /📌/, 'pinned rows are flagged in the summary');
});

test('sweep guard: concurrent runs are refused and the guard clears after failure', async () => {
  const automationRuns = new Map();
  const sandbox = loadSandbox(['runGuardedSweep'], {
    runningSweeps: new Set(), automationRuns,
    recordAutomationRun: (name, state) => automationRuns.set(name, state),
  });
  const first = sandbox.run(`runGuardedSweep('season-pack', () => new Promise(resolve => { release = resolve; }))`);
  await Promise.resolve();
  assert.strictEqual((await sandbox.run(`runGuardedSweep('season-pack', () => Promise.resolve())`)).busy, true);
  sandbox.release('done');
  assert.strictEqual((await first).result, 'done');
  await assert.rejects(sandbox.run(`runGuardedSweep('season-pack', () => Promise.reject(new Error('failed')))`), /failed/);
  assert.strictEqual((await sandbox.run(`runGuardedSweep('season-pack', () => Promise.resolve('retried'))`)).result, 'retried');
});

test('season search cooldown: reports the next eligible time and expires on the boundary', () => {
  const sandbox = loadSandbox(['seasonSearchCooldown'], { CONFIG: { SEASON_PACK_COOLDOWN_HOURS: 24 } });
  const last = NOW - 2 * 3600000;
  const cooling = sandbox.seasonSearchCooldown(last, NOW);
  assert.strictEqual(cooling.cooling, true);
  assert.strictEqual(cooling.nextEligible, last + 24 * 3600000);
  assert.strictEqual(sandbox.seasonSearchCooldown(last, last + 24 * 3600000).cooling, false);
  assert.strictEqual(sandbox.seasonSearchCooldown(undefined, NOW).cooling, false);
});

function seasonVerifier({ command, episodes = [ep(1, 1), ep(1, 2), ep(1, 3)], queue = [] }) {
  const notices = [];
  const audits = [];
  const sandbox = loadSandbox(['verifySeasonSearchCommand'], {
    CONFIG: { SONARR_URL: 'http://sonarr', SONARR_API_KEY: 'key' },
    pollArrCommand: async () => command,
    getSeriesEpisodes: async () => episodes,
    fetchArrQueues: async () => queue,
    audit: (action, detail) => audits.push({ action, detail }),
    notifyChannel: (channel, msg) => notices.push({ channel, msg }),
    pad: n => String(n).padStart(2, '0'),
    COLORS: { WARN: 1, INFO: 2, SUCCESS: 3 },
    brandedEmbed: color => ({ color, setTitle(value) { this.title = value; return this; }, setDescription(value) { this.description = value; return this; } }),
  });
  return { sandbox, notices, audits };
}

test('season search verification: reports a completed search with no accepted release', async () => {
  const h = seasonVerifier({ command: { status: 'completed', message: 'Season search completed. 0 reports downloaded.' } });
  const result = await h.sandbox.verifySeasonSearchCommand({ seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1, missingAtSearch: 3, commandId: 101 });
  assert.strictEqual(result.outcome, 'no_grab');
  assert.match(h.notices[0].msg.embeds[0].description, /Interactive Search/);
  assert.strictEqual(h.audits[0].detail.downloaded, 0);
});

test('season search verification: distinguishes queued, verified, failed, and wedged outcomes', async () => {
  let h = seasonVerifier({
    command: { status: 'completed', message: 'Season search completed. 1 report downloaded.' },
    queue: [{ source: { kind: 'tv' }, seriesId: 1, seasonNumber: 1 }],
  });
  assert.strictEqual((await h.sandbox.verifySeasonSearchCommand({ seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1, missingAtSearch: 3, commandId: 101 })).outcome, 'grabbed');

  h = seasonVerifier({ command: { status: 'completed' }, episodes: [ep(1, 1, { hasFile: true }), ep(1, 2, { hasFile: true }), ep(1, 3, { hasFile: true })] });
  assert.strictEqual((await h.sandbox.verifySeasonSearchCommand({ seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1, missingAtSearch: 3, commandId: 101 })).outcome, 'verified');

  h = seasonVerifier({ command: { status: 'failed', message: 'Indexer unavailable' } });
  assert.strictEqual((await h.sandbox.verifySeasonSearchCommand({ seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1, missingAtSearch: 3, commandId: 101 })).outcome, 'failed');

  h = seasonVerifier({ command: { status: 'started' } });
  assert.strictEqual((await h.sandbox.verifySeasonSearchCommand({ seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1, missingAtSearch: 3, commandId: 101 })).outcome, 'timed_out');
  assert.match(h.notices[0].msg.embeds[0].description, /task queue may be wedged/);
});
