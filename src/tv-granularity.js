// Season/episode-level TV cache planning identity + pure planner slices (issue #183).
//
// STATUS — PREVIEW + GATED WIRING (issue #183). This module stays a self-contained,
// DB/Discord-free library (same shape as src/tier.js). The live planner (src/tier.js),
// staging (src/staging.js), and agent ignore-rule generation still use whole-series units
// everywhere — nothing here changes live inventory, budgets, or deletion boundaries. What IS
// wired, as of this writing:
//   · `/tier granularity preview` (index.js) — read-only; runs buildTvUnitInventory +
//     computeMigrationPreview against live Sonarr data and renders the report. Writes nothing.
//   · handleCaPlayStart (index.js) — resolves the played unit via resolvePromotableUnit and
//     records the promotion-cap verdict in audit events. At the default 'series' granularity
//     this is byte-identical to the old behavior (unit === the whole-series id, no new reads).
// Live inventory expansion and any manifest migration remain explicitly out of scope and need
// their own human-reviewed step per the #183 issue's routing guidance. See the #183 PR
// description for the exact rollout plan and what remains before any of this can run in
// production.
//
// Design note: src/tier.js's planner (`planNode` / `planTier`) is already generic over inventory
// items shaped as { mediaId, title, mediaType, sizeBytes, addedAt, path, relPath } — it has no
// idea whether a `mediaId` denotes a movie, a whole TV series, a season, or an episode. That means
// season/episode-granularity planning needs NO changes to src/tier.js itself: this module's job is
// only to (a) mint canonical season/episode ids, (b) turn whole-series inventory + Sonarr episode-
// file data into season/episode-level inventory items in that same shape, and (c) resolve which
// unit a play event should promote. Feed the result of buildTvUnitInventory() into planNode/
// planTier exactly as today's whole-series items are fed in, and budget/eviction math is already
// correct — see scripts/tests/tv-granularity.test.js for the proof (a played episode pins/promotes
// only its season, not the whole series, and byte accounting uses the season's real bytes).
//
// Default granularity everywhere is 'series' — pass it through unchanged (see buildTvUnitInventory
// below) so a caller that never touches this module, or that explicitly configures 'series', gets
// byte-for-byte the same inventory shape existing whole-series manifests already use.

const TV_GRANULARITIES = ['series', 'season', 'episode'];

function normalizeGranularity(raw, fallback = 'series') {
  const g = String(raw || '').trim().toLowerCase();
  return TV_GRANULARITIES.includes(g) ? g : fallback;
}

// ---- Canonical episode/season/series identity -----------------------------------------------
// series: tvdb:<id>            — unchanged legacy whole-series id (src/tier.js `fetchTierInventory`)
// season: tvdb:<id>:s<N>       — N is the raw Sonarr season number (0 = specials), no zero-padding
// episode: tvdb:<id>:s<N>e<M>  — M is the raw Sonarr episode number within that season
//
// These are deliberately still `tvdb:`-prefixed so a season/episode id sorts and greps next to its
// series id, and so any code that only cares "is this a TV id" can keep matching on the prefix.
function bareTvdbId(id) {
  const s = String(id ?? '').trim();
  const m = /^tvdb:(\d+)$/.exec(s) || /^(\d+)$/.exec(s);
  return m ? m[1] : null;
}

function canonicalSeriesId(tvdbId) {
  const n = bareTvdbId(tvdbId);
  return n ? `tvdb:${n}` : null;
}

function canonicalSeasonId(tvdbId, seasonNumber) {
  const n = bareTvdbId(tvdbId);
  if (!n || seasonNumber == null || !Number.isFinite(Number(seasonNumber))) return null;
  return `tvdb:${n}:s${Number(seasonNumber)}`;
}

function canonicalEpisodeId(tvdbId, seasonNumber, episodeNumber) {
  const n = bareTvdbId(tvdbId);
  if (!n || seasonNumber == null || episodeNumber == null
    || !Number.isFinite(Number(seasonNumber)) || !Number.isFinite(Number(episodeNumber))) return null;
  return `tvdb:${n}:s${Number(seasonNumber)}e${Number(episodeNumber)}`;
}

const SERIES_ID_RE = /^tvdb:(\d+)$/;
const SEASON_ID_RE = /^tvdb:(\d+):s(\d+)$/;
const EPISODE_ID_RE = /^tvdb:(\d+):s(\d+)e(\d+)$/;

