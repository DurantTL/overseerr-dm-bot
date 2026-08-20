// Plex Home staging: everything the remote PH cache box needs that isn't Discord plumbing.
// Server-identity classification for webhook routing, source resolution against the *arrs,
// rclone copy/purge/about wrappers, and the pure cache-pressure math (eviction order + space
// planning) the tests exercise directly.
const { spawn } = require('child_process');
const { CONFIG } = require('./config');
const { radarrGetFrom, sonarrGet, remapPath } = require('./arr');
const path = require('path');

const stagingConfigured = () => !!(CONFIG.STAGING_ENABLED && CONFIG.STAGE_RCLONE_REMOTE);

// Which Plex server did a webhook event come from? Edge events must NEVER reach the deletion
// flow. PH gets its staging/eviction flow; California is observed but managed by the tier agent.
// Fail-safe rules:
//   - both edge identity lists unset   → 'primary' (legacy single-server behavior)
//   - identity matches PH_SERVER_NAMES → 'ph'
//   - identity matches CA_EDGE_SERVER_NAMES → 'ca-edge'
//   - payload carries no identity      → 'unknown' (skipped by callers; better no prompt than a
//                                        delete prompt fired for a PH viewer)
//   - PRIMARY_SERVER_NAMES set         → must match to count as 'primary', else 'unknown'
//   - PRIMARY_SERVER_NAMES unset       → any named non-edge server counts as 'primary'
// cfg is injectable for tests; callers use the CONFIG-backed default.
function classifyServerIdentity({ serverName, machineId } = {}, cfg = undefined) {
  const phNames = cfg ? cfg.phNames : CONFIG.PH_SERVER_NAMES;
  const caEdgeNames = cfg ? (cfg.caEdgeNames || []) : CONFIG.CA_EDGE_SERVER_NAMES;
  const primaryNames = cfg ? cfg.primaryNames : CONFIG.PRIMARY_SERVER_NAMES;
  if (!phNames.length && !caEdgeNames.length) return 'primary';
  const ids = [serverName, machineId].map(v => String(v || '').trim().toLowerCase()).filter(Boolean);
  if (!ids.length) return 'unknown';
  if (ids.some(id => phNames.includes(id))) return 'ph';
  if (ids.some(id => caEdgeNames.includes(id))) return 'ca-edge';
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

// Play-triggered promotion decision (§2.2 of docs/edge-playback-architecture.md), PH pilot.
// Pure so the branching is testable without Discord/DB/rclone. index.js supplies the impure
// facts (is it already staged? when did we last promote it? is the watcher under their daily
// cap?) and acts on the returned action. Order matters: the cheapest/most-decisive skips first.
//   enabled       — EDGE_PROMOTE_ON_PLAY master switch
//   alreadyStaged — getStagedItem(mediaId) truthy: the copy already exists, nothing to do
//   lastPromoteAt — ms epoch of the last promotion for this title (0/undefined = never)
//   cooldownMs    — EDGE_PROMOTE_COOLDOWN_HOURS as ms; a binge shouldn't re-enqueue nightly
//   rateLimitOk   — false once the attributed watcher has hit EDGE_PROMOTE_MAX_PER_USER_PER_DAY
//   auditOnly     — EDGE_PROMOTE_AUDIT_ONLY: decide + log but never actually copy (dark rollout)
// Returns { action: 'skip'|'audit'|'enqueue', reason }.
function planPlayPromotion({ enabled, alreadyStaged, lastPromoteAt = 0, now = Date.now(), cooldownMs = 0, rateLimitOk = true, auditOnly = false }) {
  if (!enabled) return { action: 'skip', reason: 'disabled' };
  if (alreadyStaged) return { action: 'skip', reason: 'already_local' };
  if (lastPromoteAt && cooldownMs > 0 && (now - lastPromoteAt) < cooldownMs) return { action: 'skip', reason: 'cooldown' };
  if (!rateLimitOk) return { action: 'skip', reason: 'rate_limited' };
  if (auditOnly) return { action: 'audit', reason: 'audit_only' };
  return { action: 'enqueue', reason: 'promote' };
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
          // §Phase2: match the master tree's relative path (e.g. `Movies/<folder>`) so a local-first
          // mergerfs view substitutes this copy instead of treating it as a duplicate.
          destSubPath: `${CONFIG.STAGE_MOVIES_SUBDIR}/${path.basename(movie.path)}`,
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
      // §Phase2: match the master tree's relative path (e.g. `TV Shows/<folder>`).
      destSubPath: `${CONFIG.STAGE_TV_SUBDIR}/${path.basename(series.path)}`,
      sizeBytes: series.statistics?.sizeOnDisk || 0,
    };
  }
  return { found: false, kind: 'unknown' };
}

