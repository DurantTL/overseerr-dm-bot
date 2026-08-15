#!/usr/bin/env node
const { test } = require('node:test');
const assert = require('node:assert');
const {
  episodeKey,
  episodeLabel,
  isAiredEpisode,
  decideEpisodeRecoveryAction,
  exactEpisodeCandidates,
  readEpisodeRecoveryConfig,
  createEpisodeRecoveryWorker,
} = require('../../src/episode-recovery');

test('episode-recovery: key/label/aired helpers, recovery decision, exact candidates, config parsing', () => {
  const HOUR = 3600000;
  const now = Date.parse('2026-07-26T12:00:00Z');
  const episode = { id: 22, seriesId: 7, seasonNumber: 2, episodeNumber: 3, monitored: true, hasFile: false, airDateUtc: '2026-07-25T12:00:00Z' };
  const series = { title: 'Example Show' };
  assert.strictEqual(episodeKey(episode), '7:22');
  assert.strictEqual(episodeLabel(series, episode), 'Example Show S02E03');
  assert.strictEqual(isAiredEpisode(episode, now), true);
  assert.strictEqual(isAiredEpisode({ ...episode, hasFile: true }, now), false);
  assert.strictEqual(isAiredEpisode({ ...episode, airDateUtc: '2026-07-27T12:00:00Z' }, now), false);

  const cfg = { publicGraceHours: 6, avistazGraceHours: 12 };
  const facts = { hasFile: false, monitored: true, aired: true, seriesTagged: true, inQueue: false, activeGrab: false };
  assert.strictEqual(decideEpisodeRecoveryAction({ first_seen_at: now }, facts, now + 5 * HOUR, cfg), 'wait');
  assert.strictEqual(decideEpisodeRecoveryAction({ first_seen_at: now }, facts, now + 6 * HOUR, cfg), 'search_public');
  assert.strictEqual(decideEpisodeRecoveryAction({ first_seen_at: now, public_searched_at: now + 6 * HOUR }, facts, now + 17 * HOUR, cfg), 'wait');
  assert.strictEqual(decideEpisodeRecoveryAction({ first_seen_at: now, public_searched_at: now + 6 * HOUR }, facts, now + 18 * HOUR, cfg), 'search_avistaz');
  assert.strictEqual(decideEpisodeRecoveryAction({ first_seen_at: now }, { ...facts, inQueue: true }, now + 99 * HOUR, cfg), 'wait');
  assert.strictEqual(decideEpisodeRecoveryAction({ first_seen_at: now }, { ...facts, hasFile: true }, now, cfg), 'resolve');
  assert.strictEqual(decideEpisodeRecoveryAction({ first_seen_at: now }, { ...facts, monitored: false }, now, cfg), 'ignore');

  const candidates = [
    { releaseTitle: 'Example.Show.S02E03.1080p', parsed: { season: 2, episode: 3, seasonPack: false } },
    { releaseTitle: 'Example.Show.S02E04.1080p', parsed: { season: 2, episode: 4, seasonPack: false } },
    { releaseTitle: 'Example.Show.S02.Complete', parsed: { season: 2, episode: null, seasonPack: true } },
  ];
  assert.deepStrictEqual(exactEpisodeCandidates(candidates, episode).map(x => x.releaseTitle), ['Example.Show.S02E03.1080p']);

  const parsed = readEpisodeRecoveryConfig({
    EPISODE_RECOVERY_ENABLED: 'true',
    EPISODE_RECOVERY_CHECK_MINUTES: '2',
    EPISODE_RECOVERY_MIN_CONFIDENCE: '150',
  });
  assert.strictEqual(parsed.enabled, true);
  assert.strictEqual(parsed.checkMinutes, 5, 'minimum check interval enforced');
  assert.strictEqual(parsed.minConfidence, 100, 'confidence clamped');
});

test('episode-recovery: concurrent sweeps are refused', async () => {
  let release;
  const tag = new Promise(resolve => { release = resolve; });
  const worker = await createEpisodeRecoveryWorker({
    CONFIG: { SONARR_URL: 'http://sonarr', PROWLARR_URL: 'http://prowlarr', RTORRENT_URL: 'http://rtorrent', AVISTAZ_TAG: 'avistaz' },
    recoveryConfig: { enabled: true, checkMinutes: 30, publicGraceHours: 6, avistazGraceHours: 12, lookbackDays: 14, maxPerRun: 3, minConfidence: 88 },
    dbApi: { db: { exec() {} }, getSetting: () => null },
    arrApi: { getArrTagId: () => tag },
    grabApi: {},
    rtorrentApi: {},
    axios: {},
    log: { info() {}, warn() {} },
  });
  const first = worker.sweep();
  await Promise.resolve();
  assert.deepStrictEqual(await worker.sweep(), { busy: true });
  release(null);
  assert.deepStrictEqual(await first, { skipped: true, reason: 'tag_missing' });
});

test('episode-recovery: preview applies unsaved grace without writes or searches', async () => {
  let writes = 0;
  let searches = 0;
  const now = Date.now();
  const db = {
    exec() { writes++; },
    prepare() {
      return {
        get() { return undefined; },
        run() { writes++; },
      };
    },
  };
  const worker = await createEpisodeRecoveryWorker({
    CONFIG: {
      SONARR_URL: 'http://sonarr', SONARR_API_KEY: 'key', PROWLARR_URL: 'http://prowlarr',
      RTORRENT_URL: 'http://rtorrent', AVISTAZ_TAG: 'avistaz', AVISTAZ_DAILY_GRAB_LIMIT: 10,
    },
    recoveryConfig: { enabled: true, checkMinutes: 30, publicGraceHours: 6, avistazGraceHours: 12, lookbackDays: 14, maxPerRun: 3, minConfidence: 88 },
    dbApi: {
      db, getSetting: () => null, listActiveGrabJobs: () => [], listRequestedTvdbIds: () => new Set(),
      mediaPriorityMap: () => new Map(),
    },
    arrApi: {
      getArrTagId: async () => 7,
      fetchArrQueues: async () => [],
      sonarrGet: async path => path === '/series'
        ? [{ id: 1, tvdbId: 2, title: 'Example', monitored: true, tags: [7] }]
        : [{ id: 3, seriesId: 1, seasonNumber: 1, episodeNumber: 2, monitored: true, hasFile: false, airDateUtc: new Date(now - 3600000).toISOString() }],
    },
    grabApi: {
      findAvistazIndexer: async () => ({ id: 9 }),
      releaseContentClaim: () => null,
      searchAvistaz: async () => { searches++; return []; },
    },
    rtorrentApi: {},
    axios: { post: async () => { searches++; } },
    log: { info() {}, warn() {} },
  });
  writes = 0;

  const result = await worker.preview({ EPISODE_RECOVERY_PUBLIC_GRACE_HOURS: '0' });

  assert.strictEqual(result.items[0].stage, 'search_public');
  assert.strictEqual(writes, 0);
  assert.strictEqual(searches, 0);
});
