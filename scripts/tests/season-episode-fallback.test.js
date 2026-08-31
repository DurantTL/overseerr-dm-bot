const test = require('node:test');
const assert = require('node:assert');
const {
  classifyEpisodeFallbackEvidence,
  planEpisodeFallback,
  orderPendingFallbacks,
} = require('../../src/season-episode-fallback');
const { classifySeasonRelease } = require('../../src/season-release');
const { loadSandbox } = require('./extract');
const Database = require('better-sqlite3');
const { normalizeTitle, releaseContentClaim, seriesAliasMatch } = require('../../src/grab');
const { orderPendingFallbacks: orderRows } = require('../../src/season-episode-fallback');

const NOW = Date.parse('2026-08-17T00:00:00Z');
const episodes = count => Array.from({ length: count }, (_, index) => ({
  id: 1000 + index,
  seasonNumber: 1,
  episodeNumber: index + 1,
  monitored: true,
  hasFile: false,
  airDateUtc: '2026-08-01T00:00:00Z',
}));
const evidence = { status: 'approved_episode' };

test('episode fallback evidence requires a clean approved exact-episode release', () => {
  const anchorEpisode = episodes(1)[0];
  const approved = classifySeasonRelease({ title: 'Revenge S01E01 720p HDTV', approved: true, downloadAllowed: true }, { season: 1 });
  assert.strictEqual(classifyEpisodeFallbackEvidence({ ranked: [approved], anchorEpisode, observedAt: NOW }).status, 'approved_episode');

  for (const release of [
    classifySeasonRelease({ title: 'La Luna Sangre S01E01', approved: false, rejections: ['Unknown Series'] }, { season: 1 }),
    classifySeasonRelease({ title: 'Revenge S01E01', approved: true, downloadAllowed: false }, { season: 1 }),
    classifySeasonRelease({ title: 'Revenge S01E02', approved: true }, { season: 1 }),
  ]) {
    assert.strictEqual(classifyEpisodeFallbackEvidence({ ranked: [release], anchorEpisode }).status, 'no_approved_episode');
  }
  assert.strictEqual(classifyEpisodeFallbackEvidence({ ranked: [], anchorEpisode }).status, 'no_approved_episode');
  assert.strictEqual(classifyEpisodeFallbackEvidence({ ranked: [], anchorEpisode, error: new Error('timeout') }).status, 'unavailable');
});

test('eligible pack evidence always blocks episode fallback', () => {
  const result = classifyEpisodeFallbackEvidence({
    ranked: [],
    packChoice: { pick: { title: 'Revenge S01 Complete' } },
    anchorEpisode: episodes(1)[0],
  });
  assert.strictEqual(result.status, 'eligible_pack');
  assert.strictEqual(planEpisodeFallback({ seasonNumber: 1, episodes: episodes(22), evidence: result, now: NOW, budget: { perSeason: 25, remainingGlobal: 50 } }).reason, 'eligible_pack');
});

test('planner bounds 22, 72, and 138 episode seasons and advances a durable cursor', () => {
  assert.strictEqual(planEpisodeFallback({ seasonNumber: 1, episodes: episodes(22), evidence, now: NOW, budget: { perSeason: 25, remainingGlobal: 50 } }).submitted, 22);
  const first = planEpisodeFallback({ seasonNumber: 1, episodes: episodes(72), evidence, now: NOW, budget: { perSeason: 25, remainingGlobal: 50 } });
  assert.deepStrictEqual({ submitted: first.submitted, deferred: first.deferred, cursor: first.cursorEpisodeNumber }, { submitted: 25, deferred: 47, cursor: 25 });
  const second = planEpisodeFallback({ seasonNumber: 1, episodes: episodes(138), evidence, now: NOW, pendingState: { cursorEpisodeNumber: 25, cursorEpisodeId: 1024 }, budget: { perSeason: 25, remainingGlobal: 25 } });
  assert.deepStrictEqual({ first: second.episodeIds[0], last: second.episodeIds.at(-1), submitted: second.submitted, deferred: second.deferred }, { first: 1025, last: 1049, submitted: 25, deferred: 113 });
});

