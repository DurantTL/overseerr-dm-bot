// Plex Home staging: everything the remote PH cache box needs that isn't Discord plumbing.
// Server-identity classification for webhook routing, source resolution against the *arrs,
// rclone copy/purge/about wrappers, and the pure cache-pressure math (eviction order + space
// planning) the tests exercise directly.
const { spawn } = require('child_process');
const { CONFIG } = require('./config');
const { radarrGetFrom, sonarrGet, remapPath } = require('./arr');
const path = require('path');

const stagingConfigured = () => !!(CONFIG.STAGING_ENABLED && CONFIG.STAGE_RCLONE_REMOTE);

// Which Plex server did a webhook event come from? 'ph' events must NEVER reach the deletion
// flow — they get the eviction flow instead. Fail-safe rules:
//   - PH_SERVER_NAMES unset            → 'primary' (legacy single-server behavior, nothing gated)
//   - identity matches PH_SERVER_NAMES → 'ph'
//   - payload carries no identity      → 'unknown' (skipped by callers; better no prompt than a
//                                        delete prompt fired for a PH viewer)
//   - PRIMARY_SERVER_NAMES set         → must match to count as 'primary', else 'unknown'
//   - PRIMARY_SERVER_NAMES unset       → any named non-PH server counts as 'primary'
// cfg is injectable for tests; callers use the CONFIG-backed default.
function classifyServerIdentity({ serverName, machineId } = {}, cfg = undefined) {
  const phNames = cfg ? cfg.phNames : CONFIG.PH_SERVER_NAMES;
  const primaryNames = cfg ? cfg.primaryNames : CONFIG.PRIMARY_SERVER_NAMES;
  if (!phNames.length) return 'primary';
  const ids = [serverName, machineId].map(v => String(v || '').trim().toLowerCase()).filter(Boolean);
  if (!ids.length) return 'unknown';
  if (ids.some(id => phNames.includes(id))) return 'ph';
  if (!primaryNames.length) return 'primary';
  return ids.some(id => primaryNames.includes(id)) ? 'primary' : 'unknown';
}

// Unpinned items, least-recently-streamed first (never-streamed items fall back to stage time).
// Pinned items are simply invisible to eviction.
function evictionOrder(items) {
  return items
    .filter(i => !i.pinned)
    .sort((a, b) => (a.last_streamed_at || a.staged_at || 0) - (b.last_streamed_at || b.staged_at || 0));
}

// Decide what (if anything) must be evicted before a copy of neededBytes can start.
// freeBytes == null means free space is unknowable (no `rclone about` support and no
// STAGE_CACHE_MAX_GB budget) — the guard can't guard, so the copy proceeds unguarded.
// When even evicting every unpinned item wouldn't make room, nothing is evicted at all:
// refuse loudly rather than trash the cache and fail anyway.
function planCacheSpace({ freeBytes, neededBytes, minFreeBytes, items }) {
  if (freeBytes == null) return { ok: true, evict: [], unguarded: true };
  const required = neededBytes + minFreeBytes - freeBytes;
  if (required <= 0) return { ok: true, evict: [] };
  const evict = [];
  let reclaimed = 0;
  for (const item of evictionOrder(items)) {
    evict.push(item);
    reclaimed += item.size_bytes || 0;
    if (reclaimed >= required) return { ok: true, evict };
  }
  return { ok: false, evict: [], shortfallBytes: required - reclaimed };
}

// Resolve a mediaId to the on-disk folder rclone should copy. Movies copy the movie folder
// (file + subs + extras), shows copy the whole series folder — a PH viewer bingeing a show
// wants all of it, and partial-season staging isn't worth the bookkeeping.
async function resolveStageSource(mediaId) {
  if (mediaId.startsWith('tmdb:')) {
    const tmdbId = Number(mediaId.slice('tmdb:'.length));
    const sources = [
      { url: CONFIG.RADARR_URL, key: CONFIG.RADARR_API_KEY },
      { url: CONFIG.RADARR_4K_URL, key: CONFIG.RADARR_4K_API_KEY },
    ].filter(s => s.url);
    for (const s of sources) {
      const matches = await radarrGetFrom(s.url, s.key, `/movie?tmdbId=${tmdbId}`).catch(() => []);
      const movie = (matches || []).find(m => m.tmdbId === tmdbId && m.hasFile && m.path);
      if (movie) {
        return {
          found: true,
          kind: 'movie',
          title: `${movie.title}${movie.year ? ` (${movie.year})` : ''}`,
          srcPath: remapPath(movie.path),
          destSubPath: `movies/${path.basename(movie.path)}`,
          sizeBytes: movie.sizeOnDisk || movie.movieFile?.size || 0,
        };
      }
    }
    return { found: false, kind: 'movie' };
  }
  if (mediaId.startsWith('tvdb:')) {
    if (!CONFIG.SONARR_URL) return { found: false, kind: 'tv' };
    const tvdbId = Number(mediaId.slice('tvdb:'.length));
    const series = (await sonarrGet('/series').catch(() => [])).find(s => s.tvdbId === tvdbId);
    if (!series || !series.path || !(series.statistics?.episodeFileCount > 0)) return { found: false, kind: 'tv' };
    return {
      found: true,
      kind: 'tv',
      title: series.title,
      srcPath: remapPath(series.path),
      destSubPath: `tv/${path.basename(series.path)}`,
      sizeBytes: series.statistics?.sizeOnDisk || 0,
    };
  }
  return { found: false, kind: 'unknown' };
}