// Parse any canonical TV unit id back into its parts. Returns null for a non-TV / unrecognized id
// (e.g. a movie's `tmdb:<id>`) so callers can safely run this over a mixed movie+TV inventory.
function parseTvUnitId(mediaId) {
  const s = String(mediaId || '');
  let m = EPISODE_ID_RE.exec(s);
  if (m) return { kind: 'episode', tvdbId: m[1], seasonNumber: Number(m[2]), episodeNumber: Number(m[3]) };
  m = SEASON_ID_RE.exec(s);
  if (m) return { kind: 'season', tvdbId: m[1], seasonNumber: Number(m[2]), episodeNumber: null };
  m = SERIES_ID_RE.exec(s);
  if (m) return { kind: 'series', tvdbId: m[1], seasonNumber: null, episodeNumber: null };
  return null;
}

// Which unit id a play/pin/promotion event should target, given the configured granularity and
// what is actually known about the played episode. ALWAYS degrades toward the coarser, already-
// battle-tested `series` unit when the finer-grained information isn't available — it never
// invents a season/episode id from partial data, and it never promotes something bigger than what
// was configured. This is the one function a future play-triggered-promotion integration (the
// California/PH staging path, still unwired here) would call to decide what to pin; it is pure and
// synchronous so that integration can stay easy to test.
//
// Returns { kind, mediaId } — kind may differ from the requested granularity when data was
// missing; callers that need to know the request was NOT honored fully should compare `kind` to
// the granularity they passed in.
function resolvePlayedUnit({ tvdbId, seasonNumber, episodeNumber, granularity } = {}) {
  const g = normalizeGranularity(granularity);
  const series = canonicalSeriesId(tvdbId);
  if (!series) return null;
  if (g === 'episode') {
    const id = canonicalEpisodeId(tvdbId, seasonNumber, episodeNumber);
    if (id) return { kind: 'episode', mediaId: id };
  }
  if (g === 'episode' || g === 'season') {
    const id = canonicalSeasonId(tvdbId, seasonNumber);
    if (id) return { kind: 'season', mediaId: id };
  }
  return { kind: 'series', mediaId: series };
}

// ---- Longest-common-directory helper (season/episode folder path) ---------------------------
// Given a set of absolute file paths that all belong to one season, the season's own "unit path"
// is their common ancestor directory (normally the season folder Sonarr organizes into). Falls
// back to the single path's own directory when only one file is given, and to the empty string
// when paths disagree so wildly there is no shared root (defensive — should not happen with real
// Sonarr data, but this must never THROW on odd input).
function commonDir(paths) {
  const dirs = paths.map(p => String(p || '').replace(/\/+$/, '').split('/').filter(Boolean));
  if (!dirs.length) return '';
  let common = dirs[0].slice(0, -1); // drop the filename component
  for (const parts of dirs.slice(1)) {
    const fileDir = parts.slice(0, -1);
    let i = 0;
    while (i < common.length && i < fileDir.length && common[i] === fileDir[i]) i += 1;
    common = common.slice(0, i);
  }
  return common.length ? `/${common.join('/')}` : '';
}