test('planner rechecks live monitored, aired, file, queue, claim, cooldown, and global budget state', () => {
  const live = episodes(5);
  live[0].hasFile = true;
  live[1].monitored = false;
  live[2].airDateUtc = '2026-09-01T00:00:00Z';
  let result = planEpisodeFallback({ seasonNumber: 1, episodes: live, evidence, queuedEpisodeIds: [1003], claimedEpisodeIds: [1004], now: NOW, budget: { perSeason: 25, remainingGlobal: 50 } });
  assert.deepStrictEqual({ action: result.action, reason: result.reason }, { action: 'blocked', reason: 'season_covered' });
  result = planEpisodeFallback({ seasonNumber: 1, episodes: episodes(5), evidence, seasonQueued: true, now: NOW, budget: { perSeason: 25, remainingGlobal: 50 } });
  assert.strictEqual(result.reason, 'season_covered');
  result = planEpisodeFallback({ seasonNumber: 1, episodes: episodes(5), evidence, pendingState: { nextEligibleAt: NOW + 1 }, now: NOW, budget: { perSeason: 25, remainingGlobal: 50 } });
  assert.strictEqual(result.reason, 'retry_cooldown');
  result = planEpisodeFallback({ seasonNumber: 1, episodes: episodes(5), evidence, now: NOW, budget: { perSeason: 25, remainingGlobal: 0 } });
  assert.strictEqual(result.reason, 'global_budget_exhausted');
});

test('pending fallback ordering is stable and favors the earliest retry', () => {
  const ordered = orderPendingFallbacks([
    { series_id: 2, season_number: 1, next_eligible_at: 20 },
    { series_id: 1, season_number: 2, next_eligible_at: 10, last_attempt_at: 5 },
    { series_id: 1, season_number: 1, next_eligible_at: 10, last_attempt_at: null },
  ]);
  assert.deepStrictEqual(ordered.map(row => `${row.series_id}:${row.season_number}`), ['1:1', '1:2', '2:1']);
});

test('Arr episode helper validates, deduplicates, and submits one bounded command payload', async () => {
  const calls = [];
  const sandbox = loadSandbox(['triggerEpisodeSearch'], {
    axios: { post: async (...args) => { calls.push(args); return { data: { id: 44 } }; } },
    CONFIG: { SONARR_URL: 'http://sonarr', SONARR_API_KEY: 'secret' },
  });
  assert.deepStrictEqual(await sandbox.triggerEpisodeSearch([3, 3, 4]), { id: 44 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls[0][1])), { name: 'EpisodeSearch', episodeIds: [3, 4] });
  await assert.rejects(sandbox.triggerEpisodeSearch([]), /positive Sonarr episode id/);
  await assert.rejects(sandbox.triggerEpisodeSearch([0]), /positive Sonarr episode id/);
});

