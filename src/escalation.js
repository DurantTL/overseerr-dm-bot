// AvistaZ escalation decisions, kept pure so they're trivially testable. The sweep in index.js
// gathers the facts (Seerr availability, arr queue, arr file state) and acts on the verdicts.

// What the watchdog should do with one 'watching' escalations row.
// facts = { isAvailable, hasQueueItem, hasFile, inArr } — the first three: any true means the
// public pipeline delivered. inArr is three-valued: false = the arr verifiably does NOT have
// the title (Seerr accepted the request and then lost it — nothing can ever download), true =
// present, null/undefined = unknown (arr unreachable, or tv without a tvdb id) so no alarms.
// avistazFit is the AvistaZ-plausibility verdict for this title (see autoEscalateAllowed below).
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
  // Pre-authorization is necessary but not sufficient: firing without a human also has to be
  // something AvistaZ could plausibly satisfy. Anything else falls back to the button alert,
  // which is a delay, never a dead end.
  return row.pre_authorized && autoEscalateAllowed(row, facts.avistazFit) ? 'escalate' : 'alert';
}

// May this title escalate to AvistaZ with nobody in the loop? AvistaZ carries Asian movies and
// TV only, so an automatic escalation is worth it exactly when the title obviously belongs
// there. Movies are safe to include because their automatic path stays inside Radarr: the bot
// adds the tag and triggers MoviesSearch, leaving release acceptance to Radarr's decision engine.
// 'non_asian' (a US network drama) and 'unknown' (Seerr unreachable, sparse TMDB record) both
// mean "not obvious", and not-obvious means ask.
// avistazFit is the stored verdict: 'asian' | 'non_asian' | 'unknown' (or null when never
// assessed, which is treated as unknown).
function autoEscalateAllowed({ media_type: mediaType }, avistazFit) {
  if (!['movie', 'tv'].includes(mediaType)) return false;
  return avistazFit === 'asian';
}

// TV can use the bot's direct AvistaZ/seedbox planner before falling back to Sonarr. Movies stay
// in Radarr so its quality profile, custom formats, blocklist, and release matching remain the
// final acceptance boundary. Manual /avistaz searches are a separate, explicit admin workflow.
function usesDirectGrabEscalation({ media_type: mediaType }) {
  return mediaType === 'tv';
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

module.exports = { decideEscalationAction, escalationEligible, autoEscalateAllowed, usesDirectGrabEscalation };
