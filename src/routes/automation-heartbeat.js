'use strict';

const { rateLimit } = require('express-rate-limit');
const fleetHost = require('../fleet-host');

// POST /api/automation/heartbeat — host crons, Edith watches and fleet scripts report a run here
// (Automation → Fleet and host). Same shape as /api/uptime/ingest:
//   - Bearer AUTOMATION_HEARTBEAT_TOKEN (only its sha256 is kept on CONFIG). Unset → 503: the
//     endpoint accepts nothing until a token is configured. Its own token, never the uptime one,
//     and never a dashboard session: no cookie is read here.
//   - Missing or wrong token → 401 with one message either way, nothing stored.
//   - A name not on the allowlist (src/fleet-host-inventory.js) → 404, nothing stored.
//   - Missing or invalid fields, or text that looks like a credential → 400, nothing stored.
//   - Only name, status, at, source, summary and counts are read; any other field is dropped.
// The rate limit runs before the token check so a guesser gets nowhere fast.
function registerAutomationHeartbeatRoutes(app, { config, db, httpRateLimitKey, sha256, safeEqual, audit, now = () => Date.now() }) {
  const limiter = rateLimit({
    windowMs: 5 * 60000,
    limit: 30,
    keyGenerator: httpRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many heartbeats. Each sender posts once per run.' }),
  });
  app.post('/api/automation/heartbeat', limiter, (req, res) => {
    const expected = config.AUTOMATION_HEARTBEAT_TOKEN_HASH;
    if (!expected) return res.status(503).json({ ok: false, error: 'Automation heartbeats are not configured.' });
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
    if (!m || !safeEqual(sha256(m[1]), expected)) {
      audit('automation_heartbeat_auth_failed', { ip: req.ip || req.socket?.remoteAddress || 'unknown' });
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const t = now();
    let row;
    try {
      row = fleetHost.parseHeartbeat(req.body, t);
    } catch (err) {
      if (err instanceof fleetHost.HeartbeatError) return res.status(err.status).json({ ok: false, error: err.message });
      throw err;
    }
    try {
      const stored = fleetHost.recordHeartbeat(db, row, t);
      fleetHost.pruneHeartbeats(db, t);
      return res.json({ ok: true, stored, duplicate: stored === 0 });
    } catch (_err) {
      return res.status(500).json({ ok: false, error: 'Could not store the heartbeat.' });
    }
  });
}

module.exports = { registerAutomationHeartbeatRoutes };
