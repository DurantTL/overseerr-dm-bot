require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const axios = require('axios');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG = {
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID,
  ADMIN_CHANNEL_ID: process.env.ADMIN_CHANNEL_ID,
  ADMIN_USER_ID: process.env.ADMIN_USER_ID,
  OVERSEERR_URL: (process.env.OVERSEERR_URL || '').replace(/\/$/, ''),
  OVERSEERR_API_KEY: process.env.OVERSEERR_API_KEY,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
  PLEX_TOKEN: process.env.PLEX_TOKEN || '',
  PLEX_USERNAME: process.env.PLEX_USERNAME || '',
  PLEX_PASSWORD: process.env.PLEX_PASSWORD || '',
  PLEX_EXCLUDE_SERVERS: process.env.PLEX_EXCLUDE_SERVERS ? process.env.PLEX_EXCLUDE_SERVERS.split(',').map(v => v.trim().toLowerCase()) : [],
  RADARR_URL: process.env.RADARR_URL || '',
  RADARR_API_KEY: process.env.RADARR_API_KEY || '',
  RADARR_4K_URL: process.env.RADARR_4K_URL || '',
  RADARR_4K_API_KEY: process.env.RADARR_4K_API_KEY || '',
  SONARR_URL: process.env.SONARR_URL || '',
  SONARR_API_KEY: process.env.SONARR_API_KEY || '',
  TUNNEL_DOMAIN: process.env.TUNNEL_DOMAIN,
  RAID_PATH: process.env.RAID_PATH || '/mnt/raid',
  PATH_REMAP_FROM: process.env.PATH_REMAP_FROM || '',
  PATH_REMAP_TO: process.env.PATH_REMAP_TO || process.env.RAID_PATH || '/mnt/raid',
  TAUTULLI_WEBHOOK_SECRET: process.env.TAUTULLI_WEBHOOK_SECRET || '',
  PORT: Number.parseInt(process.env.PORT || '3000', 10),
  DASHBOARD_ENABLED: parseBool(process.env.DASHBOARD_ENABLED, true),
  DASHBOARD_ADMIN_PASSWORD: process.env.DASHBOARD_ADMIN_PASSWORD || '',
  DASHBOARD_ADMIN_TOKEN: process.env.DASHBOARD_ADMIN_TOKEN || '',
  STRICT_DASHBOARD_POST_AUTH: parseBool(process.env.STRICT_DASHBOARD_POST_AUTH, true),
  SESSION_SECRET: process.env.SESSION_SECRET || '',
  SESSION_TTL_HOURS: Number.parseInt(process.env.SESSION_TTL_HOURS || '12', 10),
  ENABLE_DELETION: parseBool(process.env.ENABLE_DELETION, false),
  DELETION_DRY_RUN: parseBool(process.env.DELETION_DRY_RUN, true),
  AUTO_REMOVE_PLEX_ON_LEAVE: parseBool(process.env.AUTO_REMOVE_PLEX_ON_LEAVE, false),
  DOWNLOAD_TOKEN_TTL_HOURS: Number.parseInt(process.env.DOWNLOAD_TOKEN_TTL_HOURS || '24', 10),
  DOWNLOAD_ONE_TIME_LINKS_DEFAULT: parseBool(process.env.DOWNLOAD_ONE_TIME_LINKS_DEFAULT, false),
  DOWNLOAD_MAX_PER_HOUR: Number.parseInt(process.env.DOWNLOAD_MAX_PER_HOUR || '10', 10),
  DOWNLOAD_ROUTE_MAX_PER_MINUTE: Number.parseInt(process.env.DOWNLOAD_ROUTE_MAX_PER_MINUTE || '60', 10),
  DOWNLOAD_LARGE_FILE_GB: Number.parseInt(process.env.DOWNLOAD_LARGE_FILE_GB || '8', 10),
  DELETION_GRACE_HOURS: Number.parseInt(process.env.DELETION_GRACE_HOURS || '24', 10),
  DELETION_REMINDER_COOLDOWN_HOURS: Number.parseInt(process.env.DELETION_REMINDER_COOLDOWN_HOURS || '12', 10),
  KEEP_LIST_DEFAULT_DAYS: Number.parseInt(process.env.KEEP_LIST_DEFAULT_DAYS || '90', 10),
  NEVER_DELETE_MEDIA_IDS: process.env.NEVER_DELETE_MEDIA_IDS ? process.env.NEVER_DELETE_MEDIA_IDS.split(',').map(s => s.trim()) : [],
};

const REQUIRED_ENV = [
  'DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'ADMIN_CHANNEL_ID', 'ADMIN_USER_ID',
  'OVERSEERR_URL', 'OVERSEERR_API_KEY', 'TUNNEL_DOMAIN', 'RAID_PATH',
];

const log = {
  info: (...a) => console.log('[INFO]', ...a),
  ok: (...a) => console.log('[OK]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERROR]', ...a),
};

function parseBool(v, fallback = false) {
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Centralized embed palette so every notification shares one consistent look.
const COLORS = {
  PLEX: 0xe5a00d,    // brand amber/gold — onboarding & welcome
  INFO: 0x3b82f6,    // blue — neutral notifications / new requests
  WARN: 0xf59e0b,    // amber — attention needed / decisions
  SUCCESS: 0x22c55e, // green — completed / available / healthy
  DANGER: 0xef4444,  // red — failures / destructive
};

// Wrap EmbedBuilder so every embed gets a uniform footer + timestamp.
function brandedEmbed(color) {
  const e = new EmbedBuilder().setFooter({ text: 'Durant Media Server' }).setTimestamp();
  if (color !== undefined) e.setColor(color);
  return e;
}

// Secret used to sign dashboard session cookies. Falls back to a value derived from the
// existing admin credentials so sessions stay valid across restarts without extra config.
function sessionSecret() {
  if (CONFIG.SESSION_SECRET) return CONFIG.SESSION_SECRET;
  return sha256(`session:${CONFIG.DASHBOARD_ADMIN_PASSWORD || CONFIG.DASHBOARD_ADMIN_TOKEN || 'durant'}`);
}

// Signed, stateless session token: base64url(payload).hmac. No external cookie/session deps.
function signSession(ttlMs) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && Date.now() < exp;
  } catch (_e) {
    return false;
  }
}

// Minimal cookie parser — pulls a single named cookie from the request header.
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

function validateConfig() {
  const missing = REQUIRED_ENV.filter(k => !CONFIG[k]);
  if (!CONFIG.PLEX_TOKEN && !(CONFIG.PLEX_USERNAME && CONFIG.PLEX_PASSWORD)) {
    missing.push('PLEX_TOKEN or PLEX_USERNAME+PLEX_PASSWORD');
  }
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (CONFIG.DASHBOARD_ENABLED && !CONFIG.DASHBOARD_ADMIN_PASSWORD && !CONFIG.DASHBOARD_ADMIN_TOKEN) {
    throw new Error('DASHBOARD_ENABLED=true requires DASHBOARD_ADMIN_PASSWORD or DASHBOARD_ADMIN_TOKEN');
  }
}

const db = new Database('/app/data/plex_invites.db');
db.pragma('journal_mode = WAL');

function ensureColumn(table, col, spec) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${spec}`);
}

function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      discord_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      invited INTEGER DEFAULT 0,
      invited_at TEXT,
      requested_at TEXT NOT NULL,
      overseerr_created INTEGER DEFAULT 0,
      overseerr_user_id INTEGER,
      plex_username TEXT
    );
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      overseerr_request_id TEXT UNIQUE,
      media_id TEXT NOT NULL,
      media_type TEXT NOT NULL,
      is_4k INTEGER DEFAULT 0,
      title TEXT NOT NULL,
      requested_by_discord_id TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS keep_list (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id TEXT NOT NULL,
      media_type TEXT NOT NULL,
      title TEXT NOT NULL,
      kept_by_discord_id TEXT,
      expires_at INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_keep_unique ON keep_list(media_id, kept_by_discord_id);

    CREATE TABLE IF NOT EXISTS download_tokens (
      token_hash TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      title TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      one_time_use INTEGER DEFAULT 0,
      used_at INTEGER,
      revoked INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      actor_discord_id TEXT,
      target_discord_id TEXT,
      metadata_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS download_access_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT,
      discord_id TEXT,
      ip TEXT,
      user_agent TEXT,
      file_path TEXT,
      status TEXT,
      bytes_sent INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS media_retention_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_class TEXT UNIQUE,
      retention_days INTEGER NOT NULL,
      enabled INTEGER DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_requests_media ON requests(media_id);
    CREATE INDEX IF NOT EXISTS idx_requests_requester ON requests(requested_by_discord_id);
    CREATE INDEX IF NOT EXISTS idx_download_tokens_discord ON download_tokens(discord_id);
    CREATE INDEX IF NOT EXISTS idx_download_tokens_expires ON download_tokens(expires_at);
    CREATE INDEX IF NOT EXISTS idx_download_access_created ON download_access_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_action_created ON audit_log(action, created_at);
  `);

  ensureColumn('users', 'overseerr_user_id', 'INTEGER');
  ensureColumn('users', 'plex_username', 'TEXT');
  ensureColumn('keep_list', 'expires_at', 'INTEGER');

  const dlCols = db.prepare('PRAGMA table_info(download_tokens)').all().map(c => c.name);
  if (dlCols.includes('token') && !dlCols.includes('token_hash')) {
    ensureColumn('download_tokens', 'token_hash', 'TEXT');
    const rows = db.prepare('SELECT token FROM download_tokens WHERE token_hash IS NULL').all();
    const stmt = db.prepare('UPDATE download_tokens SET token_hash = ? WHERE token = ?');
    for (const row of rows) stmt.run(sha256(row.token), row.token);
  }
  ensureColumn('download_tokens', 'one_time_use', 'INTEGER DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_download_tokens_hash ON download_tokens(token_hash)');
  ensureColumn('download_tokens', 'used_at', 'INTEGER');
  ensureColumn('download_tokens', 'revoked', 'INTEGER DEFAULT 0');

  db.prepare(`INSERT OR IGNORE INTO media_retention_rules (media_class, retention_days, enabled)
    VALUES
    ('movie_4k', 30, 1),
    ('movie_1080p', 60, 1),
    ('tv_episode', 30, 1),
    ('tv_season', 90, 1)
  `).run();
}

function audit(action, details = {}) {
  const meta = { ...details };
  if (meta.error && typeof meta.error === 'string') meta.error = meta.error.slice(0, 500);
  db.prepare('INSERT INTO audit_log (action, actor_discord_id, target_discord_id, metadata_json) VALUES (?, ?, ?, ?)')
    .run(action, details.actorDiscordId || null, details.targetDiscordId || null, JSON.stringify(meta));
}

function notifyAdmin(msg) {
  safeGetChannel(CONFIG.ADMIN_CHANNEL_ID)
    .then(ch => ch && ch.send(msg).catch(() => {}))
    .catch(() => {});
}

// basic helpers
function storeUserEmail(discordId, email) {
  db.prepare(`INSERT INTO users (discord_id, email, requested_at)
    VALUES (?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET email=excluded.email, requested_at=excluded.requested_at, overseerr_created=0, overseerr_user_id=NULL`)
    .run(discordId, email.toLowerCase().trim(), new Date().toISOString());
}
const getUserByDiscordId = discordId => db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
const getUserByEmail = email => db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email.toLowerCase().trim());
const markUserInvited = discordId => db.prepare('UPDATE users SET invited = 1, invited_at = ? WHERE discord_id = ?').run(new Date().toISOString(), discordId);
const markOverseerrCreated = (discordId, overseerrId) => db.prepare('UPDATE users SET overseerr_created = 1, overseerr_user_id = ? WHERE discord_id = ?').run(overseerrId, discordId);
const removeUser = discordId => db.prepare('DELETE FROM users WHERE discord_id = ?').run(discordId);

