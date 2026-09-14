'use strict';

// TV season selection: shared between the /request slash command and the mobile request wizard
// (src/setup-request-ui.js) so both flows agree on how a season pick is parsed, validated,
// displayed, and stored. Movies never carry a season selection — every function here that takes
// a mediaType treats anything other than 'tv' as "not applicable" and returns null/no-op.

const ALL_SEASONS = 'all';

// Overseerr/Jellyseerr/Seerr media status enum, shared with src/seerr.js so a season counts as
// "already spoken for" the same way checkExistingSeerrMedia decides the whole show is.
const SEERR_STATUS = { UNKNOWN: 1, PENDING: 2, PROCESSING: 3, PARTIALLY_AVAILABLE: 4, AVAILABLE: 5 };
const isCoveredStatus = status => status >= SEERR_STATUS.PENDING && status <= SEERR_STATUS.AVAILABLE;

function normalizeSeasonList(seasons) {
  const list = Array.isArray(seasons) ? seasons : [seasons];
  return [...new Set(list.map(Number).filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}

// Canonical string for comparing/storing a selection: 'all' for the all-seasons sentinel (or
// null/undefined, which callers use interchangeably with 'all'), otherwise a JSON array of
// sorted, de-duplicated season numbers. Two selections are the "same" iff this key matches.
function seasonsKey(seasons) {
  if (seasons == null || seasons === ALL_SEASONS) return ALL_SEASONS;
  return JSON.stringify(normalizeSeasonList(seasons));
}

function seasonsEqual(a, b) {
  return seasonsKey(a) === seasonsKey(b);
}

// What gets written to requests.seasons / the pending-request stash. Movies always store null —
// the column (and this whole feature) simply doesn't apply to them, so a movie row before and
// after this change looks identical.
function seasonsToStorageKey(mediaType, seasons) {
  if (mediaType !== 'tv') return null;
  return seasonsKey(seasons);
}

function seasonsFromStorageKey(raw) {
  if (raw == null) return null;
  if (raw === ALL_SEASONS) return ALL_SEASONS;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeSeasonList(parsed) : null;
  } catch (_e) {
    return null;
  }
}

// Parses the /request `seasons` option and the mobile wizard's season-picker selection. Accepts
// "all"/empty (explicit or default → ALL_SEASONS), single numbers, comma lists, and ranges
// ("1,3,5", "1-3", "1-3,7"). Never throws — callers show `error` to the user instead.
function parseSeasonSelection(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text || text === 'all' || text === 'all seasons') return { ok: true, seasons: ALL_SEASONS };
  const parts = text.split(',').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return { ok: true, seasons: ALL_SEASONS };
  const numbers = new Set();
  for (const part of parts) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let a = Number(range[1]); let b = Number(range[2]);
      if (a > b) [a, b] = [b, a];
      if (b - a > 200) return { ok: false, error: `Season range "${part}" is too wide.` };
      for (let n = a; n <= b; n++) numbers.add(n);
      continue;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: `"${part}" isn't a valid season number.` };
    numbers.add(n);
  }
  if (!numbers.size) return { ok: false, error: 'No valid season numbers found.' };
  return { ok: true, seasons: [...numbers].sort((a, b) => a - b) };
}

// Human-readable label used in confirmations, approval embeds, DMs, and /request-status.
function formatSeasonsLabel(seasons) {
  if (seasons == null || seasons === ALL_SEASONS) return 'all seasons';
  const list = normalizeSeasonList(seasons);
  if (!list.length) return 'no seasons';
  if (list.length === 1) return `season ${list[0]}`;
  return `seasons ${list.join(', ')}`;
}

// Narrows a requested selection against what Seerr says is actually requestable/already covered
// for this show, so "unavailable/already-requested seasons are handled clearly" (issue #255).
// `eligible`/`covered` are season-number arrays from src/seerr.js's fetchSeerrTvSeasonInfo; an
// empty `eligible` means that lookup failed or hasn't run — fail open and trust the request as-is
// rather than block a legitimate request on a Seerr hiccup (matches this codebase's convention
// elsewhere, e.g. checkExistingSeerrMedia).
function splitCoveredSeasons({ requested, eligible = [], covered = [] }) {
  const coveredSet = new Set(covered);
  if (requested == null || requested === ALL_SEASONS) {
    return { toSubmit: ALL_SEASONS, alreadyCovered: eligible.filter(n => coveredSet.has(n)), invalid: [] };
  }
  const list = normalizeSeasonList(requested);
  const eligibleSet = new Set(eligible);
  const invalid = eligibleSet.size ? list.filter(n => !eligibleSet.has(n)) : [];
  const valid = eligibleSet.size ? list.filter(n => eligibleSet.has(n)) : list;
  const alreadyCovered = valid.filter(n => coveredSet.has(n));
  const toSubmit = valid.filter(n => !coveredSet.has(n));
  return { toSubmit, alreadyCovered, invalid };
}

module.exports = {
  ALL_SEASONS,
  SEERR_STATUS,
  isCoveredStatus,
  normalizeSeasonList,
  seasonsKey,
  seasonsEqual,
  seasonsToStorageKey,
  seasonsFromStorageKey,
  parseSeasonSelection,
  formatSeasonsLabel,
  splitCoveredSeasons,
};