// Spawn rclone and wait for exit. Keeps only a stderr tail — that's where rclone puts the
// reason a transfer died, and it's what lands in stage_jobs.error and the failure DM.
// `flags` lets the AvistaZ grab pipeline pass its own tuning (GRAB_RCLONE_FLAGS) instead
// of the PH staging flags.
// `maxStdoutBytes` bounds memory while letting listing-heavy callers (rclone lsf -R for the
// adoption filename search) keep more than the 64 KB default; the tail is kept on overflow.
function runRclone(args, { timeoutMs = 0, flags = CONFIG.STAGE_RCLONE_FLAGS, maxStdoutBytes = 65536 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CONFIG.STAGE_RCLONE_BINARY, [...args, ...flags], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderrTail = '';
    let timedOut = false;
    child.stdout.on('data', d => { stdout += d; if (stdout.length > maxStdoutBytes) stdout = stdout.slice(-maxStdoutBytes); });
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
// Is this a safe argument for `rclone purge`? purge is recursive and unconditional, so an empty
// or degenerate subpath would resolve to the cache ROOT and wipe every staged title on the box in
// one call. Every value in staged_items.dest_path is built with path.basename today, so this
// should be unreachable — but "should be unreachable" is not a guard, and the blast radius here is
// the entire remote cache. Rejects empty/whitespace, '.', '/', bare separators, and any traversal.
function safeStageSubPath(destSubPath) {
  const p = String(destSubPath ?? '').trim();
  if (!p) return { ok: false, why: 'empty destination path' };
  if (p.startsWith('/')) return { ok: false, why: `absolute destination path (${p})` };
  const parts = p.split('/').filter(s => s !== '');
  if (!parts.length) return { ok: false, why: `destination path resolves to the cache root (${p})` };
  if (parts.some(s => s === '.' || s === '..')) return { ok: false, why: `destination path contains a traversal segment (${p})` };
  return { ok: true };
}

async function purgeStagedPath(destSubPath) {
  // Fail closed: refusing to purge leaves an orphaned folder on the cache (recoverable, costs
  // disk); purging the wrong path destroys the whole cache (not recoverable, costs a re-seed).
  const safe = safeStageSubPath(destSubPath);
  if (!safe.ok) return { ok: false, error: `refusing to purge — ${safe.why}` };
  const res = await runRclone(['purge', stageDest(destSubPath)], { timeoutMs: 10 * 60000 });
  if (res.code !== 0 && !/directory not found|doesn't exist|not found/i.test(res.stderr)) {
    return { ok: false, error: res.stderr || `rclone exited ${res.code}` };
  }
  return { ok: true };
}

// Free space on the filesystem that actually contains the staging cache.
// For SFTP remotes the remote root may be the server's OS disk while
// STAGE_RCLONE_REMOTE points to a separately mounted media/cache drive.
async function fetchCacheFreeBytes() {
  const target = CONFIG.STAGE_RCLONE_REMOTE;
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

// §Phase2 stale-staging reconciliation (pure). The PH box has treated a title as "local" purely
// because a staged_items row exists — never verifying the file is actually present and complete. So
// after a restart, a manual cache wipe, or an interrupted copy, the DB and disk drift: the guard
// counts space that isn't used, and play-promotion skips titles as 'already_local' that vanished.
// This classifies each row from three observed facts and returns disjoint action lists:
//   local        — row present with bytes ≥ size×completeFrac: healthy, nothing to do
//   transferring — row with an in-flight copy job, OR present-but-incomplete: leave it alone
//   restage      — row but the file is missing/empty: drop the stale row and re-queue a copy
// presentBytes is a Map(destPath → on-disk bytes); pass null when the cache couldn't be listed, in
// which case nothing is reconciled (never delete a row on a failed listing — that would restage the
// whole cache on a transient rclone error). Orphan files (on disk, no row) are handled by the
// caller since importing one safely needs media resolution this pure step doesn't have.
function reconcileStagedItems({ rows, presentBytes, activeMediaIds = new Set(), completeFrac = 0.98 }) {
  if (!presentBytes) return { unknown: true, local: [], transferring: [], restage: [] };
  const local = [], transferring = [], restage = [];
  for (const r of rows || []) {
    if (activeMediaIds.has(r.media_id)) { transferring.push(r); continue; }
    const bytes = presentBytes.get(r.dest_path) || 0;
    if (bytes <= 0) { restage.push(r); continue; }
    if ((r.size_bytes || 0) > 0 && bytes < r.size_bytes * completeFrac) { transferring.push(r); continue; }
    local.push(r);
  }
  return { unknown: false, local, transferring, restage };
}

// Sum on-disk bytes per staged dest subpath from an `rclone lsjson -R` listing (entries carry a
// remote-root-relative `Path`, a `Size`, and `IsDir`). A file belongs to dest D when its Path is D
// or nested under `D/`. Every requested dest appears in the result (0 when nothing on disk matches).
function sumBytesByDest(entries, destPaths) {
  const bytes = new Map(destPaths.map(d => [d, 0]));
  for (const e of entries || []) {
    if (e.IsDir) continue;
    const p = String(e.Path || '');
    for (const d of destPaths) {
      if (p === d || p.startsWith(`${d}/`)) { bytes.set(d, (bytes.get(d) || 0) + (Number(e.Size) || 0)); break; }
    }
  }
  return bytes;
}

// Impure: list the cache remote and return on-disk bytes for the given dest subpaths, or null when
// the listing fails (so the caller can skip reconciliation rather than act on a blind read).
async function fetchStagedPresence(destPaths) {
  if (!destPaths.length) return new Map();
  try {
    const res = await runRclone(['lsjson', '--recursive', '--no-modtime', CONFIG.STAGE_RCLONE_REMOTE], { timeoutMs: 5 * 60000, maxStdoutBytes: 64 * 1024 * 1024 });
    if (res.code !== 0) return null;
    const entries = JSON.parse(res.stdout || '[]');
    return sumBytesByDest(entries, destPaths);
  } catch (_e) {
    return null;
  }
}

module.exports = { stagingConfigured, classifyServerIdentity, evictionOrder, planCacheSpace, planPlayPromotion, resolveStageSource, runRclone, stageCopy, safeStageSubPath, purgeStagedPath, fetchCacheFreeBytes, getCacheStatus, reconcileStagedItems, sumBytesByDest, fetchStagedPresence };
