'use strict';

// Per-title priority for the bot's own work queues.
//
// Every sweep that talks to Sonarr is capped per run — season-pack search, episode recovery — and
// until now the cap fell wherever Sonarr's series order happened to put it. That is fine until you
// care about one specific show, at which point "it'll come round eventually" is not an answer.
//
// Pinning a title moves it to the front of those queues. It does NOT raise the cap: an operator
// pinning ten shows should get them searched first, not get thirty indexer searches in one sweep.
// The guarantee is position in line, not exemption from it — and across successive runs that is
// what actually gets a pinned show finished sooner.
//
// Priority lives in the bot, not in Sonarr, because Sonarr has no per-series priority concept to
// write to; what the bot controls is the order in which it asks.

// Stable key for a title across the request table, escalations, and arr payloads.
function priorityKey({ mediaType, tvdbId, tmdbId } = {}) {
  if (tvdbId != null && tvdbId !== '') return `tvdb:${tvdbId}`;
  if (tmdbId != null && tmdbId !== '') return `tmdb:${tmdbId}`;
  return mediaType ? `${mediaType}:unknown` : null;
}

// Ascending rank, ties broken by the caller's original order — so pinning is a promotion, never a
// reshuffle of everything else. `keyFor` maps an item to its priority key.
function orderByPriority(items, { keyFor, priority } = {}) {
  const ranks = priority instanceof Map ? priority : new Map(Object.entries(priority || {}));
  return (items || [])
    .map((item, index) => {
      const key = keyFor ? keyFor(item) : null;
      const rank = key != null && ranks.has(key) ? Number(ranks.get(key)) : null;
      return { item, index, rank: Number.isFinite(rank) ? rank : null };
    })
    .sort((a, b) => {
      if (a.rank == null && b.rank == null) return a.index - b.index;
      if (a.rank == null) return 1;
      if (b.rank == null) return -1;
      return a.rank - b.rank || a.index - b.index;
    })
    .map(entry => entry.item);
}

function isPinned(item, { keyFor, priority } = {}) {
  const ranks = priority instanceof Map ? priority : new Map(Object.entries(priority || {}));
  const key = keyFor ? keyFor(item) : null;
  return key != null && ranks.has(key);
}

// Next free rank, so a newly pinned title lands at the back of the pinned group rather than
// silently displacing whatever was pinned first.
function nextRank(rows) {
  const ranks = (rows || []).map(r => Number(r.rank)).filter(Number.isFinite);
  return ranks.length ? Math.max(...ranks) + 1 : 1;
}

module.exports = { priorityKey, orderByPriority, isPinned, nextRank };
