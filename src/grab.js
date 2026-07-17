// AvistaZ direct grab: search AvistaZ through Prowlarr, score the results, and decide what
// the grab-job sweep should do. Everything decision-shaped is pure (directly testable);
// index.js wires Discord, rTorrent, rclone, and the arr import around these verdicts.
//
// This is the smarter sibling of the tag-based escalation in src/arr.js: instead of handing
// the search to Radarr/Sonarr (which grab whatever scores best and burn AvistaZ download
// slots on their own judgement), the bot searches Prowlarr itself, ranks the candidates,
// and only sends a chosen torrent to the seedbox — with an allowance counter so a limited
// AvistaZ account can't be drained by automation.
const axios = require('axios');
const { CONFIG } = require('./config');

// The full pipeline needs Prowlarr (search), rTorrent (download), and an rclone remote +
// local staging folder (transfer & import).
const grabConfigured = () => !!(CONFIG.PROWLARR_URL && CONFIG.RTORRENT_URL && CONFIG.GRAB_RCLONE_REMOTE && CONFIG.GRAB_STAGING_PATH);

// The arr that will import a grab of this media type — a movie grab is useless without
// Radarr, a TV grab without Sonarr. Null means "don't even start the download".
function grabImportTarget(mediaType, cfg = CONFIG) {
  if (mediaType === 'tv') return cfg.SONARR_URL ? 'sonarr' : null;
  return cfg.RADARR_URL ? 'radarr' : null;
}

// ---- Prowlarr ----
// The AvistaZ indexer as defined in Prowlarr, matched by name (case-insensitive substring,
// so 'AvistaZ (API)' matches the default 'avistaz').
async function findAvistazIndexer(cfg = CONFIG) {
  const res = await axios.get(`${cfg.PROWLARR_URL}/api/v1/indexer`, { headers: { 'X-Api-Key': cfg.PROWLARR_API_KEY }, timeout: 10000 });
  const wanted = cfg.AVISTAZ_INDEXER_NAME;
  return (res.data || []).find(ix => String(ix.name || '').toLowerCase().includes(wanted)) || null;
}

// Search scoped to that one indexer. Torznab categories: 2000 = Movies, 5000 = TV.
async function searchAvistaz({ query, mediaType, indexerId }, cfg = CONFIG) {
  const res = await axios.get(`${cfg.PROWLARR_URL}/api/v1/search`, {
    params: { query, indexerIds: indexerId, categories: mediaType === 'tv' ? 5000 : 2000, type: 'search', limit: 50 },
    headers: { 'X-Api-Key': cfg.PROWLARR_API_KEY },
    timeout: 90000, // private-tracker searches routinely take tens of seconds
  });
  return res.data || [];
}

// Fetch the .torrent file behind a Prowlarr result (the downloadUrl already carries the
// apikey). The bytes go straight to rTorrent — the seedbox can't reach Prowlarr itself.
async function fetchTorrentFile(downloadUrl) {
  const res = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 60000, maxRedirects: 5 });
  return Buffer.from(res.data);
}

// ---- Release parsing & scoring ----
const normalizeTitle = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function parseReleaseName(name) {
  const n = String(name || '');
  const resolution = (n.match(/\b(2160p|1080p|720p|480p)\b/i) || [])[1]?.toLowerCase() || null;
  const source = /web[-. ]?dl/i.test(n) ? 'webdl'
    : /web[-. ]?rip/i.test(n) ? 'webrip'
      : /\bhdtv\b/i.test(n) ? 'hdtv'
        : /blu[-. ]?ray|bdrip|brrip|remux/i.test(n) ? 'bluray'
          : null;
  const se = n.match(/\bS(\d{1,2})[\s._-]*E(\d{1,3})\b/i);
  const seasonOnly = se ? null : n.match(/\bS(\d{1,2})\b/i);
  const complete = /\bcomplete\b/i.test(n);
  const year = (n.match(/\b((?:19|20)\d{2})\b/) || [])[1];
  return {
    resolution,
    source,
    season: se ? Number(se[1]) : seasonOnly ? Number(seasonOnly[1]) : null,
    episode: se ? Number(se[2]) : null,
    seasonPack: (!!seasonOnly || complete) && !se,
    year: year ? Number(year) : null,
  };
}

