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

// Seerr/escalation titles often carry a trailing year — "My Title (2017)" — which hurts
// tracker search recall; split it into query + year for scoring instead. Moved here from
// index.js so the season-pack sweep (src/grab.js's only other module-level consumer, via
// index.js) can strip Sonarr's "Full House (2004)"-style titles before they become a
// required token in normalizeTitle.
function splitTitleYear(title) {
  const m = /^(.*?)\s*\(((?:19|20)\d{2})\)\s*$/.exec(String(title || ''));
  return m ? { query: m[1], year: Number(m[2]) } : { query: String(title || ''), year: null };
}

// ---- Series identity: accepted aliases + the alias gate ----
// Tokens that may legitimately differ between a release head and an accepted alias without
// meaning "different show": leading articles, country/edition qualifiers. Deliberately small —
// every token added here widens what counts as the same show.
const ALIAS_NOISE_TOKENS = new Set(['the', 'a', 'an', 'us', 'uk', 'au', 'ca', 'kr', 'jp', 'cn', 'tw', 'hk', 'th', 'ph', 'aka']);

// Every normalized, year-stripped title this series legitimately answers to: primary title,
// Sonarr-style alternateTitles ([{title}] or plain strings), clean/original title, and any
// caller-supplied extras. Deduped, empties dropped.
function buildSeriesAliases({ title = '', alternateTitles = [], cleanTitle = '', originalTitle = '', extra = [] } = {}) {
  const raw = [title, cleanTitle, originalTitle, ...extra,
    ...(alternateTitles || []).map(t => (typeof t === 'string' ? t : t?.title))];
  const set = new Set();
  for (const t of raw) {
    const { query } = splitTitleYear(t);
    const norm = normalizeTitle(query);
    if (norm) set.add(norm);
  }
  return [...set];
}

// Does a release's parsed series head (see seriesToken, below) name this series? `head` and
// `aliases` are both already-normalized strings. Conservative by design:
//   - exact:  head === some alias
//   - loose:  every head token not in the matched alias is ALIAS_NOISE_TOKENS-only extra
//   - else:   rejected, with the offending extra tokens reported
// An empty alias list or an unparseable head fails OPEN (ok:true, alias:null) — the gate only
// fires on positive evidence of a different show, matching releaseContentClaim's philosophy
// that an unparseable name is never blocked.
function seriesAliasMatch(head, aliases) {
  const h = normalizeTitle(head);
  if (!h || !aliases || !aliases.length) return { ok: true, exact: false, alias: null, extraTokens: [] };
  if (aliases.includes(h)) return { ok: true, exact: true, alias: h, extraTokens: [] };
  const headTokens = h.split(' ').filter(Boolean);
  let best = null;
  for (const alias of aliases) {
    const aliasTokens = new Set(alias.split(' ').filter(Boolean));
    const extraTokens = headTokens.filter(t => !aliasTokens.has(t));
    // Every head token accounted for either by the alias itself or by noise, and the alias
    // isn't just noise words matching nothing real in the head.
    if (extraTokens.every(t => ALIAS_NOISE_TOKENS.has(t)) && extraTokens.length < headTokens.length) {
      if (!best || extraTokens.length < best.extraTokens.length) best = { ok: true, exact: false, alias, extraTokens };
    }
  }
  if (best) return best;
  // Nothing matched even loosely — report the extras against the closest (shortest) alias for
  // a useful note.
  const closest = [...aliases].sort((a, b) => a.length - b.length)[0] || '';
  const closestTokens = new Set(closest.split(' ').filter(Boolean));
  return { ok: false, exact: false, alias: null, extraTokens: headTokens.filter(t => !closestTokens.has(t)) };
}

// Alias-less precision fallback: release-head tokens that aren't in the wanted title and aren't
// noise. Used by the score's precision penalty when no alias list was supplied.
function headExtraTokens(head, wantTokens) {
  const wanted = new Set(wantTokens);
  return normalizeTitle(head).split(' ').filter(Boolean).filter(t => !wanted.has(t) && !ALIAS_NOISE_TOKENS.has(t));
}

