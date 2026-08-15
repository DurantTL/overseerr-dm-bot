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

function describeRejections(release = {}) {
  const reasons = Array.isArray(release.rejections) && release.rejections.every(item => typeof item === 'string')
    ? release.rejections.filter(Boolean)
    : releaseRejections(release);
  if (!reasons.length) return release.approved === true ? 'Approved by Sonarr' : 'No rejection reason reported';
  const suffix = reasons.length > 1 ? ` (+${reasons.length - 1} more)` : '';
  return `${reasons[0]}${suffix}`.slice(0, 240);
}

module.exports = { classifySeasonRelease, rankSeasonReleases, chooseSeasonPack, describeRejections };
