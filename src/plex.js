// plex.tv API: auth, server discovery, invites, access removal.
const axios = require('axios');
const { CONFIG } = require('./config');
const { audit } = require('./db');
const { log } = require('./log');

const PLEX_CLIENT_ID = 'durant-media-server-bot';

async function getPlexToken() {
  if (CONFIG.PLEX_TOKEN) return CONFIG.PLEX_TOKEN;
  const res = await axios.post('https://plex.tv/users/sign_in.json', {}, {
    auth: { username: CONFIG.PLEX_USERNAME, password: CONFIG.PLEX_PASSWORD },
    headers: { 'X-Plex-Client-Identifier': PLEX_CLIENT_ID, 'X-Plex-Product': 'Durant Media Server Bot', 'X-Plex-Version': '1.0' },
  });
  return res.data.user.authToken;
}

async function plexApiGet(urlPath, token) {
  const res = await axios.get(`https://plex.tv${urlPath}`, {
    headers: { 'X-Plex-Token': token, 'Accept': 'application/json', 'X-Plex-Client-Identifier': PLEX_CLIENT_ID },
  });
  return res.data;
}

async function getPlexServers(token) {
  const data = await plexApiGet('/api/v2/resources?includeHttps=1&includeRelay=1', token);
  return (Array.isArray(data) ? data : []).filter(r => r.provides?.includes('server') && !CONFIG.PLEX_EXCLUDE_SERVERS.includes((r.name || '').toLowerCase()));
}

async function inviteUserToPlex(email) {
  const token = await getPlexToken();
  const servers = await getPlexServers(token);
  let successCount = 0;
  for (const server of servers) {
    try {
      await axios.post('https://plex.tv/api/v2/shared_servers', {
        invitedEmail: email,
        machineIdentifier: server.clientIdentifier,
        librarySectionIds: [],
        settings: { allowSync: true },
      }, { headers: { 'X-Plex-Token': token, 'X-Plex-Client-Identifier': PLEX_CLIENT_ID, Accept: 'application/json' } });
      successCount++;
    } catch (err) {
      log.warn(`Plex invite failed on ${server.name}: ${err.message}`);
    }
  }
  audit('plex_invite_sent', { email, successCount, total: servers.length });
  return { successCount, total: servers.length };
}

async function removePlexAccess(email) {
  const token = await getPlexToken();
  const friendsData = await plexApiGet('/api/v2/friends', token).catch(() => []);
  const friends = Array.isArray(friendsData) ? friendsData : (friendsData.data || []);
  const friend = friends.find(f => [f.email, f.username, f.title].some(v => (v || '').toLowerCase() === email.toLowerCase()));
  if (!friend) return { removed: false, reason: 'No Plex account found' };
  const servers = await getPlexServers(token);
  let removedCount = 0;
  for (const server of servers) {
    try {
      await axios.delete(`https://plex.tv/api/v2/shared_servers/${server.clientIdentifier}/friends/${friend.id}`, {
        headers: { 'X-Plex-Token': token, 'X-Plex-Client-Identifier': PLEX_CLIENT_ID, Accept: 'application/json' },
      });
      removedCount++;
    } catch (_e) {}
  }
  audit('plex_access_removed', { email, removedCount, total: servers.length });
  return { removed: removedCount > 0, removedCount, total: servers.length };
}

module.exports = { PLEX_CLIENT_ID, getPlexToken, plexApiGet, getPlexServers, inviteUserToPlex, removePlexAccess };
