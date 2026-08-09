// Episode-level recovery for monitored AvistaZ-tagged Sonarr series.
//
// This worker is intentionally separate from the request escalation watchdog: a TV request can be
// "available" after one episode imports, while later aired episodes may still be missing. The
// recovery sweep gives Sonarr/public indexers a targeted search first, then sends an exact SxxEyy
// AvistaZ match through the existing rTorrent -> rclone -> Sonarr import pipeline.

const { assessSeriesAge, planSeasonSearches } = require('./season-pack');

const pad2 = n => String(n).padStart(2, '0');

function episodeKey(episode) {
  return `${episode.seriesId}:${episode.id}`;
}

function episodeLabel(series, episode) {
  return `${series.title} S${pad2(episode.seasonNumber)}E${pad2(episode.episodeNumber)}`;
}

function isAiredEpisode(episode, now = Date.now()) {
  if (!episode || episode.seasonNumber <= 0 || episode.hasFile || !episode.monitored) return false;
  const airedAt = Date.parse(episode.airDateUtc || episode.airDate || '');
  return Number.isFinite(airedAt) && airedAt <= now;
}

function decideEpisodeRecoveryAction(row, facts, now, cfg) {
  if (facts.hasFile) return 'resolve';
  if (!facts.monitored || !facts.aired || !facts.seriesTagged) return 'ignore';
  if (facts.inQueue || facts.activeGrab) return 'wait';
  const firstSeen = Number(row?.first_seen_at || now);
  if (!row?.public_searched_at) {
    return now - firstSeen >= cfg.publicGraceHours * 3600000 ? 'search_public' : 'wait';
  }
  if (row.avistaz_grabbed_at) return 'wait';
  return now - Number(row.public_searched_at) >= cfg.avistazGraceHours * 3600000 ? 'search_avistaz' : 'wait';
}

function exactEpisodeCandidates(candidates, episode) {
  return (candidates || []).filter(c => {
    const p = c.parsed || c;
    return Number(p.season) === Number(episode.seasonNumber)
      && Number(p.episode) === Number(episode.episodeNumber)
      && !p.seasonPack;
  });
}

