'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');
const { rateLimit } = require('express-rate-limit');
const { createAgentApiAuth } = require('./agent-api-auth');
const { statusFromSeerrRequest } = require('../request-tracking');
const { mergeFleetDisks } = require('../fleet-disks');
const { pad } = require('../util');

// Machine API for the Plex Director agent (v1.1).
// Auth: `Authorization: Bearer <token>`, hash-compared like the tier-agent tokens; the matched
// token's label rides on req.agentTokenLabel so every audited mutation names its client.
// v1 was GET-only; v1.1 adds a small allowlist of fix endpoints (POST) behind explicit approval.
// The allowlist is deliberately narrow: only repairs the bot already performs on its own or
// through existing dashboard/Discord controls. No deletes, restarts, config changes, user
// management, or token management exist on this surface. Every mutation is audited with an
// `agent:<label>` actor, and POST routes sit behind a much tighter rate limiter than reads.
// Responses are small, typed projections — never raw upstream payloads, so tokens, API keys,
// and full config can never leak through this surface.

// Readable request states the /api/v1/requests ?status= filter accepts. Status labels come
// from statusFromSeerrRequest (src/request-tracking.js) — the same mapping the bot's own
// request reconciliation uses — so the API never invents its own vocabulary.
const REQUEST_STATUS_FILTERS = ['pending', 'approved', 'available', 'declined', 'failed'];
const MAX_RESULTS = 25;
const MAX_REQUESTS = 200;
const HEALTH_CACHE_MS = 30000;

// Roots that POST /api/v1/seedbox/import-force is allowed to copy into. The endpoint takes a
// caller-supplied absolute `destination`, mkdir -p's it, and overwrites files inside it, so the
// path has to be contained the same way resolveSafeMediaPath() contains the download routes —
// otherwise an agent token can write anywhere the bot's uid can reach, /app/data (the SQLite
// database and its backups) included. Derived from the media/import paths the deployment already
// configures, plus IMPORT_FORCE_DEST_ROOTS for a layout none of them cover. Order doesn't matter;
// blanks are dropped.
function importDestinationRoots(config = {}) {
  const extra = Array.isArray(config.IMPORT_FORCE_DEST_ROOTS)
    ? config.IMPORT_FORCE_DEST_ROOTS
    : String(config.IMPORT_FORCE_DEST_ROOTS || '').split(',');
  return [
    ...extra,
    config.RAID_PATH,
    config.PATH_REMAP_TO,
    config.TIER_SOURCE_ROOT,
    config.GRAB_IMPORT_PATH,
    config.GRAB_STAGING_PATH,
    config.PREMIUMIZE_IMPORT_PATH,
    config.PREMIUMIZE_STAGING_PATH,
  ]
    .map(root => String(root || '').trim())
    .filter(Boolean);
}

// Containment check for a caller-supplied import destination. The destination usually does not
// exist yet (the importer creates it), so realpath the deepest ancestor that *does* exist and
// require that to sit inside an allowed root — a symlinked parent therefore cannot be used to
// escape, while the not-yet-created leaf is still checked. Returns the resolved real path on
// success so callers copy into the checked location rather than re-deriving it.
function resolveSafeImportDestination(destination, allowedRoots) {
  const raw = String(destination || '').trim();
  if (!raw || raw.includes('\0') || !path.isAbsolute(raw)) return { ok: false, reason: 'not_absolute' };
  const roots = [];
  for (const root of allowedRoots || []) {
    const resolvedRoot = path.resolve(String(root));
    try { roots.push(fs.realpathSync(resolvedRoot)); } catch { roots.push(resolvedRoot); }
  }
  if (!roots.length) return { ok: false, reason: 'no_roots' };
  const resolved = path.resolve(raw);
  let probe = resolved;
  let realAncestor = null;
  for (;;) {
    try { realAncestor = fs.realpathSync(probe); break; } catch { /* keep walking up */ }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (!realAncestor) return { ok: false, reason: 'unresolvable' };
  // path.resolve() already collapsed any `..`, so this tail can only descend.
  const tail = path.relative(probe, resolved);
  const realTarget = tail ? path.join(realAncestor, tail) : realAncestor;
  const inside = roots.some(root => realTarget === root || realTarget.startsWith(root + path.sep));
  if (!inside) return { ok: false, reason: 'outside_roots' };
  return { ok: true, path: realTarget, roots };
}

function createAgentApiReadLimiter({ limit, windowMs = 60000, keyGenerator }) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many agent API requests' }),
  });
}

// Mutations get their own, much tighter budget (default 10/min): repairs are human-scale
// operations, and a runaway client must not be able to hammer the arrs through this surface.
function createAgentApiWriteLimiter({ limit, windowMs = 60000, keyGenerator }) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many agent API mutations — wait a moment and retry' }),
  });
}

// Every audited mutation names its client: `agent:<dashboard token label>` or
// `agent:legacy-env-token`, so the audit log shows exactly which agent client acted.
function agentActor(req) {
  return { actor: `agent:${req.agentTokenLabel || 'unknown'}` };
}

// fetchArrQueues() items carry `source` with the instance URL and API key — project a safe shape.
function projectQueueItem(item) {
  const size = Number(item.size) || 0;
  const sizeLeft = Number(item.sizeleft) || 0;
  const progress = size > 0 ? Math.max(0, Math.min(1, 1 - sizeLeft / size)) : null;
  return {
    source: String(item.source?.label || 'unknown').slice(0, 40),
    kind: item.source?.kind === 'tv' ? 'tv' : 'movie',
    title: String(item.title || 'Unknown').slice(0, 200),
    status: String(item.status || '').slice(0, 60),
    trackedStatus: String(item.trackedStatus || '').slice(0, 60),
    progress: progress == null ? null : Math.round(progress * 1000) / 1000,
    sizeBytes: size,
    sizeLeftBytes: sizeLeft,
    timeLeft: item.timeleft || null,
    messages: (item.messages || []).slice(0, 3).map(m => String(m).slice(0, 200)),
  };
}

// Seerr's /api/v1/request items join only the Media row (tmdbId/tvdbId/status) — no title.
// Resolve titles through the movie/tv detail endpoints. TMDB titles are immutable, so cache
// by mediaType:tmdbId with a bounded size; per-item lookup failures degrade to a fallback
// title, never a failed request.
const SEERR_TITLE_CACHE_MAX = 2000;
const seerrTitleCache = new Map();

function seerrTitleCacheSet(key, title) {
  if (seerrTitleCache.size >= SEERR_TITLE_CACHE_MAX) {
    const oldest = seerrTitleCache.keys().next();
    if (!oldest.done) seerrTitleCache.delete(oldest.value);
  }
  seerrTitleCache.set(key, title);
}

