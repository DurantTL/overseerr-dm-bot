'use strict';

// F10 weekly viewing insights for the admin channel, from Tautulli's own history: what was
// watched most, who watched how much, and which recent additions were hits versus still
// untouched. Pure: the sweep in index.js fetches and posts. Per-person numbers stay in the
// admin channel; the public monthly recap is unchanged.

const DAY_MS = 86400000;
const HIT_WINDOW_MS = 3 * DAY_MS;       // watched within 3 days of being added
const UNWATCHED_AFTER_MS = 7 * DAY_MS;  // added at least a week ago and never played since
const TOP = 5;

const FIELD_MAX = 1024; // Discord's cap on one embed field value

// Whole lines that fit in one field, then "…and N more" for the rest (counting `hidden` items
// that never became lines). Never cuts a line in half, so the count is always visible.
function fit(lines, hidden = 0) {
  const kept = [];
  let used = 0;
  for (const l of lines) {
    const rest = lines.length - kept.length - 1 + hidden;
    const tail = rest > 0 ? `\n…and ${rest} more`.length : 0;
    if (used + l.length + (kept.length ? 1 : 0) + tail > FIELD_MAX) break;
    kept.push(l);
    used += l.length + (kept.length > 1 ? 1 : 0);
  }
  const more = lines.length - kept.length + hidden;
  return kept.join('\n') + (more > 0 ? `\n…and ${more} more` : '');
}

const isTv = type => ['episode', 'season', 'show'].includes(type);

// One normalised play from a get_history row, or null for music and unusable rows.
function toPlay(r) {
  if (!r || r.media_type === 'track') return null;
  const tv = isTv(r.media_type);
  const key = String((tv && r.grandparent_rating_key) || r.rating_key || '');
  const at = (Number(r.date) || Number(r.started) || 0) * 1000;
  if (!key || !at) return null;
  const seconds = Number(r.play_duration ?? r.duration);
  return {
    key,
    title: (tv ? r.grandparent_title : r.title) || r.full_title || 'Unknown',
    type: tv ? 'tv' : 'movie',
    user: String(r.friendly_name || r.user || r.user_id || 'Unknown'),
    at,
    seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
  };
}

const hours = seconds => {
  const h = seconds / 3600;
  return h >= 10 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`;
};

function topTitles(plays, type) {
  const by = new Map();
  for (const p of plays.filter(x => x.type === type)) {
    const e = by.get(p.key) || { title: p.title, plays: 0, users: new Set() };
    e.plays++;
    e.users.add(p.user);
    by.set(p.key, e);
  }
  return [...by.values()].sort((a, b) => b.plays - a.plays || b.users.size - a.users.size || a.title.localeCompare(b.title)).slice(0, TOP);
}

function perUser(plays) {
  const by = new Map();
  for (const p of plays) {
    const e = by.get(p.user) || { user: p.user, plays: 0, seconds: 0, titles: new Map() };
    e.plays++;
    e.seconds += p.seconds;
    e.titles.set(p.title, (e.titles.get(p.title) || 0) + 1);
    by.set(p.user, e);
  }
  return [...by.values()]
    .sort((a, b) => b.seconds - a.seconds || b.plays - a.plays)
    .map(e => ({ user: e.user, plays: e.plays, seconds: e.seconds, top: [...e.titles.entries()].sort((a, b) => b[1] - a[1])[0][0] }));
}

// Recent additions grouped by title (a show's newest episode counts), then split into hits
// (someone played it within 3 days of it arriving) and untouched (here a week or more, no play).
function additions(added, plays, { now, since }) {
  const byKey = new Map();
  for (const a of added) {
    if (!a.titleKey || !a.addedAt || a.addedAt < since) continue;
    const e = byKey.get(a.titleKey);
    if (!e || a.addedAt > e.addedAt) byKey.set(a.titleKey, { key: a.titleKey, title: a.title, addedAt: a.addedAt });
  }
  const hits = [];
  const untouched = [];
  for (const e of byKey.values()) {
    const after = plays.filter(p => p.key === e.key && p.at >= e.addedAt);
    const quick = after.filter(p => p.at - e.addedAt <= HIT_WINDOW_MS);
    if (quick.length) hits.push({ title: e.title, viewers: new Set(after.map(p => p.user)).size, plays: after.length });
    else if (!after.length && now - e.addedAt >= UNWATCHED_AFTER_MS) untouched.push({ title: e.title, days: Math.floor((now - e.addedAt) / DAY_MS) });
  }
  hits.sort((a, b) => b.viewers - a.viewers || b.plays - a.plays || a.title.localeCompare(b.title));
  untouched.sort((a, b) => b.days - a.days || a.title.localeCompare(b.title));
  return { hits: hits.slice(0, TOP), untouched: untouched.slice(0, TOP), untouchedTotal: untouched.length };
}

// historyRows: get_history rows covering at least `lookbackDays`; added: mapRecentlyAdded items.
// Returns { title, fields: [{ name, value }] } — short fields that read well on a phone.
function buildViewingInsights({ historyRows = [], added = [], now = Date.now(), days = 7, lookbackDays = 21 } = {}) {
  const allPlays = historyRows.map(toPlay).filter(Boolean);
  const plays = allPlays.filter(p => p.at >= now - days * DAY_MS);
  const fields = [];
  const line = (e, i) => `${i + 1}. ${e.title}: ${e.plays} play${e.plays === 1 ? '' : 's'} · ${e.users.size} viewer${e.users.size === 1 ? '' : 's'}`;
  const movies = topTitles(plays, 'movie');
  const shows = topTitles(plays, 'tv');
  if (movies.length) fields.push({ name: '🎬 Top movies', value: fit(movies.map(line)) });
  if (shows.length) fields.push({ name: '📺 Top shows', value: fit(shows.map(line)) });
  const users = perUser(plays);
  if (users.length) {
    const shown = users.slice(0, 10).map(u => `**${u.user}**: ${hours(u.seconds)} · ${u.plays} play${u.plays === 1 ? '' : 's'} · mostly ${u.top}`);
    fields.push({ name: '👥 Who watched', value: fit(shown, users.length - shown.length) });
  }
  const adds = additions(added, allPlays, { now, since: now - lookbackDays * DAY_MS });
  if (adds.hits.length) fields.push({ name: '🔥 New and watched fast', value: fit(adds.hits.map(h => `${h.title}: ${h.viewers} viewer${h.viewers === 1 ? '' : 's'}`)) });
  if (adds.untouched.length) {
    fields.push({ name: '💤 New but not watched yet', value: fit(adds.untouched.map(u => `${u.title}: added ${u.days} days ago`), adds.untouchedTotal - adds.untouched.length) });
  }
  const totalHours = plays.reduce((n, p) => n + p.seconds, 0);
  const title = plays.length
    ? `Viewing this week: ${plays.length} play${plays.length === 1 ? '' : 's'} · ${hours(totalHours)} · ${users.length} viewer${users.length === 1 ? '' : 's'}`
    : 'Viewing this week: nothing was played';
  return { title, fields };
}

module.exports = { fit, toPlay, topTitles, perUser, additions, buildViewingInsights, HIT_WINDOW_MS, UNWATCHED_AFTER_MS };
