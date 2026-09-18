'use strict';

// Machine counterpart to the dashboard's human login and the tier agent's per-node tokens: a
// single shared Bearer <redacted> for the agent API. Only the sha256 hash is ever stored
// (CONFIG.AGENT_API_TOKEN_HASH); the presented token is hashed and compared in constant time,
// and failures are audited. This is a cheap header check, so it belongs ahead of any downstream
// work: an unauthenticated caller shouldn't be able to spend Plex/*arr/Seerr API calls.
function createAgentApiAuth({ getAgentApiTokenHash, sha256, safeEqual, audit }) {
  return (req, res, next) => {
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
    const storedHash = getAgentApiTokenHash();
    if (!m || !storedHash || !safeEqual(sha256(m[1]), storedHash)) {
      audit('agent_api_auth_failed', { ip: req.ip || req.socket?.remoteAddress || 'unknown', path: req.path });
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

module.exports = { createAgentApiAuth };