function upsertRequest(overseerrRequestId, mediaId, mediaType, is4k, title, discordId, status) {
  db.prepare(`INSERT OR REPLACE INTO requests
    (overseerr_request_id, media_id, media_type, is_4k, title, requested_by_discord_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(overseerrRequestId, mediaId, mediaType, is4k ? 1 : 0, title, discordId || null, status);
}

function addToKeepList(mediaId, mediaType, title, discordId, keepDays = CONFIG.KEEP_LIST_DEFAULT_DAYS) {
  const expiresAt = keepDays > 0 ? Date.now() + keepDays * 86400000 : null;
  db.prepare('INSERT OR REPLACE INTO keep_list (media_id, media_type, title, kept_by_discord_id, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(mediaId, mediaType, title, discordId || null, expiresAt);
}

function isInKeepList(mediaId) {
  return !!db.prepare('SELECT id FROM keep_list WHERE media_id = ? AND (expires_at IS NULL OR expires_at > ?)').get(mediaId, Date.now());
}

function createDownloadToken(filePath, title, discordId, oneTimeUse = CONFIG.DOWNLOAD_ONE_TIME_LINKS_DEFAULT) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(rawToken);
  const expiresAt = Date.now() + CONFIG.DOWNLOAD_TOKEN_TTL_HOURS * 3600 * 1000;
  db.prepare('INSERT INTO download_tokens (token_hash, file_path, title, discord_id, expires_at, one_time_use) VALUES (?, ?, ?, ?, ?, ?)')
    .run(tokenHash, filePath, title, discordId, expiresAt, oneTimeUse ? 1 : 0);
  audit('download_link_generated', { targetDiscordId: discordId, title, expiresAt, oneTimeUse: !!oneTimeUse });
  return { rawToken, tokenHash, expiresAt };
}

function getDownloadRecordByRawToken(rawToken) {
  return db.prepare('SELECT * FROM download_tokens WHERE token_hash = ?').get(sha256(rawToken));
}

function revokeAllDownloadLinks(discordId = null) {
  if (discordId) {
    db.prepare('UPDATE download_tokens SET revoked = 1 WHERE discord_id = ? AND revoked = 0').run(discordId);
    audit('download_links_revoked_user', { targetDiscordId: discordId });
  } else {
    db.prepare('UPDATE download_tokens SET revoked = 1 WHERE revoked = 0').run();
    audit('download_links_revoked_global', {});
  }
}

function cleanExpiredTokens() {
  db.prepare('DELETE FROM download_tokens WHERE expires_at < ?').run(Date.now());
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row?.value || null;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value));
}

// Pending onboarding is mirrored in app_settings (pending_email:<discordId>) so it survives
// restarts — including Watchtower's nightly update — mid-onboarding. The Map is a hot cache,
// rehydrated from the DB at startup.
const pendingEmailRequests = new Map();
function setPendingEmail(discordId) {
  pendingEmailRequests.set(discordId, true);
  setSetting(`pending_email:${discordId}`, '1');
}
function hasPendingEmail(discordId) {
  return pendingEmailRequests.has(discordId) || !!getSetting(`pending_email:${discordId}`);
}
function clearPendingEmail(discordId) {
  pendingEmailRequests.delete(discordId);
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(`pending_email:${discordId}`);
}
function rehydratePendingEmails() {
  const rows = db.prepare("SELECT key FROM app_settings WHERE key LIKE 'pending_email:%'").all();
  for (const r of rows) pendingEmailRequests.set(r.key.slice('pending_email:'.length), true);
  if (rows.length) log.info(`Rehydrated ${rows.length} pending onboarding request(s)`);
}
const routeLimits = new Map();
const userGenerationLimits = new Map();

function takeRateLimit(bucketMap, key, maxHits, periodMs) {
  const now = Date.now();
  const hits = (bucketMap.get(key) || []).filter(ts => now - ts < periodMs);
  if (hits.length >= maxHits) {
    bucketMap.set(key, hits);
    return false;
  }
  hits.push(now);
  bucketMap.set(key, hits);
  return true;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

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

async function createOverseerrUser(email, discordId, username) {
  const createRes = await axios.post(`${CONFIG.OVERSEERR_URL}/api/v1/user`, {
    email, username, password: crypto.randomUUID(), permissions: 32, userType: 2,
  }, { headers: { 'X-Api-Key': CONFIG.OVERSEERR_API_KEY } });
  const id = createRes.data.id;
  await axios.post(`${CONFIG.OVERSEERR_URL}/api/v1/user/${id}/settings/notifications`, { discordId }, { headers: { 'X-Api-Key': CONFIG.OVERSEERR_API_KEY } });
  return id;
}

async function approveOverseerrRequest(requestId) {
  return axios.post(`${CONFIG.OVERSEERR_URL}/api/v1/request/${requestId}/approve`, {}, { headers: { 'X-Api-Key': CONFIG.OVERSEERR_API_KEY } });
}
async function denyOverseerrRequest(requestId) {
  return axios.post(`${CONFIG.OVERSEERR_URL}/api/v1/request/${requestId}/decline`, {}, { headers: { 'X-Api-Key': CONFIG.OVERSEERR_API_KEY } });
}

async function radarrGetFrom(url, apiKey, endpoint) {
  const res = await axios.get(`${url}/api/v3${endpoint}`, { params: { apikey: apiKey }, timeout: 10000 });
  return res.data;
}
async function sonarrGet(endpoint, params = {}) {
  const res = await axios.get(`${CONFIG.SONARR_URL}/api/v3${endpoint}`, { params: { apikey: CONFIG.SONARR_API_KEY, ...params }, timeout: 10000 });
  return res.data;
}

async function searchMovies(title) {
  const lower = title.toLowerCase();
  const results = [];
  if (CONFIG.RADARR_URL) {
    const all = await radarrGetFrom(CONFIG.RADARR_URL, CONFIG.RADARR_API_KEY, '/movie');
    all.filter(m => m.hasFile && m.title.toLowerCase().includes(lower)).forEach(m => results.push({ ...m, _radarrUrl: CONFIG.RADARR_URL, _radarrKey: CONFIG.RADARR_API_KEY }));
  }
  if (CONFIG.RADARR_4K_URL) {
    const all = await radarrGetFrom(CONFIG.RADARR_4K_URL, CONFIG.RADARR_4K_API_KEY, '/movie');
    all.filter(m => m.hasFile && m.title.toLowerCase().includes(lower)).forEach(m => results.push({ ...m, _radarrUrl: CONFIG.RADARR_4K_URL, _radarrKey: CONFIG.RADARR_4K_API_KEY }));
  }
  return results;
}
async function searchSeries(title) {
  const all = await sonarrGet('/series');
  return all.filter(s => s.title.toLowerCase().includes(title.toLowerCase()));
}
async function getEpisodeFiles(seriesId) {
  return sonarrGet('/episodefile', { seriesId });
}

// Resolve a stored mediaId (tmdb:/tvdb:) to the concrete Radarr movie or Sonarr episode files
// behind it, so deletion can report exact paths in dry-run and issue the right API call when live.
async function resolveDeletableMedia(mediaId) {
  if (mediaId.startsWith('tmdb:')) {
    const tmdbId = Number(mediaId.slice('tmdb:'.length));
    const sources = [
      { url: CONFIG.RADARR_URL, key: CONFIG.RADARR_API_KEY, label: 'radarr' },
      { url: CONFIG.RADARR_4K_URL, key: CONFIG.RADARR_4K_API_KEY, label: 'radarr-4k' },
    ].filter(s => s.url);
    for (const s of sources) {
      const all = await radarrGetFrom(s.url, s.key, '/movie').catch(() => []);
      const movie = all.find(m => m.tmdbId === tmdbId);
      if (movie) {
        return {
          found: true, kind: 'movie', source: s, movie,
          paths: movie.movieFile?.path ? [movie.movieFile.path] : [],
          apiCall: `DELETE ${s.url}/api/v3/movie/${movie.id}?deleteFiles=true (${s.label})`,
        };
      }
    }
    return { found: false, kind: 'movie' };
  }
  if (mediaId.startsWith('tvdb:')) {
    if (!CONFIG.SONARR_URL) return { found: false, kind: 'tv' };
    const tvdbId = Number(mediaId.slice('tvdb:'.length));
    const all = await sonarrGet('/series').catch(() => []);
    const series = all.find(s => s.tvdbId === tvdbId);
    if (!series) return { found: false, kind: 'tv' };
    const files = await getEpisodeFiles(series.id).catch(() => []);
    return {
      found: true, kind: 'tv', series, files,
      paths: files.map(f => f.path),
      apiCall: `DELETE ${CONFIG.SONARR_URL}/api/v3/episodefile/{id} ×${files.length}`,
    };
  }
  return { found: false, kind: 'unknown' };
}

function remapPath(hostPath) {
  if (CONFIG.PATH_REMAP_FROM && hostPath.startsWith(CONFIG.PATH_REMAP_FROM)) {
    return hostPath.replace(CONFIG.PATH_REMAP_FROM, CONFIG.PATH_REMAP_TO);
  }
  return hostPath;
}

function resolveSafeMediaPath(requestedPath) {
  const normalizedRoot = fs.realpathSync(path.resolve(CONFIG.RAID_PATH));
  const resolved = path.resolve(requestedPath);
  const realResolved = fs.realpathSync(resolved);
  if (!realResolved.startsWith(normalizedRoot + path.sep) && realResolved !== normalizedRoot) {
    throw new Error('Resolved file path escapes configured RAID_PATH');
  }
  return realResolved;
}

function mediaTypeLabel(mediaType, is4k) { if (mediaType === 'tv') return is4k ? '4K TV Show' : 'TV Show'; return is4k ? '4K Movie' : 'Movie'; }
function mediaTypeEmoji(mediaType, is4k) { if (mediaType === 'tv') return '📺'; return is4k ? '🎥' : '🎬'; }
function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function canonicalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  const [local, domain] = email.split('@');
  if (!domain) return email;
  if (domain === 'plex.local') return `__placeholder__:${email}`;
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${local.split('+')[0].replace(/\./g, '')}@gmail.com`;
  }
  return `${local.split('+')[0]}@${domain}`;
}
function statusEmoji(v) {
  if (['ok', 'configured'].includes(v)) return '✅';
  if (v === 'skipped') return '⏭️';
  return '❌';
}
function pad(n) { return String(n).padStart(2, '0'); }
function mimeFor(ext) { return ({ '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.wmv': 'video/x-ms-wmv' })[ext] || 'application/octet-stream'; }

async function safeGetChannel(channelId) {
  try { return await client.channels.fetch(channelId); } catch (_e) { return null; }
}

function isAdminInteraction(interaction) {
  return interaction.user.id === CONFIG.ADMIN_USER_ID || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

const slashCommands = [
  new SlashCommandBuilder().setName('download').setDescription('Get a secure download link').addStringOption(o => o.setName('title').setDescription('Movie or show title').setRequired(true)).addIntegerOption(o => o.setName('season').setDescription('Season number')).addIntegerOption(o => o.setName('episode').setDescription('Episode number')).addBooleanOption(o => o.setName('one_time').setDescription('One-time download link')),
  new SlashCommandBuilder().setName('link').setDescription('Link a user to Plex email').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('email').setDescription('Plex email').setRequired(true)),
  new SlashCommandBuilder().setName('unlink').setDescription('Unlink a user').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('users').setDescription('List linked users').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('status').setDescription('Show status').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('sync').setDescription('Sync users safely').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addStringOption(o => o.setName('mode').setDescription('preview or apply').setRequired(true).addChoices({ name: 'preview', value: 'preview' }, { name: 'apply', value: 'apply' })),
  new SlashCommandBuilder().setName('sync-fix').setDescription('Resolve sync issues found in the preview').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addStringOption(o => o.setName('target').setDescription('Category to fix').setRequired(true).addChoices({ name: 'placeholders', value: 'placeholders' }, { name: 'duplicates', value: 'duplicates' }, { name: 'orphans', value: 'orphans' }, { name: 'mergeemails', value: 'mergeemails' })),
  new SlashCommandBuilder().setName('cleanup').setDescription('Cleanup deleted Overseerr users').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addStringOption(o => o.setName('mode').setDescription('preview or apply').setRequired(false).addChoices({ name: 'preview', value: 'preview' }, { name: 'apply', value: 'apply' })),
  new SlashCommandBuilder().setName('audit').setDescription('Audit log queries').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('recent').setDescription('Recent entries').addIntegerOption(o => o.setName('count').setDescription('Count').setMinValue(1).setMaxValue(100)))
    .addSubcommand(s => s.setName('user').setDescription('Entries by user').addUserOption(o => o.setName('person').setDescription('User').setRequired(true)).addIntegerOption(o => o.setName('count').setDescription('Count').setMinValue(1).setMaxValue(100)))
    .addSubcommand(s => s.setName('action').setDescription('Entries by action').addStringOption(o => o.setName('action').setDescription('Action name').setRequired(true)).addIntegerOption(o => o.setName('count').setDescription('Count').setMinValue(1).setMaxValue(100))),
  new SlashCommandBuilder().setName('me').setDescription('Show your linked profile'),
  new SlashCommandBuilder().setName('myrequests').setDescription('Show your recent requests'),
  new SlashCommandBuilder().setName('downloads').setDescription('Show your active download links'),
  new SlashCommandBuilder().setName('keep').setDescription('Show your keep list'),
  new SlashCommandBuilder().setName('help').setDescription('How this media server works'),
  new SlashCommandBuilder().setName('revoke-downloads').setDescription('Revoke download links').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('scope').setDescription('all or user').setRequired(true).addChoices({ name: 'all', value: 'all' }, { name: 'user', value: 'user' }))
    .addUserOption(o => o.setName('user').setDescription('User for user scope').setRequired(false)),
].map(v => v.toJSON());

async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_BOT_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CONFIG.DISCORD_CLIENT_ID, CONFIG.DISCORD_GUILD_ID), { body: slashCommands });
  log.ok(`Registered ${slashCommands.length} slash command(s)`);
}

client.once('ready', async () => {
  log.ok(`Discord bot online as ${client.user.tag}`);
  rehydratePendingEmails();
  await registerSlashCommands();
  startExpressServer();
});

client.on('guildMemberAdd', async member => {
  try {
    await member.send({ embeds: [brandedEmbed(COLORS.PLEX)
      .setTitle('👋 Welcome to Durant Media Server!')
      .setDescription('Glad to have you here! To request access, just **reply to this message with the email on your Plex account**.\n\nOnce an admin approves you, you\'ll get a Plex invite and a DM confirming you\'re all set. 🍿')] });
    setPendingEmail(member.id);
  } catch (err) {
    log.warn(`Could not DM ${member.user.tag}: ${err.message}`);
  }
});

