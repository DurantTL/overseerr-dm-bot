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

async function plexApiGetXml(urlPath, token) {
  const res = await axios.get(`https://plex.tv${urlPath}`, {
    responseType: 'text',
    headers: { 'X-Plex-Token': token, 'X-Plex-Client-Identifier': PLEX_CLIENT_ID },
  });
  return res.data;
}

async function getPlexServers(token, { includeExcluded = false } = {}) {
  const data = await plexApiGet('/api/v2/resources?includeHttps=1&includeRelay=1', token);
  return (Array.isArray(data) ? data : []).filter(r => r.provides?.includes('server')
    && (includeExcluded || !CONFIG.PLEX_EXCLUDE_SERVERS.includes((r.name || '').toLowerCase())));
}

// Plex never syncs watch state between servers — separate Continue Watching, separate watched
// marks, separate Tautulli history. So a person belongs to exactly one server: PH users get the
// cache box only, everyone else gets everything except it. With PH_SERVER_NAMES unset this is a
// no-op and invites go to every server, exactly as before.
function serversForHomeServer(servers, homeServer) {
  if (!CONFIG.PH_SERVER_NAMES.length) return servers;
  const isPh = s => CONFIG.PH_SERVER_NAMES.includes(String(s.name || '').toLowerCase())
    || CONFIG.PH_SERVER_NAMES.includes(String(s.clientIdentifier || '').toLowerCase());
  return homeServer === 'ph' ? servers.filter(isPh) : servers.filter(s => !isPh(s));
}

function plexServersForHomeServer(servers, homeServer) {
  let scoped = serversForHomeServer(servers, homeServer);
  if (homeServer !== 'ph') scoped = scoped.filter(s => !CONFIG.PLEX_EXCLUDE_SERVERS.includes((s.name || '').toLowerCase()));
  return scoped;
}

async function inviteUserToPlex(email, { homeServer = 'primary' } = {}) {
  const token = await getPlexToken();
  // Scope from the FULL server list, then apply PLEX_EXCLUDE_SERVERS only to primary invites:
  // excluding the PH box was the pre-staging way to keep it out of invites, and a PH-scoped
  // invite must still reach it even when it's on that list.
  const servers = plexServersForHomeServer(await getPlexServers(token, { includeExcluded: true }), homeServer);
  if (!servers.length) log.warn(`Plex invite for ${email}: no servers match home_server='${homeServer}' — are the ${homeServer === 'ph' ? 'Philippines server' : 'Main servers'} in this Plex account?`);
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
  audit('plex_invite_sent', { email, homeServer, successCount, total: servers.length });
  return { successCount, total: servers.length };
}

// Plex's /api/users endpoint is XML even though the old v2 friends endpoint was JSON. Keep the
// JSON normalizer for compatibility with old payloads, but parse the live XML response below.
function normalizePlexFriendsResponse(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  if (Array.isArray(raw.data)) return raw.data;
  const container = raw.MediaContainer;
  if (container) {
    const users = container.User ?? container.Friend ?? [];
    return Array.isArray(users) ? users : [users];
  }
  return [];
}

function decodePlexXml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parsePlexXmlAttributes(source) {
  const attributes = {};
  String(source || '').replace(/([\w:-]+)=(?:"([^"]*)"|'([^']*)')/g, (_match, key, doubleQuoted, singleQuoted) => {
    attributes[key] = decodePlexXml(doubleQuoted ?? singleQuoted);
    return _match;
  });
  return attributes;
}

function normalizePlexFriendsXml(xml) {
  const friends = [];
  const users = /<User\b([^>]*)(?:\/>|>([\s\S]*?)<\/User>)/g;
  let match;
  while ((match = users.exec(String(xml || '')))) {
    const friend = parsePlexXmlAttributes(match[1]);
    const shares = [];
    const servers = /<Server\b([^>]*?)(?:\/>|>[\s\S]*?<\/Server>)/g;
    let serverMatch;
    while ((serverMatch = servers.exec(match[2] || ''))) shares.push(parsePlexXmlAttributes(serverMatch[1]));
    friend.Server = shares;
    friends.push(friend);
  }
  return friends;
}

