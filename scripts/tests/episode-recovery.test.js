#!/usr/bin/env node
const assert = require('assert');
const {
  episodeKey,
  episodeLabel,
  isAiredEpisode,
  decideEpisodeRecoveryAction,
  exactEpisodeCandidates,
  readEpisodeRecoveryConfig,
} = require('../../src/episode-recovery');

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
console.log('episode recovery tests passed');