function drainBed({ rows, finalQueue = [], preview = false } = {}) {
  const mutableRows = rows.map(row => ({ state: 'pending', next_eligible_at: null, ...row }));
  const commands = [];
  const writes = [];
  const notices = [];
  const seriesList = [...new Map(mutableRows.map(row => [row.series_id, {
    id: row.series_id, title: row.series_title, monitored: true,
  }])).values()];
  const allEpisodes = Object.fromEntries(mutableRows.map(row => [row.series_id, episodes(row.episodeCount || 72).map(ep => ({
    ...ep, id: row.series_id * 10000 + ep.episodeNumber,
  }))]));
  const tunables = {
    SEASON_PACK_EPISODE_FALLBACK: true,
    SEASON_PACK_EPISODE_BATCH_SIZE: 25,
    SEASON_PACK_EPISODE_MAX_PER_RUN: 50,
    SEASON_PACK_EPISODE_RETRY_MINUTES: 180,
  };
  const names = ['episodeFallbackRetryMs', 'episodeFallbackEvidenceFromRow', 'episodeFallbackPendingState', 'episodeFallbackCoverage', 'drainSeasonEpisodeFallbacks'];
  const sandbox = loadSandbox(names, {
    tunable: key => tunables[key],
    previewRuntimeValue: (_values, key) => tunables[key],
    orderPendingFallbacks: orderRows,
    listSeasonEpisodeFallbacks: () => mutableRows,
    getSeasonEpisodeFallback: (seriesId, seasonNumber) => mutableRows.find(row => row.series_id === seriesId && row.season_number === seasonNumber),
    getSeriesEpisodes: async seriesId => allEpisodes[seriesId],
    listActiveGrabJobs: () => [],
    normalizeTitle,
    seriesAliasMatch,
    sonarrSeriesAliases: series => [normalizeTitle(series?.title)].filter(Boolean),
    releaseContentClaim,
    planEpisodeFallback,
    fetchArrQueues: async () => finalQueue,
    triggerEpisodeSearch: async ids => { commands.push([...ids]); return { id: 700 + commands.length }; },
    markSeasonEpisodeFallbackSubmitted: detail => {
      writes.push({ kind: 'submitted', detail });
      const row = mutableRows.find(item => item.series_id === detail.seriesId && item.season_number === detail.seasonNumber);
      Object.assign(row, { state: 'submitted', last_command_id: detail.commandId, cursor_episode_number: detail.cursorEpisodeNumber, cursor_episode_id: detail.cursorEpisodeId, submitted_count: detail.submittedCount, deferred_count: detail.deferredCount });
      return true;
    },
    attachSeasonEpisodeFallbackCommand: (seriesId, seasonNumber, commandId) => {
      const row = mutableRows.find(item => item.series_id === seriesId && item.season_number === seasonNumber);
      row.last_command_id = commandId;
      return true;
    },
    finishSeasonEpisodeFallback: detail => { writes.push({ kind: 'finished', detail }); return true; },
    clearSeasonEpisodeFallback: () => { writes.push({ kind: 'cleared' }); return true; },
    monitorEpisodeFallback: () => {},
    audit: () => {},
    notifyChannel: (_channel, message) => notices.push(message),
    pad: number => String(number).padStart(2, '0'),
    COLORS: { INFO: 1 },
    brandedEmbed: () => ({ setTitle() { return this; }, setDescription() { return this; } }),
  });
  return { sandbox, mutableRows, seriesList, commands, writes, notices, preview };
}

test('guarded drain shares the global cap and excludes a queue race on its final live read', async () => {
  const rows = [1, 2].map(seriesId => ({
    series_id: seriesId, season_number: 1, series_title: `Series ${seriesId}`, episodeCount: 72,
    evidence_status: 'approved_episode', evidence_fingerprint: `evidence-${seriesId}`,
    evidence_observed_at: NOW, anchor_episode_id: seriesId * 10000 + 1, anchor_episode_number: 1,
  }));
  const bed = drainBed({
    rows,
    finalQueue: [{ source: { kind: 'tv' }, seriesId: 1, seasonNumber: 1, episodeNumber: 1, episodeNumbers: [], fullSeason: false }],
  });
  const result = await bed.sandbox.drainSeasonEpisodeFallbacks({ seriesList: bed.seriesList, queue: [] });
  assert.strictEqual(result.submitted, 50);
  assert.deepStrictEqual(bed.commands.map(ids => ids.length), [25, 25]);
  assert.ok(!bed.commands[0].includes(10001), 'the episode queued between reads is removed');
  assert.strictEqual(bed.writes.filter(write => write.kind === 'submitted').length, 2);
});

