// AvistaZ escalation decisions, kept pure so they're trivially testable. The sweep in index.js
// gathers the facts (Seerr availability, arr queue, arr file state) and acts on the verdicts.

// What the watchdog should do with one 'watching' escalations row.
// facts = { isAvailable, hasQueueItem, hasFile, inArr } — the first three: any true means the
// public pipeline delivered. inArr is three-valued: false = the arr verifiably does NOT have
// the title (Seerr accepted the request and then lost it — nothing can ever download), true =
// present, null/undefined = unknown (arr unreachable, or tv without a tvdb id) so no alarms.
// cfg   = { delayMinutes, maxAgeDays, arrGraceMinutes }
function decideEscalationAction(row, facts, now, cfg) {
  if (facts.isAvailable || facts.hasQueueItem || facts.hasFile) return 'resolve';
  const age = now - row.approved_at;
  if (age > cfg.maxAgeDays * 86400000) return 'expire';
  // A title missing from its arr can't be escalated (the search/import has nothing to attach
  // to) — alert once so an admin can add it directly, then hold until it appears.
  if (facts.inArr === false && age >= (cfg.arrGraceMinutes ?? 10) * 60000) {
    return row.arr_missing_alerted ? 'wait' : 'alert_missing';
  }
  if (age < cfg.delayMinutes * 60000) return 'wait';
  return row.pre_authorized ? 'escalate' : 'alert';
}

// Whether a request can be escalated to AvistaZ at all. 4K is excluded by design (the fallback
// is for hard-to-find content, not 4K upgrades), and each media type needs its arr configured.
// cfg = { enabled, radarrConfigured, sonarrConfigured }
function escalationEligible({ mediaType, is4k }, cfg) {
  if (!cfg.enabled || is4k) return false;
  if (mediaType === 'movie') return !!cfg.radarrConfigured;
  if (mediaType === 'tv') return !!cfg.sonarrConfigured;
  return false;
}

module.exports = { decideEscalationAction, escalationEligible };