// Additive confidence score, 0–100. Budget: title 40, year/season fit 15, quality 15,
// seeders 15, size sanity 10, freeleech 5. Zero seeders caps the whole thing at 40 — a
// dead torrent can never look auto-grabbable no matter how perfect the name is.
// ctx = { title, year, mediaType, season } (year/season optional).
function scoreAvistazResult(result, ctx) {
  const parsed = parseReleaseName(result.title);
  const flags = (result.indexerFlags || []).map(f => String(f).toLowerCase());
  const freeleech = flags.some(f => f.includes('freeleech'));
  const notes = [];
  let score = 0;

  const wantTokens = normalizeTitle(ctx.title).split(' ').filter(Boolean);
  const haystack = ` ${normalizeTitle(result.title)} `;
  const matched = wantTokens.filter(t => haystack.includes(` ${t} `)).length;
  score += wantTokens.length ? Math.round(40 * (matched / wantTokens.length)) : 0;
  if (matched < wantTokens.length) notes.push('partial title match');

  if (ctx.mediaType === 'movie') {
    if (!ctx.year || !parsed.year) score += 8;
    else if (Math.abs(parsed.year - ctx.year) <= 1) score += 15;
    else notes.push(`year mismatch (${parsed.year})`);
  } else if (ctx.season != null) {
    if (parsed.seasonPack && (parsed.season === ctx.season || parsed.season == null)) score += 15;
    else if (parsed.season === ctx.season) { score += 6; notes.push('single episode, not a season pack'); }
    else if (parsed.season == null) score += 5;
    else notes.push(`wrong season (S${parsed.season})`);
  } else {
    // No season specified: prefer packs/complete runs, single episodes are a poor fit.
    if (parsed.seasonPack) score += 15;
    else if (parsed.episode != null) { score += 4; notes.push('single episode'); }
    else score += 8;
  }

  const resPts = { '1080p': 10, '720p': 7, '2160p': 4, '480p': 2 }[parsed.resolution] ?? 4;
  const srcPts = { webdl: 5, bluray: 5, webrip: 4, hdtv: 2 }[parsed.source] ?? 2;
  score += Math.min(15, resPts + srcPts);

  const seeders = Number(result.seeders) || 0;
  score += seeders >= 10 ? 15 : seeders >= 3 ? 11 : seeders >= 1 ? 6 : 0;
  if (!seeders) notes.push('no seeders');

  const sizeGb = (Number(result.size) || 0) / 1024 ** 3;
  const minGb = ctx.mediaType === 'tv' && parsed.seasonPack ? 2 : 0.2;
  if (sizeGb >= minGb && sizeGb <= 200) score += 10;
  else notes.push(sizeGb ? `suspicious size (${sizeGb.toFixed(1)} GB)` : 'unknown size');

  if (freeleech) score += 5;

  let confidence = Math.max(0, Math.min(100, score));
  if (!seeders) confidence = Math.min(confidence, 40);
  return { confidence, notes, parsed, freeleech };
}

// Score, sort, and normalize the raw Prowlarr results into what the embeds and grab flow
// need. Results with no downloadUrl (nothing to grab) are dropped.
function rankAvistazResults(results, ctx, { limit = 3 } = {}) {
  return (results || [])
    .filter(r => r.downloadUrl)
    .map(r => {
      const { confidence, notes, parsed, freeleech } = scoreAvistazResult(r, ctx);
      return {
        releaseTitle: r.title,
        downloadUrl: r.downloadUrl,
        // Prowlarr sometimes knows the info-hash up front — it enables the duplicate
        // check to run BEFORE the metered .torrent download.
        infoHash: r.infoHash ? String(r.infoHash).toUpperCase() : null,
        size: Number(r.size) || 0,
        seeders: Number(r.seeders) || 0,
        confidence,
        notes,
        freeleech,
        resolution: parsed.resolution,
        source: parsed.source,
        seasonPack: parsed.seasonPack,
      };
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

// ---- Allowance ----
// AvistaZ accounts have limited download slots; the counter refuses grabs beyond the daily
// limit so automation can't drain the account. 0/unset = unlimited.
function grabAllowance(usedToday, dailyLimit) {
  if (!dailyLimit || dailyLimit <= 0) return { limited: false, remaining: null, exhausted: false };
  const remaining = Math.max(0, dailyLimit - usedToday);
  return { limited: true, remaining, exhausted: remaining <= 0 };
}

// ---- Grab-job sweep state machine ----
// What the sweep should do with one active ('sent'/'downloading') grab_jobs row.
// facts = { reachable, found, complete } from rTorrent; reachable=false means the RPC call
// itself failed, which proves nothing about the torrent — never fail a job on it.
// cfg = { missingAfterMinutes, downloadTimeoutHours }
function decideGrabJobAction(row, facts, now, cfg) {
  if (!facts.reachable) return 'wait';
  if (!facts.found) {
    // Grace period: rTorrent needs a moment to register freshly pushed bytes.
    return now - row.sent_at > cfg.missingAfterMinutes * 60000 ? 'fail_missing' : 'wait';
  }
  if (facts.complete) return 'transfer';
  if (now - row.sent_at > cfg.downloadTimeoutHours * 3600000) return 'fail_timeout';
  return row.state === 'sent' ? 'mark_downloading' : 'wait';
}

module.exports = { grabConfigured, grabImportTarget, findAvistazIndexer, searchAvistaz, fetchTorrentFile, normalizeTitle, parseReleaseName, scoreAvistazResult, rankAvistazResults, grabAllowance, decideGrabJobAction };