async function fetchPlexFriends(token) {
  const raw = await plexApiGetXml('/api/users', token);
  return typeof raw === 'string' ? normalizePlexFriendsXml(raw) : normalizePlexFriendsResponse(raw);
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function findPlexFriend(friends, email) {
  const wanted = String(email || '').trim().toLowerCase();
  return friends.find(friend => [friend.email, friend.username, friend.title]
    .some(value => String(value || '').trim().toLowerCase() === wanted));
}

function findPlexServerShare(friend, machineIdentifier) {
  const shares = [
    ...asArray(friend?.Server),
    ...asArray(friend?.servers),
    ...asArray(friend?.sharedServers),
  ];
  return shares.find(share => String(share?.machineIdentifier || share?.machine_identifier || '') === String(machineIdentifier));
}

// plex.tv's /api/servers/{machineIdentifier} response has used a few JSON wrappers over time.
// The legacy sharing endpoint needs the section *id* (not the local section key) for every
// library that should be shared.
function normalizePlexLibrarySectionIds(raw) {
  const container = raw?.MediaContainer || raw || {};
  const sections = [
    ...asArray(container.Directory),
    ...asArray(container.LibrarySection),
    ...asArray(container.librarySections),
  ];
  return [...new Set(sections
    .map(section => section?.id)
    .filter(id => id !== undefined && id !== null && String(id).trim() !== '')
    .map(id => String(id)))];
}

async function fetchPlexLibrarySectionIds(machineIdentifier, token) {
  const raw = await plexApiGet(`/api/servers/${encodeURIComponent(machineIdentifier)}`, token);
  const sectionIds = normalizePlexLibrarySectionIds(raw);
  if (!sectionIds.length) throw new Error(`Plex returned no library sections for server ${machineIdentifier}`);
  return sectionIds;
}

async function createPlexShareRefreshContext() {
  const token = await getPlexToken();
  const [servers, friends] = await Promise.all([
    getPlexServers(token, { includeExcluded: true }),
    fetchPlexFriends(token),
  ]);
  return { token, servers, friends, librarySectionIdsByMachine: new Map() };
}

function plexJsonHeaders(token) {
  return {
    'X-Plex-Token': token,
    'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

// Refresh an existing Plex share instead of trying to invite the same user again. Plex rejects
// duplicate invitations, while this PUT updates the current share with every live library.
// If a known Plex friend has no share on one of their assigned servers, create that one missing
// server share only; never send a duplicate invite for a share that already exists.
async function refreshPlexShare(email, { homeServer = 'primary', context = null } = {}) {
  const refreshContext = context || await createPlexShareRefreshContext();
  const servers = plexServersForHomeServer(refreshContext.servers, homeServer);
  const friend = findPlexFriend(refreshContext.friends, email);
  const result = { updatedCount: 0, createdCount: 0, failedCount: 0, total: servers.length, errors: [] };

  if (!friend) {
    result.failedCount = servers.length || 1;
    result.errors.push('No matching Plex friend or accepted invite was found');
    return result;
  }

  for (const server of servers) {
    try {
      let sectionIds = refreshContext.librarySectionIdsByMachine.get(server.clientIdentifier);
      if (!sectionIds) {
        sectionIds = await fetchPlexLibrarySectionIds(server.clientIdentifier, refreshContext.token);
        refreshContext.librarySectionIdsByMachine.set(server.clientIdentifier, sectionIds);
      }
      const share = findPlexServerShare(friend, server.clientIdentifier);
      if (share?.id != null) {
        await axios.put(
          `https://plex.tv/api/servers/${encodeURIComponent(server.clientIdentifier)}/shared_servers/${encodeURIComponent(share.id)}`,
          { server_id: server.clientIdentifier, shared_server: { library_section_ids: sectionIds } },
          { headers: plexJsonHeaders(refreshContext.token) },
        );
        result.updatedCount++;
      } else {
        await axios.post(
          `https://plex.tv/api/servers/${encodeURIComponent(server.clientIdentifier)}/shared_servers`,
          { server_id: server.clientIdentifier, shared_server: { library_section_ids: sectionIds, invited_id: friend.id } },
          { headers: plexJsonHeaders(refreshContext.token) },
        );
        result.createdCount++;
      }
    } catch (err) {
      result.failedCount++;
      const message = err?.response?.data?.error || err?.message || 'Unknown Plex API error';
      result.errors.push(`${server.name || server.clientIdentifier}: ${message}`);
      log.warn(`Plex share refresh failed for ${email} on ${server.name || server.clientIdentifier}: ${message}`);
    }
  }
  audit('plex_share_refreshed', {
    email,
    homeServer,
    updatedCount: result.updatedCount,
    createdCount: result.createdCount,
    failedCount: result.failedCount,
    total: result.total,
  });
  return result;
}

async function removePlexAccess(email) {
  const token = await getPlexToken();
  const friends = await fetchPlexFriends(token).catch(() => []);
  const friend = friends.find(f => [f.email, f.username, f.title].some(v => (v || '').toLowerCase() === email.toLowerCase()));
  if (!friend) return { removed: false, reason: 'No Plex account found' };
  // Revocation deliberately ignores PLEX_EXCLUDE_SERVERS and home_server scoping: removing
  // someone must reach EVERY server in the account, or an "excluded" box (like the PH cache)
  // silently keeps serving a person who was supposed to lose access.
  const servers = await getPlexServers(token, { includeExcluded: true });
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

module.exports = { PLEX_CLIENT_ID, getPlexToken, plexApiGet, plexApiGetXml, getPlexServers, serversForHomeServer, plexServersForHomeServer, inviteUserToPlex, removePlexAccess, fetchPlexFriends, normalizePlexFriendsResponse, normalizePlexFriendsXml, normalizePlexLibrarySectionIds, createPlexShareRefreshContext, refreshPlexShare };
