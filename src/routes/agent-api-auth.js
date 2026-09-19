'use strict';

// Machine counterpart to the dashboard's human login and the tier agent's per-node tokens: Bearer
// auth for the agent API. Only sha256 hashes are ever stored — dashboard-minted tokens live in the
// agent_api_tokens table (created/revoked from /admin), and the original single AGENT_API_TOKEN
// env var remains as a legacy fallback so existing deployments keep working. The presented token
// is hashed and compared in constant time against every live hash, and failures are audited. This
// is a cheap header check, so it belongs ahead of any downstream work: an unauthenticated caller
// shouldn't be able to spend Plex/*arr/Seerr API calls.
function createAgentApiAuth({ getAgentApiTokenHashes, getAgentApiTokenLabel = () => null, legacyTokenHash = '', sha256, safeEqual, audit, touchAgentApiTokenUse = () => {} }) {
  return (req, res, next) => {
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
    const presentedHash = m ? sha256(m[1]) : '';
    const candidates = [...(getAgentApiTokenHashes() || [])];
    if (legacyTokenHash) candidates.push(legacyTokenHash);
    let matched = '';
    for (const candidate of candidates) {
      if (presentedHash && candidate && safeEqual(presentedHash, candidate)) { matched = candidate; break; }
    }
    if (!matched) {
      audit('agent_api_auth_failed', { ip: req.ip || req.socket?.remoteAddress || 'unknown', path: req.path });
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // Attach the token's label so audited mutations can say which client acted. The legacy env
    // token has no row; label it as legacy.
    req.agentTokenLabel = matched === legacyTokenHash
      ? 'legacy-env-token'
      : (getAgentApiTokenLabel(matched) || 'unknown');
    // The legacy env token has no row to track; dashboard tokens record throttled last-use so an
    // operator can see which client is actually calling.
    if (matched !== legacyTokenHash) touchAgentApiTokenUse(matched);
    next();
  };
}

module.exports = { createAgentApiAuth };
