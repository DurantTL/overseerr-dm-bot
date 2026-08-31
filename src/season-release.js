// Pure decisions for Sonarr's interactive season-search results. Sonarr supplies useful facts
// (`fullSeason`, approval, rejection reasons), while grab.js supplies the release-name parser and
// scoring budget already used for private-tracker results. Keeping the merge here makes the
// eventual Discord/button flow testable without Sonarr or Discord.
const { parseReleaseName, scoreAvistazResult } = require('./grab');

const BYTES_PER_GB = 1024 ** 3;

function rejectionText(rejection) {
  if (typeof rejection === 'string') return rejection.trim();
  return String(rejection?.reason || rejection?.message || rejection?.type || '').trim();
}

function releaseRejections(release = {}) {
  return (Array.isArray(release.rejections) ? release.rejections : [])
    .map(rejectionText)
    .filter(Boolean);
}

function parsedReleaseCoversSeason(parsed, season) {
  if (!parsed.seasonPack) return false;
  if (parsed.multiSeason && parsed.season == null) return true;
  if (parsed.season == null) return Number(season) === 1;
  if (parsed.seasonEnd != null) return parsed.season <= season && season <= parsed.seasonEnd;
  return parsed.season === season;
}

function classifySeasonRelease(release = {}, { season } = {}) {
  const title = String(release.title || release.releaseTitle || 'Unknown release');
  const parsed = parseReleaseName(title);
  const wantedSeason = Number(season);
  const reportedSeason = Number(release.seasonNumber);
  const reportedPack = release.fullSeason === true;
  const namePack = parsed.seasonPack;
  const isPack = reportedPack || namePack;
  const reportedCovers = reportedPack && (!Number.isFinite(reportedSeason) || reportedSeason === wantedSeason);
  const nameCovers = Number.isFinite(wantedSeason) && parsedReleaseCoversSeason(parsed, wantedSeason);
  const packSignal = reportedPack === namePack ? (reportedPack ? 'reported_and_name' : 'none')
    : reportedPack ? 'reported_only'
      : 'name_only';
  const rejections = releaseRejections(release);
  return {
    guid: release.guid || null,
    indexerId: release.indexerId ?? null,
    indexer: String(release.indexer || release.indexerName || 'Unknown indexer'),
    title,
    size: Number(release.size) || 0,
    sizeGb: (Number(release.size) || 0) / BYTES_PER_GB,
    seeders: Number(release.seeders) || 0,
    leechers: Number(release.leechers) || 0,
    protocol: release.protocol || null,
    approved: release.approved === true,
    downloadAllowed: release.downloadAllowed !== false,
    // Sonarr's size floors are configured per quality definition, so the quality name is what
    // ties a size rejection back to the exact setting that produced it.
    quality: String(release.quality?.quality?.name || release.quality?.name || '') || null,
    isPack,
    coversSeason: isPack && (reportedCovers || nameCovers),
    reportedPack,
    namePack,
    packSignal,
    rejections,
    parsed,
    raw: release,
  };
}

function rankSeasonReleases(releases, ctx = {}, { limit = Infinity } = {}) {
  const season = Number(ctx.season);
  return (releases || []).map(release => {
    const classified = classifySeasonRelease(release, { season });
    const scored = scoreAvistazResult(release, { ...ctx, mediaType: 'tv', season });
    const notes = [...scored.notes];
    if (classified.packSignal === 'reported_only') notes.push('Sonarr reports a full season but the release name does not');
    if (classified.packSignal === 'name_only') notes.push('release name looks like a pack but Sonarr does not mark it full-season');
    return { ...classified, confidence: scored.confidence, notes };
  }).sort((a, b) => {
    const aPack = Number(a.isPack && a.coversSeason);
    const bPack = Number(b.isPack && b.coversSeason);
    return bPack - aPack
      || b.confidence - a.confidence
      || b.seeders - a.seeders
      || a.size - b.size
      || a.title.localeCompare(b.title);
  }).slice(0, Math.max(0, Number(limit) || 0));
}