async function resolveSeerrTitle(r, { seerrUrl, seerrApiKey, httpClient }) {
  const media = r?.media || {};
  // Prefer a title the payload already carries when present.
  const direct = String(media.title || media.name || '').trim();
  if (direct) return direct.slice(0, 200);
  const mediaType = media.mediaType === 'tv' ? 'tv' : 'movie';
  const tmdbId = Number(media.tmdbId);
  if (!seerrUrl || !seerrApiKey || !Number.isFinite(tmdbId) || tmdbId <= 0) return 'Unknown';
  const cacheKey = `${mediaType}:${tmdbId}`;
  const cached = seerrTitleCache.get(cacheKey);
  if (cached) return cached;
  try {
    const res = await httpClient.get(`${seerrUrl}/api/v1/${mediaType}/${tmdbId}`, {
      headers: { 'X-Api-Key': seerrApiKey },
      timeout: 8000,
    });
    const title = String(res.data?.title || res.data?.name || '').trim();
    if (title) {
      const clipped = title.slice(0, 200);
      seerrTitleCacheSet(cacheKey, clipped);
      return clipped;
    }
  } catch (_err) {
    // Swallowed: an unresolvable title degrades to 'Unknown', not a failed request.
  }
  return 'Unknown';
}

// Bounded-concurrency map so a full 200-request inventory doesn't fan out hundreds of
// simultaneous Seerr detail calls.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function projectSeerrRequestStatus(r) {
  return statusFromSeerrRequest(r) || `unknown(${r.status})`;
}

async function projectSeerrRequest(r, status, { seerrUrl, seerrApiKey, httpClient }) {
  return {
    id: r.id,
    status,
    mediaType: r.media?.mediaType === 'tv' ? 'tv' : 'movie',
    title: await resolveSeerrTitle(r, { seerrUrl, seerrApiKey, httpClient }),
    requestedBy: String(r.requestedBy?.displayName || r.requestedBy?.username || 'unknown').slice(0, 120),
    createdAt: r.createdAt || null,
  };
}

// Pick the best direct connection URI for a Plex server resource: local non-relay first,
// then any non-relay, then whatever plex.tv advertised.
function pickServerConnection(server) {
  const usable = (Array.isArray(server?.connections) ? server.connections : []).filter(c => c && c.uri);
  return (
    usable.find(c => c.local && !c.relay)
    || usable.find(c => !c.relay)
    || usable[0]
    || null
  );
}

// "Do I have this" — fan out a Plex library search across every known server. One unreachable
// server must not fail the whole lookup, so per-server failures are swallowed.
async function searchPlexLibrary({ title, type }, { getPlexToken, getPlexServers, httpClient }) {
  const token = await getPlexToken();
  const servers = await getPlexServers(token);
  const results = [];
  await Promise.all(servers.map(async server => {
    const conn = pickServerConnection(server);
    if (!conn) return;
    try {
      const res = await httpClient.get(`${conn.uri}/library/search`, {
        params: { query: title },
        headers: { 'X-Plex-Token': token, Accept: 'application/json' },
        timeout: 8000,
      });
      for (const m of res.data?.MediaContainer?.Metadata || []) {
        const mediaType = m.type === 'show' ? 'tv' : m.type === 'movie' ? 'movie' : null;
        if (!mediaType) continue;
        if (type && mediaType !== type) continue;
        results.push({
          title: String(m.title || 'Unknown').slice(0, 200),
          year: m.year || null,
          type: mediaType,
          server: String(server.name || 'unknown').slice(0, 120),
          library: String(m.librarySectionTitle || 'unknown').slice(0, 120),
        });
        if (results.length >= MAX_RESULTS) break;
      }
    } catch (_err) {
      // Swallowed per above: a down server degrades to fewer results, not a failed request.
    }
  }));
  return results.slice(0, MAX_RESULTS);
}

