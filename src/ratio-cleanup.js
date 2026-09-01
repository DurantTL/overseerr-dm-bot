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

// Whether the seedbox-side data for a removed torrent is safe for a human to go delete by
// hand. rTorrent's own d.erase never touches that data (see index.js sweepRatioCleanup), and
// this bot has no destructive seedbox access of its own — so "safe" here means only "this
// bot's pipeline has proof the release already landed in the media library", via the matching
// grab_jobs row reaching its terminal 'verified' state (set once the leftover-file check
// passes after the *arr's scan/import — see finishGrabJobImported in index.js). Anything
// short of that — no grab_jobs row at all (adopted or added outside this bot, or never
// matched), or one still mid-pipeline — is reported as unconfirmed rather than ever being
// called safe: a torrent this bot didn't grab may have been placed there for a reason it
// knows nothing about.
function describeDeletionSafety(job) {
  if (!job) return { safe: false, reason: 'no matching grab job — this bot never tracked it, so there is no confirmation it landed anywhere else' };
  if (job.state === 'verified') return { safe: true, reason: 'imported and verified in the media library' };
  return { safe: false, reason: `grab job #${job.id} is still '${job.state}' — import not confirmed yet` };
}

module.exports = { decideRatioRemoval, describeDeletionSafety };