test('fallback preview uses persisted evidence and performs no search or write', async () => {
  const bed = drainBed({ rows: [{
    series_id: 3, season_number: 1, series_title: 'Majika', episodeCount: 138,
    evidence_status: 'approved_episode', evidence_fingerprint: 'cached', evidence_observed_at: NOW,
    anchor_episode_id: 30001, anchor_episode_number: 1,
  }] });
  const result = await bed.sandbox.drainSeasonEpisodeFallbacks({ seriesList: bed.seriesList, queue: [], preview: true, values: {} });
  assert.strictEqual(bed.commands.length, 0);
  assert.strictEqual(bed.writes.length, 0);
  assert.match(result.items[0].reason, /25 submit, 113 deferred/);
  assert.match(result.items[0].reason, /evidence observed/);
});

test('durable fallback state survives reload and submitted transition is one-shot', () => {
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE season_episode_fallbacks (
    series_id INTEGER NOT NULL, season_number INTEGER NOT NULL, series_title TEXT, state TEXT NOT NULL,
    evidence_status TEXT NOT NULL, evidence_fingerprint TEXT NOT NULL, evidence_observed_at INTEGER NOT NULL,
    anchor_episode_id INTEGER, anchor_episode_number INTEGER, last_command_id INTEGER,
    cursor_episode_number INTEGER, cursor_episode_id INTEGER, submitted_count INTEGER DEFAULT 0,
    deferred_count INTEGER DEFAULT 0, last_attempt_at INTEGER, next_eligible_at INTEGER,
    last_outcome TEXT, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (series_id, season_number));`);
  const names = ['recordSeasonEpisodeFallbackEvidence', 'getSeasonEpisodeFallback', 'listSeasonEpisodeFallbacks',
    'markSeasonEpisodeFallbackSubmitted', 'finishSeasonEpisodeFallback', 'clearSeasonEpisodeFallback'];
  let store = loadSandbox(names, { db: database });
  store.recordSeasonEpisodeFallbackEvidence({ seriesId: 7, seasonNumber: 2, seriesTitle: 'Revenge', evidence: {
    status: 'approved_episode', fingerprint: 'positive', observedAt: NOW, anchorEpisodeId: 7001, anchorEpisodeNumber: 1,
  }, now: NOW });
  assert.strictEqual(store.markSeasonEpisodeFallbackSubmitted({ seriesId: 7, seasonNumber: 2, commandId: 99, cursorEpisodeNumber: 22, cursorEpisodeId: 7022, submittedCount: 22, deferredCount: 0, nextEligibleAt: NOW + 1, now: NOW }), true);
  assert.strictEqual(store.markSeasonEpisodeFallbackSubmitted({ seriesId: 7, seasonNumber: 2, commandId: 100, cursorEpisodeNumber: 22, cursorEpisodeId: 7022, submittedCount: 22, deferredCount: 0, nextEligibleAt: NOW + 1, now: NOW }), false);
  store = loadSandbox(names, { db: database });
  assert.deepStrictEqual({ state: store.getSeasonEpisodeFallback(7, 2).state, command: store.getSeasonEpisodeFallback(7, 2).last_command_id }, { state: 'submitted', command: 99 });
  store.finishSeasonEpisodeFallback({ seriesId: 7, seasonNumber: 2, outcome: 'no_episode_release', nextEligibleAt: NOW + 1000, resetCursor: true, now: NOW + 2 });
  assert.deepStrictEqual({ state: store.getSeasonEpisodeFallback(7, 2).state, cursor: store.getSeasonEpisodeFallback(7, 2).cursor_episode_number }, { state: 'cooldown', cursor: null });
  database.close();
});

test('restart reconciliation waits on running commands and cools down unknown commands', async () => {
  const row = { series_id: 7, season_number: 2, series_title: 'Revenge', state: 'submitted', last_command_id: 99, next_eligible_at: 0 };
  const names = ['episodeFallbackRetryMs', 'drainSeasonEpisodeFallbacks'];
  const tunable = key => ({
    SEASON_PACK_EPISODE_FALLBACK: true,
    SEASON_PACK_EPISODE_BATCH_SIZE: 25,
    SEASON_PACK_EPISODE_MAX_PER_RUN: 50,
    SEASON_PACK_EPISODE_RETRY_MINUTES: 180,
  })[key];
  let deferred = 0;
  let finished = null;
  let sandbox = loadSandbox(names, {
    tunable,
    orderPendingFallbacks: values => values,
    listSeasonEpisodeFallbacks: () => [row],
    getSonarrCommand: async () => ({ status: 'started' }),
    deferSubmittedSeasonEpisodeFallback: () => { deferred++; },
    finishSeasonEpisodeFallback: detail => { finished = detail; },
    audit: () => {},
  });
  await sandbox.drainSeasonEpisodeFallbacks({ seriesList: [], queue: [] });
  assert.strictEqual(deferred, 1);
  assert.strictEqual(finished, null);

  sandbox = loadSandbox(names, {
    tunable,
    orderPendingFallbacks: values => values,
    listSeasonEpisodeFallbacks: () => [row],
    getSonarrCommand: async () => null,
    deferSubmittedSeasonEpisodeFallback: () => {},
    finishSeasonEpisodeFallback: detail => { finished = detail; },
    audit: () => {},
  });
  await sandbox.drainSeasonEpisodeFallbacks({ seriesList: [], queue: [] });
  assert.strictEqual(finished.outcome, 'command_unknown');
  assert.ok(finished.nextEligibleAt > Date.now(), 'unknown command cannot immediately resubmit');
});

test('failed episode fallback command enters cooldown and reports a distinct failure', async () => {
  let finished;
  const audits = [];
  const sandbox = loadSandbox(['episodeFallbackRetryMs', 'finishEpisodeFallbackCommand'], {
    tunable: key => key === 'SEASON_PACK_EPISODE_RETRY_MINUTES' ? 180 : undefined,
    CONFIG: { SEASON_PACK_COOLDOWN_HOURS: 24 },
    getSeriesEpisodes: async () => episodes(3),
    fetchArrQueues: async () => [],
    finishSeasonEpisodeFallback: detail => { finished = detail; },
    clearSeasonEpisodeFallback: () => {},
    clearSeasonAlertState: () => {},
    recordSeasonNoGrab: () => ({ shouldAlert: true }),
    sha256: value => value,
    audit: (action, detail) => audits.push({ action, detail }),
    notifyChannel: () => {},
    pad: value => String(value).padStart(2, '0'),
    COLORS: { INFO: 1, DANGER: 2 },
    brandedEmbed: () => ({ setTitle() { return this; }, setDescription() { return this; } }),
  });
  const result = await sandbox.finishEpisodeFallbackCommand({
    series_id: 7, season_number: 1, series_title: 'Revenge', last_command_id: 99,
    submitted_count: 22, deferred_count: 0, cursor_episode_number: 22,
  }, { status: 'failed', message: 'indexer unavailable' });
  assert.strictEqual(result.outcome, 'failed');
  assert.strictEqual(finished.outcome, 'failed');
  assert.match(finished.error, /indexer unavailable/);
  assert.ok(audits.some(row => row.action === 'episode_fallback_failed'));
});

test('planner refuses to spend grabs while the download path is blocked', () => {
  // Submitting here would hand Sonarr 25 episodes to grab into a client that refuses to import
  // any of them. The reason is distinct from fallback_disabled so the cause stays legible.
  const blocked = planEpisodeFallback({
    seasonNumber: 1, episodes: episodes(36), evidence, downloadPathBlocked: true,
    now: NOW, budget: { perSeason: 25, remainingGlobal: 50 },
  });
  assert.deepStrictEqual({ action: blocked.action, reason: blocked.reason, submitted: blocked.submitted },
    { action: 'blocked', reason: 'download_path_blocked', submitted: 0 });
  // And it is a pause, not a cancellation: the same season submits normally once cleared.
  const cleared = planEpisodeFallback({
    seasonNumber: 1, episodes: episodes(36), evidence, downloadPathBlocked: false,
    now: NOW, budget: { perSeason: 25, remainingGlobal: 50 },
  });
  assert.strictEqual(cleared.action, 'submit');
  assert.strictEqual(cleared.submitted, 25);
});
