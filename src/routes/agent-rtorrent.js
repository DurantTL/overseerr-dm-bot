'use strict';

function registerAgentRtorrentRoutes(app, { service, auth, readLimiter, writeLimiter, requireRead, requireWrite, audit }) {
  const wrap = (action, handler) => async (req, res) => {
    const actor = `agent:${req.agentTokenLabel || 'unknown'}`;
    if (!service?.configured()) return res.status(503).json({ error: 'rTorrent is not configured' });
    try {
      const result = await handler(req);
      if (req.method === 'POST') audit('agent_rtorrent_control', { actor, action, hash: result.hash || null, outcome: 'success' });
      res.json(result);
    } catch (err) {
      // Neither credentials, upstream fault strings nor magnets (tracker passkeys) enter logs.
      audit('agent_rtorrent_error', { actor, action, outcome: 'failed' });
      const status = [400, 404].includes(err.status) ? err.status : 502;
      res.status(status).json({ error: status === 502 ? 'rTorrent request failed; check state before retrying' : err.message });
    }
  };
  const read = [auth, readLimiter, requireRead];
  const write = [auth, writeLimiter, requireWrite];
  app.get('/api/v1/rtorrent/torrents', ...read, wrap('list', req => {
    const { search = '', offset = '0', limit = '50' } = req.query;
    if (typeof search !== 'string' || search.length > 200 || typeof offset !== 'string' || !/^\d{1,7}$/.test(offset) || typeof limit !== 'string' || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) {
      throw Object.assign(new Error('Invalid search, offset or limit (1–100)'), { status: 400 });
    }
    return service.list({ search, offset: Number(offset), limit: Number(limit) });
  }));
  app.get('/api/v1/rtorrent/torrents/:hash', ...read, wrap('detail', req => service.detail(req.params.hash)));
  app.post('/api/v1/rtorrent/torrents', ...write, wrap('add', req => service.add(req.body)));
  for (const action of ['start', 'resume', 'stop', 'pause', 'recheck', 'set-label']) {
    app.post(`/api/v1/rtorrent/torrents/:hash/${action}`, ...write, wrap(action, req => service.control(req.params.hash, action, req.body || {})));
  }
}
module.exports = { registerAgentRtorrentRoutes };