function parseReleaseName(name) {
  const n = String(name || '');
  const resolution = (n.match(/\b(2160p|1080p|720p|480p)\b/i) || [])[1]?.toLowerCase() || null;
  const source = /web[-. ]?dl/i.test(n) ? 'webdl'
    : /web[-. ]?rip/i.test(n) ? 'webrip'
      : /\bhdtv\b/i.test(n) ? 'hdtv'
        : /blu[-. ]?ray|bdrip|brrip|remux/i.test(n) ? 'bluray'
          : null;
  // SxxEyy, or the '1x05' form old rips still use.
  const se = n.match(/\bS(\d{1,2})[\s._-]*E(\d{1,3})\b/i) || n.match(/\b(\d{1,2})x(\d{1,3})\b/);
  // A trailing episode in a multi-episode file: "S01E01-E10", "S01E01E02". The E is required —
  // without it "S01E01.1080p" would read 1080 as the end episode.
  const seEnd = se ? n.slice(se.index + se[0].length).match(/^(?:[-–~]\s*)?E(\d{1,3})\b/i) : null;
  // Multi-season packs: "S01-S05", "S01~S03", "Season 1-3", "Seasons 1-5". Old shows are often
  // only available as one complete-series torrent, so these must parse as covering a RANGE of
  // seasons instead of mis-reading the first number as "season 1 only".
  const range = se ? null
    : n.match(/\bS(\d{1,2})\s*[-–~]\s*S?(\d{1,2})\b/i) || n.match(/\bseasons?[\s._]+(\d{1,2})\s*[-–~]\s*(\d{1,2})\b/i);
  const seasonOnly = se || range ? null : n.match(/\bS(\d{1,2})\b/i) || n.match(/\bseason[\s._]+(\d{1,2})\b/i);
  // "E01-E30" with no SxxEyy anywhere: a run of episodes shipped as one pack, which is how
  // single-season Asian dramas and old shows are usually uploaded. Without this the release
  // parses as nothing at all and the whole-series planner never sees the only pack on offer.
  const epRange = se || range ? null : n.match(/\bE(?:p)?(\d{1,3})\s*[-–~]\s*(?:E(?:p)?)?(\d{1,3})\b/i);
  const complete = /\bcomplete\b/i.test(n);
  const year = (n.match(/\b((?:19|20)\d{2})\b/) || [])[1];
  // An episode range with no season marker is season 1 — a show with only one season is exactly
  // the case that omits the marker.
  const season = se ? Number(se[1]) : range ? Number(range[1]) : seasonOnly ? Number(seasonOnly[1]) : epRange ? 1 : null;
  const seasonEnd = range ? Number(range[2]) : null;
  return {
    resolution,
    source,
    season,
    seasonEnd,
    episode: se ? Number(se[2]) : null,
    // Last episode of a multi-episode file, else null. Lets a claim cover E01–E10 instead of
    // just E01, so a second release of E02–E10 is recognized as a duplicate.
    episodeEnd: seEnd ? Number(seEnd[1]) : null,
    seasonPack: (!!seasonOnly || !!range || !!epRange || complete) && !se,
    // A whole show in one download: an explicit multi-season range, or "complete" with no
    // season marker at all ("Old.Drama.Complete.Series" — vs "S01.COMPLETE", one season).
    multiSeason: !se && ((!!range && Number(range[2]) > Number(range[1])) || (complete && season == null)),
    year: year ? Number(year) : null,
  };
}

// ---- Content-identity dedupe ----
// "Same content, different encoding/size" can't be caught by info-hash or exact release title:
// two different releases of the same episode or season pack have different hashes, names, and
// byte counts. So we reduce a release name to *what episodes it covers* — a normalized series
// token plus the seasons/episodes it claims — and block a new grab when an active job already
// covers any of the same episode-space. Deliberately conservative: an unparseable name yields no
// claim (null) and is never blocked, so a legitimately different episode is never lost.

