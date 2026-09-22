'use strict';

// Machine counterpart to the dashboard's human login and the tier agent's per-node tokens: Bearer
// auth for the agent API. Only sha256 hashes are ever stored — dashboard-minted tokens live in the
// agent_api_tokens table (created/revoked from /admin), and the original single AGENT_API_TOKEN
// env var remains as a legacy fallback so existing deployments keep working. The presented token
// is hashed and compared in constant time against every live hash, and failures are audited. This
// is a cheap header check, so it belongs ahead of any downstream work: an unauthenticated caller
// shouldn't be able to spend Plex/*arr/Seerr API calls.
function createAgentApiAuth({ getAgentApiTokenHashes, getAgentApiTokenLabel = () => null, getAgentApiTokenGrants = () => null, legacyTokenHash = '', sha256, safeEqual, audit, touchAgentApiTokenUse = () => {} }) {
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
    // A stable per-token identity for the rate limiters, which run after this middleware. The
    // stored hash is already a one-way digest of the token and never leaves the process, and
    // unlike the label it is unique — two tokens may carry the same label, and sharing a budget
    // between them would be a surprise an operator never asked for.
    req.agentTokenId = matched;
    // What this token may reach. The legacy env token has no row to carry grants, and it
    // predates scopes entirely, so it is grandfathered at full access exactly like the tokens
    // migration 5 backfilled — clearing AGENT_API_TOKEN stays the way to retire it. A dashboard
    // token whose row has somehow lost its grants reads as full access too (see readGrants):
    // narrowing a live token silently is a worse failure than leaving it as its operator left it.
    const grants = matched === legacyTokenHash ? null : getAgentApiTokenGrants(matched);
    req.agentScopes = grants ? grants.scopes : ['read', 'write', 'discord'];
    req.agentDiscordActions = grants ? grants.discordActions : ['*'];
    // The legacy env token has no row to track; dashboard tokens record throttled last-use so an
    // operator can see which client is actually calling.
    if (matched !== legacyTokenHash) touchAgentApiTokenUse(matched);
    next();
  };
}

module.exports = { createAgentApiAuth };
