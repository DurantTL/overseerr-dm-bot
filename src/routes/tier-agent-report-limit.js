// Bounds POST /agent/report/:node so a malfunctioning or compromised node token can't force
// repeated 25 MB JSON parses. Runs after tierAgentAuth (so an invalid token is rejected first)
// but before the body parser, keyed per node rather than per IP — an agent's egress address can
// legitimately change, but its identity (the node in the URL, already proven by the bearer token)
// should not be able to exceed its own budget regardless of source IP.
const { rateLimit } = require('express-rate-limit');

function createTierAgentReportLimiter({ limit, windowMs = 60000 }) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: req => String(req.params.node || '').toLowerCase(),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many reports for this node' }),
  });
}

module.exports = { createTierAgentReportLimiter };