client.on('guildMemberRemove', async member => {
  const user = getUserByDiscordId(member.id);
  if (!user) return;

  // Notify-only by default: leaving Discord never silently revokes Plex. The admin gets a
  // one-click "Revoke Plex" button. Set AUTO_REMOVE_PLEX_ON_LEAVE=true for the old behavior.
  if (!CONFIG.AUTO_REMOVE_PLEX_ON_LEAVE) {
    audit('user_left_guild', { targetDiscordId: member.id, email: user.email, autoRemoved: false });
    const adminChannel = await safeGetChannel(CONFIG.ADMIN_CHANNEL_ID);
    if (!adminChannel) return;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`revoke_plex:${member.id}`).setLabel('Revoke Plex').setStyle(ButtonStyle.Danger),
    );
    await adminChannel.send({ embeds: [brandedEmbed(COLORS.WARN).setTitle('👋 User left Discord').setDescription(`<@${member.id}> (${user.email}) left the server.\nPlex access was **not** auto-revoked.`)], components: [row] }).catch(() => {});
    return;
  }

  try {
    const result = await removePlexAccess(user.email);
    removeUser(member.id);
    audit('user_unlinked', { targetDiscordId: member.id, email: user.email, removed: result.removed });
    notifyAdmin(`⚠️ User left Discord: <@${member.id}> (${user.email}). Plex removed: ${result.removed ? 'yes' : 'no'}`);
  } catch (err) {
    audit('external_api_error', { targetDiscordId: member.id, provider: 'plex', error: err.message });
    notifyAdmin(`⚠️ Failed to remove Plex access for ${user.email}: ${err.message}`);
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot || message.guild) return;
  if (!hasPendingEmail(message.author.id)) return;
  const email = message.content.trim().toLowerCase();
  if (!isValidEmail(email)) return message.reply('That does not look like a valid email. Try again.');
  clearPendingEmail(message.author.id);
  storeUserEmail(message.author.id, email);
  audit('user_linked', { targetDiscordId: message.author.id, email });
  await message.reply('✅ Thanks! Your request has been sent to the admins for approval. You\'ll get a DM here as soon as you\'re approved.');
  const adminChannel = await safeGetChannel(CONFIG.ADMIN_CHANNEL_ID);
  if (!adminChannel) return;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`plex_approve:${message.author.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`plex_deny:${message.author.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
  );
  const requestEmbed = brandedEmbed(COLORS.INFO)
    .setTitle('🔐 New Plex Access Request')
    .addFields({ name: 'User', value: `<@${message.author.id}>`, inline: true }, { name: 'Email', value: `\`${email}\``, inline: true });
  const avatarUrl = message.author.displayAvatarURL?.();
  if (avatarUrl) requestEmbed.setThumbnail(avatarUrl);
  await adminChannel.send({ embeds: [requestEmbed], components: [row] });
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) await handleSlashCommand(interaction);
    if (interaction.isButton()) await handleButton(interaction);
  } catch (err) {
    audit('external_api_error', { actorDiscordId: interaction.user?.id, error: err.message, action: 'interaction' });
    const payload = { content: `❌ ${err.message}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

async function handleSlashCommand(interaction) {
  const n = interaction.commandName;
  if (n === 'download') return handleDownloadCommand(interaction);
  if (n === 'link') return handleLinkCommand(interaction);
  if (n === 'unlink') return handleUnlinkCommand(interaction);
  if (n === 'users') return handleUsersCommand(interaction);
  if (n === 'status') return handleStatusCommand(interaction);
  if (n === 'sync') return handleSyncCommand(interaction);
  if (n === 'sync-fix') return handleSyncFixCommand(interaction);
  if (n === 'cleanup') return handleCleanupCommand(interaction);
  if (n === 'audit') return handleAuditCommand(interaction);
  if (n === 'me') return handleMeCommand(interaction);
  if (n === 'myrequests') return handleMyRequestsCommand(interaction);
  if (n === 'downloads') return handleDownloadsCommand(interaction);
  if (n === 'keep') return handleKeepCommand(interaction);
  if (n === 'help') return handleHelpCommand(interaction);
  if (n === 'revoke-downloads') return handleRevokeDownloadsCommand(interaction);
}

async function requireAdmin(interaction) {
  if (!isAdminInteraction(interaction)) {
    await interaction.reply({ content: '❌ Admin only command.', ephemeral: true });
    return false;
  }
  return true;
}

async function handleDownloadCommand(interaction) {
  const user = getUserByDiscordId(interaction.user.id);
  if (!user) return interaction.reply({ content: '❌ You must be linked first.', ephemeral: true });
  if (!takeRateLimit(userGenerationLimits, interaction.user.id, CONFIG.DOWNLOAD_MAX_PER_HOUR, 3600000)) {
    return interaction.reply({ content: '❌ Rate limit reached. Try again later.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const title = interaction.options.getString('title');
  const season = interaction.options.getInteger('season');
  const episode = interaction.options.getInteger('episode');
  const oneTime = interaction.options.getBoolean('one_time') ?? CONFIG.DOWNLOAD_ONE_TIME_LINKS_DEFAULT;

  let filePath; let displayTitle;
  if (season || episode) {
    const series = (await searchSeries(title))[0];
    if (!series) return interaction.editReply('❌ Series not found.');
    const epFile = (await getEpisodeFiles(series.id)).find(f => f.seasonNumber === (season || 1) && f.episodeNumber === (episode || 1));
    if (!epFile) return interaction.editReply('❌ Episode not found.');
    filePath = epFile.path; displayTitle = `${series.title} S${pad(season || 1)}E${pad(episode || 1)}`;
  } else {
    const movie = (await searchMovies(title))[0];
    if (!movie || !movie.movieFile?.path) return interaction.editReply('❌ Movie file not found.');
    filePath = movie.movieFile.path; displayTitle = `${movie.title}${movie.year ? ` (${movie.year})` : ''}`;
  }

  filePath = resolveSafeMediaPath(remapPath(filePath));
  if (!fs.existsSync(filePath)) return interaction.editReply('❌ File missing on server.');

  const { rawToken, expiresAt } = createDownloadToken(filePath, displayTitle, interaction.user.id, oneTime);
  await interaction.editReply(`📥 **${displayTitle}**\n🔗 https://${CONFIG.TUNNEL_DOMAIN}/download/${rawToken}\n⏳ Expires: ${new Date(expiresAt).toUTCString()}\n${oneTime ? '🔒 One-time link enabled.' : ''}`);
}

async function handleLinkCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const target = interaction.options.getUser('user');
  const email = interaction.options.getString('email').toLowerCase().trim();
  storeUserEmail(target.id, email); markUserInvited(target.id);
  audit('user_linked', { actorDiscordId: interaction.user.id, targetDiscordId: target.id, email, source: 'slash_link' });
  await interaction.reply({ content: `✅ Linked ${target.tag} to ${email}`, ephemeral: true });
}

async function handleUnlinkCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const target = interaction.options.getUser('user');
  const record = getUserByDiscordId(target.id);
  if (!record) return interaction.reply({ content: '⚠️ Not in DB.', ephemeral: true });
  removeUser(target.id);
  audit('user_unlinked', { actorDiscordId: interaction.user.id, targetDiscordId: target.id, email: record.email });
  await interaction.reply({ content: `✅ Removed ${target.tag} from DB.`, ephemeral: true });
}

async function handleUsersCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const rows = db.prepare('SELECT * FROM users ORDER BY requested_at ASC').all();
  await interaction.reply({ content: rows.slice(0, 50).map(u => `<@${u.discord_id}> — ${u.email}`).join('\n') || 'No users', ephemeral: true });
}

async function handleStatusCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  await interaction.deferReply({ ephemeral: true });
  const health = await gatherHealth();
  const invitedUsers = db.prepare('SELECT COUNT(*) AS c FROM users WHERE invited = 1').get().c;
  const pendingRequests = db.prepare("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'").get().c;
  const activeLinks = db.prepare('SELECT COUNT(*) AS c FROM download_tokens WHERE revoked = 0 AND expires_at > ?').get(Date.now()).c;

  const integrationKeys = ['discord', 'sqlite', 'plex', 'overseerr', 'radarr', 'radarr4k', 'sonarr', 'raidPath', 'tunnelDomain'];
  const integrationLines = integrationKeys.filter(k => health[k] !== undefined).map(k => `${statusEmoji(health[k])} ${k}: ${health[k]}`);

  // Categorize DB rows: real Discord-linked, plex_-only synthetic, and @plex.local placeholders
  // (collapsed to a count once acknowledged). Also tally fixable issues so admins know to run /sync-fix.
  const allUsers = db.prepare('SELECT discord_id, email FROM users').all().filter(u => u.discord_id !== CONFIG.DISCORD_CLIENT_ID);
  const canonCounts = new Map();
  const dbCanon = new Set();
  let discordLinked = 0; let plexOnly = 0; let placeholderCount = 0; let placeholderAcked = 0;
  for (const u of allUsers) {
    const key = canonicalizeEmail(u.email);
    if (key.startsWith('__placeholder__:')) {
      placeholderCount++;
      if (getSetting(`placeholder_ack:${u.discord_id}`)) placeholderAcked++;
      continue;
    }
    dbCanon.add(key);
    canonCounts.set(key, (canonCounts.get(key) || 0) + 1);
    if (u.discord_id.startsWith('plex_')) plexOnly++; else discordLinked++;
  }
  const placeholderUnacked = placeholderCount - placeholderAcked;
  const duplicateCount = Array.from(canonCounts.values()).filter(n => n > 1).length;
  const fixableLine = (duplicateCount || placeholderUnacked)
    ? `${duplicateCount} duplicate-email · ${placeholderUnacked} placeholder — run /sync-fix`
    : 'none';

  // Reconcile DB vs Overseerr on canonical keys; when they differ, name the unmatched side.
  const overseerrUsers = await fetchOverseerrUsers().catch(() => null);
  let reconcileLine;
  if (overseerrUsers === null) {
    reconcileLine = `DB users: ${allUsers.length} · Overseerr: unavailable`;
  } else {
    const oCanon = new Set(overseerrUsers.map(u => canonicalizeEmail(u.email)).filter(Boolean));
    const oNotInDb = [...oCanon].filter(k => !dbCanon.has(k)).length;
    const dbNotInO = [...dbCanon].filter(k => !oCanon.has(k)).length;
    reconcileLine = `DB users: ${allUsers.length} · Overseerr users: ${overseerrUsers.length}`;
    const notes = [];
    if (oNotInDb) notes.push(`${oNotInDb} Overseerr user${oNotInDb === 1 ? '' : 's'} not in DB`);
    if (dbNotInO) notes.push(`${dbNotInO} DB user${dbNotInO === 1 ? '' : 's'} not in Overseerr`);
    if (notes.length) reconcileLine += `\n${notes.join(' · ')}`;
  }

  const usersSummary = [
    `**Discord-linked:** ${discordLinked} (${invitedUsers} invited)`,
    `**Plex-only:** ${plexOnly}`,
    `**Placeholder:** ${placeholderCount}${placeholderCount ? ` (${placeholderAcked} acknowledged)` : ''}`,
  ].join('\n');

  const embed = brandedEmbed(health.overall === 'ok' ? COLORS.SUCCESS : COLORS.WARN)
    .setTitle('📊 Durant Media Server Status')
    .setDescription(`Overall: **${String(health.overall).toUpperCase()}**`)
    .addFields(
      { name: 'Integrations', value: integrationLines.join('\n') || 'none', inline: false },
      { name: 'Users', value: usersSummary, inline: true },
      { name: 'Pending requests', value: `${pendingRequests}`, inline: true },
      { name: 'Active download links', value: `${activeLinks}`, inline: true },
      { name: 'DB ↔ Overseerr', value: reconcileLine, inline: false },
      { name: 'Fixable sync issues', value: fixableLine, inline: false },
    );
  audit('status_checked', { actorDiscordId: interaction.user.id, overall: health.overall });
  await interaction.editReply({ embeds: [embed] });
}

async function fetchOverseerrUsers() {
  const res = await axios.get(`${CONFIG.OVERSEERR_URL}/api/v1/user?take=200`, { headers: { 'X-Api-Key': CONFIG.OVERSEERR_API_KEY } });
  return res.data.results || [];
}