// ---- Whole-series inventory → season/episode inventory --------------------------------------
//
// `seriesItems`: whole-series inventory items exactly as src/tier.js `fetchTierInventory` already
//   produces them: { mediaId: 'tvdb:<id>', title, mediaType: 'tv', sizeBytes, addedAt, path,
//   relPath }. Movie items in the same array (mediaType !== 'tv') pass through completely
//   untouched, at any granularity.
//
// `episodeFilesBySeries`: a plain object or Map keyed by bare tvdb id (string or number, either
//   works — see bareTvdbId) whose value is an array of episode-file records:
//     { seasonNumber, episodeNumber (nullable — see below), sizeBytes, path, addedAt (ms|null) }
//   This is deliberately NOT the raw Sonarr `/api/v3/episodefile` response shape (whose exact
//   fields aren't re-derived here) — a caller integrating real Sonarr data maps it into this small
//   documented shape first, keeping this module decoupled from Sonarr API specifics. A record with
//   `episodeNumber: null` (Sonarr can return a multi-episode file with an ambiguous single episode
//   number) still rolls up into its season correctly; it just can't be split further at episode
//   granularity — see the `episode`-granularity note below.
//
// `granularity`: 'series' (default), 'season', or 'episode'.
//
// `sourceRoot`: same meaning as src/tier.js TIER_SOURCE_ROOT — stripped to compute relPath.
//
// Returns { items, warnings }. `items` covers every input title exactly once (never fewer, never
// duplicated) — a series with no episode-file data available for it is a case a caller MUST expect
// (an arr that hasn't backfilled episode files yet, a partial fetch, etc.) and this function always
// keeps that series as its original whole-series item rather than dropping it, emitting a warning
// instead. That mirrors src/tier.js's own rule that a fetch failure must never silently remove a
// title from the plan (see fetchTierInventory's failedSources contract).
function buildTvUnitInventory({ seriesItems = [], episodeFilesBySeries = {}, granularity = 'series', sourceRoot = '' } = {}) {
  const g = normalizeGranularity(granularity);
  const warnings = [];
  const filesFor = id => {
    if (episodeFilesBySeries instanceof Map) return episodeFilesBySeries.get(id) || episodeFilesBySeries.get(String(id)) || episodeFilesBySeries.get(Number(id));
    return episodeFilesBySeries[id] || episodeFilesBySeries[String(id)] || [];
  };

  if (g === 'series') {
    return { items: seriesItems.map(t => (t.mediaType === 'tv' ? { ...t, unit: 'series' } : t)), warnings };
  }

  const items = [];
  for (const t of seriesItems) {
    if (t.mediaType !== 'tv') { items.push(t); continue; }
    const tvdbId = bareTvdbId(t.mediaId);
    const files = tvdbId ? filesFor(tvdbId) : [];
    if (!tvdbId || !files || !files.length) {
      warnings.push(`"${t.title}" (${t.mediaId}): no episode-file data available — kept as a single whole-series unit (legacy behavior) instead of splitting to ${g} granularity.`);
      items.push({ ...t, unit: 'series' });
      continue;
    }

    // Group by season first (needed at both 'season' and 'episode' granularity).
    const bySeason = new Map();
    for (const f of files) {
      const sn = Number(f.seasonNumber);
      if (!Number.isFinite(sn)) continue;
      if (!bySeason.has(sn)) bySeason.set(sn, []);
      bySeason.get(sn).push(f);
    }
    if (!bySeason.size) {
      warnings.push(`"${t.title}" (${t.mediaId}): episode-file data carried no usable season numbers — kept as a single whole-series unit.`);
      items.push({ ...t, unit: 'series' });
      continue;
    }

    const seasonBytesTotal = [...bySeason.values()].reduce((a, fs) => a + fs.reduce((b, f) => b + (Number(f.sizeBytes) || 0), 0), 0);
    if (t.sizeBytes && seasonBytesTotal && Math.abs(seasonBytesTotal - t.sizeBytes) / t.sizeBytes > 0.05) {
      warnings.push(`"${t.title}" (${t.mediaId}): summed episode-file bytes (${seasonBytesTotal}) differ from the series' reported sizeOnDisk (${t.sizeBytes}) by more than 5% — episode-file data may be stale or incomplete.`);
    }

    for (const [seasonNumber, seasonFiles] of bySeason) {
      const seasonPaths = seasonFiles.map(f => f.path).filter(Boolean);
      const seasonPath = commonDir(seasonPaths) || (seasonPaths[0] ? seasonPaths[0].split('/').slice(0, -1).join('/') : t.path);
      const seasonAddedAt = seasonFiles.reduce((a, f) => (f.addedAt && (!a || f.addedAt > a) ? f.addedAt : a), null);
      const seasonSizeBytes = seasonFiles.reduce((a, f) => a + (Number(f.sizeBytes) || 0), 0);

      if (g === 'season') {
        const mediaId = canonicalSeasonId(tvdbId, seasonNumber);
        items.push({
          mediaId,
          title: `${t.title} — Season ${seasonNumber}`,
          mediaType: 'tv',
          unit: 'season',
          seriesMediaId: t.mediaId,
          seasonNumber,
          sizeBytes: seasonSizeBytes,
          addedAt: seasonAddedAt,
          path: seasonPath,
          relPath: sourceRoot ? stripRoot(seasonPath, sourceRoot) : seasonPath,
        });
        continue;
      }

      // g === 'episode': split further; a file with no resolvable episodeNumber can't be split
      // further, so it becomes its own single-file "episode" unit keyed off the file path instead
      // of an episode number — still season-scoped, still never silently merged into a bigger unit
      // than the data supports.
      const byEpisode = new Map();
      let unresolved = 0;
      for (const f of seasonFiles) {
        const en = f.episodeNumber == null ? NaN : Number(f.episodeNumber);
        if (Number.isFinite(en)) {
          if (!byEpisode.has(en)) byEpisode.set(en, []);
          byEpisode.get(en).push(f);
        } else {
          unresolved += 1;
          byEpisode.set(`unresolved:${byEpisode.size}`, [f]);
        }
      }
      if (unresolved) {
        warnings.push(`"${t.title}" S${seasonNumber} (${t.mediaId}): ${unresolved} episode-file(s) carried no resolvable episode number — each was kept as its own file-scoped unit rather than merged.`);
      }
      for (const [epKey, epFiles] of byEpisode) {
        const isNumbered = typeof epKey === 'number';
        const mediaId = isNumbered ? canonicalEpisodeId(tvdbId, seasonNumber, epKey)
          : `${canonicalSeasonId(tvdbId, seasonNumber)}:file:${epFiles[0].path}`;
        const epPaths = epFiles.map(f => f.path).filter(Boolean);
        const epPath = commonDir(epPaths) || epPaths[0] || seasonPath;
        items.push({
          mediaId,
          title: isNumbered ? `${t.title} — S${seasonNumber}E${epKey}` : `${t.title} — S${seasonNumber} (unresolved episode)`,
          mediaType: 'tv',
          unit: 'episode',
          seriesMediaId: t.mediaId,
          seasonMediaId: canonicalSeasonId(tvdbId, seasonNumber),
          seasonNumber,
          episodeNumber: isNumbered ? epKey : null,
          sizeBytes: epFiles.reduce((a, f) => a + (Number(f.sizeBytes) || 0), 0),
          addedAt: epFiles.reduce((a, f) => (f.addedAt && (!a || f.addedAt > a) ? f.addedAt : a), null),
          path: epPath,
          relPath: sourceRoot ? stripRoot(epPath, sourceRoot) : epPath,
        });
      }
    }
  }
  return { items, warnings };
}