function chooseSeasonPack(ranked, cfg = {}) {
  const minConfidence = cfg.minConfidence ?? 70;
  const minSeeders = cfg.minSeeders ?? 1;
  const minSizeGb = cfg.minSizeGb ?? 0.2;
  const maxSizeGb = cfg.maxSizeGb ?? 200;
  const runnerUpLimit = cfg.runnerUpLimit ?? 2;
  const releases = ranked || [];
  const packs = releases.filter(release => release.isPack && release.coversSeason);
  const grabbable = packs.filter(release => release.guid && release.indexerId != null);
  const seeded = grabbable.filter(release => release.seeders >= minSeeders);
  const saneSize = seeded.filter(release => release.sizeGb >= minSizeGb && release.sizeGb <= maxSizeGb);
  const eligible = saneSize.filter(release => release.confidence >= minConfidence);
  if (eligible.length) {
    return {
      pick: eligible[0],
      why: `${eligible[0].confidence}% confidence, ${eligible[0].seeders} seeder${eligible[0].seeders === 1 ? '' : 's'}`,
      runnersUp: eligible.slice(1, runnerUpLimit + 1),
    };
  }
  let why = 'No releases were returned.';
  if (releases.length && !packs.length) why = 'No full-season release covers the requested season.';
  else if (packs.length && !grabbable.length) why = 'The matching season packs do not include a usable Sonarr grab identity.';
  else if (grabbable.length && !seeded.length) why = `No matching season pack has at least ${minSeeders} seeder${minSeeders === 1 ? '' : 's'}.`;
  else if (seeded.length && !saneSize.length) why = `No seeded season pack is inside the ${minSizeGb}–${maxSizeGb} GB size band.`;
  else if (saneSize.length && !eligible.length) why = `No season pack reaches the ${minConfidence}% confidence threshold.`;
  return { pick: null, why, runnersUp: [] };
}

// ---- Rejection classification ----
// Sonarr explains every refusal in prose, and until now the bot rendered the first sentence into
// a Discord embed and threw the rest away. That makes the one question worth asking — "which of
// my Sonarr settings is actually blocking season packs?" — unanswerable, because the evidence is
// gone by the time anyone thinks to look. Bucketing the prose keeps the raw text for the operator
// while giving the rest of the pipeline something countable.
//
// Rules are ordered: the first match wins, and anything unrecognised stays 'other' with its text
// intact. Sonarr's wording drifts between versions, so this is deliberately forgiving — a missed
// match degrades to 'other' (a visible "we don't know") rather than silently landing in the wrong
// bucket and skewing a suggestion.
const REJECTION_RULES = [
  ['size_below_min', /smaller than minimum/i],
  ['size_above_max', /larger than maximum/i],
  ['custom_format_score', /custom format/i],
  ['cutoff_met', /equal or higher preference|meets cutoff|cutoff has already been met|not an upgrade|upgrade for existing/i],
  ['language', /\blanguages?\b/i],
  ['quality_not_wanted', /not wanted in profile|quality is (?:not wanted|rejected)/i],
  ['blocklisted', /blocklist|blacklist|is blocked/i],
  ['not_monitored', /not monitored/i],
  ['unmatched_series', /unknown series|unable to parse|matched to series by id/i],
  ['propers_repacks', /\b(?:proper|repack)\b/i],
];

// Operator-facing names. These appear in Discord, so they say what the operator would change.
const REJECTION_LABELS = {
  size_below_min: 'Sonarr minimum size limit',
  size_above_max: 'Sonarr maximum size limit',
  custom_format_score: 'Custom format score too low',
  cutoff_met: 'Existing files already meet the cutoff',
  language: 'Language not wanted in profile',
  quality_not_wanted: 'Quality not wanted in profile',
  blocklisted: 'Blocklisted release',
  not_monitored: 'Series or episode not monitored',
  unmatched_series: 'Sonarr could not match the release',
  propers_repacks: 'Proper/repack handling',
  other: 'Other',
};

function classifyRejection(text) {
  const reason = String(text || '');
  if (!reason.trim()) return 'other';
  for (const [bucket, pattern] of REJECTION_RULES) if (pattern.test(reason)) return bucket;
  return 'other';
}

const rejectionLabel = bucket => REJECTION_LABELS[bucket] || REJECTION_LABELS.other;

const SIZE_UNITS_MB = { b: 1 / (1024 ** 2), kb: 1 / 1024, mb: 1, gb: 1024, tb: 1024 ** 2 };
const sizeToMb = (value, unit) => {
  const factor = SIZE_UNITS_MB[String(unit || '').toLowerCase()];
  const parsed = Number(value);
  return factor && Number.isFinite(parsed) ? parsed * factor : null;
};

