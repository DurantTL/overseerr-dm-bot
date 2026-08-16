#!/usr/bin/env node
// The season-pack sweep as it actually ships: sweepSeasonPacks is pulled out of index.js and run
// against stubbed Sonarr/db/Discord, so the wiring (age gate, queue skip, cooldown persistence,
// per-run cap, notification) is covered without booting the bot or opening SQLite.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadSandbox } = require('./extract');
const { assessSeriesAge, seasonSearchTargets, describeSeasonSearch, summarizeSeasonFillActivity } = require('../../src/season-pack');
const { rankSeasonReleases, chooseSeasonPack, describeRejections } = require('../../src/season-release');
const runtimeSettings = require('../../src/runtime-settings');
const { priorityKey, orderByPriority, isPinned } = require('../../src/priority');
const { sha256 } = require('../../src/util');

const DAY = 86400000;
const NOW = Date.now();
const daysAgo = n => new Date(NOW - n * DAY).toISOString();
const daysAhead = n => new Date(NOW + n * DAY).toISOString();

const ep = (season, number, over = {}) => ({
  id: season * 100 + number,
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
  const rearmed = [];
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
    clearSeasonAlertState: (seriesId, seasonNumber) => rearmed.push(`${seriesId}:${seasonNumber}`),
    audit: () => {},
    notifyChannel: (channel, msg) => notices.push({ channel, msg }),
    COLORS: { INFO: 1 },
    brandedEmbed: () => ({ setTitle() { return this; }, setDescription(d) { this.description = d; return this; } }),
  });
  return { sandbox, calls, recorded, notices, episodeFetches, monitored, rearmed };
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