function stripRoot(absPath, sourceRoot) {
  const p = String(absPath || '').replace(/\/+$/, '');
  const root = String(sourceRoot || '').replace(/\/+$/, '');
  if (root && (p === root || p.startsWith(`${root}/`))) return p.slice(root.length).replace(/^\/+/, '');
  return p.replace(/^\/+/, '');
}

// ---- Oversized-promotion gate ------------------------------------------------------------------
// A single episode/season/series promotion above `capBytes` requires explicit operator
// confirmation before anything acts on it — mirrors the existing `/tier apply` confirm-code
// pattern (`assessApplyImpact` / `tierApplyConfirmCode` in src/tier.js) rather than inventing a new
// convention. `capBytes` <= 0 or null disables the cap (matches the "0 disables" convention used by
// TIER_APPLY_MAX_* in src/config.js).
function checkPromotionCap({ unitBytes, capBytes }) {
  const cap = Number(capBytes) || 0;
  const bytes = Number(unitBytes) || 0;
  const exceeds = cap > 0 && bytes > cap;
  return { unitBytes: bytes, capBytes: cap, exceeds, requiresConfirm: exceeds };
}

// ---- Read-only migration preview ---------------------------------------------------------------
// Reports what converting a legacy whole-series manifest to season/episode granularity WOULD look
// like — byte accounting and path/unit breakdown per series — and touches nothing: no file is
// written, no DB row is read or written, no plan is applied. This is intentionally the full extent
// of "migration" implemented so far; live conversion (rewriting stored plans/state, or the agent's
// ignore rules, to season/episode identity) is out of scope here and needs its own human-reviewed
// step per the #183 issue's own routing guidance.
//
// `legacyEntries`: the whole-series entries from an existing manifest, e.g. `manifest.keep` and/or
//   `manifest.drop` from src/tier.js (only TV entries matter; movie entries are ignored here).
// `expandedItems`: the season/episode-granularity items for the SAME library from
//   buildTvUnitInventory() (granularity 'season' or 'episode').
// `capBytes`: optional — when given, flags which resulting units would need the confirmation gate.
function computeMigrationPreview({ legacyEntries = [], expandedItems = [], capBytes = null } = {}) {
  const childrenBySeries = new Map();
  for (const item of expandedItems) {
    if (!item.seriesMediaId) continue;
    if (!childrenBySeries.has(item.seriesMediaId)) childrenBySeries.set(item.seriesMediaId, []);
    childrenBySeries.get(item.seriesMediaId).push(item);
  }

  const perSeries = [];
  const warnings = [];
  let totalLegacyBytes = 0;
  let totalUnitBytes = 0;
  let oversizedUnitCount = 0;
  let seriesMissingChildData = 0;

  for (const entry of legacyEntries) {
    const parsed = parseTvUnitId(entry.mediaId);
    if (!parsed || parsed.kind !== 'series') continue; // not a whole-series TV entry; skip
    const children = childrenBySeries.get(entry.mediaId) || [];
    totalLegacyBytes += entry.sizeBytes || 0;
    if (!children.length) {
      seriesMissingChildData += 1;
      warnings.push(`"${entry.title || entry.mediaId}": no season/episode breakdown available in the expanded inventory — migration would have to keep this series whole for now.`);
      perSeries.push({
        seriesMediaId: entry.mediaId,
        title: entry.title,
        legacyRelPath: entry.relPath,
        legacyBytes: entry.sizeBytes || 0,
        units: [],
        unitBytes: 0,
        byteDeltaBytes: -(entry.sizeBytes || 0),
        missingChildData: true,
      });
      continue;
    }
    const units = children.map(c => {
      const cap = checkPromotionCap({ unitBytes: c.sizeBytes, capBytes });
      if (cap.requiresConfirm) oversizedUnitCount += 1;
      return {
        mediaId: c.mediaId, title: c.title, unit: c.unit, relPath: c.relPath, sizeBytes: c.sizeBytes,
        requiresConfirm: cap.requiresConfirm,
      };
    });
    const unitBytes = units.reduce((a, u) => a + (u.sizeBytes || 0), 0);
    totalUnitBytes += unitBytes;
    perSeries.push({
      seriesMediaId: entry.mediaId,
      title: entry.title,
      legacyRelPath: entry.relPath,
      legacyBytes: entry.sizeBytes || 0,
      units,
      unitBytes,
      byteDeltaBytes: unitBytes - (entry.sizeBytes || 0),
      missingChildData: false,
    });
  }

  return {
    perSeries,
    totals: {
      seriesCount: perSeries.length,
      seriesMissingChildData,
      unitCount: perSeries.reduce((a, s) => a + s.units.length, 0),
      oversizedUnitCount,
      totalLegacyBytes,
      totalUnitBytes,
      totalByteDeltaBytes: totalUnitBytes - totalLegacyBytes,
    },
    warnings,
    // Explicit marker so anything that logs/serializes this result is unambiguous about what it
    // is: a report, not a plan, and never something to act on directly.
    readOnly: true,
    live: false,
  };
}