async function buildSyncPreview() {
  // Exclude the bot's own account from all matching.
  const dbUsers = db.prepare('SELECT * FROM users').all().filter(u => u.discord_id !== CONFIG.DISCORD_CLIENT_ID);
  const guild = client.guilds.cache.get(CONFIG.DISCORD_GUILD_ID) || client.guilds.cache.first();
  const discordMembers = guild ? Array.from((await guild.members.fetch()).values()).filter(m => !m.user.bot) : [];
  const discordIds = new Set(discordMembers.map(m => m.user.id));

  const token = await getPlexToken();
  const friendsData = await plexApiGet('/api/v2/friends', token).catch(() => []);
  const plexFriends = Array.isArray(friendsData) ? friendsData : (friendsData.data || []);
  const plexEmails = new Set(plexFriends.map(f => canonicalizeEmail(f.email)).filter(Boolean));

  const overseerrUsers = await fetchOverseerrUsers().catch(() => []);
  const overseerrEmails = new Set(overseerrUsers.map(u => canonicalizeEmail(u.email)).filter(Boolean));

  const isPlaceholderKey = key => key.startsWith('__placeholder__:');
  const isAcked = discordId => !!getSetting(`placeholder_ack:${discordId}`);

  // Canonical email -> Discord IDs map for the DB, used for matching and duplicate detection.
  const dbCanonSet = new Set(dbUsers.map(u => canonicalizeEmail(u.email)).filter(Boolean));
  const placeholderDiscordIds = new Set(dbUsers.filter(u => isPlaceholderKey(canonicalizeEmail(u.email))).map(u => u.discord_id));

  const discordNotLinkedToPlex = discordMembers.filter(m => !dbUsers.find(u => u.discord_id === m.user.id)).map(m => `${m.user.tag}`);
  const plexNotInDiscord = plexFriends.filter(f => f.email && !dbCanonSet.has(canonicalizeEmail(f.email))).map(f => f.email);
  const overseerrNotLinkedToDiscord = overseerrUsers.filter(u => u.email && !dbCanonSet.has(canonicalizeEmail(u.email))).map(u => u.email);

  // Placeholder accounts (e.g. @plex.local) are valid Plex managed/home users — keep them out of missing/risky.
  const unmatchablePlaceholders = dbUsers
    .filter(u => isPlaceholderKey(canonicalizeEmail(u.email)) && !isAcked(u.discord_id))
    .map(u => ({ discord_id: u.discord_id, email: u.email, invited: u.invited, overseerr_created: u.overseerr_created, requested_at: u.requested_at }));

  const dbMissingFromPlex = dbUsers
    .filter(u => !u.discord_id.startsWith('plex_') && !placeholderDiscordIds.has(u.discord_id) && !plexEmails.has(canonicalizeEmail(u.email)))
    .map(u => `${u.email}`);

  const wouldAdd = plexNotInDiscord.slice();
  const wouldUpdate = dbUsers.filter(u => overseerrEmails.has(canonicalizeEmail(u.email)) && !u.overseerr_created).map(u => u.email);

  const orphanRows = dbUsers.filter(u => !u.discord_id.startsWith('plex_') && !placeholderDiscordIds.has(u.discord_id) && !isAcked(u.discord_id) && !discordIds.has(u.discord_id));
  const risky = orphanRows.map(u => `${u.email} (discord missing)`);
  const orphans = orphanRows.map(u => ({ discord_id: u.discord_id, email: u.email, invited: u.invited, overseerr_created: u.overseerr_created, requested_at: u.requested_at }));

  // Duplicate canonical emails mapped to more than one Discord ID (placeholders excluded — they share a key space).
  const canonToRows = new Map();
  for (const u of dbUsers) {
    const key = canonicalizeEmail(u.email);
    if (isPlaceholderKey(key)) continue;
    if (!canonToRows.has(key)) canonToRows.set(key, []);
    canonToRows.get(key).push(u.discord_id);
  }
  const duplicateEmails = Array.from(canonToRows.entries())
    .filter(([, ids]) => ids.length > 1)
    .map(([canonicalEmail, discordIds]) => ({ canonicalEmail, discordIds }));

  // Suggested links for plex_ friends with no real Discord link (preview only — never auto-linked in apply).
  const suggestedLinks = [];
  for (const f of plexFriends) {
    if (!dbUsers.find(u => u.discord_id === `plex_${f.id}`)) continue;
    const name = String(f.username || f.title || '').toLowerCase().trim();
    if (!name) continue;
    const match = discordMembers.find(m => {
      const uname = String(m.user.username || '').toLowerCase();
      return uname && (uname === name || uname.includes(name) || name.includes(uname));
    });
    if (match) suggestedLinks.push({ plexFriend: f.username || f.title, plexId: f.id, discordTag: match.user.tag, discordId: match.user.id });
  }

  // Multi-email merge candidates: a plex_ synthetic row that is likely the same human as an
  // existing Discord-linked row. Suggestion-only — never auto-applied. Two heuristics:
  //   A) the Plex friend's username/title fuzzy-matches the Discord member's username
  //   B) same email domain and the local parts are token-reorderings (split on . and _)
  // Dismissed pairs are remembered via multiemail_ack:<discordId>:<canonicalPlexEmail>.
  const discordLinkedRows = dbUsers.filter(u => !u.discord_id.startsWith('plex_') && !isPlaceholderKey(canonicalizeEmail(u.email)));
  const memberById = new Map(discordMembers.map(m => [m.user.id, m.user]));
  const tokenKey = email => {
    const [local, domain] = String(email || '').toLowerCase().split('@');
    if (!domain) return null;
    const tokens = local.split('+')[0].split(/[._]+/).filter(Boolean).sort();
    if (!tokens.length) return null;
    return `${tokens.join('.')}@${domain}`;
  };
  const emailMergeCandidates = [];
  const seenMergePairs = new Set();
  for (const p of dbUsers) {
    if (!p.discord_id.startsWith('plex_')) continue;
    const pCanon = canonicalizeEmail(p.email);
    if (isPlaceholderKey(pCanon)) continue;
    const plexId = p.discord_id.slice('plex_'.length);
    const friend = plexFriends.find(f => String(f.id) === plexId);
    const plexName = String(friend?.username || friend?.title || '').toLowerCase().trim();
    const pToken = tokenKey(p.email);
    for (const d of discordLinkedRows) {
      if (canonicalizeEmail(d.email) === pCanon) continue; // same canonical → a duplicate, handled elsewhere
      let reason = null;
      const uname = String(memberById.get(d.discord_id)?.username || '').toLowerCase();
      if (plexName && uname && (uname === plexName || uname.includes(plexName) || plexName.includes(uname))) reason = 'username-match';
      if (!reason) {
        const dToken = tokenKey(d.email);
        if (pToken && dToken && pToken === dToken) reason = 'token-reorder';
      }
      if (!reason) continue;
      if (getSetting(`multiemail_ack:${d.discord_id}:${pCanon}`)) continue;
      const pairKey = `${d.discord_id}|${p.discord_id}`;
      if (seenMergePairs.has(pairKey)) continue;
      seenMergePairs.add(pairKey);
      emailMergeCandidates.push({ keptDiscordId: d.discord_id, discordEmail: d.email, plexDiscordId: p.discord_id, plexEmail: p.email, reason });
    }
  }

  return { discordNotLinkedToPlex, plexNotInDiscord, overseerrNotLinkedToDiscord, dbMissingFromPlex, wouldAdd, wouldRemove: [], wouldUpdate, risky, unmatchablePlaceholders, duplicateEmails, orphans, suggestedLinks, emailMergeCandidates };
}

async function handleSyncCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  await interaction.deferReply({ ephemeral: true });
  const mode = interaction.options.getString('mode', true);
  const preview = await buildSyncPreview();
  audit('sync_preview_run', { actorDiscordId: interaction.user.id, ...preview });
  if (mode === 'preview') {
    return interaction.editReply(formatSyncPreview(preview, 'Preview only; no changes made.'));
  }

  let added = 0; let updated = 0; let repaired = 0;
  const isPlaceholderKey = key => key.startsWith('__placeholder__:');
  const beforeCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;

  // Add Plex friends not already represented in the DB, matching on canonical email exactly as
  // buildSyncPreview does. Raw lowercase comparison previously re-touched gmail dot/plus variants
  // every run, so the same friend churned in and out — canonical keys make the match stick.
  const existingCanon = new Set(
    db.prepare('SELECT * FROM users').all()
      .filter(u => u.discord_id !== CONFIG.DISCORD_CLIENT_ID)
      .map(u => canonicalizeEmail(u.email))
      .filter(Boolean),
  );
  const token = await getPlexToken();
  const friendsData = await plexApiGet('/api/v2/friends', token).catch(() => []);
  const friends = Array.isArray(friendsData) ? friendsData : (friendsData.data || []);
  for (const friend of friends) {
    const email = (friend.email || '').trim().toLowerCase();
    if (!email) continue;
    const key = canonicalizeEmail(friend.email);
    if (!key || existingCanon.has(key)) continue;
    db.prepare('INSERT OR IGNORE INTO users (discord_id, email, invited, requested_at) VALUES (?, ?, 1, ?)').run(`plex_${friend.id}`, email, new Date().toISOString());
    existingCanon.add(key);
    added++;
  }

  // Reconcile Discord-linked rows against Overseerr on canonical keys. A canonical match that we
  // haven't flagged yet is a "repair" (link the existing Overseerr user, no API write); a true
  // absence is an "add" (create the Overseerr user). Skip synthetic plex_ rows, the bot's own
  // account, and placeholder (@plex.local) rows — none of those map to a real Overseerr login.
  const dbUsers = db.prepare('SELECT * FROM users').all();
  const overseerrUsers = await fetchOverseerrUsers().catch(() => []);
  const overseerrByCanon = new Map();
  for (const ou of overseerrUsers) {
    const key = canonicalizeEmail(ou.email);
    if (key && !overseerrByCanon.has(key)) overseerrByCanon.set(key, ou);
  }
  for (const u of dbUsers) {
    if (u.discord_id === CONFIG.DISCORD_CLIENT_ID || u.discord_id.startsWith('plex_')) continue;
    const key = canonicalizeEmail(u.email);
    if (!key || isPlaceholderKey(key)) continue;
    if (overseerrByCanon.has(key)) {
      if (!u.overseerr_created) {
        markOverseerrCreated(u.discord_id, overseerrByCanon.get(key).id ?? null);
        repaired++;
      }
      continue;
    }
    try {
      const du = await client.users.fetch(u.discord_id).catch(() => null);
      const id = await createOverseerrUser(u.email, u.discord_id, du?.username || u.email.split('@')[0]);
      markOverseerrCreated(u.discord_id, id);
      updated++;
    } catch (err) {
      audit('external_api_error', { actorDiscordId: interaction.user.id, provider: 'overseerr', error: err.message, targetDiscordId: u.discord_id });
    }
  }
  const afterCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  audit('sync_changes_applied', { actorDiscordId: interaction.user.id, added, updated, repaired, beforeCount, afterCount });
  await interaction.editReply(`${formatSyncPreview(preview, 'Apply completed.')}\n\nAdded to DB: ${added}\nOverseerr users created: ${updated}\nLinks repaired: ${repaired}`);
}

// Store a long canonical-email key under a short deterministic handle so it fits Discord's 100-char customId limit.
function pendingFixKey(prefix, value) {
  const key = `${prefix}_${sha256(value).slice(0, 8)}`;
  setSetting(`syncfix_pending:${key}`, value);
  return key;
}

async function handleSyncFixCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  await interaction.deferReply({ ephemeral: true });
  const target = interaction.options.getString('target', true);
  // Recompute fresh — never trust stale state.
  const preview = await buildSyncPreview();
  audit('sync_fix_opened', { actorDiscordId: interaction.user.id, target });

  if (target === 'duplicates') {
    if (!preview.duplicateEmails.length) return interaction.editReply('✅ No duplicate-email users to fix.');
    const embeds = []; const components = [];
    for (const dup of preview.duplicateEmails.slice(0, 5)) {
      const key = pendingFixKey('dup', dup.canonicalEmail);
      const rows = dup.discordIds.map(id => getUserByDiscordId(id)).filter(Boolean);
      const embed = brandedEmbed(COLORS.WARN)
        .setTitle('Duplicate email')
        .setDescription(`Canonical: \`${dup.canonicalEmail}\`\n\n` + rows.map(r => `• <@${r.discord_id}> (\`${r.discord_id}\`) — ${r.email} | invited: ${r.invited ? 'yes' : 'no'} | seerr: ${r.overseerr_created ? 'yes' : 'no'} | ${r.requested_at}`).join('\n'));
      const row = new ActionRowBuilder();
      for (const r of rows.slice(0, 5)) {
        row.addComponents(new ButtonBuilder().setCustomId(`syncfix_keepdup:${key}:${r.discord_id}`).setLabel(`Keep ${r.discord_id}`.slice(0, 80)).setStyle(ButtonStyle.Primary));
      }
      embeds.push(embed); components.push(row);
    }
    return interaction.editReply({ content: `Found ${preview.duplicateEmails.length} duplicate-email group(s). Pick which row survives — the others are removed:`, embeds, components });
  }

  if (target === 'placeholders') {
    if (!preview.unmatchablePlaceholders.length) return interaction.editReply('✅ No placeholder accounts to review.');
    const embeds = []; const components = [];
    for (const ph of preview.unmatchablePlaceholders.slice(0, 5)) {
      const embed = brandedEmbed(COLORS.INFO)
        .setTitle('Placeholder account')
        .setDescription(`<@${ph.discord_id}> (\`${ph.discord_id}\`) — ${ph.email}\nInvited: ${ph.invited ? 'yes' : 'no'} | Seerr: ${ph.overseerr_created ? 'yes' : 'no'} | ${ph.requested_at}\n\nUsually a valid Plex managed/home user. Default action is to acknowledge.`);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`syncfix_ackph:${ph.discord_id}`).setLabel('Dismiss (acknowledge)').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`syncfix_rmph:${ph.discord_id}`).setLabel('Remove from DB').setStyle(ButtonStyle.Danger),
      );
      embeds.push(embed); components.push(row);
    }
    return interaction.editReply({ content: `Found ${preview.unmatchablePlaceholders.length} placeholder account(s):`, embeds, components });
  }

  if (target === 'orphans') {
    if (!preview.orphans.length) return interaction.editReply('✅ No orphaned DB users to review.');
    const embeds = []; const components = [];
    for (const o of preview.orphans.slice(0, 5)) {
      const embed = brandedEmbed(COLORS.WARN)
        .setTitle('Orphaned DB user')
        .setDescription(`<@${o.discord_id}> (\`${o.discord_id}\`) is no longer in the guild — ${o.email}\nInvited: ${o.invited ? 'yes' : 'no'} | Seerr: ${o.overseerr_created ? 'yes' : 'no'} | ${o.requested_at}`);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`syncfix_rmorphan:${o.discord_id}`).setLabel('Remove from DB').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`syncfix_rmorphan_revoke:${o.discord_id}`).setLabel('Remove + revoke Plex').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`syncfix_keeporphan:${o.discord_id}`).setLabel('Keep').setStyle(ButtonStyle.Secondary),
      );
      embeds.push(embed); components.push(row);
    }
    return interaction.editReply({ content: `Found ${preview.orphans.length} orphaned DB user(s):`, embeds, components });
  }

  if (target === 'mergeemails') {
    if (!preview.emailMergeCandidates.length) return interaction.editReply('✅ No multi-email merge candidates found.');
    const embeds = []; const components = [];
    for (const c of preview.emailMergeCandidates.slice(0, 5)) {
      const key = pendingFixKey('merge', `${c.keptDiscordId}|${c.plexDiscordId}`);
      const embed = brandedEmbed(COLORS.WARN)
        .setTitle('Possible same person — multiple emails')
        .setDescription(
          `Heuristic: **${c.reason}** (suggestion only)\n\n` +
          `**Discord row:** <@${c.keptDiscordId}> (\`${c.keptDiscordId}\`) — ${c.discordEmail}\n` +
          `**Plex row:** \`${c.plexDiscordId}\` — ${c.plexEmail}\n\n` +
          'Pick the surviving email. The Discord row\'s email is sometimes the wrong one.');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`syncfix_mergekeep:${key}`).setLabel('Merge — keep Discord email').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`syncfix_mergeadopt:${key}`).setLabel('Merge — adopt Plex email').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`syncfix_mergedismiss:${key}`).setLabel('Not the same — dismiss').setStyle(ButtonStyle.Secondary),
      );
      embeds.push(embed); components.push(row);
    }
    return interaction.editReply({ content: `Found ${preview.emailMergeCandidates.length} merge candidate(s). Suggestions only — nothing is applied until you click:`, embeds, components });
  }

  return interaction.editReply('❌ Unknown target.');
}