function readEpisodeRecoveryConfig(env = process.env) {
  const bool = (v, fallback = false) => v == null ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
  const int = (name, fallback) => {
    const n = Number.parseInt(env[name] || String(fallback), 10);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    enabled: bool(env.EPISODE_RECOVERY_ENABLED, false),
    checkMinutes: Math.max(5, int('EPISODE_RECOVERY_CHECK_MINUTES', 30)),
    publicGraceHours: Math.max(0, int('EPISODE_RECOVERY_PUBLIC_GRACE_HOURS', 6)),
    avistazGraceHours: Math.max(0, int('EPISODE_RECOVERY_AVISTAZ_GRACE_HOURS', 12)),
    lookbackDays: Math.max(1, int('EPISODE_RECOVERY_LOOKBACK_DAYS', 14)),
    maxPerRun: Math.max(1, int('EPISODE_RECOVERY_MAX_PER_RUN', 3)),
    minConfidence: Math.max(0, Math.min(100, int('EPISODE_RECOVERY_MIN_CONFIDENCE', 88))),
  };
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS episode_recovery (
      episode_key TEXT PRIMARY KEY,
      series_id INTEGER NOT NULL,
      episode_id INTEGER NOT NULL,
      series_title TEXT NOT NULL,
      season_number INTEGER NOT NULL,
      episode_number INTEGER NOT NULL,
      first_seen_at INTEGER NOT NULL,
      public_searched_at INTEGER,
      avistaz_grabbed_at INTEGER,
      resolved_at INTEGER,
      ignored_at INTEGER,
      last_error TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_episode_recovery_open
      ON episode_recovery(resolved_at, ignored_at, first_seen_at);
  `);
}

function upsertMissingEpisode(db, series, episode, now) {
  const key = episodeKey(episode);
  db.prepare(`INSERT INTO episode_recovery
    (episode_key, series_id, episode_id, series_title, season_number, episode_number, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(episode_key) DO UPDATE SET
      series_title = excluded.series_title,
      season_number = excluded.season_number,
      episode_number = excluded.episode_number,
      updated_at = CURRENT_TIMESTAMP`)
    .run(key, episode.seriesId, episode.id, series.title, episode.seasonNumber, episode.episodeNumber, now);
  return db.prepare('SELECT * FROM episode_recovery WHERE episode_key = ?').get(key);
}

function setEpisodeRecoveryState(db, key, fields) {
  const allowed = ['public_searched_at', 'avistaz_grabbed_at', 'resolved_at', 'ignored_at', 'last_error'];
  const entries = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!entries.length) return;
  const sql = `UPDATE episode_recovery SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE episode_key = ?`;
  db.prepare(sql).run(...entries.map(([, v]) => v), key);
}

async function createEpisodeRecoveryWorker(deps = {}) {
  const CONFIG = deps.CONFIG || require('./config').CONFIG;
  const { db, audit, recordGrabJob, getGrabJobByHash, getGrabJobByRelease, listActiveGrabJobs, countGrabJobsToday, listRequestedTvdbIds } = deps.dbApi || require('./db');
  const { sonarrGet, fetchArrQueues, getArrTagId } = deps.arrApi || require('./arr');
  const { findAvistazIndexer, searchAvistaz, fetchTorrentFile, rankAvistazResults, grabAllowance, releaseContentClaim, contentClaimsOverlap } = deps.grabApi || require('./grab');
  const { addTorrentToRtorrent } = deps.rtorrentApi || require('./rtorrent');
  const axios = deps.axios || require('axios');
  const log = deps.log || require('./log').log;
  const cfg = deps.recoveryConfig || readEpisodeRecoveryConfig();

  ensureSchema(db);

  async function sweep() {
    if (!cfg.enabled || !CONFIG.SONARR_URL || !CONFIG.PROWLARR_URL || !CONFIG.RTORRENT_URL) return { skipped: true };
    const source = { url: CONFIG.SONARR_URL, key: CONFIG.SONARR_API_KEY, label: 'sonarr' };
    const tagId = await getArrTagId(source, CONFIG.AVISTAZ_TAG).catch(() => null);
    if (tagId == null) return { skipped: true, reason: 'tag_missing' };

    const [seriesList, queue, indexer] = await Promise.all([
      sonarrGet('/series'),
      fetchArrQueues(),
      findAvistazIndexer(),
    ]);
    if (!indexer) return { skipped: true, reason: 'indexer_missing' };

    const now = Date.now();
    const cutoff = now - cfg.lookbackDays * 86400000;
    const activeJobs = listActiveGrabJobs();
    // Requested shows are season-pack eligible whatever their age, so the stand-down below has
    // to know about them too — otherwise both paths would chase the same requested season.
    const requestedTvdbIds = CONFIG.SEASON_PACK_REQUESTED && listRequestedTvdbIds ? listRequestedTvdbIds() : new Set();
    let acted = 0;

    for (const series of seriesList.filter(s => s.monitored && (s.tags || []).includes(tagId))) {
      const episodes = await sonarrGet('/episode', { seriesId: series.id });
      // Seasons the season-pack path owns (old show, enough missing episodes to be worth a
      // pack). Recovering those one episode at a time is the exact waste season-pack-first
      // exists to prevent — and on a metered tracker the two paths would race for the same
      // slots. Left untouched here; they resume episode-level recovery if the season later
      // drops below the pack threshold.
      const packCfg = {
        dormantDays: CONFIG.SEASON_PACK_DORMANT_DAYS,
        minMissing: CONFIG.SEASON_PACK_MIN_MISSING,
      };
      const packEligible = assessSeriesAge(series, now, packCfg).old || requestedTvdbIds.has(Number(series.tvdbId));
      const packSeasons = new Set(
        CONFIG.SEASON_PACK_FIRST && packEligible
          ? planSeasonSearches(episodes, now, packCfg).map(s => s.season)
          : []);
      for (const episode of episodes) {
        if (packSeasons.has(Number(episode.seasonNumber))) continue;
        const airedAt = Date.parse(episode.airDateUtc || episode.airDate || '');
        if (!isAiredEpisode(episode, now) || !Number.isFinite(airedAt) || airedAt < cutoff) continue;
        const row = upsertMissingEpisode(db, series, episode, now);
        const key = episodeKey(episode);
        const label = episodeLabel(series, episode);
        const activeGrab = activeJobs.some(j => {
          const claim = releaseContentClaim(j.release_title);
          return claim && claim.series && contentClaimsOverlap(claim, releaseContentClaim(label));
        });
        const facts = {
          hasFile: !!episode.hasFile,
          monitored: !!episode.monitored && !!series.monitored,
          aired: true,
          seriesTagged: true,
          inQueue: queue.some(q => q.source.kind === 'tv' && q.seriesId === series.id && q.seasonNumber === episode.seasonNumber && q.episodeNumber === episode.episodeNumber),
          activeGrab,
        };
        const action = decideEpisodeRecoveryAction(row, facts, now, cfg);
        if (action === 'resolve' || action === 'ignore') {
          setEpisodeRecoveryState(db, key, action === 'resolve' ? { resolved_at: now, last_error: null } : { ignored_at: now });
          continue;
        }
        if (action === 'wait' || acted >= cfg.maxPerRun) continue;

        if (action === 'search_public') {
          try {
            await axios.post(`${CONFIG.SONARR_URL}/api/v3/command`, { name: 'EpisodeSearch', episodeIds: [episode.id] },
              { headers: { 'X-Api-Key': CONFIG.SONARR_API_KEY }, timeout: 15000 });
            setEpisodeRecoveryState(db, key, { public_searched_at: now, last_error: null });
            audit('episode_recovery_public_search', { episodeKey: key, title: label, seriesId: series.id, episodeId: episode.id });
          } catch (err) {
            setEpisodeRecoveryState(db, key, { last_error: String(err.message).slice(0, 500) });
            audit('external_api_error', { provider: 'sonarr', action: 'episode_recovery_search', episodeKey: key, error: err.message });
          }
          acted++;
          continue;
        }

        const allowance = grabAllowance(countGrabJobsToday(), CONFIG.AVISTAZ_DAILY_GRAB_LIMIT);
        if (allowance.exhausted) return { acted, deferred: true, reason: 'allowance_exhausted' };
        try {
          const raw = await searchAvistaz({ query: label, mediaType: 'tv', indexerId: indexer.id });
          // series.year disambiguates same-titled shows ("Full House" is a 1987 US sitcom and a
          // 2004 Korean drama); without it both score identically and the wrong one can win.
          const ranked = rankAvistazResults(raw, { title: series.title, year: series.year || null, mediaType: 'tv', season: episode.seasonNumber }, { limit: 10 });
          const exact = exactEpisodeCandidates(ranked.map(c => ({ ...c, parsed: { season: c.season, episode: (String(c.releaseTitle).match(/\bS(\d{1,2})[\s._-]*E(\d{1,3})\b/i) || [])[2], seasonPack: c.seasonPack } })), episode)
            .filter(c => c.confidence >= cfg.minConfidence);
          const chosen = exact[0];
          if (!chosen) {
            setEpisodeRecoveryState(db, key, { last_error: 'no exact high-confidence AvistaZ episode match' });
            audit('episode_recovery_no_match', { episodeKey: key, title: label, candidates: ranked.length });
            acted++;
            continue;
          }
          if (getGrabJobByRelease(chosen.releaseTitle)) {
            setEpisodeRecoveryState(db, key, { avistaz_grabbed_at: now, last_error: null });
            continue;
          }
          const torrent = await fetchTorrentFile(chosen.downloadUrl);
          const infoHash = await addTorrentToRtorrent(torrent, CONFIG.RTORRENT_LABEL_TV);
          if (getGrabJobByHash(infoHash)) {
            setEpisodeRecoveryState(db, key, { avistaz_grabbed_at: now, last_error: null });
            continue;
          }
          recordGrabJob({
            mediaId: `tvdb:${series.tvdbId}`,
            mediaType: 'tv',
            title: label,
            releaseTitle: chosen.releaseTitle,
            infoHash,
            sizeBytes: chosen.size,
            label: CONFIG.RTORRENT_LABEL_TV,
            origin: 'episode-recovery',
          });
          setEpisodeRecoveryState(db, key, { avistaz_grabbed_at: now, last_error: null });
          audit('episode_recovery_avistaz_grab', { episodeKey: key, title: label, release: chosen.releaseTitle, confidence: chosen.confidence, infoHash });
        } catch (err) {
          setEpisodeRecoveryState(db, key, { last_error: String(err.message).slice(0, 500) });
          audit('external_api_error', { provider: 'avistaz', action: 'episode_recovery_grab', episodeKey: key, error: err.message });
        }
        acted++;
      }
    }
    return { acted };
  }

  function start() {
    if (!cfg.enabled) return null;
    const run = () => sweep().catch(err => log.warn(`Episode recovery sweep failed: ${err.message}`));
    setTimeout(run, 30000).unref();
    const timer = setInterval(run, cfg.checkMinutes * 60000);
    timer.unref();
    log.info(`Episode recovery enabled (${cfg.checkMinutes}m check, ${cfg.publicGraceHours}h public grace, ${cfg.avistazGraceHours}h AvistaZ grace)`);
    return timer;
  }

  return { cfg, sweep, start };
}

async function startEpisodeRecovery(deps) {
  const worker = await createEpisodeRecoveryWorker(deps);
  return worker.start();
}

module.exports = {
  episodeKey,
  episodeLabel,
  isAiredEpisode,
  decideEpisodeRecoveryAction,
  exactEpisodeCandidates,
  readEpisodeRecoveryConfig,
  ensureSchema,
  createEpisodeRecoveryWorker,
  startEpisodeRecovery,
};