// ---- Promotion-unit resolution (play-start wiring) ------------------------------------------------
// Which unit id a play-start promotion may pin, floored to units the planner actually knows
// about. `inventoryMediaIds` is the live planner's unit vocabulary (e.g. the node's published
// plan keep set); pass null/undefined when there is nothing to floor against.
//
// At the default 'series' granularity this is a byte-identical no-op: the resolved unit IS the
// whole-series id, returned without any inventory lookup. With finer granularity configured but a
// whole-series inventory, a season/episode id fails closed back to the whole-series id rather
// than pinning a unit no plan contains (a pin whose mediaId matches nothing in the manifest
// resolves to nothing and would be silently inert).
//
// Returns the mediaId to pin, or null when tvdbId itself is unusable.
function resolvePromotableUnit({ tvdbId, seasonNumber, episodeNumber, granularity = 'series', inventoryMediaIds = null } = {}) {
  const series = canonicalSeriesId(tvdbId);
  if (!series) return null;
  const unit = resolvePlayedUnit({ tvdbId, seasonNumber, episodeNumber, granularity });
  const resolved = unit ? unit.mediaId : series;
  if (resolved === series) return series;
  if (!inventoryMediaIds) return resolved;
  const known = inventoryMediaIds instanceof Set ? inventoryMediaIds : new Set(inventoryMediaIds);
  const parsed = parseTvUnitId(resolved);
  const candidates = [resolved];
  if (parsed?.kind === 'episode') candidates.push(canonicalSeasonId(parsed.tvdbId, parsed.seasonNumber));
  candidates.push(series);
  return candidates.find(id => known.has(id)) || series;
}