function syncFixHints(p) {
  const hints = [];
  if (p.duplicateEmails?.length) hints.push(`${p.duplicateEmails.length} duplicate-email user(s) — run /sync-fix duplicates to resolve`);
  if (p.unmatchablePlaceholders?.length) hints.push(`${p.unmatchablePlaceholders.length} placeholder account(s) — run /sync-fix placeholders to review`);
  if (p.risky?.length) hints.push(`${p.risky.length} orphaned DB user(s) — run /sync-fix orphans to review`);
  if (p.emailMergeCandidates?.length) hints.push(`${p.emailMergeCandidates.length} multi-email merge candidate(s) — run /sync-fix mergeemails to review`);
  if (p.suggestedLinks?.length) {
    const pairs = p.suggestedLinks.slice(0, 10).map(s => `  • ${s.plexFriend} → ${s.discordTag} (${s.discordId})`);
    hints.push(`Suggested links (review manually, never auto-applied):\n${pairs.join('\n')}`);
  }
  return hints.length ? `\n\n${hints.join('\n')}` : '';
}

function formatSyncPreview(p, header) {
  return `${header}\n\n` +
    `Discord not linked to Plex: ${p.discordNotLinkedToPlex.length}\n` +
    `Plex users not in Discord links: ${p.plexNotInDiscord.length}\n` +
    `Overseerr users not linked to Discord: ${p.overseerrNotLinkedToDiscord.length}\n` +
    `DB users missing from Plex: ${p.dbMissingFromPlex.length}\n` +
    `Unmatchable placeholders: ${p.unmatchablePlaceholders?.length || 0}\n` +
    `Duplicate-email users: ${p.duplicateEmails?.length || 0}\n` +
    `Email-merge candidates: ${p.emailMergeCandidates?.length || 0}\n` +
    `Suggested links: ${p.suggestedLinks?.length || 0}\n` +
    `Would add: ${p.wouldAdd.length}\nWould remove: ${p.wouldRemove.length}\nWould update: ${p.wouldUpdate.length}\nRisky changes: ${p.risky.length}` +
    syncFixHints(p);
}

async function handleCleanupCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const mode = interaction.options.getString('mode') || 'preview';
  await interaction.deferReply({ ephemeral: true });
  const users = await fetchOverseerrUsers();
  const toDelete = users.filter(u => u.userType !== 1 && ['displayName', 'email', 'username'].some(k => (u[k] || '').toLowerCase().startsWith('deleted_user')));
  audit('cleanup_preview_run', { actorDiscordId: interaction.user.id, count: toDelete.length });
  if (mode === 'preview') return interaction.editReply(`Preview: ${toDelete.length} accounts would be removed.`);
  let removed = 0;
  for (const u of toDelete) {
    try { await axios.delete(`${CONFIG.OVERSEERR_URL}/api/v1/user/${u.id}`, { headers: { 'X-Api-Key': CONFIG.OVERSEERR_API_KEY } }); removed++; } catch (_e) {}
  }
  audit('cleanup_changes_applied', { actorDiscordId: interaction.user.id, removed, failed: toDelete.length - removed });
  await interaction.editReply(`Cleanup complete. Removed ${removed}/${toDelete.length}.`);
}

async function handleAuditCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const sub = interaction.options.getSubcommand();
  let rows = [];
  if (sub === 'recent') {
    const count = interaction.options.getInteger('count') || 25;
    rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(count);
  } else if (sub === 'user') {
    const user = interaction.options.getUser('person', true);
    const count = interaction.options.getInteger('count') || 25;
    rows = db.prepare('SELECT * FROM audit_log WHERE actor_discord_id = ? OR target_discord_id = ? ORDER BY id DESC LIMIT ?').all(user.id, user.id, count);
  } else {
    const action = interaction.options.getString('action', true);
    const count = interaction.options.getInteger('count') || 25;
    rows = db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT ?').all(action, count);
  }
  await interaction.reply({ content: rows.map(r => `#${r.id} ${r.created_at} ${r.action}`).join('\n') || 'No rows', ephemeral: true });
}

async function handleMeCommand(interaction) {
  const row = getUserByDiscordId(interaction.user.id);
  if (!row) return interaction.reply({ content: 'You are not linked yet.', ephemeral: true });
  await interaction.reply({ content: `Linked email: ${row.email}\nInvited: ${row.invited ? 'yes' : 'no'}\nOverseerr linked: ${row.overseerr_created ? 'yes' : 'no'}`, ephemeral: true });
}
async function handleMyRequestsCommand(interaction) {
  const rows = db.prepare('SELECT * FROM requests WHERE requested_by_discord_id = ? ORDER BY id DESC LIMIT 15').all(interaction.user.id);
  await interaction.reply({ content: rows.map(r => `${r.title} — ${r.status}`).join('\n') || 'No requests found.', ephemeral: true });
}
async function handleDownloadsCommand(interaction) {
  const rows = db.prepare('SELECT title, expires_at, one_time_use, created_at, revoked FROM download_tokens WHERE discord_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 20').all(interaction.user.id, Date.now());
  await interaction.reply({ content: rows.map(r => `${r.title} | expires ${new Date(r.expires_at).toUTCString()} | ${r.revoked ? 'revoked' : (r.one_time_use ? 'one-time' : 'multi-use')}`).join('\n') || 'No active links.', ephemeral: true });
}
async function handleKeepCommand(interaction) {
  const rows = db.prepare('SELECT title, media_id, expires_at FROM keep_list WHERE kept_by_discord_id = ? ORDER BY created_at DESC LIMIT 20').all(interaction.user.id);
  await interaction.reply({ content: rows.map(r => `${r.title} (${r.media_id})${r.expires_at ? ` expires ${new Date(r.expires_at).toUTCString()}` : ''}`).join('\n') || 'No keep entries.', ephemeral: true });
}
async function handleHelpCommand(interaction) {
  const userCommands = [
    '`/download` — Get a secure download link for a movie or episode',
    '`/me` — Show your linked profile and access status',
    '`/myrequests` — Show your recent Seerr requests',
    '`/downloads` — Show your active download links',
    '`/keep` — Show your keep list (media saved from cleanup)',
    '`/help` — Show this help message',
  ];
  let content = '**How Durant Media Server works**\n' +
    'DM the bot your Plex account email → an admin approves → you get Plex + Seerr (request) access.\n\n' +
    '**Commands**\n' + userCommands.join('\n');
  if (isAdminInteraction(interaction)) {
    const adminCommands = [
      '`/link` — Link a Discord user to a Plex email',
      '`/unlink` — Remove a user from the DB',
      '`/users` — List linked users',
      '`/status` — Show system health and stats',
      '`/sync` — Preview or apply user sync',
      '`/sync-fix` — Resolve duplicate / placeholder / orphan records',
      '`/cleanup` — Remove deleted Overseerr users',
      '`/audit` — Query the audit log',
      '`/revoke-downloads` — Revoke active download links',
    ];
    content += '\n\n**Admin commands**\n' + adminCommands.join('\n');
  }
  await interaction.reply({ content, ephemeral: true });
}
async function handleRevokeDownloadsCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const scope = interaction.options.getString('scope', true);
  if (scope === 'all') {
    revokeAllDownloadLinks();
    audit('admin_command_executed', { actorDiscordId: interaction.user.id, command: 'revoke-downloads all' });
    return interaction.reply({ content: '✅ Revoked all active download links.', ephemeral: true });
  }
  const user = interaction.options.getUser('user');
  if (!user) return interaction.reply({ content: '❌ user is required for scope:user', ephemeral: true });
  revokeAllDownloadLinks(user.id);
  audit('admin_command_executed', { actorDiscordId: interaction.user.id, command: 'revoke-downloads user', targetDiscordId: user.id });
  return interaction.reply({ content: `✅ Revoked active links for ${user.tag}.`, ephemeral: true });
}

