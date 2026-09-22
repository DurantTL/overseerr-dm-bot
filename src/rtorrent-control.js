'use strict';

const HASH = /^[a-f0-9]{40}$/i;
const LABEL = /^[a-zA-Z0-9 _.-]{0,64}$/;
const ACTIONS = Object.freeze({ start: 'd.start', resume: 'd.start', stop: 'd.stop', pause: 'd.stop', recheck: 'd.check_hash', 'set-label': 'd.custom1.set' });
function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
function hashValue(value) {
  if (typeof value !== 'string' || !HASH.test(value)) throw invalid('hash must contain 40 hexadecimal characters');
  return value.toUpperCase();
}
function labelValue(value) {
  if (typeof value !== 'string' || !LABEL.test(value)) throw invalid('label must be at most 64 letters, numbers, spaces, dots, underscores or hyphens');
  return value;
}
function validateBody(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))) throw invalid('Unexpected request fields');
}
function createRtorrentControl({ call, list, configured }) {
  return {
    configured,
    async list({ search = '', offset = 0, limit = 50 } = {}) {
      const rows = (await list()).filter(t => t.name.toLowerCase().includes(search.toLowerCase()));
      return { total: rows.length, offset, limit, torrents: rows.slice(offset, offset + limit) };
    },
    async detail(hash) {
      const normalized = hashValue(hash);
      const torrent = (await list()).find(t => t.hash === normalized);
      if (!torrent) throw Object.assign(new Error('Torrent not found'), { status: 404 });
      return torrent;
    },
    async control(hash, action, body = {}) {
      const normalized = hashValue(hash);
      if (!Object.hasOwn(ACTIONS, action)) throw invalid('Unsupported torrent action');
      validateBody(body, action === 'set-label' ? ['label'] : []);
      const params = [normalized];
      if (action === 'set-label') params.push(labelValue(body.label));
      await this.detail(normalized);
      await call(ACTIONS[action], params);
      return { ok: true, hash: normalized, action };
    },
    async add(body) {
      validateBody(body, ['magnet', 'label']);
      if (typeof body.magnet !== 'string' || body.magnet.length > 8192 || ['\r', '\n', '\0'].some(c => body.magnet.includes(c))) throw invalid('Invalid magnet');
      let magnet;
      try { magnet = new URL(body.magnet); } catch { throw invalid('Invalid magnet'); }
      // Only a BTIH magnet, never a caller-selected HTTP URL or local file path.
      const hashes = magnet.searchParams.getAll('xt');
      if (magnet.protocol !== 'magnet:' || magnet.host || magnet.pathname || hashes.length !== 1 || !/^urn:btih:([a-f0-9]{40}|[a-z2-7]{32})$/i.test(hashes[0])) throw invalid('A single BitTorrent v1 magnet is required');
      // No webseed/exact-source URL parameters: rTorrent must not fetch arbitrary internal URLs.
      if ([...magnet.searchParams.keys()].some(k => !['xt', 'dn', 'tr'].includes(k))) throw invalid('Only xt, dn and tr magnet parameters are supported');
      const label = labelValue(body.label === undefined ? '' : body.label);
      const commands = label ? [`d.custom1.set=${label}`] : [];
      await call('load.start', ['', body.magnet, ...commands]);
      return { ok: true, action: 'add', accepted: true };
    },
  };
}
module.exports = { createRtorrentControl };
