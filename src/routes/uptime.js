'use strict';

const { rateLimit } = require('express-rate-limit');
const uptime = require('../uptime-monitor');

// Uptime history routes (src/uptime-monitor.js).
//
// POST /api/uptime/ingest — the RackNerd reachability checker posts each run's results here.
//   Bearer UPTIME_INGEST_TOKEN (only its sha256 is kept on CONFIG). Unset → 503: the endpoint
//   never accepts anything until a token is configured. The rate limit runs before the token
//   check so a guesser gets nowhere fast; the checker posts about once every 5 minutes.
// GET /admin/api/uptime — the dashboard's Uptime section, behind the dashboard's own auth.
function registerUptimeRoutes(app, { config, db, dashboardAuth, httpRateLimitKey, sha256, safeEqual, audit, now = () => Date.now() }) {
  const ingestLimiter = rateLimit({
    windowMs: 5 * 60000,
    limit: 10,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many uptime posts. The checker posts once per run.' }),
  });
  app.post('/api/uptime/ingest', ingestLimiter, (req, res) => {
    const expected = config.UPTIME_INGEST_TOKEN_HASH;
    if (!expected) return res.status(503).json({ ok: false, error: 'Uptime ingest is not configured.' });
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
    if (!m || !safeEqual(sha256(m[1]), expected)) {
      audit('uptime_ingest_auth_failed', { ip: req.ip || req.socket?.remoteAddress || 'unknown' });
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    let rows;
    try {
      rows = uptime.parseIngest(req.body, now());
    } catch (err) {
      if (err instanceof uptime.IngestError) return res.status(400).json({ ok: false, error: err.message });
      throw err;
    }
    try {
      const added = uptime.recordSamples(db, rows);
      uptime.pruneSamples(db, now());
      return res.json({ ok: true, stored: added, duplicates: rows.length - added });
    } catch (_err) {
      return res.status(500).json({ ok: false, error: 'Could not store the results.' });
    }
  });

  app.get('/admin/api/uptime', rateLimit({
    windowMs: 15 * 60000,
    limit: 300,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many dashboard requests. Wait a moment and try again.' }),
  }), dashboardAuth, (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, now: now(), endpoints: uptime.uptimeReport(db, now()) });
    } catch (_err) {
      return res.status(500).json({ ok: false, error: 'Uptime history unavailable.' });
    }
  });
}

module.exports = { registerUptimeRoutes };