test('season-pack-sweep: a manual run re-arms only seasons it actually retries', async () => {
  const h = build({ maxPerRun: 2 });
  await h.sandbox.sweepSeasonPacks({ rearmAlerts: true });
  assert.deepStrictEqual(h.rearmed, ['1:1', '1:2']);
  assert.deepStrictEqual(h.calls, ['1:1', '1:2'], 'manual re-arm does not expand the normal search cap');
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

test('season-pack-sweep: summary does not promise a whole-season release for partial gaps', async () => {
  const { sandbox, notices } = build();
  await sandbox.run('sweepSeasonPacks()');
  const summary = notices.at(-1).msg.embeds[0].description;
  assert.match(summary, /partially missing seasons may still be searched episode by episode/);
  assert.doesNotMatch(summary, /asked for these seasons as a whole/);
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

test('season search history: keeps recent grabs/imports for the requested season and detects pack names', async () => {
  const rows = [
    { eventType: 'grabbed', date: new Date(NOW + 1000).toISOString(), downloadId: 'pack-1', sourceTitle: 'Drama.S01.1080p', episode: { seasonNumber: 1, episodeNumber: 1 } },
    { eventType: 'downloadFolderImported', date: new Date(NOW + 2000).toISOString(), data: { downloadId: 'pack-1', sourceTitle: 'Drama.S01.1080p' }, episode: { seasonNumber: 1, episodeNumber: 2 } },
    { eventType: 'grabbed', date: new Date(NOW - 1000).toISOString(), downloadId: 'old', sourceTitle: 'Drama.S01E03.1080p', episode: { seasonNumber: 1, episodeNumber: 3 } },
    { eventType: 'grabbed', date: new Date(NOW + 1000).toISOString(), downloadId: 'other-season', sourceTitle: 'Drama.S02.1080p', episode: { seasonNumber: 2, episodeNumber: 1 } },
    { eventType: 'episodeFileDeleted', date: new Date(NOW + 1000).toISOString(), downloadId: 'delete', episode: { seasonNumber: 1, episodeNumber: 4 } },
  ];
  const sandbox = loadSandbox(['parseReleaseName', 'getSeasonDownloadHistory'], {
    sonarrGet: async () => ({ records: rows }),
  });
  const result = await sandbox.getSeasonDownloadHistory(7, 1, NOW);
  assert.strictEqual(result.length, 2);
  assert.ok(result.every(row => row.downloadId === 'pack-1'));
  assert.ok(result.every(row => row.fullSeason), 'S01 without an episode marker is a season pack');
});

function seasonVerifier({ command, episodes = [ep(1, 1), ep(1, 2), ep(1, 3)], queue = [], history = [], interactive = [], interactiveError = null, interactiveEnabled = true, autoForce = false, duplicate = null, recheckQueue = null, forceError = null, alertDecision = null }) {
  const notices = [];
  const audits = [];
  const interactiveCalls = [];
  const offers = [];
  const alertRecords = [];
  const clearedAlerts = [];
  const forced = [];
  let queueCalls = 0;
  class FakeButton {
    setCustomId(value) { this.customId = value; return this; }
    setLabel(value) { this.label = value; return this; }
    setStyle(value) { this.style = value; return this; }
  }
  class FakeRow {
    constructor() { this.components = []; }
    addComponents(...values) { this.components.push(...values); return this; }
  }
  const sandbox = loadSandbox(['seasonPackForceBlocker', 'autoForceSeasonPack', 'verifySeasonSearchCommand'], {
    CONFIG: { SONARR_URL: 'http://sonarr', SONARR_API_KEY: 'key', SEASON_PACK_INTERACTIVE: interactiveEnabled, SEASON_PACK_FORCE_GRAB: autoForce },
    tunable: key => ({
      SEASON_PACK_INTERACTIVE: interactiveEnabled,
      SEASON_PACK_FORCE_GRAB: autoForce,
      SEASON_PACK_MIN_SEEDERS: 1,
      SEASON_PACK_MAX_SIZE_GB: 200,
      SEASON_PACK_MIN_CONFIDENCE: 70,
    })[key],
    pollArrCommand: async () => command,
    getSeriesEpisodes: async () => episodes,
    fetchArrQueues: async () => (++queueCalls === 1 ? queue : (recheckQueue ?? queue)),
    getSeasonDownloadHistory: async () => history,
    interactiveSeasonSearch: async (seriesId, seasonNumber, episodeId) => {
      interactiveCalls.push({ seriesId, seasonNumber, episodeId });
      if (interactiveError) throw interactiveError;
      return interactive;
    },
    findActiveContentDuplicate: () => duplicate,
    forceGrabRelease: async identity => { forced.push(identity); if (forceError) throw forceError; },
    rankSeasonReleases,
    chooseSeasonPack,
    describeRejections,
    stashGrabOffer: payload => { offers.push(payload); return 'abc12345'; },
    sha256,
    recordSeasonNoGrab: detail => {
      alertRecords.push(detail);
      return alertDecision || { attemptCount: 1, changed: true, stoodDown: false, shouldAlert: true, nextAlertAttempt: 2 };
    },
    clearSeasonAlertState: (seriesId, seasonNumber) => { clearedAlerts.push({ seriesId, seasonNumber }); },
    summarizeSeasonFillActivity,
    audit: (action, detail) => audits.push({ action, detail }),
    notifyChannel: (channel, msg) => notices.push({ channel, msg }),
    pad: n => String(n).padStart(2, '0'),
    fmtSpace: bytes => `${(bytes / (1024 ** 3)).toFixed(1)} GB`,
    ActionRowBuilder: FakeRow,
    ButtonBuilder: FakeButton,
    ButtonStyle: { Danger: 'danger', Secondary: 'secondary' },
    COLORS: { WARN: 1, INFO: 2, SUCCESS: 3, DANGER: 4 },
    brandedEmbed: color => ({
      color, fields: [],
      setTitle(value) { this.title = value; return this; },
      setDescription(value) { this.description = value; return this; },
      addFields(...values) { this.fields.push(...values); return this; },
    }),
  });
  return { sandbox, notices, audits, interactiveCalls, offers, alertRecords, clearedAlerts, forced, get queueCalls() { return queueCalls; } };
}

test('season search verification: reports ranked candidates and rejection reasons after no accepted release', async () => {
  const h = seasonVerifier({
    command: { status: 'completed', message: 'Season search completed. 0 reports downloaded.' },
    interactive: [
      { title: 'Winter.Sonata.S01.1080p.WEB-DL', guid: 'pack-guid', indexerId: 7, indexerFlags: 8, size: 20 * 1024 ** 3, seeders: 12, indexer: 'AvistaZ', fullSeason: true, seasonNumber: 1, approved: false, rejections: [{ reason: 'Quality for existing file on disk is of equal or higher preference' }] },
      { title: 'Winter.Sonata.S01.720p.WEB-DL', guid: 'pack-guid-2', indexerId: 8, size: 12 * 1024 ** 3, seeders: 5, indexer: 'Public', fullSeason: true, seasonNumber: 1, approved: false, rejections: [{ reason: 'Custom format score too low' }] },
      { title: 'Winter.Sonata.S01E01.1080p.WEB-DL', size: 2 * 1024 ** 3, seeders: 30, indexer: 'Public', fullSeason: false, approved: true },
    ],
  });
  const result = await h.sandbox.verifySeasonSearchCommand({ seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1, missingAtSearch: 3, commandId: 101 });
  assert.strictEqual(result.outcome, 'no_grab');
  const embed = h.notices[0].msg.embeds[0];
  assert.match(embed.description, /nothing entered its queue/);
  assert.deepStrictEqual(h.interactiveCalls, [{ seriesId: 1, seasonNumber: 1, episodeId: 101 }]);
  assert.match(embed.fields.find(field => field.name === 'Interactive search').value, /3 releases via E01 · 2 full-season packs/);
  const candidate = embed.fields.find(field => field.name.startsWith('Candidate 1'));
  assert.match(candidate.value, /20\.0 GB · 12 seeders · AvistaZ/);
  assert.match(candidate.value, /Quality for existing file/);
  assert.match(embed.fields.at(-1).value, /admin can force one eligible pack/);
  assert.strictEqual(h.offers.length, 1);
  assert.strictEqual(h.forced.length, 0, 'automatic forcing remains off by default');
  assert.strictEqual(h.offers[0].kind, 'season-pack-force');
  assert.deepStrictEqual(h.notices[0].msg.components[0].components.map(button => button.customId), ['season_grab:abc12345:0', 'season_grab:abc12345:1']);
  const resultAudit = h.audits.find(row => row.action === 'season_pack_search_result');
  assert.strictEqual(resultAudit.detail.downloaded, 0);
  assert.strictEqual(resultAudit.detail.interactiveReleaseCount, 3);
  assert.strictEqual(resultAudit.detail.interactivePackCount, 2);
  assert.ok(h.audits.some(row => row.action === 'season_pack_force_offered'));
});

test('season search verification: default-off auto-force grabs only the best eligible pack when enabled', async () => {
  const h = seasonVerifier({
    command: { status: 'completed', message: 'Season search completed. 0 reports downloaded.' },
    autoForce: true,
    interactive: [
      { title: 'Winter.Sonata.S01.1080p.WEB-DL', guid: 'best-guid', indexerId: 7, size: 20 * 1024 ** 3, seeders: 12, indexer: 'Public', fullSeason: true, seasonNumber: 1 },
      { title: 'Winter.Sonata.S01.720p.WEB-DL', guid: 'runner-guid', indexerId: 8, size: 12 * 1024 ** 3, seeders: 5, indexer: 'Backup', fullSeason: true, seasonNumber: 1 },
    ],
  });
  const result = await h.sandbox.verifySeasonSearchCommand({ seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1, missingAtSearch: 3, commandId: 101 });
  assert.strictEqual(result.outcome, 'auto_forced');
  assert.strictEqual(JSON.stringify(h.forced), JSON.stringify([{ guid: 'best-guid', indexerId: 7 }]));
  assert.strictEqual(h.offers.length, 0, 'a successful automatic grab does not leave stale manual buttons');
  assert.ok(h.audits.some(row => row.action === 'season_pack_auto_force_grabbed'));
  assert.strictEqual(h.audits.find(row => row.action === 'season_pack_search_result').detail.autoForceStatus, 'grabbed');
  assert.match(h.notices[0].msg.embeds[0].title, /Auto-Forced/);
});

test('season search verification: auto-force rechecks live coverage and falls back to buttons on failure', async () => {
  const candidate = [{ title: 'Winter.Sonata.S01.1080p', guid: 'pack-guid', indexerId: 7, size: 20 * 1024 ** 3, seeders: 12, indexer: 'Public', fullSeason: true, seasonNumber: 1 }];
  let h = seasonVerifier({
    command: { status: 'completed' }, autoForce: true, interactive: candidate,
    duplicate: { job: { id: 44, state: 'downloading' }, label: 'season 1' },
  });
  let result = await h.sandbox.verifySeasonSearchCommand({ seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1, missingAtSearch: 3, commandId: 101 });
  assert.strictEqual(result.outcome, 'grabbed');
  assert.strictEqual(h.forced.length, 0);
  assert.ok(h.audits.some(row => row.action === 'season_pack_auto_force_refused' && row.detail.reason === 'active_grab'));

  h = seasonVerifier({
    command: { status: 'completed' }, autoForce: true, interactive: candidate,
    recheckQueue: [{ source: { kind: 'tv' }, seriesId: 1, seasonNumber: 1 }],
  });
  result = await h.sandbox.verifySeasonSearchCommand({ seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1, missingAtSearch: 3, commandId: 102 });
  assert.strictEqual(result.outcome, 'grabbed', 'a queue item appearing after the first snapshot wins the race');
  assert.strictEqual(h.forced.length, 0);
  assert.ok(h.audits.some(row => row.action === 'season_pack_auto_force_refused' && row.detail.reason === 'sonarr_queue'));

  h = seasonVerifier({ command: { status: 'completed' }, autoForce: true, interactive: candidate, forceError: new Error('indexer unavailable') });
  result = await h.sandbox.verifySeasonSearchCommand({ seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1, missingAtSearch: 3, commandId: 103 });
  assert.strictEqual(result.outcome, 'no_grab');
  assert.strictEqual(h.offers.length, 1, 'a failed automatic grab still offers the safe manual retry');
  assert.ok(h.audits.some(row => row.action === 'season_pack_auto_force_failed'));
  assert.match(h.notices[0].msg.embeds[0].fields.at(-1).value, /Automatic force-grab failed/);
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
  assert.match(h.notices[0].msg.embeds[0].fields.at(-1).value, /System → Tasks/);
});

test('season search verification: interactive lookup only runs for partial and no-grab outcomes', async () => {
  let h = seasonVerifier({
    command: { status: 'completed' },
    episodes: [ep(1, 1, { hasFile: true }), ep(1, 2), ep(1, 3)],
  });
  assert.strictEqual((await h.sandbox.verifySeasonSearchCommand({ seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1, missingAtSearch: 3, commandId: 101 })).outcome, 'partial');
  assert.strictEqual(h.interactiveCalls.length, 1, 'partial progress gets release detail');
  assert.strictEqual(h.interactiveCalls[0].episodeId, 102, 'the lookup anchors to the first episode that is still missing');

  h = seasonVerifier({
    command: { status: 'completed' },
    episodes: [ep(1, 1, { hasFile: true }), ep(1, 2, { hasFile: true }), ep(1, 3, { hasFile: true })],
  });
  await h.sandbox.verifySeasonSearchCommand({ seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1, missingAtSearch: 3, commandId: 102 });
  assert.strictEqual(h.interactiveCalls.length, 0, 'verified searches do not pay for another query');

  h = seasonVerifier({ command: { status: 'failed' } });
  await h.sandbox.verifySeasonSearchCommand({ seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1, missingAtSearch: 3, commandId: 103 });
  assert.strictEqual(h.interactiveCalls.length, 0, 'failed commands do not query releases');
});

test('season search verification: interactive reporting can be disabled and failures remain non-fatal', async () => {
  let h = seasonVerifier({ command: { status: 'completed' }, interactiveEnabled: false });
  const disabled = await h.sandbox.verifySeasonSearchCommand({ seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1, missingAtSearch: 3, commandId: 101 });
  assert.strictEqual(disabled.outcome, 'no_grab');
  assert.strictEqual(h.interactiveCalls.length, 0);
  assert.match(h.notices[0].msg.embeds[0].fields.at(-1).value, /Run an Interactive Search/);

  h = seasonVerifier({ command: { status: 'completed' }, interactiveError: new Error('Sonarr timed out') });
  const failed = await h.sandbox.verifySeasonSearchCommand({ seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1, missingAtSearch: 3, commandId: 102 });
  assert.strictEqual(failed.outcome, 'no_grab', 'release detail failure does not erase the verified command outcome');
  assert.strictEqual(h.notices.length, 1, 'the result notification is still posted');
  assert.match(h.notices[0].msg.embeds[0].fields.find(field => field.name === 'Interactive search').value, /Sonarr timed out/);
  assert.strictEqual(h.audits.find(row => row.action === 'season_pack_search_result').detail.interactiveError, 'Sonarr timed out');
});

test('season search verification: suppresses an identical backed-off result but keeps auditing and searching', async () => {
  const h = seasonVerifier({
    command: { status: 'completed', message: 'Season search completed. 0 reports downloaded.' },
    interactive: [{ title: 'Winter.Sonata.S01.1080p', guid: 'pack-guid', indexerId: 7, size: 20 * 1024 ** 3, seeders: 12, indexer: 'Public', fullSeason: true, seasonNumber: 1 }],
    alertDecision: { attemptCount: 3, changed: false, stoodDown: false, shouldAlert: false, nextAlertAttempt: 4 },
  });
  const result = await h.sandbox.verifySeasonSearchCommand({ seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1, missingAtSearch: 3, commandId: 101 });
  assert.strictEqual(result.outcome, 'no_grab');
  assert.strictEqual(result.alerted, false);
  assert.strictEqual(h.notices.length, 0, 'only the repeated Discord message is suppressed');
  assert.strictEqual(h.alertRecords.length, 1, 'the attempted search still advances durable state');
  assert.strictEqual(h.audits.find(row => row.action === 'season_pack_search_result').detail.noGrabAttempts, 3);
  assert.strictEqual(h.offers.length, 0, 'a muted result does not create invisible force-grab buttons');
});

test('season search verification: records and labels pack versus episode fills', async () => {
  const complete = [ep(1, 1, { hasFile: true }), ep(1, 2, { hasFile: true }), ep(1, 3, { hasFile: true })];
  let h = seasonVerifier({
    command: { status: 'completed' }, episodes: complete,
    history: [
      { downloadId: 'pack-1', sourceTitle: 'Winter.Sonata.S01.1080p', episodeNumber: 1 },
      { downloadId: 'pack-1', sourceTitle: 'Winter.Sonata.S01.1080p', episodeNumber: 2 },
      { downloadId: 'pack-1', sourceTitle: 'Winter.Sonata.S01.1080p', episodeNumber: 3 },
    ],
  });
  let result = await h.sandbox.verifySeasonSearchCommand({ seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1, missingAtSearch: 3, commandId: 101, searchedAt: NOW });
  assert.strictEqual(result.fill.mode, 'pack');
  assert.match(h.notices[0].msg.embeds[0].title, /Season Pack Verified/);
  assert.match(h.notices[0].msg.embeds[0].fields.find(field => field.name === 'Fill method').value, /Season pack · 1 release/);
  assert.strictEqual(h.audits.find(row => row.action === 'season_pack_search_result').detail.fillMode, 'pack');
  assert.strictEqual(h.audits.find(row => row.action === 'season_pack_search_result').detail.releaseCount, 1);

  h = seasonVerifier({
    command: { status: 'completed' }, episodes: complete,
    history: [
      { downloadId: 'ep-1', sourceTitle: 'Winter.Sonata.S01E01.1080p', episodeNumber: 1 },
      { downloadId: 'ep-2', sourceTitle: 'Winter.Sonata.S01E02.1080p', episodeNumber: 2 },
      { downloadId: 'ep-3', sourceTitle: 'Winter.Sonata.S01E03.1080p', episodeNumber: 3 },
    ],
  });
  result = await h.sandbox.verifySeasonSearchCommand({ seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1, missingAtSearch: 3, commandId: 102, searchedAt: NOW });
  assert.strictEqual(result.fill.mode, 'episodes');
  assert.match(h.notices[0].msg.embeds[0].title, /Episode Releases Verified/);
  assert.strictEqual(h.audits.find(row => row.action === 'season_pack_search_result').detail.episodeReleases, 3);
});

function seasonGrabHarness({ admin = true, offer, duplicate = null, queue = [], forceError = null } = {}) {
  const audits = [];
  const restored = [];
  const forced = [];
  const calls = [];
  let cached = offer || {
    kind: 'season-pack-force', seriesId: 1, seriesTitle: 'Winter Sonata', seasonNumber: 1,
    candidates: [{ guid: 'pack-guid', indexerId: 7, title: 'Winter.Sonata.S01.1080p', size: 20 * 1024 ** 3, seeders: 12, indexer: 'AvistaZ', confidence: 92 }],
  };
  const embed = () => ({ setTitle(value) { this.title = value; return this; }, setDescription(value) { this.description = value; return this; } });
  const sandbox = loadSandbox(['seasonPackForceBlocker', 'handleSeasonPackGrab'], {
    isAdminInteraction: () => admin,
    takeGrabOffer: () => { const value = cached; cached = null; return value; },
    restashGrabOffer: (nonce, value) => { restored.push({ nonce, value }); cached = value; },
    findActiveContentDuplicate: () => duplicate,
    fetchArrQueues: async () => queue,
    forceGrabRelease: async identity => { forced.push(identity); if (forceError) throw forceError; },
    audit: (action, detail) => audits.push({ action, detail }),
    brandedEmbed: embed,
    COLORS: { INFO: 1, SUCCESS: 2 },
    pad: n => String(n).padStart(2, '0'),
    fmtSpace: bytes => `${(bytes / (1024 ** 3)).toFixed(1)} GB`,
  });
  const interaction = {
    user: { id: 'admin-1' },
    reply: async payload => { calls.push({ method: 'reply', payload }); return payload; },
    update: async payload => { calls.push({ method: 'update', payload }); return payload; },
    deferUpdate: async () => { calls.push({ method: 'deferUpdate' }); },
    editReply: async payload => { calls.push({ method: 'editReply', payload }); return payload; },
    followUp: async payload => { calls.push({ method: 'followUp', payload }); return payload; },
  };
  return { sandbox, interaction, audits, restored, forced, calls };
}

test('season force-grab button: admin click consumes the nonce, rechecks safety, and audits the override', async () => {
  const h = seasonGrabHarness();
  await h.sandbox.handleSeasonPackGrab(h.interaction, 'abc12345', 0);
  assert.strictEqual(JSON.stringify(h.forced), JSON.stringify([{ guid: 'pack-guid', indexerId: 7 }]));
  assert.ok(h.audits.some(row => row.action === 'season_pack_force_grabbed' && row.detail.actorDiscordId === 'admin-1'));
  assert.match(h.calls.find(call => call.method === 'editReply').payload.embeds[0].title, /Season Pack Forced/);
});

test('season force-grab button: non-admin, duplicate, and Sonarr failure paths never silently force', async () => {
  let h = seasonGrabHarness({ admin: false });
  await h.sandbox.handleSeasonPackGrab(h.interaction, 'abc12345', 0);
  assert.strictEqual(h.forced.length, 0);
  assert.match(h.calls[0].payload.content, /Admin only/);

  h = seasonGrabHarness({ duplicate: { job: { id: 44, state: 'downloading' }, label: 'season 1' } });
  await h.sandbox.handleSeasonPackGrab(h.interaction, 'abc12345', 0);
  assert.strictEqual(h.forced.length, 0);
  assert.ok(h.audits.some(row => row.action === 'season_pack_force_refused' && row.detail.reason === 'active_grab'));

  h = seasonGrabHarness({ queue: [{ source: { kind: 'tv' }, seriesId: 1, seasonNumber: 1 }] });
  await h.sandbox.handleSeasonPackGrab(h.interaction, 'abc12345', 0);
  assert.strictEqual(h.forced.length, 0);
  assert.ok(h.audits.some(row => row.action === 'season_pack_force_refused' && row.detail.reason === 'sonarr_queue'));

  h = seasonGrabHarness({ forceError: new Error('indexer unavailable') });
  await h.sandbox.handleSeasonPackGrab(h.interaction, 'abc12345', 0);
  assert.strictEqual(h.restored.length, 1, 'a failed force-grab restores the offer for retry');
  assert.match(h.calls.find(call => call.method === 'followUp').payload.content, /indexer unavailable/);
  assert.ok(h.audits.some(row => row.action === 'season_pack_force_failed'));
});

// ---- Preview (#134) ----
// The preview must reach a verdict for every season the sweep would consider without spending a
// single search, write, or notification — that is the whole reason it exists. These build on the
// same SERIES/EPISODES fixtures so a drift between preview and sweep shows up as a test failure
// rather than as a threshold someone tuned against a lie.

function previewBed({ values = {}, searchedAt = {}, queue = [], maxPerRun = 5, episodeError = null, itemLimit = 60, episodes = EPISODES } = {}) {
  const sideEffects = [];
  const CONFIG = {
    SEASON_PACK_FIRST: true,
    SONARR_URL: 'http://sonarr',
    SEASON_PACK_DORMANT_DAYS: 365,
    SEASON_PACK_MIN_MISSING: 3,
    SEASON_PACK_COOLDOWN_HOURS: 24,
    SEASON_PACK_MAX_PER_RUN: maxPerRun,
    SEASON_PACK_REQUESTED: true,
  };
  const store = { get: () => null };
  const sandbox = loadSandbox(['previewSeasonPacks', 'previewRuntimeValue', 'seasonPackConfig', 'queuedSeasons'], {
    CONFIG,
    runtimeSettings,
    tunable: key => runtimeSettings.resolveRuntime(key, { config: CONFIG, store }),
    PREVIEW_ITEM_LIMIT: itemLimit,
    priorityKey,
    orderByPriority,
    mediaPriorityMap: () => new Map(),
    assessSeriesAge,
    seasonSearchTargets,
    pad: n => String(n).padStart(2, '0'),
    listSonarrSeries: async () => SERIES,
    fetchArrQueues: async () => queue,
    getSeriesEpisodes: async id => {
      if (episodeError && id === episodeError) throw new Error('Sonarr timed out');
      return episodes[id] || [];
    },
    getSeasonSearchTimes: id => searchedAt[id] || {},
    listRequestedTvdbIds: () => new Set(),
    // Anything that changes the world. A preview touching one of these is the bug.
    triggerSeasonSearch: async () => { sideEffects.push('search'); },
    recordSeasonSearch: () => sideEffects.push('record'),
    monitorSeasonSearch: () => sideEffects.push('monitor'),
    notifyChannel: () => sideEffects.push('notify'),
    audit: () => sideEffects.push('audit'),
  });
  return { sandbox, sideEffects, values };
}

test('season-pack preview: reports the same seasons the sweep would search, and changes nothing', async () => {
  const bed = previewBed();
  const items = await bed.sandbox.previewSeasonPacks({});
  assert.strictEqual(bed.sideEffects.length, 0, 'a preview spends no search, write, audit, or notification');
  // Spread into a host array first: objects built inside the vm carry the sandbox's own
  // prototypes, which deepStrictEqual counts as a difference (same reason as the JSON compare
  // in the sweep tests above).
  assert.deepStrictEqual(
    [...items].map(item => item.title).sort(),
    ['Dormant Drama S01', 'Winter Sonata S01', 'Winter Sonata S02'],
    'the preview names exactly the seasons the sweep searches',
  );
  assert.ok([...items].every(item => item.stage === 'search'), 'nothing is capped at the default per-run cap');
  assert.match([...items].find(item => item.title === 'Winter Sonata S01').reason, /series has ended; 3 of 3 aired episode\(s\) missing/);
});

test('season-pack preview: unsaved values are what gets evaluated', async () => {
  // A partially-missing season is the only case min-missing governs — a season missing every
  // aired episode is the clean pack case and qualifies whatever the threshold says. So this
  // needs a season with a file in it: 3 of 4 missing passes at 3 and must drop at 4.
  const partial = { ...EPISODES, 2: [ep(1, 1, { hasFile: true }), ep(1, 2), ep(1, 3), ep(1, 4)] };
  const bed = previewBed({ episodes: partial });
  assert.ok([...await bed.sandbox.previewSeasonPacks({})].some(item => item.title === 'Dormant Drama S01'),
    'the partially-missing season qualifies at the saved threshold of 3');

  const items = await bed.sandbox.previewSeasonPacks({ SEASON_PACK_MIN_MISSING: '4' });
  assert.ok(![...items].some(item => item.title.startsWith('Dormant Drama')), 'the unsaved threshold applies to the preview');
  assert.strictEqual(bed.sideEffects.length, 0, 'evaluating a threshold still writes nothing');

  // And an invalid value is refused rather than silently falling back to the saved one.
  await assert.rejects(() => bed.sandbox.previewSeasonPacks({ SEASON_PACK_MIN_MISSING: 'nonsense' }));
});

test('season-pack preview: cooldown-held seasons stay visible with their next-eligible time', async () => {
  const heldAt = NOW - 3600000; // searched an hour ago, 24h cooldown
  const bed = previewBed({ searchedAt: { 1: { 1: heldAt } } });
  const items = await bed.sandbox.previewSeasonPacks({});
  const held = [...items].find(item => item.title === 'Winter Sonata S01');
  assert.strictEqual(held.stage, 'cooldown', 'a cooled-down season is reported, not omitted');
  assert.match(held.reason, new RegExp(new Date(heldAt + 24 * 3600000).toISOString()), 'it carries the time it becomes eligible again');
  assert.strictEqual([...items].find(item => item.title === 'Winter Sonata S02').stage, 'search', 'its sibling season is unaffected');
});

test('season-pack preview: the per-run cap is shown as placement, not as truncation', async () => {
  const bed = previewBed({ maxPerRun: 2 });
  const items = await bed.sandbox.previewSeasonPacks({});
  assert.strictEqual(items.length, 3, 'seasons past the cap are still listed');
  assert.deepStrictEqual([...items].map(item => item.stage), ['search', 'search', 'held by per-run cap 2']);
});

test('season-pack preview: one unreadable series does not sink the whole preview', async () => {
  // The sweep audits and moves on; a preview that threw would report nothing at all because a
  // single series in the library is unreachable.
  const bed = previewBed({ episodeError: 1 });
  const items = await bed.sandbox.previewSeasonPacks({});
  assert.match([...items].find(item => item.title === 'Winter Sonata').reason, /episodes could not be read: Sonarr timed out/);
  assert.ok([...items].some(item => item.title === 'Dormant Drama S01'), 'the rest of the library is still evaluated');
});

test('season-pack preview: a large library is bounded rather than walked end to end', async () => {
  const bed = previewBed({ itemLimit: 2 });
  const items = await bed.sandbox.previewSeasonPacks({});
  assert.strictEqual(items.length, 2, 'the preview stops once it has enough to judge a threshold by');
});