// Spawn rclone and wait for exit. Keeps only a stderr tail — that's where rclone puts the
// reason a transfer died, and it's what lands in stage_jobs.error and the failure DM.
// `flags` lets the AvistaZ grab pipeline pass its own tuning (GRAB_RCLONE_FLAGS) instead
// of the PH staging flags.
function runRclone(args, { timeoutMs = 0, flags = CONFIG.STAGE_RCLONE_FLAGS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CONFIG.STAGE_RCLONE_BINARY, [...args, ...flags], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderrTail = '';
    let timedOut = false;
    child.stdout.on('data', d => { stdout += d; if (stdout.length > 65536) stdout = stdout.slice(-65536); });
    child.stderr.on('data', d => { stderrTail += d; if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000); });
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : null;
    if (timer) timer.unref();
    child.on('error', err => { if (timer) clearTimeout(timer); reject(new Error(`rclone failed to start: ${err.message}`)); });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr: stderrTail.trim(), timedOut });
    });
  });
}

const stageDest = destSubPath => `${CONFIG.STAGE_RCLONE_REMOTE}/${destSubPath}`;

// Copy a source folder into the cache. rclone copy is effectively resumable for our purposes:
// re-running after a restart skips files that already transferred whole.
async function stageCopy(srcPath, destSubPath, timeoutMs) {
  const res = await runRclone(['copy', srcPath, stageDest(destSubPath)], { timeoutMs });
  if (res.timedOut) return { ok: false, error: `timed out after ${Math.round(timeoutMs / 60000)} min (rclone killed)` };
  if (res.code !== 0) return { ok: false, error: res.stderr || `rclone exited ${res.code}` };
  return { ok: true };
}

// Remove a staged folder from the cache (eviction / evict-button). Purge only ever targets a
// path under STAGE_RCLONE_REMOTE — the master library is a different filesystem entirely.
async function purgeStagedPath(destSubPath) {
  const res = await runRclone(['purge', stageDest(destSubPath)], { timeoutMs: 10 * 60000 });
  if (res.code !== 0 && !/directory not found|doesn't exist|not found/i.test(res.stderr)) {
    return { ok: false, error: res.stderr || `rclone exited ${res.code}` };
  }
  return { ok: true };
}

// Free space on the cache drive via `rclone about` (asked of the remote root, not the cache
// subfolder — disk pressure is a drive property). Returns null when the backend can't say.
async function fetchCacheFreeBytes() {
  const m = CONFIG.STAGE_RCLONE_REMOTE.match(/^([^:]+:)/);
  const target = m ? m[1] : CONFIG.STAGE_RCLONE_REMOTE;
  try {
    const res = await runRclone(['about', target, '--json'], { timeoutMs: 60000 });
    if (res.code !== 0) return null;
    const data = JSON.parse(res.stdout);
    return typeof data.free === 'number' ? { freeBytes: data.free, totalBytes: data.total ?? null } : null;
  } catch (_e) {
    return null;
  }
}

// Cache status for the guard and /status: prefer live `rclone about` numbers, fall back to the
// STAGE_CACHE_MAX_GB budget minus tracked items, else admit the guard is blind.
async function getCacheStatus(stagedItems) {
  const usedByCache = stagedItems.reduce((a, i) => a + (i.size_bytes || 0), 0);
  const about = await fetchCacheFreeBytes();
  if (about) return { freeBytes: about.freeBytes, totalBytes: about.totalBytes, usedByCache, source: 'rclone' };
  if (CONFIG.STAGE_CACHE_MAX_GB > 0) {
    const budget = CONFIG.STAGE_CACHE_MAX_GB * 1024 ** 3;
    return { freeBytes: Math.max(budget - usedByCache, 0), totalBytes: budget, usedByCache, source: 'budget' };
  }
  return { freeBytes: null, totalBytes: null, usedByCache, source: 'none' };
}

module.exports = { stagingConfigured, classifyServerIdentity, evictionOrder, planCacheSpace, resolveStageSource, runRclone, stageCopy, purgeStagedPath, fetchCacheFreeBytes, getCacheStatus };
