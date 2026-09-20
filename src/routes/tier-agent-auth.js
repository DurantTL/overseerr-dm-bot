// Same auth style as download links: only a hash of each node's bearer token is stored; compare
// in constant time. A node's token only unlocks that node's manifest/report. This check is a
// cheap header comparison, so it belongs ahead of any request body parsing: an unauthenticated
// caller shouldn't be able to spend parser/memory work on a large agent report body.
function createTierAgentAuth({ getTierAgentTokenHash, sha256, safeEqual, audit }) {
  return (req, res, next) => {
    const node = String(req.params.node || '').toLowerCase();
    // L4: validate the node name at the auth boundary — it is interpolated into install.sh.tmpl
    // which operators pipe to sh as root. Names are validated at creation too, but the route
    // must not trust that a future token-issuance path keeps the invariant.
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(node)) {
      audit('tier_agent_auth_failed', { node: '(invalid)', ip: req.ip || req.socket?.remoteAddress || 'unknown' });
      return res.status(400).json({ error: 'Invalid node name' });
    }
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
    const storedHash = getTierAgentTokenHash(node);
    if (!m || !storedHash || !safeEqual(sha256(m[1]), storedHash)) {
      audit('tier_agent_auth_failed', { node, ip: req.ip || req.socket?.remoteAddress || 'unknown' });
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

module.exports = { createTierAgentAuth };