function registerAgentApiRoutes(app, deps) {
  const {
    config,
    getAgentApiTokenHashes,
    getAgentApiTokenLabel = () => null,
    legacyTokenHash = '',
    touchAgentApiTokenUse = () => {},
    sha256,
    safeEqual,
    audit,
    gatherHealth,
    fetchArrQueues,
    fetchSeerrRequests,
    fetchDiskSpace = async () => [],
    // Fleet disks: tier-node telemetry disks merge with the *arr volumes. Both default to
    // empty so the route still works in tests that don't wire the tier registry.
    listTierNodes = () => [],
    getTierPlan = () => null,
    // Master SMART readings persisted by the disk-space sweep (MASTER_SMART_DEVICES).
    getMasterSmartHealth = () => null,
    getPlexToken,
    getPlexServers,
    httpRateLimitKey,
    httpClient = axios,
    // v1.1 fix-endpoint collaborators. All are existing bot functions passed in from index.js —
    // the API invents no repair logic of its own.
    automationRegistry = null,
    addMediaToArr = null,
    fetchSeerrTvdbId = null,
    listSonarrSeries = null,
    getSeriesEpisodes = null,
    getArrTagId = null,
    triggerSeasonSearch = null,
    runSeasonDirectGrab = null,
    findAvistazIndexer = null,
    findAnimezIndexer = null,
    grabDailyAllowance = null,
    grabConfigured = null,
    tunable = () => undefined,
    clearSeasonAlertState = () => {},
    recordSeasonSearch = () => 0,
    getSeasonSearchTimes = () => ({}),
    seasonSearchCooldown = () => ({ cooling: false }),
    getSeasonEpisodeFallback = () => null,
    monitorSeasonSearch = () => {},
    sonarrSeriesAliases = () => [],
    summarizeManualImportPreview = null,
    // v1.2 Discord bridge: headless slash-command executor built in index.js around the
    // real handleSlashCommand dispatch. Null in tests that don't wire it (-> 503).
    discordExec = null,
    // v1.2 Discord button bridge: headless button-press executor built in index.js
    // around the real handleButton dispatch. Null in tests that don't wire it (-> 503).
    discordInteract = null,
    auth = createAgentApiAuth({ getAgentApiTokenHashes, getAgentApiTokenLabel, legacyTokenHash, touchAgentApiTokenUse, sha256, safeEqual, audit }),
    readLimiter = createAgentApiReadLimiter({ limit: config.AGENT_API_READ_MAX_PER_MINUTE, keyGenerator: httpRateLimitKey }),
    writeLimiter = createAgentApiWriteLimiter({ limit: config.AGENT_API_WRITE_MAX_PER_MINUTE || 10, keyGenerator: httpRateLimitKey }),
  } = deps;

  // gatherHealth() fans out to every integration; cache briefly like the public /health does so
  // a polling agent can't multiply upstream traffic.
  let healthCache = null;
  async function getCachedHealth() {
    if (healthCache && Date.now() - healthCache.at < HEALTH_CACHE_MS) return healthCache.value;
    const value = await gatherHealth();
    healthCache = { at: Date.now(), value };
    return value;
  }

  // Upstream failures surface as 502 with a fixed message — never the raw error, which can carry
  // sensitive data (see health.js's healthErrorDetail for the same rule).
  const guarded = handler => async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      audit('agent_api_error', { path: req.path, error: err.message });
      res.status(502).json({ error: 'Upstream request failed' });
    }
  };

  app.get('/api/v1/health', auth, readLimiter, guarded(async (_req, res) => {
    const h = await getCachedHealth();
    // v1.1: backup age is additive — the v1 shape is unchanged, two fields are added so a
    // polling agent can alert on stale backups, not just hard backup failures.
    const ageMs = Number(h.backupAgeMs);
    res.json({
      ok: true,
      timestamp: h.timestamp || new Date().toISOString(),
      overall: h.overall || 'unknown',
      backupLastSuccessfulAt: h.backupLastSuccessfulAt || null,
      backupAgeHours: Number.isFinite(ageMs) ? Math.round((ageMs / 3600000) * 10) / 10 : null,
      bot: {
        discord: h.discord || 'unknown',
        sqlite: h.sqlite || 'unknown',
        backup: h.backup || 'unknown',
      },
      downstream: {
        plex: h.plex || 'unknown',
        seerr: h.overseerr || 'unknown',
        radarr: h.radarr || 'unknown',
        sonarr: h.sonarr || 'unknown',
      },
    });
  }));

  // v1.1: fleet disk space. Merges (a) the *arr-reported volumes (durant-server's own
  // disks, the same fetchDiskSpace() the Director tab uses) with (b) per-tier-node disks
  // from the latest agent telemetry. Safe shape only: names + byte counts, no arr URLs,
  // keys, or raw mount internals. Tier nodes with no telemetry yet are skipped; stale
  // telemetry is included but flagged via telemetryAgeMs.
  app.get('/api/v1/disks', auth, readLimiter, guarded(async (_req, res) => {
    const raw = (await fetchDiskSpace()) || [];
    const tierNodes = listTierNodes().map(n => ({ name: n.name, telemetry: getTierPlan(n.name)?.lastTelemetry || null }));
    const disks = mergeFleetDisks({ arrDisks: raw, tierNodes, masterSmartHealth: getMasterSmartHealth() });
    res.json({ ok: true, count: disks.length, disks });
  }));

  app.get('/api/v1/library/search', auth, readLimiter, guarded(async (req, res) => {
    const title = String(req.query.title || '').trim();
    const type = String(req.query.type || '').trim().toLowerCase();
    if (title.length < 2 || title.length > 100) {
      return res.status(400).json({ error: 'title query param is required (2-100 chars)' });
    }
    if (type && type !== 'movie' && type !== 'tv') {
      return res.status(400).json({ error: "type must be 'movie' or 'tv'" });
    }
    const results = await searchPlexLibrary(
      { title, type: type || null },
      { getPlexToken, getPlexServers, httpClient },
    );
    res.json({ ok: true, query: title, type: type || null, count: results.length, results });
  }));

  app.get('/api/v1/queue', auth, readLimiter, guarded(async (_req, res) => {
    const items = (await fetchArrQueues()).map(projectQueueItem);
    res.json({ ok: true, count: items.length, items });
  }));

  app.get('/api/v1/requests', auth, readLimiter, guarded(async (req, res) => {
    const statusFilter = String(req.query.status || '').trim().toLowerCase();
    if (statusFilter && !REQUEST_STATUS_FILTERS.includes(statusFilter)) {
      return res.status(400).json({ error: `status must be one of: ${REQUEST_STATUS_FILTERS.join(', ')}` });
    }
    // Status mapping is cheap and synchronous — filter first, then resolve titles only for the
    // page actually returned so one call never fans out more detail lookups than needed.
    const withStatus = (await fetchSeerrRequests()).map(r => ({ r, status: projectSeerrRequestStatus(r) }));
    const filtered = statusFilter ? withStatus.filter(x => x.status === statusFilter) : withStatus;
    const capped = filtered.slice(0, MAX_REQUESTS);
    const titleDeps = { seerrUrl: config.OVERSEERR_URL, seerrApiKey: config.OVERSEERR_API_KEY, httpClient };
    const requests = await mapWithConcurrency(capped, 8, x => projectSeerrRequest(x.r, x.status, titleDeps));
    res.json({ ok: true, count: requests.length, total: filtered.length, requests });
  }));

  // ---- v1.1 fix endpoints ----
  // Small allowlist of repairs the bot already performs on its own or through existing
  // dashboard/Discord controls. Every one of these: requires agent auth, sits behind the
  // tight write limiter, runs inside `guarded` (502 on upstream failure, never raw errors),
  // and audits with the agent token's label. Anything not listed here does not exist.

  // Run or preview an automation sweep — the same preview()/run() the /automation Discord
  // command uses. Sweep names are validated against the registry; unknown names are 400.
  app.post('/api/v1/automation/sweep', auth, writeLimiter, guarded(async (req, res) => {
    if (!automationRegistry) return res.status(503).json({ error: 'Automation registry is unavailable' });
    const sweep = String(req.body?.sweep || '').trim();
    const mode = String(req.body?.mode || '').trim();
    const names = (automationRegistry.list() || []).map(item => item.id);
    if (!sweep || !names.includes(sweep)) {
      audit('agent_api_automation_sweep', { ...agentActor(req), ok: false, reason: 'unknown_sweep', sweep: sweep || null });
      return res.status(400).json({ error: `Unknown sweep. Valid sweeps: ${names.join(', ') || '(none)'}` });
    }
    if (mode !== 'preview' && mode !== 'run') {
      audit('agent_api_automation_sweep', { ...agentActor(req), ok: false, reason: 'invalid_mode', sweep, mode: mode || null });
      return res.status(400).json({ error: 'mode must be "preview" or "run"' });
    }
    if (mode === 'preview') {
      const preview = await automationRegistry.preview(sweep);
      if (!preview.ok) {
        audit('agent_api_automation_sweep', { ...agentActor(req), ok: false, sweep, mode, reason: preview.busy ? 'busy' : (preview.reason || 'unavailable') });
        return res.status(409).json({ error: preview.busy ? `${sweep} is already running` : (preview.reason || 'Preview is unavailable') });
      }
      const items = (preview.result || []).map(item => ({
        title: String(item.title || '').slice(0, 200),
        stage: String(item.stage || '').slice(0, 60),
        reason: String(item.reason || '').slice(0, 200),
      }));
      audit('agent_api_automation_sweep', { ...agentActor(req), ok: true, sweep, mode, items: items.length });
      return res.json({ ok: true, sweep, mode, count: items.length, items });
    }
    const outcome = await automationRegistry.run(sweep, { trigger: 'agent' });
    if (!outcome.ok) {
      audit('agent_api_automation_sweep', { ...agentActor(req), ok: false, sweep, mode, reason: outcome.busy ? 'busy' : (outcome.reason || 'unavailable') });
      return res.status(409).json({ error: outcome.busy ? `${sweep} is already running` : (outcome.reason || 'Sweep is unavailable') });
    }
    const result = outcome.result || {};
    const count = result.searched ?? result.acted ?? result.alerted ?? 0;
    audit('agent_api_automation_sweep', { ...agentActor(req), ok: true, sweep, mode, actions: count });
    return res.json({ ok: true, sweep, mode, actions: count });
  }));

  // Retry a failed Seerr request: re-runs the same direct-add repair the escalation sweep
  // uses for lost hand-offs (addMediaToArr — bypasses Seerr, adds to the arr, starts a search).
  // Only requests currently in the `failed` state are eligible; anything else is 404.
  app.post('/api/v1/requests/:id/retry', auth, writeLimiter, guarded(async (req, res) => {
    if (!addMediaToArr) return res.status(503).json({ error: 'Request repair is unavailable' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Request id must be a positive integer' });
    }
    const raw = (await fetchSeerrRequests()).find(r => Number(r.id) === id);
    if (!raw || projectSeerrRequestStatus(raw) !== 'failed') {
      audit('agent_api_request_retry', { ...agentActor(req), ok: false, reason: 'not_failed', requestId: id });
      return res.status(404).json({ error: 'No failed request with that id' });
    }
    const media = raw.media || {};
    const mediaType = media.mediaType === 'tv' ? 'tv' : 'movie';
    const tmdbId = Number(media.tmdbId) || null;
    let tvdbId = Number(media.tvdbId) || null;
    if (mediaType === 'tv' && !tvdbId && tmdbId && fetchSeerrTvdbId) {
      tvdbId = await fetchSeerrTvdbId(tmdbId).catch(() => null);
    }
    if (mediaType === 'tv' && !tvdbId) {
      audit('agent_api_request_retry', { ...agentActor(req), ok: false, reason: 'no_tvdb_id', requestId: id });
      return res.status(409).json({ error: 'Could not resolve a TVDB id for this request — the TMDB↔TVDB mapping is broken' });
    }
    const added = await addMediaToArr({ mediaType, tmdbId, tvdbId, tagLabel: config.AVISTAZ_TAG });
    audit('agent_api_request_retry', { ...agentActor(req), ok: !!added.ok, requestId: id, title: added.title || null, arrId: added.arrId ?? null, reason: added.ok ? undefined : added.reason });
    if (!added.ok) return res.status(502).json({ error: `Repair failed: ${added.reason || 'unknown'}` });
    return res.json({ ok: true, requestId: id, title: added.title, arrId: added.arrId, already: !!added.already, detail: String(added.detail || '').slice(0, 500) });
  }));

  // Force a season search — mirrors the dashboard's "Search Now" button: same series
  // resolution (Sonarr id or unambiguous title), same missing-episode / fallback / cooldown
  // gates, and the same AvistaZ-tagged → direct grab vs Sonarr SeasonSearch route decision.
  app.post('/api/v1/search/season', auth, writeLimiter, guarded(async (req, res) => {
    const need = { listSonarrSeries, getSeriesEpisodes, triggerSeasonSearch };
    if (Object.values(need).some(fn => typeof fn !== 'function')) {
      return res.status(503).json({ error: 'Season search is unavailable' });
    }
    const seasonNumber = Number(req.body?.season);
    if (!Number.isInteger(seasonNumber) || seasonNumber < 0) {
      audit('agent_api_season_search', { ...agentActor(req), ok: false, reason: 'invalid_season' });
      return res.status(400).json({ error: 'season must be a non-negative integer' });
    }
    const seriesInput = String(req.body?.series || '').trim();
    if (!seriesInput) {
      audit('agent_api_season_search', { ...agentActor(req), ok: false, reason: 'missing_series' });
      return res.status(400).json({ error: 'series is required (Sonarr series id or title)' });
    }
    const all = await listSonarrSeries().catch(() => []);
    let series;
    if (/^\d+$/.test(seriesInput)) {
      series = all.find(s => Number(s.id) === Number(seriesInput)) || null;
    } else {
      const lower = seriesInput.toLowerCase();
      const matches = all.filter(s => String(s.title || '').toLowerCase().includes(lower));
      if (matches.length === 1) series = matches[0];
      else {
        audit('agent_api_season_search', { ...agentActor(req), ok: false, reason: matches.length ? 'ambiguous_series' : 'series_not_found', series: seriesInput.slice(0, 120) });
        return res.status(matches.length ? 409 : 404).json({
          error: matches.length ? `Multiple series match "${seriesInput.slice(0, 120)}" — use a Sonarr series id` : `No Sonarr series matches "${seriesInput.slice(0, 120)}"`,
        });
      }
    }
    if (!series) {
      audit('agent_api_season_search', { ...agentActor(req), ok: false, reason: 'series_not_found', series: seriesInput.slice(0, 120) });
      return res.status(404).json({ error: `Sonarr series ${seriesInput.slice(0, 120)} was not found` });
    }
    const episodes = await getSeriesEpisodes(series.id).catch(() => null);
    if (!episodes) {
      audit('agent_api_season_search', { ...agentActor(req), ok: false, reason: 'episodes_unreadable', seriesId: series.id });
      return res.status(502).json({ error: `Couldn't read episodes for ${series.title} from Sonarr` });
    }
    const missing = episodes.filter(ep => Number(ep.seasonNumber) === seasonNumber && ep.monitored && !ep.hasFile
      && Date.parse(ep.airDateUtc || ep.airDate || '') <= Date.now());
    if (!missing.length) {
      audit('agent_api_season_search', { ...agentActor(req), ok: false, reason: 'nothing_missing', seriesId: series.id, season: seasonNumber });
      return res.status(409).json({ error: `${series.title} S${pad(seasonNumber)} has no aired missing episodes — nothing to search for` });
    }
    const fallback = getSeasonEpisodeFallback(series.id, seasonNumber);
    if (fallback) {
      audit('agent_api_season_search', { ...agentActor(req), ok: false, reason: 'episode_fallback_active', seriesId: series.id, season: seasonNumber });
      return res.status(409).json({ error: `A bounded episode fallback already owns ${series.title} S${pad(seasonNumber)} (${fallback.state})` });
    }
    const force = req.body?.force === true;
    const { cooling, nextEligible } = force ? { cooling: false } : seasonSearchCooldown(getSeasonSearchTimes(series.id)[seasonNumber]);
    if (cooling) {
      audit('agent_api_season_search', { ...agentActor(req), ok: false, reason: 'cooldown', seriesId: series.id, season: seasonNumber });
      return res.status(409).json({ error: `Season search is cooling down until ${new Date(nextEligible).toISOString()}`, nextEligible, canOverride: true });
    }
    // Same route decision as the dashboard button and the /season Discord command:
    // AvistaZ-tagged + direct grab enabled goes through the seedbox, everything else
    // through Sonarr's own SeasonSearch.
    const tagSource = { url: config.SONARR_URL, key: config.SONARR_API_KEY, label: 'sonarr' };
    const tagId = getArrTagId ? await getArrTagId(tagSource, config.AVISTAZ_TAG).catch(() => null) : null;
    const tagged = tagId != null && (series.tags || []).includes(tagId);
    const directEnabled = tunable('SEASON_PACK_AVISTAZ_DIRECT') && grabConfigured && grabConfigured();
    // Use AnimeZ for anime series, AvistaZ for other tagged content
    const isAnime = String(series.seriesType || '').toLowerCase() === 'anime';
    const findIndexer = isAnime && findAnimezIndexer ? findAnimezIndexer : findAvistazIndexer;
    const indexer = tagged && directEnabled && findIndexer ? await findIndexer().catch(() => null) : null;
    if (tagged && directEnabled && !indexer) {
      audit('agent_api_season_search', { ...agentActor(req), ok: false, reason: 'indexer_missing', seriesId: series.id, season: seasonNumber });
      return res.status(409).json({ error: `${series.title} is tagged for AvistaZ, but the AvistaZ indexer could not be found in Prowlarr` });
    }
    if (tagged && directEnabled && indexer && runSeasonDirectGrab && grabDailyAllowance) {
      const allowance = grabDailyAllowance();
      const result = await runSeasonDirectGrab({ series, season: { season: seasonNumber, missing: missing.length }, indexer, allowance });
      clearSeasonAlertState(series.id, seasonNumber);
      recordSeasonSearch({ seriesId: series.id, seasonNumber, seriesTitle: series.title, missing: missing.length });
      audit('agent_api_season_search', { ...agentActor(req), ok: result.status !== 'error', seriesId: series.id, season: seasonNumber, title: series.title, route: 'avistaz', status: result.status, override: force });
      return res.json({ ok: result.status !== 'error', route: 'avistaz', seriesId: series.id, season: seasonNumber, status: result.status, detail: String(result.detail || result.error || '').slice(0, 500) });
    }
    const command = await triggerSeasonSearch(series.id, seasonNumber);
    clearSeasonAlertState(series.id, seasonNumber);
    const stallCount = recordSeasonSearch({ seriesId: series.id, seasonNumber, seriesTitle: series.title, missing: missing.length });
    monitorSeasonSearch({ seriesId: series.id, seriesTitle: series.title, seriesYear: series.year, seriesAliases: sonarrSeriesAliases(series), seasonNumber, missingAtSearch: missing.length, commandId: command?.id, searchedAt: Date.now(), stallCount });
    audit('agent_api_season_search', { ...agentActor(req), ok: true, seriesId: series.id, season: seasonNumber, title: series.title, route: 'sonarr', commandId: command?.id || null, override: force });
    return res.json({ ok: true, route: 'sonarr', seriesId: series.id, season: seasonNumber, commandId: command?.id || null, message: `Sonarr accepted the S${pad(seasonNumber)} season search for ${series.title}` });
  }));

  // Trigger an arr import scan of a staging folder — the same safety logic as the
  // /debrid and /rtorrent Discord `import` subcommands: path traversal guard, `.incoming`
  // guard, existence through the bot's path view, and a partial-match preview in Move mode
  // that refuses (409) instead of asking an interactive confirm button.
  app.post('/api/v1/import-scan', auth, writeLimiter, guarded(async (req, res) => {
    if (!summarizeManualImportPreview) return res.status(503).json({ error: 'Import scan is unavailable' });
    const target = String(req.body?.target || '').trim().toLowerCase();
    if (target !== 'sonarr' && target !== 'radarr' && target !== 'radarr-4k') {
      audit('agent_api_import_scan', { ...agentActor(req), ok: false, reason: 'invalid_target', target: target || null });
      return res.status(400).json({ error: 'target must be "sonarr", "radarr", or "radarr-4k"' });
    }
    const source = String(req.body?.source || 'premiumize').trim().toLowerCase();
    const pair = source === 'seedbox'
      ? { stagingPath: config.GRAB_STAGING_PATH, importPath: config.GRAB_IMPORT_PATH, label: 'seedbox staging' }
      : source === 'premiumize'
        ? { stagingPath: config.PREMIUMIZE_STAGING_PATH, importPath: config.PREMIUMIZE_IMPORT_PATH, label: 'Premiumize' }
        : null;
    if (!pair) {
      audit('agent_api_import_scan', { ...agentActor(req), ok: false, reason: 'invalid_source', source });
      return res.status(400).json({ error: 'source must be "premiumize" or "seedbox"' });
    }
    if (!pair.stagingPath || !pair.importPath) {
      audit('agent_api_import_scan', { ...agentActor(req), ok: false, reason: 'not_configured', target, source });
      return res.status(409).json({ error: `${pair.label} import isn't configured (needs both a staging and an import path)` });
    }
    const arr = target === 'sonarr'
      ? { url: config.SONARR_URL, key: config.SONARR_API_KEY, cmd: 'DownloadedEpisodesScan', label: 'Sonarr' }
      : target === 'radarr-4k'
        ? { url: config.RADARR_4K_URL, key: config.RADARR_4K_API_KEY, cmd: 'DownloadedMoviesScan', label: 'Radarr 4K' }
        : { url: config.RADARR_URL, key: config.RADARR_API_KEY, cmd: 'DownloadedMoviesScan', label: 'Radarr' };
    if (!arr.url) {
      audit('agent_api_import_scan', { ...agentActor(req), ok: false, reason: 'arr_not_configured', target });
      return res.status(409).json({ error: `${arr.label} isn't configured` });
    }
    const stripEdgeChars = (s, chars) => {
      let start = 0, end = s.length;
      while (start < end && chars.includes(s[start])) start++;
      while (end > start && chars.includes(s[end - 1])) end--;
      return s.slice(start, end);
    };
    let clean = stripEdgeChars(String(req.body?.folder || '').trim(), '"\'');
    clean = stripEdgeChars(clean, '/');
    if (clean && clean.split('/').some(p => !p || p === '.' || p === '..')) {
      audit('agent_api_import_scan', { ...agentActor(req), ok: false, reason: 'unsafe_path', target, source });
      return res.status(400).json({ error: 'Unsafe folder path' });
    }
    if (clean === '.incoming' || clean.startsWith('.incoming/')) {
      audit('agent_api_import_scan', { ...agentActor(req), ok: false, reason: 'incoming_folder', target, source });
      return res.status(400).json({ error: '`.incoming` holds in-flight copies — never import from there' });
    }
    const mode = req.body?.mode === 'copy' ? 'Copy' : 'Move';
    const localPath = clean ? path.join(pair.stagingPath, clean) : pair.stagingPath;
    if (!fs.existsSync(localPath)) {
      audit('agent_api_import_scan', { ...agentActor(req), ok: false, reason: 'folder_missing', target, source, folder: clean || null });
      return res.status(404).json({ error: `\`${clean || '(folder root)'}\` doesn't exist under \`${pair.stagingPath}\`` });
    }
    if (!clean) {
      const incoming = path.join(pair.stagingPath, '.incoming');
      const busy = fs.existsSync(incoming) && fs.readdirSync(incoming).length > 0;
      if (busy) {
        audit('agent_api_import_scan', { ...agentActor(req), ok: false, reason: 'incoming_busy', target, source });
        return res.status(409).json({ error: 'A transfer is mid-copy (`.incoming` isn\'t empty) — scan a specific folder, or wait for the transfers to finish' });
      }
    }
    const fullImportPath = clean ? `${pair.importPath}/${clean}` : pair.importPath;
    // Move mode deletes/relocates the source once the arr considers the download handled —
    // including files that never matched. The Discord flow asks an interactive confirm here;
    // the API has no buttons, so a partial match refuses instead of risking data loss.
    // P1 fix: require a valid, nonempty preview for Move. A failed/empty preview must
    // refuse, not fall through to Move (previously a timeout/error would proceed).
    if (mode === 'Move') {
      const preview = await httpClient.get(`${arr.url}/api/v3/manualimport`, {
        params: { folder: fullImportPath, filterExistingFiles: false },
        headers: { 'X-Api-Key': arr.key },
        timeout: 120000,
      }).then(r => summarizeManualImportPreview(r.data || [], target)).catch(() => null);
      if (!preview || preview.totalFiles === 0) {
        audit('agent_api_import_scan', { ...agentActor(req), ok: false, reason: 'preview_unavailable', target, source, folder: clean || null });
        return res.status(409).json({
          error: 'Refusing Move import: the safety preview is unavailable (timeout, error, or empty). Use mode "copy", or try again once the arr responds.',
        });
      }
      if (preview.unmatchedFiles > 0) {
        audit('agent_api_import_scan', { ...agentActor(req), ok: false, reason: 'partial_match', target, source, folder: clean || null, matched: preview.matchedFiles, total: preview.totalFiles });
        return res.status(409).json({
          error: `Refusing Move import: ${preview.unmatchedFiles} of ${preview.totalFiles} file(s) won't import and would be swept away with the folder. Use mode "copy", or fix the mismatch first.`,
          matchedFiles: preview.matchedFiles,
          unmatchedFiles: preview.unmatchedFiles,
          totalFiles: preview.totalFiles,
        });
      }
    }
    const res2 = await httpClient.post(`${arr.url}/api/v3/command`,
      { name: arr.cmd, path: fullImportPath, importMode: mode },
      { headers: { 'X-Api-Key': arr.key }, timeout: 15000 });
    audit('agent_api_import_scan', { ...agentActor(req), ok: true, target, source, path: fullImportPath, mode, commandId: res2.data?.id ?? null });
    return res.json({ ok: true, target, source, path: fullImportPath, mode, commandId: res2.data?.id ?? null, message: `${arr.label} is scanning \`${fullImportPath}\` (import mode: ${mode})` });
  }));

  // Seedbox sync: rclone copy a folder from the seedbox (GRAB_RCLONE_REMOTE) to the
  // local staging path (GRAB_STAGING_PATH). This is the "merge" step for torrents that
  // completed in rTorrent on the seedbox — e.g. Bleach Season 2-5. After the sync,
  // call /api/v1/import-scan with source=seedbox to have Sonarr/Radarr import it.
  // The copy is resumable (rclone skips already-transferred files), so re-running after
  // a failure is safe.
  // NOTE: This endpoint bypasses the `guarded` wrapper (which returns a generic 502)
  // so that handler crashes return the actual error message for debugging.
  app.post('/api/v1/seedbox/sync', auth, writeLimiter, async (req, res) => {
    try {
    const remote = (config.GRAB_RCLONE_REMOTE || '').replace(/\/$/, '');
    const stagingPath = (config.GRAB_STAGING_PATH || '').replace(/\/$/, '');
    if (!remote || !stagingPath) {
      audit('agent_api_seedbox_sync', { ...agentActor(req), ok: false, reason: 'not_configured' });
      return res.status(409).json({ error: 'Seedbox sync is not configured (needs GRAB_RCLONE_REMOTE and GRAB_STAGING_PATH)' });
    }
    // Validate folder name (same rules as import-scan: no traversal, no .incoming)
    const stripEdgeChars = (s, chars) => {
      let start = 0, end = s.length;
      while (start < end && chars.includes(s[start])) start++;
      while (end > start && chars.includes(s[end - 1])) end--;
      return s.slice(start, end);
    };
    let clean = stripEdgeChars(String(req.body?.folder || '').trim(), '"\'');
    clean = stripEdgeChars(clean, '/');
    if (!clean) {
      audit('agent_api_seedbox_sync', { ...agentActor(req), ok: false, reason: 'missing_folder' });
      return res.status(400).json({ error: 'folder is required' });
    }
    if (clean.split('/').some(p => !p || p === '.' || p === '..')) {
      audit('agent_api_seedbox_sync', { ...agentActor(req), ok: false, reason: 'unsafe_path', folder: clean });
      return res.status(400).json({ error: 'Unsafe folder path' });
    }
    if (clean === '.incoming' || clean.startsWith('.incoming/')) {
      audit('agent_api_seedbox_sync', { ...agentActor(req), ok: false, reason: 'incoming_folder', folder: clean });
      return res.status(400).json({ error: '`.incoming` holds in-flight copies — never sync from there' });
    }

    const srcPath = `${remote}/${clean}`;
    const destPath = path.join(stagingPath, clean);
    // GRAB_RCLONE_FLAGS may be a string (space-separated) or an array (if config parses it)
    const flagsRaw = config.GRAB_RCLONE_FLAGS;
    const flags = Array.isArray(flagsRaw) ? flagsRaw.filter(Boolean) : String(flagsRaw || '').split(/\s+/).filter(Boolean);
    const rcloneBinary = config.STAGE_RCLONE_BINARY || 'rclone';

    // Disk space check: ensure at least 5 GB free on the staging filesystem before
    // starting. The copy will fail anyway if space runs out, but failing fast with a
    // clear message is kinder than a mid-transfer rclone error.
    try {
      const stats = fs.statfsSync(stagingPath);
      const freeBytes = Number(stats.bfree) * Number(stats.bsize);
      const freeGB = freeBytes / 1e9;
      if (freeGB < 5) {
        audit('agent_api_seedbox_sync', { ...agentActor(req), ok: false, reason: 'low_disk', folder: clean, freeGB: Math.round(freeGB * 10) / 10 });
        return res.status(409).json({
          error: `Refusing seedbox sync: only ${freeGB.toFixed(1)} GB free on staging (need at least 5 GB). Free up space first.`,
          freeGB: Math.round(freeGB * 10) / 10,
        });
      }
    } catch (err) {
      // If we can't check disk space, proceed anyway — rclone will fail with a clear
      // error if space runs out. Don't block the sync on a stat failure.
    }

    audit('agent_api_seedbox_sync', { ...agentActor(req), ok: true, reason: 'started', folder: clean, src: srcPath, dest: destPath });

    // Run rclone in the background. The HTTP request returns immediately (202);
    // the client polls /api/v1/seedbox/sync-status for completion.
    // We use a marker file to track status: .sync-in-progress means running,
    // .sync-failed means rclone errored (contains stderr).
    const markerInProgress = `${destPath}.sync-in-progress`;
    const markerFailed = `${destPath}.sync-failed`;
    try {
      fs.writeFileSync(markerInProgress, JSON.stringify({ started: new Date().toISOString(), src: srcPath }));
      if (fs.existsSync(markerFailed)) fs.unlinkSync(markerFailed);
    } catch (err) {
      // Non-fatal
    }

    // Spawn rclone. We don't wait for it — unref() lets the response return.
    // If rclone isn't installed or fails to start, the error is captured async
    // and written to the .sync-failed marker.
    let spawnError = null;
    try {
      const child = spawn(rcloneBinary, ['copy', srcPath, destPath, ...flags], {
        stdio: 'ignore',
      });
      child.on('error', (err) => {
        spawnError = err.message;
        try {
          fs.writeFileSync(markerFailed, `rclone failed to start: ${err.message}`);
          if (fs.existsSync(markerInProgress)) fs.unlinkSync(markerInProgress);
        } catch {}
        audit('agent_api_seedbox_sync', { ...agentActor(req), ok: false, reason: 'rclone_start_failed', folder: clean });
      });
      child.on('close', (code) => {
        try {
          if (fs.existsSync(markerInProgress)) fs.unlinkSync(markerInProgress);
          if (code !== 0) {
            fs.writeFileSync(markerFailed, `rclone exited ${code}`);
          }
          audit('agent_api_seedbox_sync', { ...agentActor(req), ok: code === 0, reason: code === 0 ? 'completed' : 'rclone_failed', folder: clean });
        } catch {}
      });
      child.unref();
    } catch (err) {
      // Synchronous spawn failure (e.g. invalid args) — return 502 with the error
      // instead of crashing the handler.
      try { if (fs.existsSync(markerInProgress)) fs.unlinkSync(markerInProgress); } catch {}
      audit('agent_api_seedbox_sync', { ...agentActor(req), ok: false, reason: 'spawn_threw', folder: clean, error: err.message?.slice(0, 200) });
      return res.status(502).json({ error: `Failed to start rclone: ${err.message}`, folder: clean });
    }

    return res.status(202).json({
      ok: true,
      folder: clean,
      dest: destPath,
      status: 'started',
      message: `Sync of \`${clean}\` started in background. Poll /api/v1/seedbox/sync-status?folder=${encodeURIComponent(clean)} for completion.`,
    });
    } catch (err) {
      // Defensive: return the actual error instead of crashing to a generic 502.
      // This helps diagnose why the sync endpoint fails.
      try {
        audit('agent_api_seedbox_sync', { ...agentActor(req), ok: false, reason: 'handler_crashed', error: String(err.message || err).slice(0, 500) });
      } catch {}
      return res.status(500).json({
        error: `Sync handler failed: ${err.message || String(err)}`,
        stack: String(err.stack || '').split('\n').slice(0, 5).join('\n'),
      });
    }
  });

  // Seedbox sync status: check if a folder is currently syncing, failed, or done.
  // Returns: { status: 'in-progress'|'failed'|'done'|'not-started', ... }
  app.get('/api/v1/seedbox/sync-status', auth, readLimiter, guarded(async (req, res) => {
    const stagingPath = (config.GRAB_STAGING_PATH || '').replace(/\/$/, '');
    if (!stagingPath) {
      return res.status(409).json({ error: 'Seedbox sync is not configured' });
    }
    const folder = String(req.query.folder || '').trim().replace(/^["']|["']$/g, '').replace(/^\/+|\/+$/g, '');
    if (!folder || folder.split('/').some(p => !p || p === '.' || p === '..')) {
      return res.status(400).json({ error: 'Valid folder query param is required' });
    }
    const destPath = path.join(stagingPath, folder);
    const markerInProgress = `${destPath}.sync-in-progress`;
    const markerFailed = `${destPath}.sync-failed`;

    // Helper: count files and total size in a directory (recursive)
    const getDirStats = (dirPath) => {
      let fileCount = 0;
      let totalBytes = 0;
      try {
        const walk = (current) => {
          const entries = fs.readdirSync(current, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
              walk(fullPath);
            } else if (entry.isFile()) {
              fileCount++;
              try {
                totalBytes += fs.statSync(fullPath).size;
              } catch {}
            }
          }
        };
        walk(dirPath);
      } catch {}
      return { fileCount, totalBytes };
    };

    if (fs.existsSync(markerFailed)) {
      const error = fs.readFileSync(markerFailed, 'utf8').slice(0, 500);
      const stats = fs.existsSync(destPath) ? getDirStats(destPath) : { fileCount: 0, totalBytes: 0 };
      return res.json({ ok: true, folder, status: 'failed', error, ...stats });
    }
    if (fs.existsSync(markerInProgress)) {
      const stats = fs.existsSync(destPath) ? getDirStats(destPath) : { fileCount: 0, totalBytes: 0 };
      return res.json({ ok: true, folder, status: 'in-progress', ...stats });
    }
    if (fs.existsSync(destPath)) {
      const stats = getDirStats(destPath);
      return res.json({ ok: true, folder, status: 'done', dest: destPath, ...stats });
    }
    return res.json({ ok: true, folder, status: 'not-started' });
  }));

  // Force import: copy files from seedbox staging to a destination path, then trigger Sonarr rescan.
  // Unlike import-scan (which relies on Sonarr's DownloadedEpisodesScan), this actually copies the files.
  // Body: { folder: "Season 4", destination: "/share/media/Tv Shows/Bleach/Season 4", target: "sonarr" }
  // The destination must be an absolute path accessible from the bot container.
  app.post('/api/v1/seedbox/import-force', auth, writeLimiter, guarded(async (req, res) => {
    const stagingPath = (config.GRAB_STAGING_PATH || '').replace(/\/$/, '');
    if (!stagingPath) {
      return res.status(409).json({ error: 'Seedbox sync is not configured (needs GRAB_STAGING_PATH)' });
    }
    const folder = String(req.body?.folder || '').trim().replace(/^["']|["']$/g, '').replace(/^\/+|\/+$/g, '');
    const requestedDestination = String(req.body?.destination || '').trim();
    const target = String(req.body?.target || 'sonarr').trim().toLowerCase();
    if (!folder || folder.split('/').some(p => !p || p === '.' || p === '..')) {
      return res.status(400).json({ error: 'Valid folder is required' });
    }
    // The destination is contained before anything is created or overwritten: this handler
    // mkdir -p's it and copyFile()s over whatever is already there, so an unchecked absolute
    // path is an arbitrary write for anyone holding an agent token. Everything below uses the
    // returned real path, never the raw request value.
    const destRoots = importDestinationRoots(config);
    const safeDestination = resolveSafeImportDestination(requestedDestination, destRoots);
    if (!safeDestination.ok) {
      audit('agent_api_seedbox_import_force', { ...agentActor(req), ok: false, reason: `destination_${safeDestination.reason}`, folder, destination: requestedDestination.slice(0, 200) });
      if (safeDestination.reason === 'no_roots') {
        return res.status(409).json({ error: 'Force import is not configured: no destination root is set (RAID_PATH, the *arr import paths, or IMPORT_FORCE_DEST_ROOTS).' });
      }
      if (safeDestination.reason === 'not_absolute') {
        return res.status(400).json({ error: 'Valid absolute destination path is required' });
      }
      return res.status(400).json({
        error: `Destination is outside every allowed media root. Allowed roots: ${destRoots.join(', ')}. Set IMPORT_FORCE_DEST_ROOTS if this layout needs another one.`,
      });
    }
    const destination = safeDestination.path;
    if (target !== 'sonarr' && target !== 'radarr' && target !== 'radarr-4k') {
      return res.status(400).json({ error: 'target must be "sonarr", "radarr", or "radarr-4k"' });
    }
    const srcPath = path.join(stagingPath, folder);
    if (!fs.existsSync(srcPath)) {
      return res.status(404).json({ error: `Staging folder not found: ${srcPath}` });
    }
    // Copy files (not directories) from staging to destination
    try {
      fs.mkdirSync(destination, { recursive: true });
      const files = fs.readdirSync(srcPath);
      // Optional ownership fix: if MEDIA_UID/MEDIA_GID are set, chown copied files
      // so the arr containers (e.g. Sonarr running as abc:users) can manage them.
      // Best-effort: if chown fails (no permission), log and continue — the files
      // are still world-readable (644) so the arr can import them.
      const mediaUid = config.MEDIA_UID ? parseInt(config.MEDIA_UID, 10) : null;
      const mediaGid = config.MEDIA_GID ? parseInt(config.MEDIA_GID, 10) : null;
      const wantChown = Number.isInteger(mediaUid) && Number.isInteger(mediaGid);
      let chowned = 0;
      let chownFailed = false;
      let copied = 0;
      for (const file of files) {
        const srcFile = path.join(srcPath, file);
        const destFile = path.join(destination, file);
        if (fs.statSync(srcFile).isFile()) {
          fs.copyFileSync(srcFile, destFile);
          // Ensure world-readable so the arr can import regardless of ownership
          try { fs.chmodSync(destFile, 0o644); } catch {}
          if (wantChown) {
            try {
              fs.chownSync(destFile, mediaUid, mediaGid);
              chowned++;
            } catch {
              chownFailed = true;
            }
          }
          copied++;
        }
      }
      // Also chown the destination directory itself so the arr can write into it
      if (wantChown) {
        try {
          fs.chownSync(destination, mediaUid, mediaGid);
          try { fs.chmodSync(destination, 0o755); } catch {}
        } catch {
          chownFailed = true;
        }
      }
      audit('agent_api_seedbox_import_force', { ...agentActor(req), ok: true, folder, destination, copied, target, chowned, chownFailed });
      // Trigger Sonarr rescan if target is sonarr
      let scanResult = null;
      if (target === 'sonarr' && config.SONARR_URL && config.SONARR_API_KEY) {
        try {
          const sonarrBase = config.SONARR_URL.replace(/\/$/, '');
          const headers = { 'X-Api-Key': config.SONARR_API_KEY };
          // Match the series by path only: the destination has to sit inside the series folder.
          // There is deliberately no title fallback — the previous `=== 'bleach'` one meant any
          // unmatched destination rescanned that one series.
          const seriesRes = await httpClient.get(`${sonarrBase}/api/v3/series`, { headers, timeout: 15000 });
          const allSeries = seriesRes.data || [];
          // Path containment, not a bare string prefix: a series at /media/Show must not claim a
          // destination under /media/ShowOther.
          const series = allSeries.find(s => s.path
            && (destination === s.path || destination.startsWith(String(s.path).replace(/\/$/, '') + path.sep)));
          if (series) {
            // Trigger RescanSeries to pick up the new files from disk
            await httpClient.post(`${sonarrBase}/api/v3/command`, {
              name: 'RescanSeries',
              seriesId: series.id,
            }, { headers, timeout: 15000 });
            scanResult = `Triggered Sonarr rescan for "${series.title}" (ID ${series.id}).`;
          } else {
            scanResult = 'Files copied. Could not find matching series in Sonarr; trigger Refresh & Scan manually.';
          }
        } catch (err) {
          scanResult = `Files copied. Sonarr rescan failed: ${err.message?.slice(0, 100)}; trigger manually.`;
        }
      }
      let message = `Copied ${copied} files to ${destination}.`;
      if (wantChown) {
        message += chownFailed
          ? ` Ownership fix partially failed (bot lacks chown permission); files are world-readable.`
          : ` Ownership set to ${mediaUid}:${mediaGid} (${chowned} files).`;
      }
      if (scanResult) message += ` ${scanResult}`;
      return res.json({
        ok: true,
        folder,
        destination,
        copied,
        chowned,
        chownFailed,
        message: message.trim(),
      });
    } catch (err) {
      audit('agent_api_seedbox_import_force', { ...agentActor(req), ok: false, folder, destination, error: err.message?.slice(0, 200) });
      return res.status(500).json({ error: `Force import failed: ${err.message}` });
    }
  }));

  // v1.2 Discord command bridge: invoke a slash command headlessly through the same
  // handleSlashCommand dispatch the Discord interactionCreate handler uses. The request
  // names the command the way Discord does; options are validated against the live
  // SlashCommandBuilder definitions (unknown command/subcommand/option, wrong type, or
  // missing required option -> 400). The handler's replies (content/embeds) are captured
  // and returned — interactive follow-ups (buttons, selects, modals) and DMs are not
  // supported headless; see docs/agent-api.md. Every invocation is audited inside the
  // executor as agent:<token-label> with the command + args.
  app.post('/api/v1/discord/exec', auth, writeLimiter, guarded(async (req, res) => {
    if (!discordExec) return res.status(503).json({ error: 'Discord command bridge is unavailable' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const command = String(body.command || '').trim();
    const subcommand = body.subcommand == null ? null : String(body.subcommand).trim();
    const options = body.options == null ? {} : body.options;
    if (!command) {
      audit('agent_api_discord_exec', { ...agentActor(req), ok: false, reason: 'missing_command' });
      return res.status(400).json({ error: 'command is required' });
    }
    if (typeof options !== 'object' || Array.isArray(options)) {
      audit('agent_api_discord_exec', { ...agentActor(req), ok: false, reason: 'invalid_options' });
      return res.status(400).json({ error: 'options must be an object of option-name -> value' });
    }
    try {
      const result = await discordExec({
        command,
        subcommand,
        options,
        actorLabel: req.agentTokenLabel || 'unknown',
      });
      return res.json({ ok: result.ok, command: command.toLowerCase(), subcommand: subcommand ? subcommand.toLowerCase() : null, replies: result.replies });
    } catch (err) {
      if (err && typeof err.status === 'number') {
        return res.status(err.status).json({ error: String(err.message).slice(0, 500) });
      }
      throw err;
    }
  }));

  // v1.2 Discord button bridge: press a button headlessly through the same handleButton
  // dispatch the Discord interactionCreate handler uses. custom_id is whatever the
  // button carried — /discord/exec replies now list their buttons as
  // `buttons: [{ custom_id, label, style }]` for discovery. The admin gate inside
  // handleButton still runs (the synthetic actor is admin-privileged, same as the exec
  // bridge), and every press is audited as agent:<token-label>, including failures.
  app.post('/api/v1/discord/interact', auth, writeLimiter, guarded(async (req, res) => {
    if (!discordInteract) return res.status(503).json({ error: 'Discord interaction bridge is unavailable' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const customId = typeof body.custom_id === 'string' ? body.custom_id.trim() : '';
    if (!customId) {
      audit('agent_api_discord_interact', { ...agentActor(req), custom_id: '', ok: false, reason: 'missing_custom_id' });
      return res.status(400).json({ error: 'custom_id is required' });
    }
    try {
      const result = await discordInteract({
        customId,
        actorLabel: req.agentTokenLabel || 'unknown',
      });
      return res.json({ ok: result.ok, custom_id: customId.slice(0, 100), replies: result.replies });
    } catch (err) {
      if (err && typeof err.status === 'number') {
        return res.status(err.status).json({ error: String(err.message).slice(0, 500) });
      }
      throw err;
    }
  }));
}

module.exports = { registerAgentApiRoutes, createAgentApiAuth, createAgentApiReadLimiter, createAgentApiWriteLimiter, importDestinationRoots, resolveSafeImportDestination };