// The series title is whatever precedes the first season/episode/complete marker, with any year
// stripped, normalized. TV only — a movie has no such marker and is deduped by resolved media id.
function seriesToken(name) {
  const n = String(name || '');
  // The `e\d` alternative catches the season-less "E01-E30" pack form; it sits last so a normal
  // SxxEyy name still cuts at the S (regex alternation takes the leftmost match, not the first
  // listed alternative).
  const m = n.match(/\b(s\d{1,2}(?:\s*e\d{1,3})?|\d{1,2}x\d{1,3}|seasons?[\s._]*\d{1,2}|complete|ep?\d{1,3}\s*[-–~])\b/i);
  const head = (m ? n.slice(0, m.index) : n).replace(/\b(?:19|20)\d{2}\b/g, ' ');
  return normalizeTitle(head);
}

// The scene/P2P group tag off the end of a release name — the trailing bracketed form
// ("...WEB-DL[rartv]") or the trailing dash-suffixed form ("...WEB-DL-RARBG"). Lowercased so
// "RARBG"/"rarbg"/"[RARBG]" all collapse to the same key for counting repeated dead groups.
// Unparseable/absent → null, same "don't act on silence" stance as parseReleaseName's fields.
function extractReleaseGroup(name) {
  const n = String(name || '').trim().replace(/\.(mkv|mp4|avi|torrent)$/i, '');
  const bracketed = n.match(/\[([A-Za-z0-9]+)\]\s*$/);
  if (bracketed) return bracketed[1].toLowerCase();
  const suffixed = n.match(/-([A-Za-z0-9]+)$/);
  if (suffixed) return suffixed[1].toLowerCase();
  return null;
}

// A release's claimed episode-space: { series, seasons:Set<int> (whole-season claims),
// episodes:Set<"s.e">, whole:bool (complete series → every season) }. Null when nothing usable
// parses. Built on the already-tested parseReleaseName so season/pack/range logic stays in one
// place; a multi-episode file only contributes its first episode (a safe under-claim).
function releaseContentClaim(name) {
  const series = seriesToken(name);
  if (!series) return null;
  const p = parseReleaseName(name);
  const seasons = new Set();
  const episodes = new Set();
  let whole = false;
  if (p.season != null && p.seasonEnd != null) { for (let s = p.season; s <= p.seasonEnd && s - p.season < 100; s++) seasons.add(s); }
  else if (p.multiSeason && p.season == null) whole = true;   // "Complete Series" with no season marker
  else if (p.season != null && p.episode != null) {
    // A multi-episode file claims its whole run (E01-E10), not just the first episode.
    const last = p.episodeEnd != null && p.episodeEnd > p.episode ? Math.min(p.episodeEnd, p.episode + 99) : p.episode;
    for (let e = p.episode; e <= last; e++) episodes.add(`${p.season}.${e}`);
  }
  else if (p.season != null) seasons.add(p.season);           // a single-season pack
  if (!whole && !seasons.size && !episodes.size) return null;
  return { series, seasons, episodes, whole };
}

// Do two claims cover any of the same episodes? Requires the same (non-empty) series token, then
// checks the covered spaces: a complete-series or same-season pack overlaps anything in that
// season; two single episodes overlap only when identical.
function contentClaimsOverlap(a, b) {
  if (!a || !b || !a.series || a.series !== b.series) return false;
  if (a.whole || b.whole) return true;
  for (const s of a.seasons) if (b.seasons.has(s)) return true;               // pack vs pack
  for (const e of a.episodes) if (b.seasons.has(Number(e.split('.')[0]))) return true; // a-episode in b-pack
  for (const e of b.episodes) if (a.seasons.has(Number(e.split('.')[0]))) return true; // b-episode in a-pack
  for (const e of a.episodes) if (b.episodes.has(e)) return true;            // episode vs episode
  return false;
}

