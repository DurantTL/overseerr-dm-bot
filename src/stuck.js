'use strict';
// Stuck-download consolidation. TV shows can now arrive from either download path (public
// indexers via Deluge, or the AvistaZ private-tracker fallback), and each episode is its own
// Sonarr queue item — so a whole season stalling used to fire one "Download Stuck" alert per
// episode. These pure helpers detect frozen queue items (byte-movement per item) and then
// collapse them into one alert per series+season, so a stuck season is a single message.
const { queueItemLooksUnhealthy } = require('./util');

// Per-queue-item byte-movement tracking. Returns `{ item, frozenMs }` for every item whose
// download has been frozen (or is flagged unhealthy by the *arr) for at least stuckAfterMs.
// Mutates `tracker` in place and prunes entries for queue items no longer present.
function detectStuckItems(items, tracker, { stuckAfterMs, now }) {
  const seen = new Set();
  const stuck = [];
  for (const item of items) {
    const key = `${item.source.label}:${item.queueId}`;
    seen.add(key);
    const entry = tracker.get(key);
    if (!entry || entry.sizeleft !== item.sizeleft) {
      // Progress (bytes moved) or first sighting — (re)arm the frozen clock.
      tracker.set(key, { sizeleft: item.sizeleft, since: now });
      continue;
    }
    const unhealthy = queueItemLooksUnhealthy(item);
    const shouldBeMoving = item.status === 'downloading' || item.trackedState === 'downloading';
    if (!(unhealthy || shouldBeMoving)) continue;
    const frozenMs = now - entry.since;
    if (frozenMs < stuckAfterMs) continue;
    stuck.push({ item, frozenMs });
  }
  for (const key of tracker.keys()) if (!seen.has(key)) tracker.delete(key);
  return stuck;
}

// Consolidation key. TV episodes collapse to one key per series+season so a whole season going
// stuck is a single alert; movies (and any TV item we can't place in a season, e.g. a season
// pack with no episode attached) stay keyed by their own queue id. Same key feeds the alert
// cooldown, the ignore flag, and the button handler (which re-derives members from the queue).
function stuckGroupKey(item) {
  if (item.source.kind === 'tv' && item.seasonNumber != null) {
    const sid = item.seriesId ?? item.seriesTvdbId ?? item.seriesTitle ?? item.title;
    return `${item.source.label}:s:${sid}:${item.seasonNumber}`;
  }
  return `${item.source.label}:${item.queueId}`;
}

// Group detected stuck items by stuckGroupKey. Each group carries its source, its members, and
// the longest-frozen duration in the group (used for the "hasn't moved in ~N min" copy).
function groupStuckItems(stuckItems) {
  const groups = new Map();
  for (const s of stuckItems) {
    const key = stuckGroupKey(s.item);
    let g = groups.get(key);
    if (!g) {
      g = { key, source: s.item.source, members: [], maxFrozenMs: 0 };
      groups.set(key, g);
    }
    g.members.push(s);
    if (s.frozenMs > g.maxFrozenMs) g.maxFrozenMs = s.frozenMs;
  }
  return groups;
}

// True when a group is a consolidated TV season (multiple episodes or one, keyed by series+season)
// rather than a single movie / lone item — drives the embed layout.
function isSeasonGroup(group) {
  return group.source.kind === 'tv' && group.members.length > 0 && group.members[0].item.seasonNumber != null;
}

module.exports = { detectStuckItems, stuckGroupKey, groupStuckItems, isSeasonGroup };
