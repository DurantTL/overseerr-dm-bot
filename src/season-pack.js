// Season-pack-first searching for old shows.
//
// Sonarr's missing-episode search is per episode: a 30-episode drama from 2007 becomes 30
// separate searches and, if they land, 30 separate grabs. On a private tracker with a metered
// download allowance that's 30 slots for what one season pack would have cost, and on public
// indexers it's 30 chances to pick up a different release group per episode. For a show that
// finished airing years ago the whole season exists as a single torrent — that's what should
// be searched for.
//
// For a currently-airing show the opposite is true: episode 8 aired last night, no pack exists
// yet, and waiting for one means waiting weeks. So this is deliberately gated on the show being
// old, and everything here is pure so the gate is testable without Sonarr.

const DAY = 86400000;

// Is this series old enough that season packs should exist for it?
//   'ended'   — Sonarr says the show is over. Packs exist; nothing new will ever air.
//   'dormant' — still nominally continuing, but nothing has aired in dormantDays and nothing
//               is scheduled. A finished-but-unmarked show, or one between seasons long enough
//               that the last season is fully packed by now.
// A scheduled next airing always wins: a show returning next week is current, whatever its
// status field says, and its latest season is still being released episode by episode.
// series = { status, ended, nextAiring, previousAiring, lastAired } (Sonarr v3 series shape).
function assessSeriesAge(series = {}, now = Date.now(), cfg = {}) {
  const dormantDays = cfg.dormantDays ?? 365;
  const next = Date.parse(series.nextAiring || '');
  if (Number.isFinite(next) && next >= now) {
    return { old: false, reason: 'an episode is scheduled to air' };
  }
  const status = String(series.status || '').toLowerCase();
  if (series.ended === true || status === 'ended') return { old: true, reason: 'series has ended' };
  const prev = Date.parse(series.previousAiring || series.lastAired || '');
  if (Number.isFinite(prev)) {
    const days = Math.floor((now - prev) / DAY);
    return days >= dormantDays
      ? { old: true, reason: `nothing has aired in ${days} days` }
      : { old: false, reason: `last aired ${days} days ago` };
  }
  // No air dates at all (an unrefreshed or very sparse series). Claims nothing — the caller
  // leaves it to Sonarr's normal behavior rather than guessing.
  return { old: false, reason: 'no air dates known' };
}

// Which seasons of an old show should be searched as a pack instead of episode by episode.
// episodes = Sonarr /episode rows: { seasonNumber, episodeNumber, monitored, hasFile, airDateUtc }.
// Returns [{ season, missing, aired, total }] sorted by season, only for seasons worth a pack:
//
//   - Season 0 (specials) is skipped: specials are never packed together usefully.
//   - Only aired, monitored, file-less episodes count as missing. An unaired episode can't be
//     downloaded, and an unmonitored one was deliberately excluded.
//   - A season qualifies when the whole aired season is missing (the clean pack case), or when
//     at least minMissing episodes are missing (a pack is still cheaper than N episode grabs,
//     and Sonarr discards the episodes it already has).
//
// One or two missing episodes fall through on purpose: pulling a 20 GB pack to fill a single
// gap wastes far more bandwidth than it saves slots, and Sonarr's per-episode search handles
// that case well.
function planSeasonSearches(episodes, now = Date.now(), cfg = {}) {
  const minMissing = cfg.minMissing ?? 3;
  const seasons = new Map();
  for (const ep of episodes || []) {
    const season = Number(ep.seasonNumber);
    if (!Number.isFinite(season) || season <= 0) continue;
    const airedAt = Date.parse(ep.airDateUtc || ep.airDate || '');
    const aired = Number.isFinite(airedAt) && airedAt <= now;
    if (!seasons.has(season)) seasons.set(season, { season, missing: 0, aired: 0, total: 0 });
    const s = seasons.get(season);
    s.total++;
    if (!aired) continue;
    s.aired++;
    if (!ep.hasFile && ep.monitored) s.missing++;
  }
  return [...seasons.values()]
    .filter(s => s.missing > 0 && (s.missing === s.aired || s.missing >= minMissing))
    .sort((a, b) => a.season - b.season);
}

// The seasons of one series that warrant a pack search right now, with the verdict that
// justified it. `inQueue` holds season numbers already downloading — Sonarr is mid-grab there,
// so searching again would only race it. `searchedAt` maps season → last search time, applying
// the cooldown so a season with nothing available isn't re-searched every sweep.
//
// `requested` = somebody actually asked for this show. That bypasses the age gate (unless
// cfg.includeRequested is false): most shows are uploaded as an "S01" season pack whatever their
// age, and on a show someone is waiting for, one pack beating N episode grabs is worth more than
// on a show nobody asked about. It stays safe on a currently-airing season because the season
// still has to clear the missing-episode bar, and only aired episodes count — a season halfway
// through its run has nothing to search for until episodes actually go missing.
// Returns { old, eligible, reason, seasons: [{ season, missing, aired, total }] }.
function seasonSearchTargets({ series, episodes, inQueue = [], searchedAt = {}, requested = false }, now = Date.now(), cfg = {}) {
  const age = assessSeriesAge(series, now, cfg);
  const byRequest = requested && cfg.includeRequested !== false;
  const eligible = age.old || byRequest;
  if (!eligible) return { ...age, eligible: false, seasons: [] };
  // An old show says so; a current one is here purely because it was requested.
  const reason = age.old ? age.reason : 'requested';
  const cooldownMs = (cfg.cooldownHours ?? 24) * 3600000;
  const queued = new Set((inQueue || []).map(Number));
  const seasons = [];
  const held = [];
  for (const season of planSeasonSearches(episodes, now, cfg)) {
    if (queued.has(season.season)) continue;
    const last = Number(searchedAt[season.season]);
    if (Number.isFinite(last) && now - last < cooldownMs) {
      held.push({ ...season, nextEligible: last + cooldownMs });
    } else {
      seasons.push(season);
    }
  }
  return { ...age, eligible, reason, seasons, held };
}

// One line per searched season for the Discord summary.
function describeSeasonSearch(seriesTitle, season) {
  return `**${seriesTitle}** S${String(season.season).padStart(2, '0')} — ${season.missing} of ${season.aired} aired episode(s) missing`;
}

module.exports = { assessSeriesAge, planSeasonSearches, seasonSearchTargets, describeSeasonSearch };
