// rTorrent ratio-based cleanup: remove seedbox torrents once they've given back enough upload,
// so a seedbox with a fixed slot count doesn't silently fill up with finished downloads nobody
// is watching anymore.
//
// Two independent triggers, evaluated fresh every sweep from what rTorrent itself reports —
// nothing here assumes yesterday's numbers still hold:
//   - "stalled at a good ratio": ratio has sat at or above the minimum AND hasn't moved since
//     the last sweep that saw it change, for at least the configured number of days. A ratio
//     that is still climbing is left alone — it's still doing its job as a seed.
//   - "force": ratio has crossed a high-enough bar that it's worth removing immediately,
//     unstalled or not.
//
// Pure decision function so behavior is testable without an rTorrent instance; index.js wires
// the rTorrent XML-RPC calls and the ratio_watch table around it.
//
// Ratios are handled throughout as rTorrent reports them: integer permille (ratio * 1000), so
// 0.5 is 500 and 2.0 is 2000. This avoids float drift in stored/compared values.

// `watch` is the stored { ratio_permille, ratio_changed_at } row for this hash, or null/undefined
// if none exists yet (never crossed the minimum, or was cleared because the ratio dropped back
// under it — a re-grab or reseed starts the stall clock over).
function decideRatioRemoval({ torrent, watch, now = Date.now(), minRatioPermille, stallDays, forceRatioPermille }) {
  const ratio = Number(torrent?.ratioPermille) || 0;

  if (forceRatioPermille > 0 && ratio >= forceRatioPermille) {
    return { action: 'remove', reason: 'force', ratio };
  }

  if (minRatioPermille <= 0 || ratio < minRatioPermille) {
    // Below the floor (or the floor is off): nothing to watch, and any prior watch row is stale.
    return watch ? { action: 'clear', ratio } : { action: 'none', ratio };
  }

  if (watch && Number(watch.ratio_permille) === ratio) {
    const stalledMs = now - Number(watch.ratio_changed_at || now);
    if (stallDays > 0 && stalledMs >= stallDays * 86400000) {
      return { action: 'remove', reason: 'stalled', ratio, stalledMs };
    }
    return { action: 'none', ratio };
  }

  // First sweep at/above the floor, or the ratio moved since the last one — (re)start the clock.
  return { action: 'watch', ratio, changedAt: now };
}

module.exports = { decideRatioRemoval };