async function handleButton(interaction) {
  const [action, ...parts] = interaction.customId.split(':');
  if (['plex_approve', 'plex_deny', 'overseerr_approve', 'overseerr_deny'].includes(action) && !isAdminInteraction(interaction)) {
    return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
  }

  if (action === 'plex_approve') {
    const targetDiscordId = parts[0];
    await interaction.deferUpdate();
    const user = getUserByDiscordId(targetDiscordId);
    if (!user) return interaction.editReply({ content: 'User not found.', components: [] });
    let plexStatus = 'failed'; let overseerrStatus = 'failed';
    try { const result = await inviteUserToPlex(user.email); markUserInvited(targetDiscordId); plexStatus = `ok (${result.successCount}/${result.total})`; } catch (err) { audit('external_api_error', { provider: 'plex', error: err.message, targetDiscordId }); }
    try { const du = await client.users.fetch(targetDiscordId); const oid = await createOverseerrUser(user.email, targetDiscordId, du.username); markOverseerrCreated(targetDiscordId, oid); overseerrStatus = `ok (${oid})`; } catch (err) { audit('external_api_error', { provider: 'overseerr', error: err.message, targetDiscordId }); }
    audit('admin_command_executed', { actorDiscordId: interaction.user.id, targetDiscordId, command: 'plex_approve' });
    await interaction.editReply({ content: `Approved <@${targetDiscordId}> | Plex: ${plexStatus} | Overseerr: ${overseerrStatus}`, components: [] });
    return;
  }

  if (action === 'plex_deny') {
    const targetDiscordId = parts[0];
    removeUser(targetDiscordId);
    audit('admin_command_executed', { actorDiscordId: interaction.user.id, targetDiscordId, command: 'plex_deny' });
    await interaction.update({ content: `Declined <@${targetDiscordId}>`, components: [] });
    return;
  }

  if (action === 'overseerr_approve') {
    await approveOverseerrRequest(parts[0]);
    audit('request_approved', { actorDiscordId: interaction.user.id, requestId: parts[0] });
    return interaction.update({ content: `✅ Request #${parts[0]} approved.`, components: [] });
  }
  if (action === 'overseerr_deny') {
    await denyOverseerrRequest(parts[0]);
    audit('request_denied', { actorDiscordId: interaction.user.id, requestId: parts[0] });
    return interaction.update({ content: `❌ Request #${parts[0]} denied.`, components: [] });
  }

  if (action === 'syncfix_keepdup') {
    if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const [key, keepDiscordId] = parts;
    const canonicalEmail = getSetting(`syncfix_pending:${key}`);
    if (!canonicalEmail) return interaction.reply({ content: '❌ This action expired. Re-run /sync-fix duplicates.', ephemeral: true });
    // Re-validate against the live DB — the row set may have changed since the embed was posted.
    const dupUsers = db.prepare('SELECT * FROM users').all().filter(u => canonicalizeEmail(u.email) === canonicalEmail);
    const keeper = dupUsers.find(u => u.discord_id === keepDiscordId);
    if (!keeper) return interaction.reply({ content: '❌ Selected row no longer exists. Re-run /sync-fix duplicates.', ephemeral: true });
    if (dupUsers.length <= 1) return interaction.reply({ content: 'ℹ️ Already resolved — only one row remains for this email.', ephemeral: true });
    const removedDiscordIds = [];
    for (const u of dupUsers) {
      if (u.discord_id === keepDiscordId) continue;
      removeUser(u.discord_id);
      removedDiscordIds.push(u.discord_id);
    }
    audit('sync_fix_duplicate_resolved', { actorDiscordId: interaction.user.id, canonicalEmail, keptDiscordId: keepDiscordId, removedDiscordIds });
    return interaction.reply({ content: `✅ Kept <@${keepDiscordId}> for \`${canonicalEmail}\`. Removed ${removedDiscordIds.length} duplicate row(s)${removedDiscordIds.length ? `: ${removedDiscordIds.map(id => `\`${id}\``).join(', ')}` : ''}.`, ephemeral: true });
  }

  if (action === 'syncfix_ackph') {
    if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const discordId = parts[0];
    const user = getUserByDiscordId(discordId);
    if (!user) return interaction.reply({ content: '⚠️ Row no longer exists in DB.', ephemeral: true });
    setSetting(`placeholder_ack:${discordId}`, '1');
    audit('sync_fix_placeholder_acknowledged', { actorDiscordId: interaction.user.id, targetDiscordId: discordId, email: user.email });
    return interaction.reply({ content: `✅ Acknowledged <@${discordId}> (${user.email}). Hidden from future /sync-fix placeholders.`, ephemeral: true });
  }

  if (action === 'syncfix_rmph') {
    if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const discordId = parts[0];
    const user = getUserByDiscordId(discordId);
    if (!user) return interaction.reply({ content: '⚠️ Row no longer exists in DB.', ephemeral: true });
    removeUser(discordId);
    audit('sync_fix_placeholder_removed', { actorDiscordId: interaction.user.id, targetDiscordId: discordId, email: user.email });
    return interaction.reply({ content: `🗑️ Removed placeholder <@${discordId}> (${user.email}) from DB.`, ephemeral: true });
  }

  if (action === 'syncfix_rmorphan') {
    if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const discordId = parts[0];
    const user = getUserByDiscordId(discordId);
    if (!user) return interaction.reply({ content: '⚠️ Row no longer exists in DB.', ephemeral: true });
    removeUser(discordId);
    audit('sync_fix_orphan_removed', { actorDiscordId: interaction.user.id, targetDiscordId: discordId, email: user.email });
    return interaction.reply({ content: `🗑️ Removed orphaned user <@${discordId}> (${user.email}) from DB.`, ephemeral: true });
  }

  if (action === 'syncfix_rmorphan_revoke') {
    if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const discordId = parts[0];
    const user = getUserByDiscordId(discordId);
    if (!user) return interaction.reply({ content: '⚠️ Row no longer exists in DB.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    let removed = false;
    try { const r = await removePlexAccess(user.email); removed = r.removed; }
    catch (err) { audit('external_api_error', { provider: 'plex', error: err.message, targetDiscordId: discordId }); }
    removeUser(discordId);
    audit('sync_fix_orphan_removed', { actorDiscordId: interaction.user.id, targetDiscordId: discordId, email: user.email, plexRevoked: removed });
    return interaction.editReply({ content: `🗑️ Removed <@${discordId}> (${user.email}) from DB and revoked Plex: ${removed ? 'yes' : 'no'}.` });
  }

  if (action === 'syncfix_keeporphan') {
    if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const discordId = parts[0];
    const user = getUserByDiscordId(discordId);
    audit('sync_fix_orphan_kept', { actorDiscordId: interaction.user.id, targetDiscordId: discordId, email: user?.email });
    return interaction.reply({ content: `✅ Keeping <@${discordId}>${user ? ` (${user.email})` : ''} in DB.`, ephemeral: true });
  }

  if (action === 'revoke_plex') {
    if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const discordId = parts[0];
    const user = getUserByDiscordId(discordId);
    if (!user) return interaction.update({ content: 'ℹ️ User already removed from DB.', components: [] });
    await interaction.deferUpdate();
    let removed = false;
    try { const r = await removePlexAccess(user.email); removed = r.removed; }
    catch (err) { audit('external_api_error', { provider: 'plex', error: err.message, targetDiscordId: discordId }); }
    removeUser(discordId);
    audit('user_unlinked', { actorDiscordId: interaction.user.id, targetDiscordId: discordId, email: user.email, removed, source: 'revoke_plex_button' });
    return interaction.editReply({ content: `🗑️ Revoked Plex for <@${discordId}> (${user.email}) and removed from DB. Removed: ${removed ? 'yes' : 'no'}.`, components: [] });
  }

  if (['syncfix_mergekeep', 'syncfix_mergeadopt', 'syncfix_mergedismiss'].includes(action)) {
    if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const stored = getSetting(`syncfix_pending:${parts[0]}`);
    if (!stored) return interaction.reply({ content: '❌ This action expired. Re-run /sync-fix mergeemails.', ephemeral: true });
    const [keptDiscordId, plexDiscordId] = stored.split('|');
    // Re-validate against the live DB — rows may have changed since the embed was posted.
    const discordRow = getUserByDiscordId(keptDiscordId);
    const plexRow = getUserByDiscordId(plexDiscordId);

    if (action === 'syncfix_mergedismiss') {
      if (plexRow) setSetting(`multiemail_ack:${keptDiscordId}:${canonicalizeEmail(plexRow.email)}`, '1');
      audit('sync_fix_email_merge_dismissed', { actorDiscordId: interaction.user.id, keptDiscordId, plexDiscordId });
      return interaction.reply({ content: `✅ Dismissed — won't suggest merging <@${keptDiscordId}> with \`${plexDiscordId}\` again.`, ephemeral: true });
    }

    if (!discordRow) return interaction.reply({ content: '❌ Discord row no longer exists. Re-run /sync-fix mergeemails.', ephemeral: true });
    if (!plexRow) return interaction.reply({ content: '❌ Plex row no longer exists. Re-run /sync-fix mergeemails.', ephemeral: true });

    const mergedEmails = [discordRow.email, plexRow.email];
    let adoptedEmail = null;
    let finalEmail = discordRow.email;
    if (action === 'syncfix_mergeadopt') {
      adoptedEmail = plexRow.email;
      finalEmail = plexRow.email;
      db.prepare('UPDATE users SET email = ? WHERE discord_id = ?').run(plexRow.email, keptDiscordId);
    }
    removeUser(plexDiscordId);
    audit('sync_fix_email_merged', { actorDiscordId: interaction.user.id, keptDiscordId, mergedEmails, adoptedEmail, finalEmail });
    return interaction.reply({ content: `✅ Merged onto <@${keptDiscordId}> with \`${finalEmail}\`${adoptedEmail ? ' (adopted Plex email)' : ''}. Removed plex row \`${plexDiscordId}\`.`, ephemeral: true });
  }

  if (action === 'delete_yes') {
    const [mediaId, encodedTitle, requestorId] = parts;
    const title = decodeURIComponent(encodedTitle);
    if (interaction.user.id !== requestorId && !isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Not allowed.', ephemeral: true });
    if (!CONFIG.ENABLE_DELETION) return interaction.reply({ content: '⚠️ Deletion is disabled by config.', ephemeral: true });
    if (CONFIG.NEVER_DELETE_MEDIA_IDS.includes(mediaId)) return interaction.reply({ content: '⚠️ This media is in never-delete override list.', ephemeral: true });
    if (isInKeepList(mediaId)) return interaction.reply({ content: '⚠️ This media is in the keep list — not deleting.', ephemeral: true });
    audit('keep_delete_decision_made', { actorDiscordId: interaction.user.id, requestorId, mediaId, decision: 'delete_now' });
    await interaction.deferUpdate();

    let resolved;
    try {
      resolved = await resolveDeletableMedia(mediaId);
    } catch (err) {
      audit('external_api_error', { provider: 'arr', error: err.message, mediaId, action: 'delete_resolve' });
      return interaction.editReply({ content: `❌ Could not resolve **${title}** for deletion: ${err.message}`, components: [] });
    }
    if (!resolved.found) {
      audit('deletion_dry_run', { actorDiscordId: interaction.user.id, requestorId, mediaId, title, result: 'not_found' });
      return interaction.editReply({ content: `⚠️ Could not find **${title}** in Radarr/Sonarr — nothing to delete.`, components: [] });
    }

    if (CONFIG.DELETION_DRY_RUN) {
      audit('deletion_dry_run', { actorDiscordId: interaction.user.id, requestorId, mediaId, title, kind: resolved.kind, paths: resolved.paths, apiCall: resolved.apiCall });
      const fileList = resolved.paths.length ? resolved.paths.slice(0, 5).map(p => `• \`${p}\``).join('\n') : '• (no files on disk)';
      return interaction.editReply({ content: `🧪 **Dry-run** — would delete **${title}** (${resolved.kind}, ${resolved.paths.length} file(s)).\n${fileList}\nWould call: \`${resolved.apiCall}\`\n\nSet \`DELETION_DRY_RUN=false\` to perform real deletes.`, components: [] });
    }

    try {
      let detail;
      if (resolved.kind === 'movie') {
        await axios.delete(`${resolved.source.url}/api/v3/movie/${resolved.movie.id}`, { params: { apikey: resolved.source.key, deleteFiles: true } });
        detail = `Radarr movie #${resolved.movie.id} deleted with files.`;
      } else {
        let n = 0;
        for (const f of resolved.files) {
          await axios.delete(`${CONFIG.SONARR_URL}/api/v3/episodefile/${f.id}`, { params: { apikey: CONFIG.SONARR_API_KEY } });
          n++;
        }
        detail = `Sonarr episode files deleted: ${n}/${resolved.files.length}.`;
      }
      audit('media_deleted', { actorDiscordId: interaction.user.id, requestorId, mediaId, title, kind: resolved.kind, paths: resolved.paths, apiCall: resolved.apiCall });
      return interaction.editReply({ content: `🗑️ Deleted **${title}**. ${detail}`, components: [] });
    } catch (err) {
      audit('external_api_error', { provider: 'arr', error: err.message, mediaId, action: 'delete' });
      return interaction.editReply({ content: `❌ Delete failed for **${title}**: ${err.message}`, components: [] });
    }
  }

  if (action === 'delete_no') {
    const [mediaId, encodedTitle, requestorId] = parts;
    const title = decodeURIComponent(encodedTitle);
    if (interaction.user.id !== requestorId && !isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Not allowed.', ephemeral: true });
    addToKeepList(mediaId, mediaId.startsWith('tvdb:') ? 'tv' : 'movie', title, requestorId);
    audit('keep_delete_decision_made', { actorDiscordId: interaction.user.id, requestorId, mediaId, decision: 'keep' });
    await interaction.update({ content: `📌 Keeping **${title}**.`, components: [] });
    return;
  }

  if (action === 'delete_later') {
    const [mediaId, _encodedTitle, requestorId] = parts;
    if (interaction.user.id !== requestorId && !isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Not allowed.', ephemeral: true });
    const nextPromptAt = Date.now() + CONFIG.DELETION_REMINDER_COOLDOWN_HOURS * 3600 * 1000;
    setSetting(`delete_prompt_snooze:${mediaId}:${requestorId}`, String(nextPromptAt));
    audit('keep_delete_decision_made', { actorDiscordId: interaction.user.id, requestorId, mediaId, decision: 'remind_later' });
    await interaction.update({ content: `⏰ Reminder set for later.`, components: [] });
  }
}

async function gatherHealth() {
  const checks = { overall: 'ok', timestamp: new Date().toISOString() };
  checks.discord = client.isReady() ? 'ok' : 'down';
  try { db.prepare('SELECT 1').get(); checks.sqlite = 'ok'; } catch (_e) { checks.sqlite = 'down'; }
  checks.raidPath = fs.existsSync(CONFIG.RAID_PATH) ? 'ok' : 'down';
  checks.tunnelDomain = CONFIG.TUNNEL_DOMAIN ? 'configured' : 'missing';

  async function apiCheck(name, fn) {
    try {
      const out = await fn();
      checks[name] = out === 'skipped' ? 'skipped' : 'ok';
    } catch (e) {
      checks[name] = 'down';
      audit('external_api_error', { provider: name, error: e.message });
    }
  }
  await Promise.all([
    apiCheck('plex', async () => { const t = await getPlexToken(); await plexApiGet('/api/v2/friends', t); }),
    apiCheck('overseerr', async () => { await axios.get(`${CONFIG.OVERSEERR_URL}/api/v1/status`, { headers: { 'X-Api-Key': CONFIG.OVERSEERR_API_KEY }, timeout: 5000 }); }),
    apiCheck('radarr', async () => { if (!CONFIG.RADARR_URL) return 'skipped'; await axios.get(`${CONFIG.RADARR_URL}/api/v3/system/status`, { params: { apikey: CONFIG.RADARR_API_KEY }, timeout: 5000 }); }),
    apiCheck('radarr4k', async () => { if (!CONFIG.RADARR_4K_URL) return 'skipped'; await axios.get(`${CONFIG.RADARR_4K_URL}/api/v3/system/status`, { params: { apikey: CONFIG.RADARR_4K_API_KEY }, timeout: 5000 }); }),
    apiCheck('sonarr', async () => { if (!CONFIG.SONARR_URL) return 'skipped'; await axios.get(`${CONFIG.SONARR_URL}/api/v3/system/status`, { params: { apikey: CONFIG.SONARR_API_KEY }, timeout: 5000 }); }),
  ]);

  const failed = Object.entries(checks).filter(([k, v]) => !['overall', 'timestamp', 'tunnelDomain'].includes(k) && !['ok','configured','skipped'].includes(v));
  checks.overall = failed.length ? 'degraded' : 'ok';
  return checks;
}

function dashboardAuth(req, res, next) {
  // Primary path for humans: a valid signed session cookie set at /admin/login.
  // Header auth stays for scripts/automation (e.g. scripts/smoke-test.sh).
  // The old ?password= URL path is gone — it leaked credentials into history and logs.
  const sessionOk = verifySession(readCookie(req, 'dm_session'));
  const pwd = req.headers['x-admin-password'];
  const token = req.headers['x-admin-token'];
  const passOk = CONFIG.DASHBOARD_ADMIN_PASSWORD && pwd === CONFIG.DASHBOARD_ADMIN_PASSWORD;
  const tokenOk = CONFIG.DASHBOARD_ADMIN_TOKEN && token === CONFIG.DASHBOARD_ADMIN_TOKEN;
  if (!sessionOk && !passOk && !tokenOk) {
    // Browsers hitting a page get sent to the login form; API/non-GET callers get 401.
    if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
      return res.redirect('/admin/login');
    }
    return res.status(401).send('Unauthorized');
  }

  if (CONFIG.STRICT_DASHBOARD_POST_AUTH && req.method !== 'GET') {
    const origin = req.get('origin');
    const referer = req.get('referer');
    if ((origin && !origin.includes(req.get('host'))) || (referer && !referer.includes(req.get('host')))) {
      return res.status(403).send('Cross-site POST denied');
    }
  }
  return next();
}

function startExpressServer() {
  const app = express();
  const upload = multer({ limits: { fileSize: 5 * 1024 * 1024, files: 5 } });
  app.use((req, res, next) => { if (req.is('multipart/form-data')) return next(); bodyParser.json({ limit: '1mb' })(req, res, next); });

  app.get('/health', async (_req, res) => res.json(await gatherHealth()));

  app.post('/webhook/overseerr', upload.any(), async (req, res) => {
    if (CONFIG.WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== CONFIG.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    res.sendStatus(200);
    try {
      let body = req.body;
      if (typeof body.payload === 'string') body = JSON.parse(body.payload);
      audit('webhook_received', { source: 'overseerr', type: body.notification_type });
      await handleOverseerrWebhook(body);
    } catch (err) { audit('external_api_error', { provider: 'overseerr_webhook', error: err.message }); }
  });

  app.post('/webhook/plex', upload.any(), async (req, res) => {
    if (CONFIG.WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== CONFIG.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    res.sendStatus(200);
    try {
      const payload = JSON.parse(req.body.payload || '{}');
      audit('webhook_received', { source: 'plex', event: payload.event });
      await handlePlexWebhook(payload);
    } catch (err) { audit('external_api_error', { provider: 'plex_webhook', error: err.message }); }
  });

  app.post('/webhook/tautulli', async (req, res) => {
    if (CONFIG.TAUTULLI_WEBHOOK_SECRET && req.headers['x-tautulli-secret'] !== CONFIG.TAUTULLI_WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    res.sendStatus(200);
    try {
      audit('webhook_received', { source: 'tautulli', event: req.body?.event });
      await handleTautulliWebhook(req.body || {});
    } catch (err) {
      audit('external_api_error', { provider: 'tautulli_webhook', error: err.message });
    }
  });

  app.get('/download/:token', async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    if (!takeRateLimit(routeLimits, ip, CONFIG.DOWNLOAD_ROUTE_MAX_PER_MINUTE, 60000)) {
      return res.status(429).send('Too many requests.');
    }
    cleanExpiredTokens();
    const record = getDownloadRecordByRawToken(req.params.token);
    if (!record || record.revoked) {
      db.prepare('INSERT INTO download_access_log (token_hash, ip, user_agent, status) VALUES (?, ?, ?, ?)').run(sha256(req.params.token), ip, req.get('user-agent') || '', 'not_found_or_revoked');
      return res.status(404).send('Link not found or revoked.');
    }
    if (Date.now() > record.expires_at) return res.status(410).send('This download link has expired.');
    if (record.one_time_use && record.used_at) return res.status(410).send('This one-time link has already been used.');

    const candidatePath = path.resolve(record.file_path);
    if (!fs.existsSync(candidatePath)) return res.status(404).send('File not found on server.');

    let filePath;
    try {
      filePath = resolveSafeMediaPath(candidatePath);
    } catch (_e) {
      db.prepare('INSERT INTO download_access_log (token_hash, discord_id, ip, user_agent, file_path, status) VALUES (?, ?, ?, ?, ?, ?)').run(record.token_hash, record.discord_id, ip, req.get('user-agent') || '', record.file_path, 'invalid_path');
      return res.status(403).send('Invalid file path.');
    }

    const stat = fs.statSync(filePath);
    if (stat.size >= CONFIG.DOWNLOAD_LARGE_FILE_GB * 1024 * 1024 * 1024) {
      notifyAdmin(`📥 Large download started by <@${record.discord_id}>: ${record.title} (${(stat.size / (1024 ** 3)).toFixed(2)} GB)`);
    }

    if (record.one_time_use) {
      db.prepare('UPDATE download_tokens SET used_at = ? WHERE token_hash = ?').run(Date.now(), record.token_hash);
    }

    const fileSize = stat.size;
    const fileName = path.basename(filePath);
    const mimeType = mimeFor(path.extname(filePath).toLowerCase());

    res.on('finish', () => {
      db.prepare('INSERT INTO download_access_log (token_hash, discord_id, ip, user_agent, file_path, status, bytes_sent) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(record.token_hash, record.discord_id, ip, req.get('user-agent') || '', filePath, `http_${res.statusCode}`, Number(res.getHeader('Content-Length')) || 0);
      audit('download_completed_or_failed', { targetDiscordId: record.discord_id, title: record.title, status: res.statusCode });
    });

    const range = req.headers.range;
    db.prepare('INSERT INTO download_access_log (token_hash, discord_id, ip, user_agent, file_path, status) VALUES (?, ?, ?, ?, ?, ?)').run(record.token_hash, record.discord_id, ip, req.get('user-agent') || '', filePath, 'download_started');
    audit('download_started', { targetDiscordId: record.discord_id, title: record.title });

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = Number.parseInt(startStr, 10);
      const end = endStr ? Number.parseInt(endStr, 10) : fileSize - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `attachment; filename="${fileName}"`,
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });

  if (CONFIG.DASHBOARD_ENABLED) {
    const loginLimits = new Map();
    const adminForm = express.urlencoded({ extended: false, limit: '16kb' });

    app.get('/admin/login', (req, res) => {
      if (verifySession(readCookie(req, 'dm_session'))) return res.redirect('/admin');
      res.type('html').send(renderLogin(!!req.query.error));
    });

    app.post('/admin/login', adminForm, (req, res) => {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
      if (!takeRateLimit(loginLimits, ip, 5, 15 * 60000)) {
        return res.status(429).type('html').send(renderLogin(false, 'Too many attempts. Try again in a few minutes.'));
      }
      const pwd = req.body?.password || '';
      const passOk = CONFIG.DASHBOARD_ADMIN_PASSWORD && pwd === CONFIG.DASHBOARD_ADMIN_PASSWORD;
      const tokenOk = CONFIG.DASHBOARD_ADMIN_TOKEN && pwd === CONFIG.DASHBOARD_ADMIN_TOKEN;
      if (!passOk && !tokenOk) {
        audit('dashboard_login_failed', { ip });
        return res.redirect('/admin/login?error=1');
      }
      const ttlMs = CONFIG.SESSION_TTL_HOURS * 3600000;
      const secure = req.secure || (req.headers['x-forwarded-proto'] || '').includes('https');
      res.setHeader('Set-Cookie', `dm_session=${signSession(ttlMs)}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${Math.floor(ttlMs / 1000)}${secure ? '; Secure' : ''}`);
      audit('dashboard_login_success', { ip });
      res.redirect('/admin');
    });

    app.post('/admin/logout', (req, res) => {
      res.setHeader('Set-Cookie', 'dm_session=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0');
      res.redirect('/admin/login');
    });

    app.get('/admin', dashboardAuth, async (_req, res) => {
      const pendingPlex = db.prepare('SELECT * FROM users WHERE invited = 0 ORDER BY requested_at DESC LIMIT 25').all();
      const pendingRequests = db.prepare('SELECT * FROM requests WHERE status = ? ORDER BY id DESC LIMIT 25').all('pending');
      const linkedUsers = db.prepare('SELECT discord_id, email, invited, requested_at FROM users ORDER BY requested_at DESC LIMIT 100').all();
      const recentDownloads = db.prepare('SELECT * FROM download_access_log ORDER BY id DESC LIMIT 25').all();
      const keepDecisions = db.prepare("SELECT * FROM audit_log WHERE action = 'keep_delete_decision_made' ORDER BY id DESC LIMIT 25").all();
      const auditRows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 50').all();
      const linkedTotal = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
      const activeLinks = db.prepare('SELECT COUNT(*) AS c FROM download_tokens WHERE revoked = 0 AND expires_at > ?').get(Date.now()).c;
      const health = await gatherHealth();

      const stats = [
        renderStat('Pending Plex users', pendingPlex.length),
        renderStat('Pending requests', pendingRequests.length),
        renderStat('Linked users', linkedTotal),
        renderStat('Active download links', activeLinks),
      ].join('');

      const body = `
        <div class="overall ${health.overall === 'ok' ? 'ok' : 'warn'}">Overall status: <strong>${escapeHtml(String(health.overall).toUpperCase())}</strong></div>
        <div class="stats">${stats}</div>
        <div class="card">
          <h2>Integrations</h2>
          <div class="badges">${renderHealthBadges(health)}</div>
        </div>
        <div class="card">
          <h2>Manual Actions</h2>
          <div class="actions">
            <a class="btn" href="/admin/health">Health JSON</a>
            <a class="btn" href="/admin/action/sync-preview">Run Sync Preview</a>
            <a class="btn" href="/admin/action/cleanup-preview">Run Cleanup Preview</a>
            <button class="btn danger" type="button" onclick="revokeAll()">Revoke All Download Links</button>
          </div>
        </div>
        ${renderSection('Pending Plex Users', pendingPlex)}
        ${renderSection('Pending Media Requests', pendingRequests)}
        ${renderSection('Linked Users', linkedUsers)}
        ${renderSection('Recent Downloads', recentDownloads)}
        ${renderSection('Keep/Delete Decisions', keepDecisions)}
        ${renderSection('Recent Audit Logs', auditRows)}
        <script>
          async function revokeAll() {
            if (!confirm('Revoke ALL active download links? This cannot be undone.')) return;
            const r = await fetch('/admin/action/revoke-all', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
            alert(r.ok ? 'All active download links revoked.' : 'Failed: ' + r.status);
            if (r.ok) location.reload();
          }
        </script>`;
      res.type('html').send(renderPage('Admin Dashboard', body, true));
    });

    app.get('/admin/health', dashboardAuth, async (_req, res) => res.json(await gatherHealth()));
    app.get('/admin/action/sync-preview', dashboardAuth, async (_req, res) => res.json(await buildSyncPreview()));
    app.get('/admin/action/cleanup-preview', dashboardAuth, async (_req, res) => {
      const users = await fetchOverseerrUsers().catch(() => []);
      const toDelete = users.filter(u => u.userType !== 1 && ['displayName', 'email', 'username'].some(k => (u[k] || '').toLowerCase().startsWith('deleted_user')));
      res.json({ wouldRemove: toDelete.length, users: toDelete.map(u => ({ id: u.id, email: u.email, username: u.username })) });
    });
    app.post('/admin/action/revoke-all', dashboardAuth, (_req, res) => { revokeAllDownloadLinks(); res.json({ ok: true }); });
    app.post('/admin/action/revoke-user/:discordId', dashboardAuth, (req, res) => { revokeAllDownloadLinks(req.params.discordId); res.json({ ok: true, discordId: req.params.discordId }); });
  }

  app.get('/', (_req, res) => res.send('Durant Media Server Bot is running.'));

  app.use((err, req, res, next) => {
    if (err && err.name === 'MulterError') {
      log.warn(`Multer error on ${req.path}: ${err.message}`);
      return res.sendStatus(200);
    }
    next(err);
  });

  app.listen(CONFIG.PORT, () => log.ok(`Express server listening on port ${CONFIG.PORT}`));
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

// ---- Dashboard rendering (dark Plex/Overseerr-style theme, all inline, no build step) ----

const DASHBOARD_CSS = `
  :root { --bg:#1b1b1d; --panel:#26282c; --panel2:#2e3035; --accent:#e5a00d; --text:#e8e8ea; --muted:#9aa0a6; --border:#3a3d42; --ok:#22c55e; --warn:#f59e0b; --down:#ef4444; --skip:#6b7280; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--text); }
  .topbar { position:sticky; top:0; z-index:10; display:flex; align-items:center; justify-content:space-between; padding:14px 20px; background:#141416; border-bottom:1px solid var(--border); }
  .topbar h1 { margin:0; font-size:18px; }
  .topbar .brand { color:var(--accent); }
  .container { max-width:1100px; margin:0 auto; padding:20px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:16px 18px; margin-bottom:18px; }
  .card h2 { margin:0 0 12px; font-size:15px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  .overall { padding:12px 16px; border-radius:10px; margin-bottom:18px; font-size:15px; }
  .overall.ok { background:rgba(34,197,94,.12); border:1px solid var(--ok); }
  .overall.warn { background:rgba(245,158,11,.12); border:1px solid var(--warn); }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:18px; }
  .stat { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px 16px; }
  .stat .n { font-size:26px; font-weight:700; color:var(--accent); }
  .stat .l { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  .badges { display:flex; flex-wrap:wrap; gap:8px; }
  .badge { display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border-radius:999px; font-size:13px; background:var(--panel2); border:1px solid var(--border); }
  .dot { width:9px; height:9px; border-radius:50%; }
  .dot.ok { background:var(--ok); } .dot.warn { background:var(--warn); } .dot.down { background:var(--down); } .dot.skip { background:var(--skip); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border); white-space:nowrap; max-width:340px; overflow:hidden; text-overflow:ellipsis; }
  th { color:var(--muted); font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:.04em; }
  tbody tr:nth-child(odd) { background:rgba(255,255,255,.02); }
  .table-wrap { overflow-x:auto; }
  .muted { color:var(--muted); font-style:italic; }
  .actions { display:flex; flex-wrap:wrap; gap:10px; }
  .btn { display:inline-block; padding:9px 14px; border-radius:8px; background:var(--panel2); color:var(--text); border:1px solid var(--border); text-decoration:none; font-size:13px; cursor:pointer; }
  .btn:hover { border-color:var(--accent); }
  .btn.danger { border-color:var(--down); color:#fca5a5; }
  .btn.primary { background:var(--accent); color:#1b1b1d; border-color:var(--accent); font-weight:600; }
  form.logout { margin:0; }
  .login-wrap { min-height:100vh; display:flex; align-items:center; justify-content:center; }
  .login-card { width:100%; max-width:360px; background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:28px; }
  .login-card h1 { margin:0 0 4px; font-size:20px; }
  .login-card h1 .brand { color:var(--accent); }
  .login-card p { margin:0 0 20px; color:var(--muted); font-size:13px; }
  .login-card label { display:block; font-size:12px; color:var(--muted); margin-bottom:6px; }
  .login-card input { width:100%; padding:11px 12px; border-radius:8px; border:1px solid var(--border); background:#1b1b1d; color:var(--text); font-size:14px; margin-bottom:16px; }
  .login-card .btn.primary { width:100%; text-align:center; }
  .error { background:rgba(239,68,68,.12); border:1px solid var(--down); color:#fca5a5; padding:10px 12px; border-radius:8px; font-size:13px; margin-bottom:16px; }
`;

function renderPage(title, bodyHtml, showLogout = false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Durant Media Server</title>
  <style>${DASHBOARD_CSS}</style></head><body>
  <div class="topbar">
    <h1><span class="brand">Durant</span> Media Server — ${escapeHtml(title)}</h1>
    ${showLogout ? '<form class="logout" method="post" action="/admin/logout"><button class="btn" type="submit">Log out</button></form>' : ''}
  </div>
  <div class="container">${bodyHtml}</div>
  </body></html>`;
}

function renderLogin(isError, message) {
  const banner = message ? `<div class="error">${escapeHtml(message)}</div>`
    : (isError ? '<div class="error">Incorrect password. Please try again.</div>' : '');
  const body = `<div class="login-wrap"><div class="login-card">
    <h1><span class="brand">Durant</span> Media Server</h1>
    <p>Admin dashboard login</p>
    ${banner}
    <form method="post" action="/admin/login">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autofocus autocomplete="current-password" required>
      <button class="btn primary" type="submit">Log in</button>
    </form>
  </div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login — Durant Media Server</title><style>${DASHBOARD_CSS}</style></head>
  <body>${body}</body></html>`;
}

function renderStat(label, value) {
  return `<div class="stat"><div class="n">${escapeHtml(String(value))}</div><div class="l">${escapeHtml(label)}</div></div>`;
}

function healthClass(v) {
  if (['ok', 'configured'].includes(v)) return 'ok';
  if (v === 'skipped') return 'skip';
  if (v === 'down' || v === 'missing') return 'down';
  return 'warn';
}

function renderHealthBadges(health) {
  const keys = ['discord', 'sqlite', 'plex', 'overseerr', 'radarr', 'radarr4k', 'sonarr', 'raidPath', 'tunnelDomain'];
  return keys.filter(k => health[k] !== undefined)
    .map(k => `<span class="badge"><span class="dot ${healthClass(health[k])}"></span>${escapeHtml(k)}: ${escapeHtml(String(health[k]))}</span>`)
    .join('');
}

function renderTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '<p class="muted">No records.</p>';
  const cols = Object.keys(rows[0]);
  const head = cols.map(c => `<th>${escapeHtml(c)}</th>`).join('');
  const bodyRows = rows.map(r => `<tr>${cols.map(c => {
    const v = r[c];
    return `<td title="${escapeHtml(v == null ? '' : String(v))}">${escapeHtml(v == null ? '' : String(v))}</td>`;
  }).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
}

function renderSection(title, rows) {
  return `<div class="card"><h2>${escapeHtml(title)}</h2>${renderTable(rows)}</div>`;
}

async function handleOverseerrWebhook(body) {
  const { notification_type, subject, media, request } = body;
  if (!notification_type || !media) return;
  const titleMatch = subject?.match(/^.+? - (.+)$/);
  const title = titleMatch ? titleMatch[1] : (subject || 'Unknown Title');
  const is4k = !!media.is4k;
  const mediaId = media.media_type === 'tv' ? `tvdb:${media.tvdbId}` : `tmdb:${media.tmdbId}`;
  const requesterEmail = request?.requestedBy_email;
  const dbUser = requesterEmail ? getUserByEmail(requesterEmail) : null;
  const requesterDiscordId = request?.requestedBy_settings_discordId || dbUser?.discord_id || null;

  if (notification_type === 'MEDIA_PENDING') {
    const adminChannel = await safeGetChannel(CONFIG.ADMIN_CHANNEL_ID);
    if (adminChannel) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`overseerr_approve:${request.request_id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`overseerr_deny:${request.request_id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
      );
      await adminChannel.send({ embeds: [brandedEmbed(COLORS.INFO).setTitle(`${mediaTypeEmoji(media.media_type, is4k)} New Request`).setDescription(`**${title}**`).addFields({ name: 'Requested By', value: requesterDiscordId ? `<@${requesterDiscordId}>` : (requesterEmail || 'Unknown'), inline: true }, { name: 'Quality', value: is4k ? '4K' : 'HD', inline: true })], components: [row] });
    }
    audit('seerr_request_received', { requestId: request?.request_id, requesterDiscordId, title, mediaId });
  }

  if (['MEDIA_PENDING', 'MEDIA_APPROVED', 'MEDIA_AVAILABLE'].includes(notification_type)) {
    const status = notification_type === 'MEDIA_APPROVED' ? 'approved' : notification_type === 'MEDIA_AVAILABLE' ? 'available' : 'pending';
    upsertRequest(String(request?.request_id || ''), mediaId, media.media_type, is4k, title, requesterDiscordId, status);
  }

  if (notification_type === 'MEDIA_AVAILABLE' && requesterDiscordId) {
    try {
      const user = await client.users.fetch(requesterDiscordId);
      await user.send({ embeds: [brandedEmbed(COLORS.SUCCESS)
        .setTitle('✅ Now Available on Plex')
        .setDescription(`**${title}** is ready to watch — enjoy! 🍿\n\nWant something else? Use \`/download\` or request more anytime.`)] });
      audit('media_available_notification_sent', { targetDiscordId: requesterDiscordId, title });
    } catch (_e) {}
  }
}

async function handlePlexWebhook(payload) {
  const { event, Account, Metadata } = payload;
  if (event !== 'media.scrobble' || !Account || !Metadata) return;
  const mediaType = Metadata.type;
  const title = mediaType === 'episode' ? (Metadata.grandparentTitle || Metadata.title) : Metadata.title;
  const videoStream = Metadata.Media?.[0]?.Part?.[0]?.Stream?.find(s => s.streamType === 1);
  const resolution = (videoStream?.displayTitle || '').toLowerCase();
  const is4k = resolution.includes('4k') || resolution.includes('2160');
  if (mediaType === 'movie' && !is4k) return;

  const guids = Metadata.Guid || [];
  const mediaId = mediaType === 'movie' ? `tmdb:${(guids.find(g => g.id?.startsWith('tmdb://'))?.id || '').replace('tmdb://', '')}` : `tvdb:${(guids.find(g => g.id?.startsWith('tvdb://'))?.id || '').replace('tvdb://', '')}`;
  if (!mediaId || mediaId.endsWith(':')) return;
  if (isInKeepList(mediaId) || CONFIG.NEVER_DELETE_MEDIA_IDS.includes(mediaId)) return;

  const reqRow = db.prepare('SELECT * FROM requests WHERE media_id = ? ORDER BY created_at DESC LIMIT 1').get(mediaId);
  if (!reqRow?.requested_by_discord_id) return;
  const snoozeUntil = Number(getSetting(`delete_prompt_snooze:${mediaId}:${reqRow.requested_by_discord_id}`) || '0');
  if (snoozeUntil > Date.now()) return;

  const adminChannel = await safeGetChannel(CONFIG.ADMIN_CHANNEL_ID);
  if (!adminChannel) return;
  const encodedTitle = encodeURIComponent(title);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`delete_no:${mediaId}:${encodedTitle}:${reqRow.requested_by_discord_id}`).setLabel('Keep').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`delete_yes:${mediaId}:${encodedTitle}:${reqRow.requested_by_discord_id}`).setLabel('Delete Now').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`delete_later:${mediaId}:${encodedTitle}:${reqRow.requested_by_discord_id}`).setLabel('Remind Me Later').setStyle(ButtonStyle.Primary),
  );
  await adminChannel.send({ content: `<@${reqRow.requested_by_discord_id}>`, embeds: [brandedEmbed(COLORS.WARN).setTitle(`${mediaTypeEmoji(mediaType === 'episode' ? 'tv' : 'movie', is4k)} Finished Watching`).setDescription(`Looks like you finished **${title}**. Should we keep it or free up space?\n\n⏳ Auto-deletes in ${CONFIG.DELETION_GRACE_HOURS} hour(s) unless you choose **Keep**.`)], components: [row] });
}

async function handleTautulliWebhook(body) {
  const { event, user_email, media_type, title, grandparent_title, tmdb_id, tvdb_id, is_4k } = body;
  if (event !== 'watched' || !user_email) return;
  const is4k = String(is_4k || '').toLowerCase().includes('4k');
  if (media_type === 'movie' && !is4k) return;
  const mediaId = media_type === 'movie' ? `tmdb:${tmdb_id}` : `tvdb:${tvdb_id}`;
  if (!tmdb_id && media_type === 'movie') return;
  if (!tvdb_id && media_type === 'episode') return;
  const reqRow = db.prepare('SELECT * FROM requests WHERE media_id = ? ORDER BY created_at DESC LIMIT 1').get(mediaId);
  if (!reqRow?.requested_by_discord_id || isInKeepList(mediaId)) return;
  const snoozeUntil = Number(getSetting(`delete_prompt_snooze:${mediaId}:${reqRow.requested_by_discord_id}`) || '0');
  if (snoozeUntil > Date.now()) return;
  const adminChannel = await safeGetChannel(CONFIG.ADMIN_CHANNEL_ID);
  if (!adminChannel) return;
  const showTitle = media_type === 'episode' ? (grandparent_title || title) : title;
  const encodedTitle = encodeURIComponent(showTitle);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`delete_no:${mediaId}:${encodedTitle}:${reqRow.requested_by_discord_id}`).setLabel('Keep').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`delete_yes:${mediaId}:${encodedTitle}:${reqRow.requested_by_discord_id}`).setLabel('Delete Now').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`delete_later:${mediaId}:${encodedTitle}:${reqRow.requested_by_discord_id}`).setLabel('Remind Me Later').setStyle(ButtonStyle.Primary),
  );
  await adminChannel.send({ content: `<@${reqRow.requested_by_discord_id}>`, embeds: [brandedEmbed(COLORS.WARN).setTitle('📺 Finished Watching').setDescription(`Looks like you finished **${showTitle}**. Keep it, or free up space?`)], components: [row] });
}

function shutdown(sig) {
  log.info(`Received ${sig}, shutting down`);
  try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch (_e) {}
  try { client.destroy(); } catch (_e) {}
  process.exit(0);
}
['SIGTERM', 'SIGINT'].forEach(s => process.on(s, () => shutdown(s)));

try {
  validateConfig();
  runMigrations();
  client.login(CONFIG.DISCORD_BOT_TOKEN);
} catch (err) {
  log.error(err.message);
  process.exit(1);
}
