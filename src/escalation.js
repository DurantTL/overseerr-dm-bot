// AvistaZ escalation decisions, kept pure so they're trivially testable. The sweep in index.js
// gathers the facts (Seerr availability, arr queue, arr file state) and acts on the verdicts.

// What the watchdog should do with one 'watching' escalations row.
// facts = { isAvailable, hasQueueItem, hasFile } — any true means the public pipeline delivered.
// cfg   = { delayMinutes, maxAgeDays }
function decideEscalationAction(row, facts, now, cfg) {
  if (facts.isAvailable || facts.hasQueueItem || facts.hasFile) return 'resolve';
  const age = now - row.approved_at;
  if (age > cfg.maxAgeDays * 86400000) return 'expire';
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