// ---- Live-Sonarr mapping + read-only preview assembly ------------------------------------------
// These map raw Sonarr API shapes into the documented inputs of buildTvUnitInventory, and assemble
// the read-only preview the `/tier granularity preview` command renders. Pure and synchronous —
// the Discord handler does the fetching (listSonarrSeries / getEpisodeFiles), this module does
// the shaping. Nothing here performs I/O or writes anything, anywhere.

// Raw Sonarr /api/v3/series record → whole-series inventory item in fetchTierInventory's shape,
// plus the Sonarr-internal id the preview needs to fetch episode files. Series without a tvdbId
// are dropped (they can never mint a canonical unit id).
function mapSonarrSeriesList(rawList, { sourceRoot = '' } = {}) {
  return (Array.isArray(rawList) ? rawList : [])
    .filter(s => s && s.tvdbId)
    .map(s => {
      const mediaId = canonicalSeriesId(s.tvdbId);
      const addedAt = s.addedDate ? Date.parse(s.addedDate) : NaN;
      const p = s.path || '';
      return {
        mediaId,
        title: s.title || `tvdb:${s.tvdbId}`,
        mediaType: 'tv',
        unit: 'series',
        seriesMediaId: mediaId,
        sonarrId: s.id,
        sizeBytes: Number(s.statistics?.sizeOnDisk) || 0,
        addedAt: Number.isFinite(addedAt) ? addedAt : null,
        path: p,
        relPath: sourceRoot ? stripRoot(p, sourceRoot) : p,
      };
    })
    .filter(t => t.mediaId);
}

// Raw Sonarr /api/v3/episodefile record → the documented episode-file shape
// { seasonNumber, episodeNumber (nullable), sizeBytes, path, addedAt (ms|null) }.
// Records without a usable season number are dropped (they can't roll up into any unit).
function mapSonarrEpisodeFiles(rawFiles) {
  return (Array.isArray(rawFiles) ? rawFiles : [])
    .filter(f => f && f.path)
    .map(f => {
      const addedAt = f.dateAdded ? Date.parse(f.dateAdded) : NaN;
      return {
        seasonNumber: Number(f.seasonNumber),
        episodeNumber: f.episodeNumber == null ? null : Number(f.episodeNumber),
        sizeBytes: Number(f.sizeOnDisk) || 0,
        path: f.path,
        addedAt: Number.isFinite(addedAt) ? addedAt : null,
      };
    })
    .filter(f => Number.isFinite(f.seasonNumber));
}

// Assemble the read-only preview: expand whole-series items to the requested granularity, then
// report what a migration to that granularity WOULD look like. Returns the computeMigrationPreview
// report plus the build warnings and the effective granularity — a report, not a plan, and never
// something to act on directly (the result carries readOnly: true, live: false).
function previewTvGranularity({ seriesItems = [], episodeFilesBySeries = {}, granularity = 'season', capBytes = null, sourceRoot = '' } = {}) {
  const g = normalizeGranularity(granularity) === 'episode' ? 'episode' : 'season';
  const { items, warnings: buildWarnings } = buildTvUnitInventory({ seriesItems, episodeFilesBySeries, granularity: g, sourceRoot });
  const preview = computeMigrationPreview({
    legacyEntries: seriesItems.filter(t => t.mediaType === 'tv'),
    expandedItems: items,
    capBytes,
  });
  return { ...preview, buildWarnings, granularity: g, previewedSeries: seriesItems.length };
}

module.exports = {
  TV_GRANULARITIES,
  normalizeGranularity,
  canonicalSeriesId,
  canonicalSeasonId,
  canonicalEpisodeId,
  parseTvUnitId,
  resolvePlayedUnit,
  resolvePromotableUnit,
  mapSonarrSeriesList,
  mapSonarrEpisodeFiles,
  previewTvGranularity,
  buildTvUnitInventory,
  checkPromotionCap,
  computeMigrationPreview,
};
