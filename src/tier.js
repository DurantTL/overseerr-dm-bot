// Regional tiering planner ("edge cache"): scores every library title per node, keeps each
// node filled to its budget with an incremental watermark LRU (evict only to admit), and
// renders transport manifests (.stignore / rclone files-from).
//
// Deliberately Discord-free AND database-free: index.js feeds it plain data (node rows, watch
// histories, agent atime reports, member requests, keep-list ids, previous plans) so the whole
// planner is testable by direct import, and /tier preview shows exactly what apply would do.
//
// Safety invariants enforced here (see tests):
//   - a title may appear in a drop list ONLY while it exists on ≥1 enabled `full` node;
//     otherwise it is force-kept everywhere and flagged
//   - `full` nodes are never pruned — their manifest keeps everything
//   - Tier-0 floor (keep list ∪ never-delete ∪ universal core ∪ member pins) is never evictable
//   - every edge manifest is marked receiveOnly so the agent can assert the topology
const axios = require('axios');
const crypto = require('crypto');

// Planner defaults; planTier() callers override via `config`, and warm/fresh windows can be
// set per node row (tier_nodes.warm_days / fresh_days).
const TIER_DEFAULTS = {
  halfLifeDays: 30,        // recency half-life for watch/atime decay
  warmDays: 14,            // titles watched this recently are never evicted
  freshDays: 30,           // titles added this recently are warm before any watch history exists
  requestGraceDays: 45,    // restricted-node member requests pin this long (cold-start)
  coreTopK: 25,            // universal core: top-K titles by summed plays across all nodes
  // On restricted nodes the universal core is NOT floor — it competes as a score so the
  // members' own history outranks the global crowd-pleasers when the budget is tight.
  coreValue: 0.25,
  stickyWarmFactor: 2,     // sticky nodes (old drives) get a doubled warm window by default
  // Anti-churn (§1.4): a candidate may only displace kept titles when it clears a MEANINGFUL bar,
  // not merely any improvement — otherwise a 0.001-value title evicts 0.000 ones every cycle and
  // the cache thrashes. See the displacement gate in planNode for how these combine.
  churnMinAbsolute: 0.05,  // candidate value must beat the SUM of evicted value by ≥ this
  churnMinRelative: 0.2,   // …and beat the WARMEST evicted title by ≥ this fraction (20%)
  churnPenaltyPerTb: 0.05, // …and overcome a transfer penalty scaled by candidate size (per TB)
};

const DAY_MS = 86400000;

// Exponential recency decay in [0, 1]: 1.0 right now, 0.5 at one half-life, → 0.
function recencyDecay(tsMs, nowMs, halfLifeDays) {
  if (!tsMs || !Number.isFinite(tsMs) || tsMs > nowMs + DAY_MS) return 0;
  return Math.pow(0.5, (nowMs - tsMs) / (halfLifeDays * DAY_MS));
}

