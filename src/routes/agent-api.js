'use strict';

const axios = require('axios');
const { rateLimit } = require('express-rate-limit');
const { createAgentApiAuth } = require('./agent-api-auth');

// Read-only machine API for the Plex Director agent (v1).
// Auth: `Authorization: Bearer <AGENT_API_TOKEN>`, hash-compared like the tier-agent tokens.
// Every route is GET-only and rate-limited; mutations are deliberately absent and arrive later
// behind explicit approval. Responses are small, typed projections — never raw upstream payloads,
// so tokens, API keys, and full config can never leak through this surface.

// Seerr's MediaRequestStatus enum for /api/v1/request.
const SEERR_REQUEST_STATUS = { 1: 'pending', 2: 'approved', 3: 'available' };
const MAX_RESULTS = 25;
const MAX_REQUESTS = 200;
const HEALTH_CACHE_MS = 30000;

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

function projectSeerrRequest(r) {
  const media = r.media || {};
  return {
    id: r.id,
    status: SEERR_REQUEST_STATUS[r.status] || `unknown(${r.status})`,
    mediaType: media.mediaType === 'tv' ? 'tv' : 'movie',
    title: String(media.title || media.name || 'Unknown').slice(0, 200),
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
    getAgentApiTokenHash,
    sha256,
    safeEqual,
    audit,
    gatherHealth,
    fetchArrQueues,
    fetchSeerrRequests,
    getPlexToken,
    getPlexServers,
    httpRateLimitKey,
    httpClient = axios,
    auth = createAgentApiAuth({ getAgentApiTokenHash, sha256, safeEqual, audit }),
    readLimiter = createAgentApiReadLimiter({ limit: config.AGENT_API_READ_MAX_PER_MINUTE, keyGenerator: httpRateLimitKey }),
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
    res.json({
      ok: true,
      timestamp: h.timestamp || new Date().toISOString(),
      overall: h.overall || 'unknown',
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
    if (statusFilter && !['pending', 'approved', 'available'].includes(statusFilter)) {
      return res.status(400).json({ error: "status must be 'pending', 'approved', or 'available'" });
    }
    const all = (await fetchSeerrRequests()).map(projectSeerrRequest);
    const filtered = statusFilter ? all.filter(r => r.status === statusFilter) : all;
    const capped = filtered.slice(0, MAX_REQUESTS);
    res.json({ ok: true, count: capped.length, total: filtered.length, requests: capped });
  }));
}

module.exports = { registerAgentApiRoutes, createAgentApiAuth, createAgentApiReadLimiter };
