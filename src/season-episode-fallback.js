const { sha256 } = require('./util');

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function episodeKey(episode = {}) {
  return [Number(episode.episodeNumber) || 0, Number(episode.id) || 0];
}

function compareEpisodes(a, b) {
  const [aNumber, aId] = episodeKey(a);
  const [bNumber, bId] = episodeKey(b);
  return aNumber - bNumber || aId - bId;
}

function afterCursor(episode, cursor = {}) {
  const number = Number(cursor.episodeNumber);
  const id = Number(cursor.episodeId);
  if (!Number.isFinite(number) || !Number.isFinite(id)) return true;
  return compareEpisodes(episode, { episodeNumber: number, id }) > 0;
}

function releaseEpisodeNumbers(release = {}) {
  const values = Array.isArray(release.raw?.episodeNumbers) ? release.raw.episodeNumbers
    : Array.isArray(release.episodeNumbers) ? release.episodeNumbers
      : [];
  return new Set(values.map(positiveInteger).filter(Boolean));
}

function releaseMatchesAnchor(release, anchor = {}) {
  const wantedSeason = positiveInteger(anchor.seasonNumber);
  const wantedEpisode = positiveInteger(anchor.episodeNumber);
  if (!wantedSeason || !wantedEpisode) return false;
  if (releaseEpisodeNumbers(release).has(wantedEpisode)) return true;
  return Number(release.parsed?.season) === wantedSeason
    && Number(release.parsed?.episode) === wantedEpisode;
}

function classifyEpisodeFallbackEvidence({ ranked = [], packChoice = {}, anchorEpisode = null, error = null, observedAt = Date.now() } = {}) {
  let status = 'no_approved_episode';
  let candidate = null;
  if (error) status = 'unavailable';
  else if (packChoice?.pick) status = 'eligible_pack';
  else {
    candidate = ranked.find(release => release.approved === true
      && release.downloadAllowed !== false
      && !release.isPack
      && (!Array.isArray(release.rejections) || release.rejections.length === 0)
      && releaseMatchesAnchor(release, {
        seasonNumber: anchorEpisode?.seasonNumber,
        episodeNumber: anchorEpisode?.episodeNumber,
      })) || null;
    if (candidate) status = 'approved_episode';
  }
  const fingerprint = sha256(JSON.stringify({
    status,
    anchorEpisodeId: positiveInteger(anchorEpisode?.id),
    anchorEpisodeNumber: positiveInteger(anchorEpisode?.episodeNumber),
    candidate: candidate ? {
      id: candidate.guid || `${candidate.indexerId ?? ''}:${candidate.title}`,
      title: candidate.title,
      approved: candidate.approved,
      downloadAllowed: candidate.downloadAllowed,
    } : null,
  }));
  return {
    status,
    fingerprint,
    observedAt: Number(observedAt) || Date.now(),
    anchorEpisodeId: positiveInteger(anchorEpisode?.id),
    anchorEpisodeNumber: positiveInteger(anchorEpisode?.episodeNumber),
  };
}

function liveMissingEpisodes(episodes = [], { seasonNumber, now = Date.now() } = {}) {
  return episodes.filter(episode => {
    const airedAt = Date.parse(episode.airDateUtc || episode.airDate || '');
    return Number(episode.seasonNumber) === Number(seasonNumber)
      && positiveInteger(episode.id)
      && positiveInteger(episode.episodeNumber)
      && episode.monitored === true
      && !episode.hasFile
      && Number.isFinite(airedAt)
      && airedAt <= now;
  }).sort(compareEpisodes);
}

function planEpisodeFallback({
  seasonNumber,
  episodes = [],
  evidence = null,
  queuedEpisodeIds = [],
  claimedEpisodeIds = [],
  seasonQueued = false,
  seasonClaimed = false,
  pendingState = null,
  enabled = true,
  now = Date.now(),
  budget = {},
} = {}) {
  const missing = liveMissingEpisodes(episodes, { seasonNumber, now });
  const base = { missing: missing.length, submitted: 0, deferred: missing.length, episodeIds: [] };
  if (!missing.length) return { ...base, action: 'resolved', reason: 'season_complete', deferred: 0 };
  if (!enabled) return { ...base, action: 'blocked', reason: 'fallback_disabled' };
  if (evidence?.status === 'eligible_pack') return { ...base, action: 'blocked', reason: 'eligible_pack' };
  if (seasonQueued || seasonClaimed) return { ...base, action: 'blocked', reason: 'season_covered' };
  const nextEligibleAt = Number(pendingState?.nextEligibleAt);
  if (Number.isFinite(nextEligibleAt) && nextEligibleAt > now) {
    return { ...base, action: 'wait', reason: 'retry_cooldown', nextEligibleAt };
  }
  if (!evidence) return { ...base, action: 'no_evidence', reason: 'evidence_not_observed' };
  if (evidence.status === 'unavailable') return { ...base, action: 'no_evidence', reason: 'interactive_unavailable' };
  if (evidence.status !== 'approved_episode') return { ...base, action: 'no_evidence', reason: 'no_approved_episode' };

  const covered = new Set([...queuedEpisodeIds, ...claimedEpisodeIds].map(positiveInteger).filter(Boolean));
  const uncovered = missing.filter(episode => !covered.has(Number(episode.id)));
  if (!uncovered.length) return { ...base, action: 'blocked', reason: 'season_covered', deferred: 0 };
  const after = uncovered.filter(episode => afterCursor(episode, {
    episodeNumber: pendingState?.cursorEpisodeNumber,
    episodeId: pendingState?.cursorEpisodeId,
  }));
  if (!after.length) return { ...base, action: 'resolved', reason: 'cycle_complete', deferred: uncovered.length };

  const perSeason = Math.max(0, Number(budget.perSeason) || 0);
  const remainingGlobal = Math.max(0, Number(budget.remainingGlobal) || 0);
  const limit = Math.min(perSeason, remainingGlobal);
  if (!limit) return { ...base, action: 'blocked', reason: 'global_budget_exhausted', deferred: uncovered.length };
  const selected = after.slice(0, limit);
  const last = selected[selected.length - 1];
  return {
    ...base,
    action: 'submit',
    reason: 'approved_episode',
    episodeIds: selected.map(episode => Number(episode.id)),
    submitted: selected.length,
    deferred: Math.max(0, uncovered.length - selected.length),
    cursorEpisodeNumber: Number(last.episodeNumber),
    cursorEpisodeId: Number(last.id),
  };
}

function orderPendingFallbacks(rows = []) {
  return [...rows].sort((a, b) => (Number(a.next_eligible_at) || 0) - (Number(b.next_eligible_at) || 0)
    || (Number(a.last_attempt_at) || 0) - (Number(b.last_attempt_at) || 0)
    || Number(a.series_id) - Number(b.series_id)
    || Number(a.season_number) - Number(b.season_number));
}

module.exports = {
  classifyEpisodeFallbackEvidence,
  liveMissingEpisodes,
  planEpisodeFallback,
  orderPendingFallbacks,
};