// Pull the numbers out of a size rejection so the limit can be compared against Sonarr's own
// quality definition without re-deriving it. Sonarr phrases these as
// "769.8 MB is smaller than minimum allowed 1.5 GB (for 45min)", and the per-minute ratio is the
// unit the quality definition is actually configured in — a raw byte count says nothing about
// whether the floor is reasonable, but MB/min compares directly against the setting.
// Every quantifier here is bounded. The input is Sonarr's own prose rather than anything a user
// supplies, but an unbounded `[\d.]+`/`[^.]*?` pair is a backtracking blowup waiting for the one
// malformed message that reaches it, and the real sentence is short enough that a ceiling costs
// nothing.
const SIZE_AMOUNT = '(\\d{1,12}(?:\\.\\d{1,4})?)\\s{0,4}(B|KB|MB|GB|TB)';
const SIZE_REJECTION = new RegExp(
  `${SIZE_AMOUNT}\\b[^.]{0,60}?(smaller than minimum allowed|larger than maximum allowed)\\s{0,4}${SIZE_AMOUNT}\\b(?:[^(]{0,40}\\(for\\s{0,4}(\\d{1,5})\\s{0,4}min)?`,
  'i');
function parseSizeRejection(text) {
  const match = SIZE_REJECTION.exec(String(text || ''));
  if (!match) return null;
  const actualMb = sizeToMb(match[1], match[2]);
  const limitMb = sizeToMb(match[4], match[5]);
  if (actualMb == null || limitMb == null) return null;
  const runtimeMinutes = Number(match[6]) || null;
  return {
    actualMb,
    limitMb,
    runtimeMinutes,
    // Sonarr's quality definitions are configured in MB per minute, so report both sides in it.
    actualMbPerMinute: runtimeMinutes ? actualMb / runtimeMinutes : null,
    limitMbPerMinute: runtimeMinutes ? limitMb / runtimeMinutes : null,
  };
}

// Every rejection on one release, classified and with any size numbers parsed out.
function classifyReleaseRejections(release = {}) {
  return releaseRejections(release).map(text => ({
    text,
    bucket: classifyRejection(text),
    size: parseSizeRejection(text),
  }));
}

// True when Sonarr's ONLY objection to this release is its minimum-size floor. This is the one
// rejection class that says nothing about whether the release is the right content — an efficient
// encode of a short episode trips it — which is why it is the only class the automatic force-grab
// may be allowed to override. Any second, different rejection makes this false: a pack that is
// both undersized and, say, the wrong language is not a size problem.
function rejectedOnlyForSizeFloor(release = {}) {
  const entries = classifyReleaseRejections(release);
  return entries.length > 0 && entries.every(entry => entry.bucket === 'size_below_min');
}

// Which rejection is blocking the season packs, across every pack candidate that covers the
// season. Ordered by how many distinct packs each bucket blocked, so the operator sees the one
// setting that would unblock the most releases rather than whichever candidate happened to rank
// first. Episode releases are excluded on purpose — they are not what this is trying to unblock.
function summarizePackRejections(ranked = []) {
  const packs = (ranked || []).filter(release => release.isPack && release.coversSeason);
  const buckets = new Map();
  for (const release of packs) {
    // One release counts once per bucket, however many reasons it listed in that bucket.
    for (const entry of new Map(classifyReleaseRejections(release).map(e => [e.bucket, e])).values()) {
      if (!buckets.has(entry.bucket)) {
        buckets.set(entry.bucket, { bucket: entry.bucket, label: rejectionLabel(entry.bucket), count: 0, sample: entry.text, size: entry.size, quality: release.quality });
      }
      const row = buckets.get(entry.bucket);
      row.count++;
      // Keep the highest floor seen — that is the one actually doing the blocking — and, among
      // equal floors, the least dense pack, since that is the release a new floor has to clear.
      const tighter = entry.size && (!row.size
        || entry.size.limitMb > row.size.limitMb
        || (entry.size.limitMb === row.size.limitMb && entry.size.actualMb < row.size.actualMb));
      if (tighter) { row.size = entry.size; row.sample = entry.text; row.quality = release.quality; }
    }
  }
  const ordered = [...buckets.values()].sort((a, b) => b.count - a.count || a.bucket.localeCompare(b.bucket));
  return { packCount: packs.length, rejectedPackCount: packs.filter(r => classifyReleaseRejections(r).length).length, buckets: ordered, primary: ordered[0] || null };
}

function describeRejections(release = {}) {
  const reasons = Array.isArray(release.rejections) && release.rejections.every(item => typeof item === 'string')
    ? release.rejections.filter(Boolean)
    : releaseRejections(release);
  if (!reasons.length) return release.approved === true ? 'Approved by Sonarr' : 'No rejection reason reported';
  const suffix = reasons.length > 1 ? ` (+${reasons.length - 1} more)` : '';
  return `${reasons[0]}${suffix}`.slice(0, 240);
}

module.exports = {
  classifySeasonRelease, rankSeasonReleases, chooseSeasonPack, describeRejections,
  classifyRejection, rejectionLabel, parseSizeRejection, classifyReleaseRejections,
  rejectedOnlyForSizeFloor, summarizePackRejections, REJECTION_LABELS,
};