// ---- Whole-series planning ----
// "Just get the whole thing": from ONE ranked search, choose a set of releases whose episode
// spaces don't overlap, so a complete-series pack — or per-season packs plus the odd
// gap-filling episode — can all be grabbed from a single prompt. Without this the Download
// buttons are one-of-N: clicking "Download 1" consumes the offer, and a title whose best
// AvistaZ release is a single episode never gets the rest.
//
// Greedy by BREADTH first, confidence second. Confidence alone gets this backwards on exactly
// the shows the feature exists for: an old drama's complete pack is typically a 2-seeder 720p
// rip (~80%) while someone's re-encode of episode 1 is a 12-seeder 1080p WEB-DL (~84%). Sorted
// by confidence the lone episode anchors the plan, claims S01E01, and the pack that holds all
// thirty episodes is then dropped as "already covered" — two download slots spent on two
// episodes. Breadth-first picks the pack and the episodes collapse into it instead.
// minConfidence still gates entry, so a dead pack can't win on breadth alone. The widest
// release claims its episodes first and every later pick can only add NEW ones, so the
// one-copy-per-episode guarantee is unchanged — this reuses the exact claim/overlap machinery
// that blocks duplicate grabs.

const claimBreadth = claim => (claim.whole ? 3 : claim.seasons.size > 1 ? 2 : claim.seasons.size ? 1 : 0);

// Does a claim touch the season the caller asked about? A null season means "any".
function claimCoversSeason(claim, season) {
  if (season == null) return true;
  if (!claim || claim.whole) return !!claim;
  if (claim.seasons.has(Number(season))) return true;
  for (const e of claim.episodes) if (Number(e.split('.')[0]) === Number(season)) return true;
  return false;
}

// picks = releases to grab, in grab order. covered = candidates dropped because an earlier pick
// already covers those episodes. trimmed = dropped by the `max` cap (allowance/config), i.e.
// real episodes left on the table — callers surface that so nobody thinks it grabbed everything.
// `exclude` takes release titles already in flight (active grab jobs) so a re-run adds only gaps.
function planSeriesGrab(candidates, { season = null, minConfidence = 0, max = 8, exclude = [], aliases = null } = {}) {
  const taken = (exclude || []).map(releaseContentClaim).filter(Boolean);
  const eligible = (candidates || [])
    .map(c => ({ c, claim: releaseContentClaim(c.releaseTitle) }))
    .filter(x => x.claim && Number(x.c.confidence) >= minConfidence && claimCoversSeason(x.claim, season)
      && (!aliases || !aliases.length || seriesAliasMatch(x.claim.series, aliases).ok))
    .sort((a, b) => claimBreadth(b.claim) - claimBreadth(a.claim) || b.c.confidence - a.c.confidence);
  // A tracker search for one show also returns other shows, and two different series never
  // overlap — so without this anchor the planner would happily grab all of them. When the
  // caller knows the requested series (aliases), an exact-alias match wins outright rather than
  // competing on confidence — otherwise one mis-scored wrong-show pack could still anchor the
  // plan. Breadth must not pick the series either, or a complete pack of the wrong show would
  // anchor a plan over an exact-title match.
  const byConfidence = eligible.reduce((best, x) => (best && best.c.confidence >= x.c.confidence ? best : x), null);
  const anchor = aliases && aliases.length
    ? eligible.find(x => seriesAliasMatch(x.claim.series, aliases).exact) || byConfidence
    : byConfidence;
  const series = anchor?.claim.series || null;
  const picks = [];
  let covered = 0;
  let trimmed = 0;
  for (const { c, claim } of eligible) {
    if (claim.series !== series) continue;
    if (taken.some(t => contentClaimsOverlap(claim, t))) { covered++; continue; }
    if (picks.length >= max) { trimmed++; continue; }
    taken.push(claim);
    picks.push(c);
  }
  return { picks, covered, trimmed, series };
}

