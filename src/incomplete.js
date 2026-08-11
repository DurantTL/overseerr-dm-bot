'use strict';

// "Is the thing I asked for actually watchable yet?" — the question the request list cannot answer.
//
// A request row goes 'available' the moment Seerr says the media exists, which for a series means
// *one* episode imported. A show can sit at ✅ Available for weeks with two thirds of its episodes
// missing, and nothing in the bot's own status vocabulary distinguishes that from complete. These
// helpers work from Sonarr's episode truth instead, so a partially-filled series is visible as
// exactly that, with the per-season shape of the gap and whatever the bot is currently doing.
//
// Everything here is pure: callers pass fetched data in, and the numbers can be tested without a
// Sonarr, a database, or a rendered page.

// An episode counts against a series only if the viewer could reasonably expect it: a real season
// (not specials), monitored, already aired, and with no file. Unaired episodes are not a gap — a
// show mid-season would otherwise look permanently broken.
function isAiredMissing(episode, now = Date.now()) {
  if (!episode || episode.hasFile || !episode.monitored) return false;
  if (Number(episode.seasonNumber) <= 0) return false;
  const airedAt = Date.parse(episode.airDateUtc || episode.airDate || '');
  return Number.isFinite(airedAt) && airedAt <= now;
}

function isUpcoming(episode, now = Date.now()) {
  if (!episode || episode.hasFile || Number(episode.seasonNumber) <= 0) return false;
  const airedAt = Date.parse(episode.airDateUtc || episode.airDate || '');
  return Number.isFinite(airedAt) && airedAt > now;
}

// Per-season counts, ascending. `aired` is how many episodes of that season have aired at all, so
// "3 of 4" reads correctly for a season still in progress rather than against its eventual length.
function seasonGaps(episodes, now = Date.now()) {
  const bySeason = new Map();
  for (const episode of episodes || []) {
    const season = Number(episode?.seasonNumber);
    if (!Number.isFinite(season) || season <= 0) continue;
    if (!bySeason.has(season)) bySeason.set(season, { season, missing: 0, aired: 0, total: 0, upcoming: 0 });
    const row = bySeason.get(season);
    row.total += 1;
    if (isUpcoming(episode, now)) row.upcoming += 1;
    const airedAt = Date.parse(episode.airDateUtc || episode.airDate || '');
    if (Number.isFinite(airedAt) && airedAt <= now) row.aired += 1;
    if (isAiredMissing(episode, now)) row.missing += 1;
  }
  return [...bySeason.values()].filter(s => s.missing > 0).sort((a, b) => a.season - b.season);
}

function summarizeSeriesGaps({ series, episodes, now = Date.now() } = {}) {
  const seasons = seasonGaps(episodes, now);
  const airedMissing = seasons.reduce((n, s) => n + s.missing, 0);
  const airedTotal = (episodes || []).filter(e => {
    const t = Date.parse(e?.airDateUtc || e?.airDate || '');
    return Number(e?.seasonNumber) > 0 && Number.isFinite(t) && t <= now;
  }).length;
  return {
    seriesId: series?.id ?? null,
    tvdbId: series?.tvdbId ?? null,
    title: series?.title || 'Unknown series',
    status: series?.status || null,
    seasons,
    airedMissing,
    airedTotal,
    // Percentage of what has aired that is actually on disk — the number a requester cares about.
    pct: airedTotal ? Math.round(((airedTotal - airedMissing) / airedTotal) * 100) : 100,
    nextAiring: series?.nextAiring || null,
  };
}

// 'S01 all 10 · S03 2 of 8' — compact enough for a dashboard row, specific enough to act on.
function describeGaps(summary, maxSeasons = 4) {
  if (!summary || !summary.seasons.length) return '';
  const shown = summary.seasons.slice(0, maxSeasons).map(s => {
    const label = `S${String(s.season).padStart(2, '0')}`;
    return s.missing >= s.aired ? `${label} all ${s.aired}` : `${label} ${s.missing} of ${s.aired}`;
  });
  const rest = summary.seasons.length - shown.length;
  return shown.join(' · ') + (rest > 0 ? ` · +${rest} more season${rest === 1 ? '' : 's'}` : '');
}

// What, if anything, is already happening for this title. Ordered by how much it should reassure
// somebody looking at the row: an active download beats a queued search beats nothing at all.
function describeActivity({ queue = [], grabJobs = [], escalations = [], recoveryRows = [] } = {}, match = {}) {
  const { tvdbId = null, tmdbId = null, title = '' } = match;
  const titleKey = String(title).toLowerCase();
  const sameTitle = value => String(value || '').toLowerCase().includes(titleKey) && titleKey.length > 2;

  const queued = (queue || []).filter(q => (tvdbId != null && Number(q.tvdbId) === Number(tvdbId))
    || (tmdbId != null && Number(q.tmdbId) === Number(tmdbId))
    || sameTitle(q.title) || sameTitle(q.series?.title) || sameTitle(q.movie?.title));
  if (queued.length) {
    const worst = queued.some(q => String(q.trackedDownloadState || q.status || '').toLowerCase().includes('warn'));
    return { state: worst ? 'warn' : 'ok', note: `${queued.length} item${queued.length === 1 ? '' : 's'} in the download queue` };
  }

  const grabbing = (grabJobs || []).filter(j => sameTitle(j.title) || (tvdbId != null && Number(j.tvdbId) === Number(tvdbId)));
  if (grabbing.length) return { state: 'ok', note: `AvistaZ grab in progress (${grabbing[0].state})` };

  const watching = (escalations || []).filter(e => sameTitle(e.title) || (tvdbId != null && Number(e.tvdb_id) === Number(tvdbId)));
  if (watching.length) return { state: 'warn', note: `escalation watching (${watching[0].state || 'watching'})` };

  const recovering = (recoveryRows || []).filter(r => (tvdbId != null && Number(r.tvdb_id) === Number(tvdbId)) || sameTitle(r.series_title));
  if (recovering.length) {
    const searched = recovering.filter(r => r.public_searched_at).length;
    return { state: 'warn', note: `episode recovery tracking ${recovering.length} episode${recovering.length === 1 ? '' : 's'}${searched ? `, ${searched} already searched` : ''}` };
  }

  return { state: 'down', note: 'nothing in flight' };
}

// Dashboard rows, worst first: nothing-in-flight above already-downloading, bigger gaps above
// smaller. Someone opening this card wants the stalled things at the top, not an alphabetical list.
function rankIncomplete(rows) {
  const severity = { down: 0, warn: 1, ok: 2, skip: 3 };
  return [...rows].sort((a, b) => (severity[a.state] ?? 3) - (severity[b.state] ?? 3)
    || (b.missing || 0) - (a.missing || 0)
    || String(a.title).localeCompare(String(b.title)));
}

module.exports = { isAiredMissing, isUpcoming, seasonGaps, summarizeSeriesGaps, describeGaps, describeActivity, rankIncomplete };