// Join key between Tautulli history rows (title strings) and the arr inventory (mediaIds):
// normalized title + media type. Tautulli knows Plex rating keys, not tmdb/tvdb ids, so a
// best-effort title match is the honest join.
function titleKey(title, mediaType) {
  const norm = String(title || '').toLowerCase()
    .replace(/\(\d{4}\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${mediaType === 'tv' ? 'tv' : 'movie'}:${norm}`;
}

// §3.2 Tier-1 score for Tautulli-backed nodes.
function demandScore(row, nowMs, halfLifeDays) {
  return recencyDecay(row.lastPlayed, nowMs, halfLifeDays)
    * Math.log1p(row.plays || 0)
    * Math.log1p(row.distinctUsers || 0);
}

// Universal core: top-K title keys by summed plays across every node's history. Only enabled
// nodes' histories should be passed in — a disabled staging node's stale history must not
// shape what every region keeps.
function computeUniversalCore(historiesByNode, k) {
  const plays = new Map();
  for (const rows of Object.values(historiesByNode)) {
    for (const r of rows || []) {
      const key = titleKey(r.title, r.mediaType);
      plays.set(key, (plays.get(key) || 0) + (r.plays || 0));
    }
  }
  return [...plays.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, k))
    .map(([key]) => key);
}

// Full title inventory from the arrs, same sources and fields as /cleanup-suggestions, plus
// the on-disk FOLDER path made relative to sourceRoot so manifests are folder-relative.
// remap = arr.remapPath (injected to keep this module free of the db-touching arr module).
// Returns { items, failedSources } — failedSources names every arr that could not be read.
// That list is NOT cosmetic: a source that fails contributes zero titles, and a title absent from
// the inventory lands in neither `keep` nor `drop` — so its folder's .stignore comes out EMPTY and
// Syncthing re-pulls everything the previous plan was holding back. Callers must treat a non-empty
// failedSources as "this plan is not publishable" rather than planning on what did answer.
// (Returned as an object rather than an array carrying a property, so a caller's map/filter can't
// silently drop the failure list and turn a partial inventory back into a publishable plan.)
async function fetchTierInventory({ sources, remap, sourceRoot, onError }) {
  const items = [];
  const failedSources = [];
  for (const s of sources) {
    try {
      if (s.kind === 'movie') {
        const movies = await axios.get(`${s.url}/api/v3/movie`, { headers: { 'X-Api-Key': s.key }, timeout: 30000 }).then(r => r.data || []);
        for (const m of movies) {
          if (!m.sizeOnDisk || !m.path) continue;
          items.push({
            mediaId: `tmdb:${m.tmdbId}`,
            title: `${m.title}${s.label === 'radarr-4k' ? ' (4K)' : ''}`,
            mediaType: 'movie',
            sizeBytes: m.sizeOnDisk,
            // A missing/invalid added date is UNKNOWN, not "added now" — falling back to `now`
            // makes genuinely old content look brand-new and win the fresh-grace force-keep,
            // displacing real demand. `null` simply means "no freshness signal" (see planNode).
            addedAt: Date.parse(m.movieFile?.dateAdded || m.added || '') || null,
            // path = full remapped on-disk path (for multi-folder resolution against each node's
            // folder roots); relPath = source-root-relative (legacy single-folder manifests).
            path: remap(m.path),
            relPath: toRelPath(remap(m.path), sourceRoot),
          });
        }
      } else {
        const series = await axios.get(`${s.url}/api/v3/series`, { headers: { 'X-Api-Key': s.key }, timeout: 30000 }).then(r => r.data || []);
        for (const t of series) {
          const size = t.statistics?.sizeOnDisk || 0;
          if (!size || !t.path) continue;
          items.push({
            mediaId: `tvdb:${t.tvdbId}`,
            title: t.title,
            mediaType: 'tv',
            sizeBytes: size,
            // Missing/invalid added date → null ("unknown"), not `now` (see the movie branch).
            addedAt: Date.parse(t.added || '') || null,
            path: remap(t.path),
            relPath: toRelPath(remap(t.path), sourceRoot),
          });
        }
      }
    } catch (err) {
      failedSources.push({ label: s.label, error: err.message });
      if (onError) onError(s, err);
    }
  }
  return { items, failedSources };
}

// Bounded-concurrency map: run `fn` over `items` with at most `limit` in flight. Used to resolve
// Plex rating keys → GUIDs without firing hundreds of metadata requests at a PMS at once.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

// Pull a stable arr media id out of a Plex GUID string. Handles both the modern structured GUIDs
// (`tmdb://603`, `tvdb://75978`) and the legacy agent form (`com.plexapp.agents.themoviedb://603`,
// `thetvdb://75978`). Returns `tmdb:<n>` / `tvdb:<n>` in the same shape the arr inventory uses, or
// null when the wanted source isn't present.
function mediaIdFromGuid(guid, want) {
  const m = /(themoviedb|thetvdb|tmdb|tvdb):\/\/(\d+)/i.exec(String(guid || ''));
  if (!m) return null;
  const src = /movie|tmdb/i.test(m[1]) ? 'tmdb' : 'tvdb';
  return src === want ? `${want}:${m[2]}` : null;
}

// §1.6 Resolve a Plex rating key to a stable arr media id (tmdb:<n> for movies, tvdb:<n> for the
// series a watched episode belongs to) via the item's metadata Guid list. Best-effort: any failure
// (unreachable PMS, deleted item, no matching guid) returns null and the caller falls back to
// title matching. mediaType decides which source we accept so a movie remake can't borrow a show's
// tvdb id and vice-versa.
async function fetchPlexGuid({ url, token }, ratingKey, mediaType) {
  try {
    const res = await axios.get(`${String(url).replace(/\/$/, '')}/library/metadata/${encodeURIComponent(ratingKey)}`, {
      headers: { 'X-Plex-Token': token, Accept: 'application/json' },
      timeout: 10000,
    });
    const meta = res.data?.MediaContainer?.Metadata?.[0];
    if (!meta) return null;
    const want = mediaType === 'tv' ? 'tvdb' : 'tmdb';
    const guids = [meta.guid, ...(Array.isArray(meta.Guid) ? meta.Guid.map(g => g && g.id) : [])];
    for (const g of guids) {
      const id = mediaIdFromGuid(g, want);
      if (id) return id;
    }
  } catch (_e) { /* fall back to title matching */ }
  return null;
}

// Watch history straight from a node's Plex Media Server (no Tautulli needed):
// GET /status/sessions/history/all with the server token, normalized to the same per-title
// rows fetchHistory produces. PMS history is per-server (watch state never syncs between
// servers), so this is inherently node-local demand — the accurate replacement for the atime
// LRU wherever the bot can reach the node's PMS.
//
// §1.6: each aggregated title is then resolved to a stable tmdb:/tvdb: mediaId via one metadata
// lookup per distinct rating key (bounded concurrency), so history joins to inventory by GUID —
// remakes, editions, and `(4K)` labels no longer collide on normalized title text. Resolution is
// best-effort; a title Plex can't resolve keeps mediaId null and joins by title as before. Pass
// resolveGuids:false to skip the lookups entirely (e.g. a PMS whose metadata route is unavailable).
async function fetchPlexHistory({ url, token }, { afterDays = 90, length = 5000, resolveGuids = true } = {}) {
  const afterSec = Math.floor((Date.now() - afterDays * 86400000) / 1000);
  const pageSize = 1000;
  const rows = [];
  for (let start = 0; rows.length < length; start += pageSize) {
    const res = await axios.get(`${String(url).replace(/\/$/, '')}/status/sessions/history/all`, {
      params: {
        'viewedAt>': afterSec,
        'X-Plex-Container-Start': start,
        'X-Plex-Container-Size': Math.min(pageSize, length - rows.length),
      },
      headers: { 'X-Plex-Token': token, Accept: 'application/json' },
      timeout: 15000,
    });
    const page = res.data?.MediaContainer?.Metadata || [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  const byTitle = new Map();
  for (const r of rows) {
    if (!['movie', 'episode'].includes(r.type)) continue;
    const tv = r.type === 'episode';
    // Episode rows carry the series as grandparentKey ('/library/metadata/<ratingKey>').
    const key = tv
      ? String(r.grandparentKey || '').split('/').pop() || `title:${r.grandparentTitle}`
      : String(r.ratingKey || `title:${r.title}`);
    const entry = byTitle.get(key) || {
      ratingKey: key,
      title: (tv ? r.grandparentTitle : r.title) || 'Unknown',
      mediaType: tv ? 'tv' : 'movie',
      plays: 0,
      lastPlayed: 0,
      users: new Set(),
    };
    entry.plays++;
    const playedMs = (Number(r.viewedAt) || 0) * 1000;
    if (playedMs > entry.lastPlayed) entry.lastPlayed = playedMs;
    entry.users.add(String(r.accountID ?? 'unknown'));
    byTitle.set(key, entry);
  }
  const out = [...byTitle.values()].map(({ users, ...e }) => ({ ...e, distinctUsers: users.size, mediaId: null }));
  if (resolveGuids && out.length) {
    // Resolve only real numeric rating keys — a `title:<x>` fallback key (Plex sent no ratingKey)
    // can't be looked up and stays on the title-match path.
    await mapLimit(out, 8, async e => {
      if (/^\d+$/.test(String(e.ratingKey))) e.mediaId = await fetchPlexGuid({ url, token }, e.ratingKey, e.mediaType);
    });
  }
  return out;
}

// ---- atime maintenance-window mask ----
// Plex's nightly scheduled tasks (extensive analysis, preview thumbnails, intro detection)
// READ media files, and under relatime that refreshes atime once a day — every title then
// looks "watched last night" and the LRU flattens. The mask launders the signal: an atime
// whose UTC time-of-day falls inside the node's maintenance window is presumed to be a
// scheduled read, and the previously stored atime (the last plausible human read) is carried
// forward instead. Format 'HH:MM-HH:MM' in UTC; windows may wrap midnight. Pad generously
// for DST — a real 3am viewer lost to the mask is acceptable noise, a flattened LRU is not.
function parseAtimeMask(raw) {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return null;
  const [h1, m1, h2, m2] = [+m[1], +m[2], +m[3], +m[4]];
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  const startMin = h1 * 60 + m1;
  const endMin = h2 * 60 + m2;
  if (startMin === endMin) return null;
  return { startMin, endMin };
}

function inAtimeMask(tsMs, mask) {
  const d = new Date(tsMs);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mask.startMin < mask.endMin
    ? mins >= mask.startMin && mins < mask.endMin
    : mins >= mask.startMin || mins < mask.endMin;
}

// Applied at report ingest, BEFORE the snapshot replaces tier_node_files, so the stored rows
// always hold the last plausible read. A suspect atime with no prior row keeps its reported
// value (better a one-day overestimate than mass-evicting on the first masked report); once
// stored, that value is what gets carried forward on later suspect reads.
function maskSuspectAtimes(files, prevFiles, mask) {
  if (!mask) return files;
  const prev = new Map(prevFiles.map(f => [folderKey(f), f.atime]));
  return files.map(f => {
    const t = Number(f.atime);
    if (!Number.isFinite(t) || t <= 0 || !inAtimeMask(t, mask)) return f;
    const prior = prev.get(folderKey(f));
    return prior != null ? { ...f, atime: prior } : f;
  });
}

function toRelPath(absPath, sourceRoot) {
  const p = String(absPath).replace(/\/+$/, '');
  const root = String(sourceRoot || '').replace(/\/+$/, '');
  if (root && (p === root || p.startsWith(`${root}/`))) return p.slice(root.length).replace(/^\/+/, '');
  return p.replace(/^\/+/, '');
}

// R2.1: a node's Syncthing folders as { folderId, folderRoot }. Reads node.folders when the
// caller (planTier / index.js) supplies the one-to-many list; otherwise synthesizes a single
// folder from the legacy folder_root/folder_id columns so single-folder nodes are unchanged.
function nodeFolders(node) {
  const raw = Array.isArray(node.folders) && node.folders.length ? node.folders : null;
  if (raw) {
    return raw.map(f => ({
      folderId: String(f.folderId ?? f.syncthing_folder_id ?? f.folder_id ?? ''),
      folderRoot: String(f.folderRoot ?? f.folder_root ?? '').replace(/\/+$/, ''),
    }));
  }
  return [{ folderId: String(node.folder_id ?? ''), folderRoot: String(node.folder_root ?? '').replace(/\/+$/, '') }];
}

// Resolve one inventory title to { folderId, relPath } for a node. Multi-folder nodes match the
// title's absolute (remapped) path against each folder root, longest prefix wins; a legacy
// single folder (one row, empty id, no explicit root matching) keeps the precomputed
// source-root-relative relPath untouched — that's the backward-compatible path.
function resolveTitleFolder(title, folders, diag = null) {
  const useRoots = folders.length > 1 || folders.some(f => f.folderId);
  if (useRoots && title.path) {
    const abs = String(title.path).replace(/\/+$/, '');
    let best = null;
    for (const f of folders) {
      if (!f.folderRoot) continue;
      if ((abs === f.folderRoot || abs.startsWith(`${f.folderRoot}/`)) && (!best || f.folderRoot.length > best.folderRoot.length)) best = f;
    }
    if (best) return { folderId: best.folderId, relPath: toRelPath(abs, best.folderRoot) };

    // The planner sees paths in the bot container's namespace (for example /mnt/raid/Media/Movies)
    // while an edge node may mount the same Syncthing folder elsewhere
    // (/mnt/media/Media/Movies). Match the longest local-root suffix against the source-relative
    // inventory path so the shared Media/Movies portion routes by folder id without requiring the
    // two hosts to use identical absolute mount points. Exact absolute matches above always win.
    const rel = String(title.relPath || '').replace(/^\/+|\/+$/g, '');
    let suffixBest = null;
    for (const f of folders) {
      const parts = String(f.folderRoot || '').split('/').filter(Boolean);
      for (let i = 0; i < parts.length; i += 1) {
        const prefix = parts.slice(i).join('/');
        if ((rel === prefix || rel.startsWith(`${prefix}/`)) && (!suffixBest || prefix.length > suffixBest.prefix.length)) {
          suffixBest = { folder: f, prefix };
        }
      }
    }
    if (suffixBest) return { folderId: suffixBest.folder.folderId, relPath: toRelPath(rel, suffixBest.prefix) };
  }
  if (diag && useRoots) {
    diag.folderFallbacks = (diag.folderFallbacks || 0) + 1;
    if (!diag.folderFallbackExamples) diag.folderFallbackExamples = [];
    if (diag.folderFallbackExamples.length < 5) diag.folderFallbackExamples.push(String(title.path || title.relPath || title.mediaId));
  }
  return { folderId: folders[0]?.folderId || '', relPath: title.relPath };
}

const folderKey = e => `${e.folderId || e.folder_id || ''}\u0000${e.relPath}`;

// §1.6 Index a node's history for lookup by stable id (tmdb:/tvdb:) with normalized title as a
// fallback. A row Plex resolved to a GUID goes ONLY into byId — it must match its exact title and
// never leak demand to a namesake (remake, edition) via title text. A row Plex could NOT resolve
// goes into byTitle, the honest best-effort join. Rows are rolled up within each map so the same
// title seen twice merges conservatively (plays summed, users maxed, newest lastPlayed).
function indexHistory(history) {
  const merge = (map, key, r) => {
    const prev = map.get(key);
    if (prev) {
      prev.plays += r.plays; prev.distinctUsers = Math.max(prev.distinctUsers, r.distinctUsers);
      prev.lastPlayed = Math.max(prev.lastPlayed, r.lastPlayed);
    } else map.set(key, { ...r });
  };
  const byId = new Map();
  const byTitle = new Map();
  for (const r of history) {
    if (r.mediaId) merge(byId, r.mediaId, r);
    else merge(byTitle, titleKey(r.title, r.mediaType), r);
  }
  return { byId, byTitle };
}

// Look one inventory title up in the history index: stable id first (§1.6), normalized title as a
// fallback. `diag` (optional) tallies which path matched so the planner can warn when a Plex node
// leans on title matching — remakes/editions/`(4K)` labels collide there and can miscredit demand.
function lookupHistory(index, t, diag) {
  const byId = index.byId.get(t.mediaId);
  if (byId) { if (diag) diag.idMatches = (diag.idMatches || 0) + 1; return byId; }
  const byTitle = index.byTitle.get(titleKey(t.title, t.mediaType));
  if (byTitle) { if (diag) diag.titleOnlyMatches = (diag.titleOnlyMatches || 0) + 1; return byTitle; }
  return null;
}

// atime LRU value per title (§3.2a): agent-reported file atimes rolled up to the owning title
// folder — "recently read by that node's Plex" is the demand signal. Files with no reported
// atime contribute nothing (graceful fallback). Multi-folder aware: a file only matches a title
// in the SAME folder (folderKey), so identical relPaths in two folders don't cross-contaminate.
function computeAtimeValues({ inventory, files = [], now, cfg }) {
  const values = new Map();
  const byRel = new Map(inventory.map(t => [folderKey(t), t]));
  const latest = new Map(); // mediaId → newest atime among the title's files
  for (const f of files) {
    const atimeMs = Number(f.atime);
    if (!Number.isFinite(atimeMs) || atimeMs <= 0) continue;
    const fid = f.folderId ?? f.folder_id ?? '';
    let dir = String(f.relPath);
    while (dir.includes('/')) {
      dir = dir.slice(0, dir.lastIndexOf('/'));
      const t = byRel.get(folderKey({ folderId: fid, relPath: dir }));
      if (t) {
        if ((latest.get(t.mediaId) || 0) < atimeMs) latest.set(t.mediaId, atimeMs);
        break;
      }
    }
  }
  for (const [mediaId, atimeMs] of latest) {
    values.set(mediaId, { value: recencyDecay(atimeMs, now, cfg.halfLifeDays), lastActivity: atimeMs });
  }
  return values;
}

// Per-node title values (Tier 1). Returns Map mediaId → { value, lastActivity }.
//   tautulli: history rows joined to inventory by titleKey, scored per §3.2
//   plex:     node's own PMS watch history (R2.2) scored recencyDecay(lastViewedAt)×log1p(viewCount),
//             with a PER-TITLE fallback to the atime LRU for any title Plex has no view record
//             for. If the PMS was unreachable the history is empty ⇒ the whole node falls back to
//             atime, no plan failure.
//   atime:    the atime LRU only (§3.2a).
function computeNodeValues({ node, inventory, history = [], files = [], now, cfg, diag = null }) {
  if (node.demand_source === 'atime') return computeAtimeValues({ inventory, files, now, cfg });

  const index = indexHistory(history);
  if (node.demand_source === 'plex') {
    const atimeValues = computeAtimeValues({ inventory, files, now, cfg });
    const values = new Map();
    for (const t of inventory) {
      const r = lookupHistory(index, t, diag);
      if (r) {
        values.set(t.mediaId, { value: recencyDecay(r.lastPlayed, now, cfg.halfLifeDays) * Math.log1p(r.plays || 0), lastActivity: r.lastPlayed || null });
      } else if (atimeValues.has(t.mediaId)) {
        values.set(t.mediaId, atimeValues.get(t.mediaId));
      }
    }
    return values;
  }

  const values = new Map();
  for (const t of inventory) {
    const r = lookupHistory(index, t, diag);
    if (!r) continue;
    values.set(t.mediaId, { value: demandScore(r, now, cfg.halfLifeDays), lastActivity: r.lastPlayed || null });
  }
  return values;
}

// §3.4 incremental watermark LRU for one node. Pure: everything comes in as data.
//   floorIds — Tier 0 for THIS node (keep list ∪ never-delete ∪ force-kept ∪, per access mode,
//              universal core and/or member pins) — never evictable
//   values   — Map mediaId → { value, lastActivity }
//   prevKeepIds — mediaIds kept by the last applied plan (null = first run: floor + admits)
function planNode({ node, inventory, values, floorIds, coreIds = new Set(), prevKeepIds = null, now = Date.now(), config = {}, folders = null }) {
  const cfg = { ...TIER_DEFAULTS, ...config };
  const flds = folders || nodeFolders(node);
  const warmDays = node.warm_days ?? (node.sticky ? cfg.warmDays * cfg.stickyWarmFactor : cfg.warmDays);
  const freshDays = node.fresh_days ?? cfg.freshDays;
  const budget = Math.floor((node.usable_bytes || 0) * (1 - (node.headroom_pct ?? 15) / 100));
  const libraryBytes = inventory.reduce((a, t) => a + (t.sizeBytes || 0), 0);

  const entries = inventory.map(t => {
    const v = values.get(t.mediaId) || { value: 0, lastActivity: null };
    let value = v.value;
    // Restricted nodes: the global core competes as a score instead of being floor, so the
    // member group's own history wins under pressure (§3.2 Tier 0 caveat).
    if (node.access === 'restricted' && coreIds.has(t.mediaId)) value = Math.max(value, cfg.coreValue);
    const fresh = t.addedAt && (now - t.addedAt) <= freshDays * DAY_MS;
    if (fresh) value = Math.max(value, recencyDecay(t.addedAt, now, cfg.halfLifeDays));
    const warm = v.lastActivity && (now - v.lastActivity) <= warmDays * DAY_MS;
    return { ...t, value, warm, fresh };
  });

  if (node.full) {
    // Never-pruned master: keeps the entire library, drops nothing, regardless of budget.
    return finishManifest({ node, keep: entries, drop: [], admits: [], evict: [], forceKept: [], budget, libraryBytes, now, folders: flds });
  }

  const inventoryIds = new Set(entries.map(e => e.mediaId));
  const floor = new Set([...floorIds].filter(id => inventoryIds.has(id)));
  const prevKeep = prevKeepIds ? new Set(prevKeepIds) : null;

  const keepSet = new Set(entries.filter(e => floor.has(e.mediaId) || (prevKeep && prevKeep.has(e.mediaId))));
  let keptBytes = [...keepSet].reduce((a, e) => a + e.sizeBytes, 0);
  const evicted = new Set();
  const evictable = e => keepSet.has(e) && !evicted.has(e) && !floor.has(e.mediaId) && !e.warm && !e.fresh;
  // Both passes evict coldest-first, but they break value ties on size in OPPOSITE directions,
  // because they optimize for different things:
  //   - displacement (step 2): to admit ONE hot title, prefer the LARGER tied victim so the space
  //     is freed by a few big titles instead of shredding dozens of small ones (fewer titles churn
  //     per apply — this is the fix for the "+3 / −46" preview);
  //   - over-budget trim (step 1): nothing is being admitted, so shed the MINIMUM to get under
  //     budget — prefer the SMALLER tied victim. Larger-first here would drop a 10 GB title to fit
  //     a set only 4 GB over budget, underfilling the cache; and since evicted entries stay in
  //     keepSet, the admission pass can't add that big title back.
  const coldLargerFirst = (a, b) => (a.value - b.value) || (b.sizeBytes - a.sizeBytes);
  const coldSmallerFirst = (a, b) => (a.value - b.value) || (a.sizeBytes - b.sizeBytes);

  // 1) If the carried-over keep-set already busts the budget (shrunk node, grown floor),
  //    evict coldest-first (smaller-first on ties) just enough to fit — no more.
  if (keptBytes > budget) {
    for (const v of [...keepSet].filter(evictable).sort(coldSmallerFirst)) {
      if (keptBytes <= budget) break;
      evicted.add(v);
      keptBytes -= v.sizeBytes;
    }
  }

  // 2) Admissions, hottest first (smaller first on equal value). A title gets in either on
  //    free budget or by evicting strictly-colder victims — never a warmer one (the gate).
  const admits = [];
  const candidates = entries.filter(e => !keepSet.has(e)).sort((a, b) => (b.value - a.value) || (a.sizeBytes - b.sizeBytes));
  for (const c of candidates) {
    const free = budget - keptBytes;
    if (c.sizeBytes <= free) {
      admits.push(c); keepSet.add(c); keptBytes += c.sizeBytes;
      continue;
    }
    // Anti-churn gate (§1.4). Displacing kept titles isn't free — the candidate has to be
    // downloaded and the victims deleted, and every swap churns the cache — so require a
    // MEANINGFUL net gain, not just `victim.value < candidate.value`. Three conditions, all
    // required: (a) the candidate's demand beats the SUM of the demand it evicts by an absolute
    // margin (blocks shredding several warm-ish titles for one slightly-hotter one); (b) it beats
    // the WARMEST victim by a relative margin (a 20%-hotter title isn't worth a swap); (c) it
    // clears a transfer penalty that scales with its own size (bigger downloads need a stronger
    // signal). Free-budget admits above never reach here — nothing is displaced there.
    const need = c.sizeBytes - free;
    const transferPenalty = cfg.churnPenaltyPerTb * (c.sizeBytes / (1024 ** 4));
    const pool = [...keepSet].filter(e => evictable(e) && e.value < c.value);
    // Greedy prefix of an ordered pool that frees `need` bytes (null if the whole pool can't).
    const buildTake = ordered => {
      let f = 0; const t = [];
      for (const v of ordered) { t.push(v); f += v.sizeBytes; if (f >= need) break; }
      return f >= need ? t : null;
    };
    const meaningful = t => t && (c.value - t.reduce((a, v) => a + v.value, 0) - transferPenalty) >= cfg.churnMinAbsolute
      && c.value >= t.reduce((a, v) => Math.max(a, v.value), 0) * (1 + cfg.churnMinRelative);
    // Primary victim set: coldest-first (value asc, size desc) — minimizes per-title value and, on
    // ties, churns the fewest titles. When that prefix passes the gate we keep it, so existing
    // behavior is unchanged. But coldest-first can BUNDLE several small cold titles whose summed
    // value trips the absolute margin and rejects the admission — even though evicting one larger
    // (still colder-than-candidate) title would lose less total demand and clear the gate. So if
    // the primary set is rejected, fall back to the fewest-victims set (largest colder title first)
    // and admit on that when it passes: a lower-churn, higher-net-win swap the guardrail intends to
    // allow. Both sets only ever contain titles strictly colder than the candidate.
    let take = buildTake(pool.slice().sort(coldLargerFirst));
    if (take && !meaningful(take)) {
      const alt = buildTake(pool.slice().sort((a, b) => (b.sizeBytes - a.sizeBytes) || (a.value - b.value)));
      if (meaningful(alt)) take = alt;
    }
    if (meaningful(take)) {
      for (const v of take) { evicted.add(v); keptBytes -= v.sizeBytes; }
      admits.push(c); keepSet.add(c); keptBytes += c.sizeBytes;
    }
  }

  const keep = entries.filter(e => keepSet.has(e) && !evicted.has(e));
  const drop = entries.filter(e => !keepSet.has(e) || evicted.has(e));
  const forceKept = keep.filter(e => floor.has(e.mediaId) && floorIds.has(e.mediaId) && e.noFullCopy).map(e => e.mediaId);
  return finishManifest({ node, keep, drop, admits, evict: [...evicted], forceKept, budget, libraryBytes, now, folders: flds });
}

// Group a node's keep/drop entries by folder (R2.1). Every declared folder appears (even with an
// empty drop, so the agent writes an empty .stignore rather than leaving a stale one), plus any
// folder that only shows up in the entries. drop paths within a folder are folder-relative.
function groupByFolder(folders, keep, drop) {
  const byId = new Map();
  const bucket = fid => {
    const key = fid || '';
    if (!byId.has(key)) byId.set(key, { folder_id: key, folder_root: '', keep: [], drop: [] });
    return byId.get(key);
  };
  for (const f of folders || []) {
    const b = bucket(f.folderId || '');
    b.folder_root = f.folderRoot || b.folder_root;
  }
  for (const e of keep) bucket(e.folderId).keep.push(e);
  for (const e of drop) bucket(e.folderId).drop.push(e);
  return [...byId.values()];
}

function finishManifest({ node, keep, drop, admits, evict, forceKept, budget, libraryBytes, now, folders = null }) {
  const strip = e => ({ mediaId: e.mediaId, title: e.title, folderId: e.folderId || '', relPath: e.relPath, sizeBytes: e.sizeBytes });
  const keepStripped = keep.map(strip).sort((a, b) => a.relPath.localeCompare(b.relPath));
  const dropStripped = drop.map(strip).sort((a, b) => a.relPath.localeCompare(b.relPath));
  const manifest = {
    node: node.name,
    access: node.access || 'open',
    transport: node.transport || 'syncthing',
    demandSource: node.demand_source || 'tautulli',
    // Every edge node's folder must be Receive Only; the agent asserts this before touching
    // anything (§4a). Full masters are the senders.
    receiveOnly: !node.full,
    full: !!node.full,
    generatedAt: new Date(now).toISOString(),
    // Aggregate keep/drop across the whole node (single budget pool) — kept for /tier preview,
    // rclone, and the single-folder agent. `folders` splits the same sets per Syncthing folder.
    keep: keepStripped,
    drop: dropStripped,
    folders: groupByFolder(folders || nodeFolders(node), keepStripped, dropStripped),
    admits: admits.map(e => e.mediaId),
    evict: evict.map(e => e.mediaId),
    forceKept,
    stats: {
      budgetBytes: budget,
      libraryBytes,
      keepBytes: keep.reduce((a, e) => a + e.sizeBytes, 0),
      dropBytes: drop.reduce((a, e) => a + e.sizeBytes, 0),
      keepCount: keep.length,
      dropCount: drop.length,
    },
  };
  manifest.planHash = computePlanHash(manifest);
  return manifest;
}

// Stable hash of the plan's OUTCOME (what to keep/drop, by folder + path) — timestamps and stats
// are excluded so an unchanged plan hashes identically and agents can skip no-op runs. The folder
// id is part of the identity so the same relPath in two folders can't collide in the hash.
function computePlanHash(manifest) {
  const basis = JSON.stringify({
    node: manifest.node,
    keep: manifest.keep.map(folderKey).sort(),
    drop: manifest.drop.map(folderKey).sort(),
  });
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

// Whole-fleet planning: builds floors, core, pins and per-node values, then plans each
// enabled node. Disabled nodes are skipped entirely — no manifest, no pins, and their
// histories never feed the universal core (historiesByNode should only contain enabled
// nodes, but this filters again to be safe).
function planTier({ nodes, inventory, historiesByNode = {}, atimeReports = {}, memberRequests = {}, keepListIds = [], neverDeleteIds = [], prevPlans = {}, now = Date.now(), config = {} }) {
  const cfg = { ...TIER_DEFAULTS, ...config };
  const enabled = nodes.filter(n => n.enabled);
  const warnings = [];
  const routingErrors = [];

  // §4.1 master coverage: without an enabled full node NOTHING may be dropped anywhere.
  // Individual titles can also be flagged onFullNode:false by the caller.
  const fullNodes = enabled.filter(n => n.full);
  if (!fullNodes.length) warnings.push('No enabled full (never-pruned) master node — every title is force-kept on every node until one exists.');
  const uncovered = inventory.filter(t => !fullNodes.length || t.onFullNode === false);
  for (const t of uncovered.slice(0, 20)) {
    if (fullNodes.length) warnings.push(`"${t.title}" (${t.mediaId}) has no copy on a full master node — force-kept everywhere.`);
  }
  const inventoryMarked = inventory.map(t => (uncovered.includes(t) ? { ...t, noFullCopy: true } : t));

  // Folder IDs are the cross-host identity. Classify each title ONCE against the full master's
  // folder map (which represents the Arr/source side), then every edge looks up that same ID in
  // its own folder list. Edge folder order, mount prefix, and local directory names are irrelevant.
  // If a multi-folder fleet has no usable master map yet, previews still render through the legacy
  // local matcher but apply is blocked by the routing diagnostic below.
  const multiFolderNodes = enabled.filter(n => nodeFolders(n).length > 1);
  const masterFolders = fullNodes.flatMap(n => nodeFolders(n)).filter(f => f.folderId && f.folderRoot);
  const canonicalRouting = multiFolderNodes.length > 0 && masterFolders.length > 0;
  const sourceRouteProblems = [];
  const inventoryRouted = inventoryMarked.map(t => {
    if (!canonicalRouting) return t;
    const routeDiag = {};
    const route = resolveTitleFolder(t, masterFolders, routeDiag);
    if (routeDiag.folderFallbacks) {
      sourceRouteProblems.push(String(t.path || t.relPath || t.mediaId));
      return { ...t, sourceFolderId: null, sourceRelPath: t.relPath };
    }
    return { ...t, sourceFolderId: route.folderId, sourceRelPath: route.relPath };
  });
  if (sourceRouteProblems.length) {
    const issue = { node: 'full master folder map', count: sourceRouteProblems.length, examples: sourceRouteProblems.slice(0, 5) };
    routingErrors.push(issue);
    warnings.push(`🛑 The full master folder map could not classify ${issue.count} title(s) by Syncthing folder ID. Fix its source-side roots before applying. Examples: ${issue.examples.join(', ')}`);
  }

  const enabledHistories = {};
  for (const n of enabled) enabledHistories[n.name] = historiesByNode[n.name] || [];
  const coreKeys = new Set(computeUniversalCore(enabledHistories, cfg.coreTopK));
  const coreIds = new Set(inventoryMarked.filter(t => coreKeys.has(titleKey(t.title, t.mediaType))).map(t => t.mediaId));

  const baseFloor = new Set([...keepListIds, ...neverDeleteIds, ...uncovered.map(t => t.mediaId)]);

  const manifests = {};
  for (const node of enabled) {
    // R2.1: resolve every title to THIS node's folders once — annotates { folderId, relPath }
    // (folder-relative). In a configured multi-folder fleet this is an ID lookup from the master
    // classification above, never a comparison of edge-local paths. Single-folder/legacy nodes
    // keep the source-root-relative behavior.
    const folders = nodeFolders(node);
    const diag = {};
    const resolvedInventory = inventoryRouted.map(t => {
      if (folders.length > 1 && canonicalRouting) {
        const local = t.sourceFolderId && folders.find(f => f.folderId === t.sourceFolderId);
        if (local) return { ...t, folderId: local.folderId, relPath: t.sourceRelPath };
        // A source-side classification failure is reported once above, rather than repeated for
        // every target node. Keep the preview renderable, but routingErrors still blocks apply.
        if (!t.sourceFolderId) return { ...t, folderId: folders[0]?.folderId || '', relPath: t.relPath };
        diag.folderFallbacks = (diag.folderFallbacks || 0) + 1;
        if (!diag.folderFallbackExamples) diag.folderFallbackExamples = [];
        if (diag.folderFallbackExamples.length < 5) diag.folderFallbackExamples.push(String(t.path || t.relPath || t.mediaId));
        return { ...t, folderId: folders[0]?.folderId || '', relPath: t.relPath };
      }
      const { folderId, relPath } = resolveTitleFolder(t, folders, diag);
      return { ...t, folderId, relPath };
    });
    const values = computeNodeValues({
      node,
      inventory: resolvedInventory,
      history: enabledHistories[node.name],
      files: atimeReports[node.name] || [],
      now,
      cfg,
      diag,
    });
    const floorIds = new Set(baseFloor);
    if (node.access === 'restricted') {
      // §3.3 member cold-start: requests by the node's member set pin within the grace
      // window. Open nodes never pin (the requester could stream anywhere).
      for (const r of memberRequests[node.name] || []) {
        if (r.requestedAt && (now - r.requestedAt) <= cfg.requestGraceDays * DAY_MS) floorIds.add(r.mediaId);
      }
    } else {
      // Open nodes: the universal core is Tier 0 floor.
      for (const id of coreIds) floorIds.add(id);
    }
    manifests[node.name] = planNode({
      node,
      inventory: resolvedInventory,
      values,
      floorIds,
      coreIds,
      prevKeepIds: prevPlans[node.name]?.keepMediaIds || null,
      now,
      config: cfg,
      folders,
    });
    // Health warnings — both are silent degradations without them:
    //   - keep-set over budget: floor + warm/fresh don't fit, so the node will hold more than
    //     its target (and Syncthing will pull it) until titles cool or the floor shrinks;
    //   - no demand signal: every value is 0, so eviction order collapses to size-only and the
    //     planner is guessing. Points at the usual causes per demand source.
    const m = manifests[node.name];
    if (!node.full && m.stats.keepBytes > m.stats.budgetBytes) {
      const gb = b => (b / 1024 ** 3).toFixed(1);
      warnings.push(`"${node.name}" keep-set (${gb(m.stats.keepBytes)} GB) exceeds its budget (${gb(m.stats.budgetBytes)} GB) — floor + warm/fresh titles don't fit; the node will hold the overage until they cool or the keep floor shrinks.`);
    }
    if (!node.full && resolvedInventory.length && values.size === 0) {
      warnings.push(`"${node.name}" has no demand signal (source: ${node.demand_source || 'tautulli'}) — scoring falls back to freshness only and eviction order is otherwise arbitrary. Check ${node.demand_source === 'atime' ? "the agent's inventory report and that the media mount records atime (relatime, not noatime)" : node.demand_source === 'plex' ? "the node's PMS reachability/token and the agent's atime fallback" : 'Tautulli reachability and its API key'}.`);
    }
    if (folders.length > 1 && !canonicalRouting) {
      const issue = { node: node.name, count: inventoryMarked.length, examples: ['full master has no multi-folder ID map'] };
      routingErrors.push(issue);
      warnings.push(`🛑 "${node.name}" cannot use stable folder-ID routing until an enabled full master has its Syncthing folder IDs and local roots configured.`);
    } else if (folders.length > 1 && diag.folderFallbacks) {
      const issue = { node: node.name, count: diag.folderFallbacks, examples: diag.folderFallbackExamples || [] };
      routingErrors.push(issue);
      warnings.push(`🛑 "${node.name}" is missing the master folder ID for ${issue.count} title(s); they fell back to the first folder in this preview. Make sure the same Syncthing folder IDs exist on the master and this node. Examples: ${issue.examples.join(', ')}`);
    }
    // §1.6: a Plex node that leaned on title matching for some titles (no stable GUID resolved) may
    // miscredit demand across remakes/editions. Only meaningful when GUID resolution partly worked
    // (some id matches) — otherwise the PMS metadata route is simply unavailable, already implied by
    // the demand-signal checks. Tautulli/atime never resolve GUIDs here, so this stays plex-only.
    if (!node.full && node.demand_source === 'plex' && diag.titleOnlyMatches > 0 && diag.idMatches > 0) {
      warnings.push(`"${node.name}" matched ${diag.titleOnlyMatches} title(s) by name only (Plex returned no stable GUID) while ${diag.idMatches} matched by tmdb/tvdb id — remakes, editions, or "(4K)" labels may be miscredited for the name-only ones.`);
    }
  }
  return { manifests, warnings, coreIds: [...coreIds], routingErrors };
}

// Best-effort per-node history gathering, routed by demand_source:
//   tautulli → that node's Tautulli (fetchHistory)
//   plex     → that node's PMS directly (fetchPlexHistory)
//   atime    → no history at all; the signal is the agent's file report
// A missing or unreachable endpoint yields an empty history for that node (logged via
// onError), never a failed plan.
async function gatherNodeHistories(nodes, { fetchHistory, fetchPlexHistory: fetchPlex, afterDays = 90, onError } = {}) {
  const histories = {};
  for (const n of nodes.filter(x => x.enabled)) {
    histories[n.name] = [];
    try {
      if (n.demand_source === 'atime') continue;
      if (n.demand_source === 'plex') {
        if (!n.plex_url || !n.plex_token || !fetchPlex) continue;
        histories[n.name] = await fetchPlex({ url: n.plex_url, token: n.plex_token }, { afterDays });
        continue;
      }
      if (!n.tautulli_url || !n.tautulli_api_key || !fetchHistory) continue;
      histories[n.name] = await fetchHistory({ url: n.tautulli_url, apiKey: n.tautulli_api_key }, { afterDays });
    } catch (err) {
      if (onError) onError(n, err);
    }
  }
  return histories;
}

// Syncthing ignore-pattern escaping: media folders legitimately contain [], {} etc.
function escapeStignore(relPath) {
  return String(relPath).replace(/[\\*?[\]{}]/g, ch => `\\${ch}`);
}

// One folder's .stignore body from a list of drop entries (folder-relative). Deliberately no
// (?d) — deletion is the agent's explicit, logged, ignore-first prune (§4a), never Syncthing
// cleanup. The plan hash header lets humans and the agent correlate file ↔ plan.
function stignoreBody(drop, headerLines) {
  const lines = [
    `// Managed by overseerr-dm-bot regional tiering — DO NOT EDIT BY HAND.`,
    ...headerLines,
    `// Drops are pruned by the sync agent AFTER these ignores load; deliberately no`,
    `// delete-on-ignore prefix — Syncthing cleanup must never do the deleting.`,
  ];
  for (const e of drop) lines.push(`/${escapeStignore(e.relPath)}`);
  return `${lines.join('\n')}\n`;
}

// The node's aggregate .stignore (all folders' drops together) — single-folder agents and the
// legacy path use this. Multi-folder agents render one .stignore per folder via renderFolderStignore.
function renderSyncthingStignore(manifest) {
  return stignoreBody(manifest.drop, [
    `// node: ${manifest.node}`,
    `// plan: ${manifest.planHash}`,
    `// generated: ${manifest.generatedAt}`,
  ]);
}

// One folder's .stignore (R2.1). `folder` is a manifest.folders entry ({ folder_id, folder_root,
// drop }). Written into that folder's own root by the agent.
function renderFolderStignore(folder, manifest) {
  return stignoreBody(folder.drop || [], [
    `// node: ${manifest.node}`,
    `// folder: ${folder.folder_id || '(default)'}${folder.folder_root ? ` @ ${folder.folder_root}` : ''}`,
    `// plan: ${manifest.planHash}`,
    `// generated: ${manifest.generatedAt}`,
  ]);
}

// rclone renderer: an --include-from style files-from list of what the node SHOULD hold.
// v1 transport is Syncthing; this keeps the interface so an rclone-transported node only
// needs an agent-side runner, not a new planner.
function renderRclone(manifest) {
  return `${manifest.keep.map(e => `${e.relPath}/**`).join('\n')}\n`;
}

// Which inventory titles are physically present on a node, from its agent file report. A title is
// present when the node reports ≥1 file under the title's folder (same folderKey dir-walk as
// computeAtimeValues), regardless of atime — presence is "the file exists on disk", a separate
// question from the atime LRU. `inventory` here is the manifest's resolved keep∪drop entries.
function physicalTitleBytes({ inventory, files = [] }) {
  const byRel = new Map(inventory.map(t => [folderKey(t), t]));
  const bytes = new Map();
  for (const f of files) {
    const fid = f.folderId ?? f.folder_id ?? '';
    let dir = String(f.relPath);
    while (dir.includes('/')) {
      dir = dir.slice(0, dir.lastIndexOf('/'));
      const t = byRel.get(folderKey({ folderId: fid, relPath: dir }));
      if (t) { bytes.set(t.mediaId, (bytes.get(t.mediaId) || 0) + (Number(f.sizeBytes) || 0)); break; }
    }
  }
  return bytes;
}

function physicalTitleIds({ inventory, files = [] }) {
  return new Set(physicalTitleBytes({ inventory, files }).keys());
}

// §1.3 Physical-action preview: what the agent will ACTUALLY do next, computed from
// {plan keep/drop} × {physical inventory}. Every keep/drop title lands in exactly one bucket:
//   downloadLocally  — keep ∧ not on disk (agent must fetch it)
//   removeLocal      — drop ∧ on disk (agent will delete the local copy; master untouched)
//   alreadyAbsent    — drop ∧ not on disk (nothing to do — e.g. deleted by hand or never fetched)
//   keptDownloading  — keep ∧ present but reported bytes < expected×completeFrac (mid-transfer)
//   keptSynced       — keep ∧ present and reported bytes ≥ expected×completeFrac (fully in place)
// Presence + byte totals come from the agent's own file report (tier_node_files), so a manual
// deletion shows as alreadyAbsent (not a spurious removal) and a title already on disk isn't
// counted as a download — the honest answer to "if I apply this, what moves?". A node with no
// report yet reports every keep as downloadLocally (nothing known present), which is the correct
// conservative reading for a first fill. completeFrac tolerates size drift between the arr's
// recorded size and the summed on-disk bytes (default 98%).
function computeTierActionPreview({ manifest, files = [], completeFrac = 0.98 }) {
  const all = [...(manifest.keep || []), ...(manifest.drop || [])];
  const bytesPresent = physicalTitleBytes({ inventory: all, files });
  const buckets = { downloadLocally: [], removeLocal: [], alreadyAbsent: [], keptDownloading: [], keptSynced: [] };
  for (const e of manifest.keep || []) {
    if (!bytesPresent.has(e.mediaId)) buckets.downloadLocally.push(e);
    else if ((bytesPresent.get(e.mediaId) || 0) < (e.sizeBytes || 0) * completeFrac) buckets.keptDownloading.push(e);
    else buckets.keptSynced.push(e);
  }
  for (const e of manifest.drop || []) {
    if (bytesPresent.has(e.mediaId)) buckets.removeLocal.push(e);
    else buckets.alreadyAbsent.push(e);
  }
  const sum = arr => arr.reduce((a, e) => a + (e.sizeBytes || 0), 0);
  const totals = {};
  for (const [k, v] of Object.entries(buckets)) totals[k] = { count: v.length, bytes: sum(v) };
  return { ...buckets, totals, hasReport: files.length > 0 };
}

// §1.5 apply-impact assessment: what publishing this plan will ACTUALLY do to disk, computed from
// the node's last physical inventory (`files`) rather than the previous plan — so a manual deletion
// doesn't count as a "removal" and a title already on disk isn't counted as a "download".
//   realRemovalBytes / removedTitles — drop-set titles currently present locally (agent will delete)
//   newDownloadBytes / newDownloadTitles — keep-set titles NOT present locally (must be fetched)
// A node with no agent report yet reports everything as "to download" (nothing known present) —
// the honest conservative reading, which is exactly when a large first fill deserves confirmation.
// `caps` (any subset) flags an over-limit rebalance; requiresConfirm is the OR of the flags set.
function assessApplyImpact({ manifest, files = [], caps = {} }) {
  const all = [...(manifest.keep || []), ...(manifest.drop || [])];
  const present = physicalTitleIds({ inventory: all, files });
  let realRemovalBytes = 0, removedTitles = 0, newDownloadBytes = 0, newDownloadTitles = 0;
  for (const e of manifest.drop || []) {
    if (present.has(e.mediaId)) { realRemovalBytes += e.sizeBytes || 0; removedTitles++; }
  }
  for (const e of manifest.keep || []) {
    if (!present.has(e.mediaId)) { newDownloadBytes += e.sizeBytes || 0; newDownloadTitles++; }
  }
  const exceeds = {
    realRemovalBytes: caps.maxRealRemovalBytes != null && realRemovalBytes > caps.maxRealRemovalBytes,
    removedTitles: caps.maxRemovedTitles != null && removedTitles > caps.maxRemovedTitles,
    newDownloadBytes: caps.maxNewDownloadBytes != null && newDownloadBytes > caps.maxNewDownloadBytes,
  };
  return {
    realRemovalBytes, removedTitles, newDownloadBytes, newDownloadTitles,
    hasReport: files.length > 0,
    exceeds,
    requiresConfirm: Object.values(exceeds).some(Boolean),
  };
}

// A short confirmation code bound to the EXACT plan a large apply would publish. Deterministic in
// (node, planHash), so `/tier preview` and `/tier apply` show the same code — but the moment the
// plan changes (inventory shifted), the hash changes and any echoed stale code no longer matches,
// which is the point: you confirm the plan you were shown, not whatever the planner produces next.
function tierApplyConfirmCode(node, planHash) {
  return crypto.createHash('sha256').update(`${String(node).toLowerCase()}:${planHash}`).digest('hex').slice(0, 4).toUpperCase();
}

module.exports = {
  TIER_DEFAULTS,
  recencyDecay,
  titleKey,
  demandScore,
  computeUniversalCore,
  fetchTierInventory,
  fetchPlexHistory,
  fetchPlexGuid,
  mediaIdFromGuid,
  indexHistory,
  parseAtimeMask,
  inAtimeMask,
  maskSuspectAtimes,
  toRelPath,
  nodeFolders,
  resolveTitleFolder,
  computeAtimeValues,
  computeNodeValues,
  planNode,
  planTier,
  gatherNodeHistories,
  computePlanHash,
  physicalTitleIds,
  physicalTitleBytes,
  computeTierActionPreview,
  assessApplyImpact,
  tierApplyConfirmCode,
  renderSyncthingStignore,
  renderFolderStignore,
  renderRclone,
};