// One label for everything a plan would grab ("S01, S02, S03E11"), for the confirm prompt
// and the summary embed.
function describeGrabPlan(picks) {
  const merged = { series: '', seasons: new Set(), episodes: new Set(), whole: false };
  for (const p of picks || []) {
    const c = releaseContentClaim(p.releaseTitle);
    if (!c) continue;
    merged.series = merged.series || c.series;
    if (c.whole) merged.whole = true;
    for (const s of c.seasons) merged.seasons.add(s);
    for (const e of c.episodes) merged.episodes.add(e);
  }
  if (!merged.whole && !merged.seasons.size && !merged.episodes.size) return describeContentClaim(null);
  return describeContentClaim(merged);
}

// Short human label for a claim, for the "already grabbing …" message.
function describeContentClaim(c) {
  if (!c) return 'this title';
  if (c.whole) return 'the complete series';
  const seasons = [...c.seasons].sort((x, y) => x - y).map(s => `S${String(s).padStart(2, '0')}`);
  const eps = [...c.episodes].sort().map(e => { const [s, ep] = e.split('.'); return `S${String(s).padStart(2, '0')}E${String(ep).padStart(2, '0')}`; });
  return [...seasons, ...eps].join(', ') || 'this title';
}

// Additive confidence score, 0–100. Budget: title 40, year/season fit 15, quality 15,
// seeders 15, size sanity 10, freeleech 5. Zero seeders caps the whole thing at 40 — a
// dead torrent can never look auto-grabbable no matter how perfect the name is.
// ctx = { title, year, mediaType, season } (year/season optional).
function scoreAvistazResult(result, ctx) {
  const parsed = parseReleaseName(result.title);
  // Prowlarr returns flag labels as an array, while Sonarr's ReleaseResource exposes the
  // same field as an integer bitmask. Season-release ranking reuses this scorer, so accept
  // either representation; scalar values cannot carry a label for the freeleech bonus but
  // must not make an otherwise valid interactive search fail.
  const rawFlags = Array.isArray(result.indexerFlags) ? result.indexerFlags : [result.indexerFlags];
  const flags = rawFlags.filter(f => f != null).map(f => String(f).toLowerCase());
  const freeleech = flags.some(f => f.includes('freeleech'));
  const notes = [];
  let score = 0;

  // Series-identity gate (TV only): when the caller knows every title this series legitimately
  // answers to, a release whose parsed series head doesn't match any of them is a different
  // show wearing the same word — "The Law of Revenge" for a "Revenge" request — and is rejected
  // outright rather than merely scored down. Fails open (no gate) when aliases weren't supplied,
  // so callers that don't yet know the series (free-text /avistaz search) are unaffected.
  const head = ctx.mediaType !== 'movie' ? seriesToken(result.title) : '';
  const aliasMatch = ctx.mediaType !== 'movie' && ctx.aliases && ctx.aliases.length
    ? seriesAliasMatch(head, ctx.aliases) : null;
  if (aliasMatch && !aliasMatch.ok) {
    return {
      confidence: 0,
      rejected: true,
      rejectReason: 'series_mismatch',
      notes: [`different series (${head || 'unrecognized'})`],
      parsed,
      freeleech,
      titleMatch: aliasMatch,
    };
  }

  const wantTokens = normalizeTitle(ctx.title).split(' ').filter(Boolean);
  const haystack = ` ${normalizeTitle(result.title)} `;
  const matched = wantTokens.filter(t => haystack.includes(` ${t} `)).length;
  score += wantTokens.length ? Math.round(40 * (matched / wantTokens.length)) : 0;
  if (matched < wantTokens.length) notes.push('partial title match');

  // Precision: a release whose parsed series head carries extra, non-noise words beyond the
  // wanted title is probably a different, similarly-named show ("Revenge" matching inside "The
  // Law of Revenge") even though every wanted word was found. Recall alone can't see this — it
  // only checks that wanted words are present, never that the release doesn't also claim more.
  // Capped, never a rejection on its own: a release with a longer *legitimate* title (a caller
  // that didn't have aliases handy) should lose points, not be thrown out.
  if (ctx.mediaType !== 'movie' && head) {
    const extraTokens = aliasMatch ? aliasMatch.extraTokens
      : headExtraTokens(head, wantTokens);
    if (extraTokens.length) {
      score -= Math.min(20, 7 * extraTokens.length);
      notes.push(`extra title words (${extraTokens.slice(0, 3).join(' ')})`);
    }
  }

  if (ctx.mediaType === 'movie') {
    if (!ctx.year || !parsed.year) score += 8;
    else if (Math.abs(parsed.year - ctx.year) <= 1) score += 15;
    else notes.push(`year mismatch (${parsed.year})`);
  } else if (ctx.season != null) {
    // A pack "covers" the wanted season when it names it, names no season at all (complete
    // series), or spans a range that includes it (S01-S05 covers a request for S03).
    const coversWanted = parsed.seasonPack && (parsed.season == null
      || parsed.season === ctx.season
      || (parsed.seasonEnd != null && parsed.season <= ctx.season && ctx.season <= parsed.seasonEnd));
    if (coversWanted) score += 15;
    else if (parsed.season === ctx.season) { score += 6; notes.push('single episode, not a season pack'); }
    else if (parsed.season == null) score += 5;
    else notes.push(`wrong season (S${parsed.season}${parsed.seasonEnd != null ? `-S${parsed.seasonEnd}` : ''})`);
  } else {
    // No season specified: prefer packs/complete runs, single episodes are a poor fit.
    if (parsed.seasonPack) score += 15;
    else if (parsed.episode != null) { score += 4; notes.push('single episode'); }
    else score += 8;
  }

  // Two shows share a title far more often than two films do — "Full House" is both a 1987 US
  // sitcom and a 2004 Korean drama, and the TV branches above never look at the year, so both
  // scored identically and the wrong show could win a plan outright. Applied as a penalty rather
  // than points because a TV release's year is usually the SEASON's air year, not the series':
  // only a release predating the series proves a mismatch, and a later year is normal for a
  // later season and costs nothing.
  if (ctx.mediaType !== 'movie' && ctx.year && parsed.year) {
    if (parsed.year < ctx.year - 1) {
      score -= 25;
      notes.push(`different show? release is from ${parsed.year}, series from ${ctx.year}`);
    } else if (parsed.year > ctx.year + 1 && (parsed.season == null || parsed.season === 1)) {
      // A first season dated years after the series began is usually a remake, not this show.
      score -= 10;
      notes.push(`year mismatch (${parsed.year})`);
    }
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
// need. Results with no downloadUrl (nothing to grab) are dropped. A result the alias gate
// rejects as a different series is dropped too, unless includeRejected is set — a caller like
// /avistaz search can show an admin *why* a plausible-looking title vanished, without ever
// making it clickable (callers must check `.rejected` before offering a Download button).
function rankAvistazResults(results, ctx, { limit = 3, includeRejected = false } = {}) {
  return (results || [])
    .filter(r => r.downloadUrl)
    .map(r => {
      const { confidence, notes, parsed, freeleech, rejected, rejectReason } = scoreAvistazResult(r, ctx);
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
        rejected: !!rejected,
        rejectReason: rejectReason || null,
        resolution: parsed.resolution,
        source: parsed.source,
        seasonPack: parsed.seasonPack,
        multiSeason: parsed.multiSeason,
        season: parsed.season,
        seasonEnd: parsed.seasonEnd,
      };
    })
    .filter(c => includeRejected || !c.rejected)
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

module.exports = { grabConfigured, grabImportTarget, findAvistazIndexer, searchAvistaz, fetchTorrentFile, normalizeTitle, splitTitleYear, parseReleaseName, seriesToken, extractReleaseGroup, releaseContentClaim, contentClaimsOverlap, describeContentClaim, claimCoversSeason, planSeriesGrab, describeGrabPlan, scoreAvistazResult, rankAvistazResults, grabAllowance, decideGrabJobAction, buildSeriesAliases, seriesAliasMatch, ALIAS_NOISE_TOKENS };
