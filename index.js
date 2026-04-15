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

const express    = require('express');
const bodyParser = require('body-parser');
const multer    = require('multer');
const axios      = require('axios');
const Database   = require('better-sqlite3');
// @ctrl/plex dropped friend management — using Plex API directly via axios
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');

// ============================================================
// Config
// ============================================================
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID  = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID   = process.env.DISCORD_GUILD_ID;
const ADMIN_CHANNEL_ID   = process.env.ADMIN_CHANNEL_ID;
const ADMIN_USER_ID      = process.env.ADMIN_USER_ID;

const OVERSEERR_URL      = process.env.OVERSEERR_URL ? process.env.OVERSEERR_URL.replace(/\/$/, '') : '';
const OVERSEERR_API_KEY  = process.env.OVERSEERR_API_KEY;
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET || '';

const PLEX_TOKEN         = process.env.PLEX_TOKEN || '';
const PLEX_USERNAME      = process.env.PLEX_USERNAME;
const PLEX_PASSWORD      = process.env.PLEX_PASSWORD;
const PLEX_EXCLUDE_SERVERS = process.env.PLEX_EXCLUDE_SERVERS
  ? process.env.PLEX_EXCLUDE_SERVERS.split(',').map(s => s.trim().toLowerCase())
  : [];

const RADARR_URL         = process.env.RADARR_URL;
const RADARR_API_KEY     = process.env.RADARR_API_KEY;
const RADARR_4K_URL      = process.env.RADARR_4K_URL;
const RADARR_4K_API_KEY  = process.env.RADARR_4K_API_KEY;
const SONARR_URL         = process.env.SONARR_URL;
const SONARR_API_KEY     = process.env.SONARR_API_KEY;

const TUNNEL_DOMAIN      = process.env.TUNNEL_DOMAIN;
const RAID_PATH          = process.env.RAID_PATH || '/mnt/raid';
const PATH_REMAP_FROM    = process.env.PATH_REMAP_FROM || '';
const PATH_REMAP_TO      = process.env.PATH_REMAP_TO   || RAID_PATH;

const TAUTULLI_SECRET    = process.env.TAUTULLI_WEBHOOK_SECRET || '';
const PORT               = parseInt(process.env.PORT || '3000', 10);
const PLEX_CLIENT_ID     = 'discord-plex-bot';

// ============================================================
// Logger
// ============================================================
const log = {
  info:  (...a) => console.log('[INFO]',  ...a),
  ok:    (...a) => console.log('[OK]',    ...a),
  warn:  (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERROR]',...a),
  step:  (n,...a) => console.log(`[Step ${n}]`, ...a),
};

// ============================================================
// Database
// ============================================================
const db = new Database('/app/data/plex_invites.db');
db.pragma('journal_mode = WAL');

db.exec(`
  -- Original user/onboarding table (preserved exactly)
  CREATE TABLE IF NOT EXISTS users (
    discord_id          TEXT PRIMARY KEY,
    email               TEXT NOT NULL,
    invited             INTEGER DEFAULT 0,
    invited_at          TEXT,
    requested_at        TEXT NOT NULL,
    overseerr_created   INTEGER DEFAULT 0,
    overseerr_user_id   INTEGER
  );

  -- Tracks approved Overseerr requests so we know who owns each file
  CREATE TABLE IF NOT EXISTS requests (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    overseerr_request_id    TEXT UNIQUE,
    media_id                TEXT NOT NULL,
    media_type              TEXT NOT NULL,
    is_4k                   INTEGER DEFAULT 0,
    title                   TEXT NOT NULL,
    requested_by_discord_id TEXT,
    status                  TEXT DEFAULT 'pending',
    created_at              DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (requested_by_discord_id) REFERENCES users(discord_id)
  );

  -- Files the requester chose to keep — removed from future watch triggers
  CREATE TABLE IF NOT EXISTS keep_list (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id            TEXT NOT NULL UNIQUE,
    media_type          TEXT NOT NULL,
    title               TEXT NOT NULL,
    kept_by_discord_id  TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Expiring 24-hour download tokens
  CREATE TABLE IF NOT EXISTS download_tokens (
    token       TEXT PRIMARY KEY,
    file_path   TEXT NOT NULL,
    title       TEXT NOT NULL,
    discord_id  TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrate: add overseerr_user_id if upgrading from v1 schema
try { db.exec(`ALTER TABLE users ADD COLUMN overseerr_user_id INTEGER`); }
catch (_) { /* already exists */ }

// ── User helpers (original) ──────────────────────────────────
function storeUserEmail(discordId, email) {
  db.prepare(`
    INSERT INTO users (discord_id, email, requested_at)
    VALUES (?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      email = excluded.email,
      requested_at = excluded.requested_at,
      overseerr_created = 0,
      overseerr_user_id = NULL
  `).run(discordId, email, new Date().toISOString());
}

function getUserByDiscordId(discordId) {
  return db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
}

function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
}

function markUserInvited(discordId) {
  db.prepare('UPDATE users SET invited = 1, invited_at = ? WHERE discord_id = ?')
    .run(new Date().toISOString(), discordId);
}

function markOverseerrCreated(discordId, overseerrUserId) {
  db.prepare('UPDATE users SET overseerr_created = 1, overseerr_user_id = ? WHERE discord_id = ?')
    .run(overseerrUserId, discordId);
}

function removeUser(discordId) {
  db.prepare('DELETE FROM users WHERE discord_id = ?').run(discordId);
}

// ── Request helpers ──────────────────────────────────────────
function upsertRequest(overseerrRequestId, mediaId, mediaType, is4k, title, discordId, status) {
  db.prepare(`
    INSERT OR REPLACE INTO requests
      (overseerr_request_id, media_id, media_type, is_4k, title, requested_by_discord_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(overseerrRequestId, mediaId, mediaType, is4k ? 1 : 0, title, discordId || null, status);
}

function getRequestByMediaId(mediaId) {
  return db.prepare(
    'SELECT * FROM requests WHERE media_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(mediaId);
}

// ── Keep list helpers ────────────────────────────────────────
function addToKeepList(mediaId, mediaType, title, discordId) {
  db.prepare(`
    INSERT OR IGNORE INTO keep_list (media_id, media_type, title, kept_by_discord_id)
    VALUES (?, ?, ?, ?)
  `).run(mediaId, mediaType, title, discordId);
}

function isInKeepList(mediaId) {
  return !!db.prepare('SELECT id FROM keep_list WHERE media_id = ?').get(mediaId);
}

// ── Download token helpers ───────────────────────────────────
function createDownloadToken(filePath, title, discordId) {
  const token     = uuidv4();
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  db.prepare(
    'INSERT INTO download_tokens (token, file_path, title, discord_id, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(token, filePath, title, discordId, expiresAt);
  return { token, expiresAt };
}

function getDownloadToken(token) {
  return db.prepare('SELECT * FROM download_tokens WHERE token = ?').get(token);
}

function deleteDownloadToken(token) {
  db.prepare('DELETE FROM download_tokens WHERE token = ?').run(token);
}

function cleanExpiredTokens() {
  db.prepare('DELETE FROM download_tokens WHERE expires_at < ?').run(Date.now());
}

// ============================================================
// Discord Client
// ============================================================
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

// ============================================================
// Plex Helpers
// ============================================================
async function getPlexToken() {
  if (PLEX_TOKEN) return PLEX_TOKEN;
  log.warn('Using Plex username/password auth (consider switching to PLEX_TOKEN)');
  const res = await axios.post('https://plex.tv/users/sign_in.json', {}, {
    auth: { username: PLEX_USERNAME, password: PLEX_PASSWORD },
    headers: {
      'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
      'X-Plex-Product': 'Discord Bot',
      'X-Plex-Version': '1.0',
    },
  });
  return res.data.user.authToken;
}

async function plexApiGet(path, token) {
  const res = await axios.get(`https://plex.tv${path}`, {
    headers: {
      'X-Plex-Token': token,
      'Accept': 'application/json',
      'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
    },
  });
  return res.data;
}

async function getPlexServers(token) {
  const data = await plexApiGet('/api/v2/resources?includeHttps=1&includeRelay=1', token);
  return (Array.isArray(data) ? data : []).filter(r =>
    r.provides?.includes('server') &&
    !PLEX_EXCLUDE_SERVERS.includes(r.name?.toLowerCase())
  );
}

async function inviteUserToPlex(email) {
  log.info('Authenticating with Plex...');
  const token = await getPlexToken();
  log.ok('Plex authentication successful');

  const servers = await getPlexServers(token);
  log.info(`Inviting ${email} to ${servers.length} server(s)...`);

  let successCount = 0;
  for (const server of servers) {
    try {
      await axios.post(
        'https://plex.tv/api/v2/shared_servers',
        {
          invitedEmail: email,
          machineIdentifier: server.clientIdentifier,
          librarySectionIds: [],
          settings: { allowSync: true },
        },
        {
          headers: {
            'X-Plex-Token': token,
            'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
            'Accept': 'application/json',
          },
        }
      );
      log.ok(`Invited to server: ${server.name}`);
      successCount++;
    } catch (err) {
      log.warn(`Failed to invite to ${server.name}: ${err.message}`);
    }
  }

  return { successCount, total: servers.length };
}

async function removePlexAccess(email) {
  log.info(`Authenticating with Plex to remove ${email}...`);
  const token = await getPlexToken();

  const friendsData = await plexApiGet('/api/v2/friends', token).catch(() => []);
  const friends = Array.isArray(friendsData) ? friendsData : (friendsData.data || []);

  const friend = friends.find(
    f => f.email?.toLowerCase() === email.toLowerCase() ||
         f.username?.toLowerCase() === email.toLowerCase() ||
         f.title?.toLowerCase() === email.toLowerCase()
  );

  if (!friend) {
    log.warn(`No Plex friend found for ${email}`);
    return { removed: false, reason: 'No Plex account found' };
  }

  log.info(`Found Plex friend: ${friend.username || friend.title} (ID: ${friend.id})`);

  const servers = await getPlexServers(token);
  log.info(`Checking ${servers.length} eligible server(s) for removal`);

  let removedCount = 0;
  for (const server of servers) {
    try {
      await axios.delete(
        `https://plex.tv/api/v2/shared_servers/${server.clientIdentifier}/friends/${friend.id}`,
        {
          headers: {
            'X-Plex-Token': token,
            'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
            'Accept': 'application/json',
          },
        }
      );
      log.ok(`Removed from ${server.name}`);
      removedCount++;
    } catch (err) {
      if (err.response?.status === 404) {
        log.info(`No share found for user on ${server.name}`);
      } else {
        log.warn(`Error removing from ${server.name}: ${err.message}`);
      }
    }
  }

  return { removed: removedCount > 0, removedCount, total: servers.length };
}

// ============================================================
// Overseerr Helpers
// ============================================================
async function createOverseerrUser(email, discordId, username) {
  log.step(1, `Overseerr: Creating/linking user "${username}" (Discord: ${discordId})`);

  // Step 1: Create local user
  const createRes = await axios.post(
    `${OVERSEERR_URL}/api/v1/user`,
    {
      email,
      username,
      password: uuidv4(),
      permissions: 32, // REQUEST permission only
      userType: 2,     // local user
    },
    { headers: { 'X-Api-Key': OVERSEERR_API_KEY } }
  );

  const overseerrUserId = createRes.data.id;
  log.step(2, `Overseerr user created (ID: ${overseerrUserId})`);

  // Step 2: Link Discord ID via notification settings
  await axios.post(
    `${OVERSEERR_URL}/api/v1/user/${overseerrUserId}/settings/notifications`,
    { discordId },
    { headers: { 'X-Api-Key': OVERSEERR_API_KEY } }
  );

  log.step(3, `Discord ID linked to Overseerr user`);
  return overseerrUserId;
}

async function approveOverseerrRequest(requestId) {
  const res = await axios.post(
    `${OVERSEERR_URL}/api/v1/request/${requestId}/approve`,
    {},
    { headers: { 'X-Api-Key': OVERSEERR_API_KEY } }
  );
  return res.data;
}

async function denyOverseerrRequest(requestId) {
  const res = await axios.post(
    `${OVERSEERR_URL}/api/v1/request/${requestId}/decline`,
    {},
    { headers: { 'X-Api-Key': OVERSEERR_API_KEY } }
  );
  return res.data;
}

// ============================================================
// Radarr / Sonarr Helpers
// ============================================================

// Query a specific Radarr instance by URL + key
async function radarrGetFrom(url, apiKey, endpoint) {
  const res = await axios.get(`${url}/api/v3${endpoint}`, {
    params: { apikey: apiKey },
    timeout: 10000,
  });
  return res.data;
}

async function sonarrGet(endpoint, params = {}) {
  const res = await axios.get(`${SONARR_URL}/api/v3${endpoint}`, {
    params: { apikey: SONARR_API_KEY, ...params },
    timeout: 10000,
  });
  return res.data;
}

// Search both Radarr instances and tag results with their source
async function searchMovies(title) {
  const lower   = title.toLowerCase();
  const results = [];

  if (RADARR_URL) {
    const all = await radarrGetFrom(RADARR_URL, RADARR_API_KEY, '/movie');
    all.filter(m => m.hasFile && m.title.toLowerCase().includes(lower))
       .forEach(m => results.push({ ...m, _radarrUrl: RADARR_URL, _radarrKey: RADARR_API_KEY }));
  }
  if (RADARR_4K_URL) {
    const all = await radarrGetFrom(RADARR_4K_URL, RADARR_4K_API_KEY, '/movie');
    all.filter(m => m.hasFile && m.title.toLowerCase().includes(lower))
       .forEach(m => results.push({ ...m, _radarrUrl: RADARR_4K_URL, _radarrKey: RADARR_4K_API_KEY }));
  }

  return results;
}

// Find a movie by TMDB ID across both Radarr instances
async function getMovieByTmdb(tmdbId) {
  const id = parseInt(tmdbId, 10);

  if (RADARR_4K_URL) {
    const all = await radarrGetFrom(RADARR_4K_URL, RADARR_4K_API_KEY, '/movie');
    const hit = all.find(m => m.tmdbId === id);
    if (hit) return { ...hit, _radarrUrl: RADARR_4K_URL, _radarrKey: RADARR_4K_API_KEY };
  }
  if (RADARR_URL) {
    const all = await radarrGetFrom(RADARR_URL, RADARR_API_KEY, '/movie');
    const hit = all.find(m => m.tmdbId === id);
    if (hit) return { ...hit, _radarrUrl: RADARR_URL, _radarrKey: RADARR_API_KEY };
  }

  return null;
}

// Delete from whichever Radarr instance the movie came from
async function deleteRadarrMovie(movie) {
  const url    = movie._radarrUrl || RADARR_URL;
  const apiKey = movie._radarrKey || RADARR_API_KEY;
  await axios.delete(`${url}/api/v3/movie/${movie.id}`, {
    params: { apikey: apiKey, deleteFiles: true },
    timeout: 10000,
  });
}

async function searchSeries(title) {
  const all   = await sonarrGet('/series');
  const lower = title.toLowerCase();
  return all.filter(s => s.title.toLowerCase().includes(lower));
}

async function getSeriesByTvdb(tvdbId) {
  const all = await sonarrGet('/series');
  return all.find(s => s.tvdbId === parseInt(tvdbId, 10)) || null;
}

async function getEpisodeFiles(seriesId) {
  return sonarrGet('/episodefile', { seriesId });
}

async function deleteSonarrSeries(sonarrId) {
  await axios.delete(`${SONARR_URL}/api/v3/series/${sonarrId}`, {
    params: { apikey: SONARR_API_KEY, deleteFiles: true },
    timeout: 10000,
  });
}

async function deleteMediaById(mediaId) {
  if (mediaId.startsWith('tmdb:')) {
    const movie = await getMovieByTmdb(mediaId.replace('tmdb:', ''));
    if (!movie) throw new Error('Movie not found in Radarr');
    await deleteRadarrMovie(movie); // pass full object so we know which instance to delete from
  } else if (mediaId.startsWith('tvdb:')) {
    const series = await getSeriesByTvdb(mediaId.replace('tvdb:', ''));
    if (!series) throw new Error('Series not found in Sonarr');
    await deleteSonarrSeries(series.id);
  } else {
    throw new Error('Unknown media ID format');
  }
}

// ============================================================
// File path remapping
// (Radarr/Sonarr store paths relative to their own mount)
// ============================================================
function remapPath(hostPath) {
  if (PATH_REMAP_FROM && hostPath.startsWith(PATH_REMAP_FROM)) {
    return hostPath.replace(PATH_REMAP_FROM, PATH_REMAP_TO);
  }
  return hostPath;
}

// ============================================================
// Media type helpers
// ============================================================
function mediaTypeLabel(mediaType, is4k) {
  if (mediaType === 'tv') return is4k ? '4K TV Show' : 'TV Show';
  return is4k ? '4K Movie' : 'Movie';
}

function mediaTypeEmoji(mediaType, is4k) {
  if (mediaType === 'tv') return '📺';
  return is4k ? '🎥' : '🎬';
}

// ============================================================
// Pending DM state
// (Tracks users mid-onboarding who haven't submitted their email yet)
// ============================================================
const pendingEmailRequests = new Map(); // discordId → true

// ============================================================
// Discord Events
// ============================================================

// ── Ready ────────────────────────────────────────────────────
client.once('ready', async () => {
  log.ok(`Discord bot online as ${client.user.tag}`);
  log.info(`Serving ${client.guilds.cache.size} guild(s)`);
  log.info(`Excluding Plex servers: ${PLEX_EXCLUDE_SERVERS.join(', ') || 'none'}`);

  await registerSlashCommands();
  startExpressServer();
});

// ── Member Join ───────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  log.info(`New member joined: ${member.user.tag}`);

  try {
    const embed = new EmbedBuilder()
      .setTitle('👋 Welcome to Durant Media Server!')
      .setDescription(
        `Hey ${member.user.username}!\n\n` +
        `You've been invited to join our private media server. We use **Plex** to stream movies and TV shows across three servers (California, South-Central, and Central Iowa).\n\n` +
        `**Step 1 — Create a free Plex account** (skip if you already have one):\n` +
        `👉 https://www.plex.tv/sign-up/\n\n` +
        `**Step 2 — Reply to this message with your Plex account email address.**\n\n` +
        `Once approved you'll get access to the full library, plus the ability to request new titles and download files directly.`
      )
      .setColor(0xe5a00d)
      .setFooter({ text: 'Already have Plex? Just reply with your email to get started' });

    await member.send({ embeds: [embed] });
    pendingEmailRequests.set(member.id, true);
    log.ok(`Sent welcome DM to ${member.user.tag}`);
  } catch (err) {
    log.warn(`Could not DM ${member.user.tag}: ${err.message}`);
  }
});

// ── Member Leave ──────────────────────────────────────────────
client.on('guildMemberRemove', async member => {
  log.info(`Member left: ${member.user.tag}`);

  const user = getUserByDiscordId(member.id);
  if (!user) return;

  const adminChannel = await safeGetChannel(ADMIN_CHANNEL_ID);

  // Remove Plex access automatically
  try {
    const result = await removePlexAccess(user.email);
    removeUser(member.id);

    const statusMsg = result.removed
      ? `Removed from ${result.removedCount}/${result.total} Plex server(s).`
      : `No active Plex shares found (may not have been invited yet).`;

    log.ok(`Cleanup complete for ${member.user.tag}`);

    if (adminChannel) {
      await adminChannel.send(
        `⚠️ **User Left Server**\n\n` +
        `**Discord:** ${member.user.tag} (<@${member.id}>)\n` +
        `**Plex Email:** \`${user.email}\`\n` +
        `**Plex Access:** ${statusMsg}\n\n` +
        `Also remove them from **Overseerr** manually if needed.`
      );
    }
  } catch (err) {
    log.error(`Error removing Plex access for ${member.user.tag}:`, err.message);
    if (adminChannel) {
      await adminChannel.send(
        `⚠️ **User Left — Manual Action Needed**\n\n` +
        `**Discord:** ${member.user.tag}\n` +
        `**Plex Email:** \`${user.email}\`\n` +
        `❌ Automatic Plex removal failed: ${err.message}\n` +
        `Please remove them from Plex and Overseerr manually.`
      );
    }
  }
});

// ── DM Handler (email collection) ────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (message.guild)      return; // Only handle DMs

  const userId = message.author.id;
  if (!pendingEmailRequests.has(userId)) return;

  const email = message.content.trim().toLowerCase();

  if (!isValidEmail(email)) {
    await message.reply(
      'That doesn\'t look like a valid email address. Please reply with your Plex account email.'
    );
    return;
  }

  pendingEmailRequests.delete(userId);
  storeUserEmail(userId, email);

  await message.reply(
    '✅ Got it! Your request has been sent to the admin for approval. ' +
    'You\'ll receive a DM once it\'s reviewed.'
  );

  log.info(`Plex request from ${message.author.tag} (${email}) forwarded to admins`);

  // Send approval card to admin channel
  const adminChannel = await safeGetChannel(ADMIN_CHANNEL_ID);
  if (!adminChannel) return;

  const joinedAt = message.author.createdAt
    ? `<t:${Math.floor(message.author.createdAt.getTime() / 1000)}:R>`
    : 'Unknown';

  const embed = new EmbedBuilder()
    .setTitle('🔐 New Plex Access Request')
    .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
    .addFields(
      { name: 'User',    value: `<@${userId}>\n${message.author.tag}`, inline: true },
      { name: 'Email',   value: `\`${email}\``,                         inline: true },
      { name: 'Account', value: `Created ${joinedAt}`,                  inline: true },
    )
    .setColor(0x3b82f6)
    .setTimestamp()
    .setFooter({ text: `Discord ID: ${userId}` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`plex_approve:${userId}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`plex_deny:${userId}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger),
  );

  await adminChannel.send({ embeds: [embed], components: [row] });
});

// ── Slash Commands + Button Interactions ──────────────────────
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    }
  } catch (err) {
    log.error('Interaction error:', err.message);
    const reply = { content: `❌ An error occurred: ${err.message}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});

client.on('error', err => log.error('Discord client error:', err));

// ============================================================
// Slash Command Definitions
// ============================================================
const slashCommands = [
  new SlashCommandBuilder()
    .setName('download')
    .setDescription('Get a 24-hour download link for a movie or TV episode')
    .addStringOption(o =>
      o.setName('title').setDescription('Movie or show title').setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName('season').setDescription('Season number (TV only)').setRequired(false)
    )
    .addIntegerOption(o =>
      o.setName('episode').setDescription('Episode number (TV only)').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link a Discord user to their Plex email (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o =>
      o.setName('user').setDescription('Discord user').setRequired(true)
    )
    .addStringOption(o =>
      o.setName('email').setDescription('Plex email address').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Remove a user from the bot database (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o =>
      o.setName('user').setDescription('Discord user').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('users')
    .setDescription('List all linked Plex users (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show system status — linked users, Overseerr accounts (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('sync')
    .setDescription('Comprehensive 3-phase sync: Plex → DB → Overseerr → Discord links (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('cleanup')
    .setDescription('Remove deleted/orphaned Overseerr accounts (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(c => c.toJSON());

async function registerSlashCommands() {
  if (!DISCORD_CLIENT_ID || !DISCORD_GUILD_ID) {
    log.warn('DISCORD_CLIENT_ID or DISCORD_GUILD_ID not set — skipping slash command registration');
    return;
  }
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
    await rest.put(
      Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
      { body: slashCommands }
    );
    log.ok(`Registered ${slashCommands.length} slash command(s)`);
  } catch (err) {
    log.error('Failed to register slash commands:', err.message);
  }
}

// ============================================================
// Slash Command Handlers
// ============================================================
async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  if (commandName === 'download') return handleDownloadCommand(interaction);
  if (commandName === 'link')     return handleLinkCommand(interaction);
  if (commandName === 'unlink')   return handleUnlinkCommand(interaction);
  if (commandName === 'users')    return handleUsersCommand(interaction);
  if (commandName === 'status')   return handleStatusCommand(interaction);
  if (commandName === 'sync')     return handleSyncCommand(interaction);
  if (commandName === 'cleanup')  return handleCleanupCommand(interaction);
}

async function handleDownloadCommand(interaction) {
  const user = getUserByDiscordId(interaction.user.id);
  if (!user) {
    return interaction.reply({
      content: '❌ You need to be a linked Plex member to use this command.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const title   = interaction.options.getString('title');
  const season  = interaction.options.getInteger('season');
  const episode = interaction.options.getInteger('episode');

  let filePath, displayTitle;

  if (season || episode) {
    // TV episode
    const results = await searchSeries(title);
    if (!results.length) {
      return interaction.editReply({ content: `❌ Could not find **${title}** in the library.` });
    }
    const series  = results[0];
    const files   = await getEpisodeFiles(series.id);
    const s = season || 1, e = episode || 1;
    const epFile  = files.find(f => f.seasonNumber === s && f.episodeNumber === e);
    if (!epFile) {
      return interaction.editReply({
        content: `❌ S${pad(s)}E${pad(e)} not found for **${series.title}**.`,
      });
    }
    filePath     = epFile.path;
    displayTitle = `${series.title} S${pad(s)}E${pad(e)}`;
  } else {
    // Movie
    const results = await searchMovies(title);
    if (!results.length) {
      return interaction.editReply({ content: `❌ Could not find **${title}** in the library.` });
    }
    const movie  = results[0];
    filePath     = movie.movieFile?.path;
    displayTitle = movie.title + (movie.year ? ` (${movie.year})` : '');
    if (!filePath) {
      return interaction.editReply({ content: `❌ **${movie.title}** has no file on disk yet.` });
    }
  }

  filePath = remapPath(filePath);

  if (!fs.existsSync(filePath)) {
    return interaction.editReply({
      content: '❌ File not found on disk. The admin may need to check the RAID path mapping.',
    });
  }

  const { token, expiresAt } = createDownloadToken(filePath, displayTitle, interaction.user.id);
  const downloadUrl = `https://${TUNNEL_DOMAIN}/download/${token}`;

  await interaction.editReply({
    content:
      `📥 **Download — ${displayTitle}**\n\n` +
      `🔗 ${downloadUrl}\n\n` +
      `⏳ Expires: ${new Date(expiresAt).toUTCString()}\n` +
      `_This link is private. Do not share it._`,
  });

  log.ok(`Download token issued for "${displayTitle}" to ${interaction.user.tag}`);
}

async function handleLinkCommand(interaction) {
  if (interaction.user.id !== ADMIN_USER_ID) {
    return interaction.reply({ content: '❌ Only the admin can use this command.', ephemeral: true });
  }

  const target = interaction.options.getUser('user');
  const email  = interaction.options.getString('email').toLowerCase().trim();

  storeUserEmail(target.id, email);
  markUserInvited(target.id); // Admin-linked users are considered already invited

  await interaction.reply({
    content: `✅ Linked **${target.displayName}** (@${target.username}) to Plex email \`${email}\`.`,
    ephemeral: true,
  });

  log.ok(`[Link] ${target.tag} (${target.id}) manually linked to ${email}`);
}

async function handleUnlinkCommand(interaction) {
  if (interaction.user.id !== ADMIN_USER_ID) {
    return interaction.reply({ content: '❌ Only the admin can use this command.', ephemeral: true });
  }

  const target = interaction.options.getUser('user');
  const record = getUserByDiscordId(target.id);

  if (!record) {
    return interaction.reply({
      content: `⚠️ **${target.tag}** is not in the database.`,
      ephemeral: true,
    });
  }

  removeUser(target.id);

  await interaction.reply({
    content:
      `✅ Removed **${target.tag}** (was \`${record.email}\`) from the database.\n` +
      `⚠️ Remember to also remove them from Plex and Overseerr manually.`,
    ephemeral: true,
  });
}

async function handleUsersCommand(interaction) {
  if (interaction.user.id !== ADMIN_USER_ID) {
    return interaction.reply({ content: '❌ Only the admin can use this command.', ephemeral: true });
  }

  const rows = db.prepare('SELECT * FROM users ORDER BY requested_at ASC').all();

  if (!rows.length) {
    return interaction.reply({ content: 'No linked users found.', ephemeral: true });
  }

  const lines = rows.map((u, i) =>
    `${i + 1}. <@${u.discord_id}> — \`${u.email}\` ${u.invited ? '✅' : '⏳'}`
  );

  const embed = new EmbedBuilder()
    .setTitle(`👥 Linked Plex Users (${rows.length})`)
    .setDescription(lines.join('\n'))
    .setColor(0x6366f1)
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ============================================================
// /status Command
// ============================================================
async function handleStatusCommand(interaction) {
  if (interaction.user.id !== ADMIN_USER_ID) {
    return interaction.reply({ content: '❌ Only the admin can use this command.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  // All users in our DB
  const dbUsers = db.prepare('SELECT * FROM users ORDER BY requested_at ASC').all();

  // All users in Overseerr
  let overseerrUsers = [];
  try {
    const res = await axios.get(`${OVERSEERR_URL}/api/v1/user?take=100`, {
      headers: { 'X-Api-Key': OVERSEERR_API_KEY },
    });
    overseerrUsers = res.data.results || [];
  } catch (err) {
    log.warn('[Status] Could not fetch Overseerr users:', err.message);
  }

  // Build sets for comparison
  const dbEmailSet       = new Set(dbUsers.map(u => u.email.toLowerCase()));
  const overseerrEmailSet = new Set(overseerrUsers.map(u => u.email?.toLowerCase()).filter(Boolean));

  // Active & Linked — in both DB and Overseerr
  const linked = dbUsers.filter(u => overseerrEmailSet.has(u.email.toLowerCase()));

  // Overseerr Only — in Overseerr but not matched to any DB user
  // Also exclude users whose Overseerr displayName matches a linked Discord username
  const guild = client.guilds.cache.first();
  const discordUsernameSet = new Set();
  if (guild) {
    dbUsers.forEach(u => {
      if (!u.discord_id.startsWith('plex_')) {
        const member = guild.members.cache.get(u.discord_id);
        if (member) {
          discordUsernameSet.add(member.user.username.toLowerCase());
          discordUsernameSet.add(member.displayName.toLowerCase());
        }
      }
    });
  }
  const overseerrOnly = overseerrUsers.filter(u => {
    if (!u.email) return false;
    if (u.userType === 1) return false;
    if (dbEmailSet.has(u.email.toLowerCase())) return false;
    const display = (u.displayName || '').toLowerCase();
    const username = (u.username || '').toLowerCase();
    if (discordUsernameSet.has(display) || discordUsernameSet.has(username)) return false;
    return true;
  });

  // Build embed
  const botId = client.user?.id;
  const linkedFiltered = linked.filter(u => u.discord_id !== botId);
  const linkedLines = linkedFiltered.map(u => {
    const isPlexOnly = u.discord_id.startsWith('plex_');
    const userDisplay = isPlexOnly
      ? `**${u.email.split('@')[0]}** *(no Discord)*`
      : `<@${u.discord_id}>`;
    return `✅ ${userDisplay} — ${u.email}`;
  });

  const overseerrOnlyLines = overseerrOnly.map(u =>
    `🔧 **${u.displayName || u.email}** — ${u.email}`
  );

  let description = '';
  if (linkedLines.length) {
    description += `**Active & Linked (${linkedLines.length})**\n${linkedLines.join('\n')}\n\n`;
  }
  if (overseerrOnlyLines.length) {
    description += `**Overseerr Only / Manual (${overseerrOnlyLines.length})**\n${overseerrOnlyLines.join('\n')}\n\n`;
  }
  if (!description) description = 'No users found.';

  const embed = new EmbedBuilder()
    .setTitle('🗺️ System Status')
    .setDescription(description)
    .setColor(0x6366f1)
    .setFooter({ text: `Total Overseerr Users: ${overseerrUsers.length}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ============================================================
// /sync Command
// ============================================================
async function handleSyncCommand(interaction) {
  if (interaction.user.id !== ADMIN_USER_ID) {
    return interaction.reply({ content: '❌ Only the admin can use this command.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  await interaction.editReply({ content: '⚙️ Starting Comprehensive Sync (Plex + Overseerr)...' });

  let phase1Added    = 0;
  let phase2Created  = 0;
  let phase3Repaired = 0;
  const errors       = [];

  // ── Phase 1: Scan Plex friends → add missing to DB ───────────
  try {
    const token = await getPlexToken();
    const friendsData = await plexApiGet('/api/v2/friends', token).catch(() => []);
    const friends = Array.isArray(friendsData) ? friendsData : (friendsData.data || []);

    for (const friend of friends) {
      const email = friend.email?.toLowerCase();
      if (!email) continue;

      const existing = getUserByEmail(email);
      if (!existing) {
        db.prepare('INSERT OR IGNORE INTO users (discord_id, email, invited, requested_at) VALUES (?, ?, 1, ?)')
          .run(`plex_${friend.id}`, email, new Date().toISOString());
        phase1Added++;
        log.info(`[Sync P1] Added Plex friend to DB: ${email}`);
      }
    }
  } catch (err) {
    errors.push(`Phase 1: ${err.message}`);
    log.error('[Sync P1]', err.message);
  }

  // ── Phase 2: Create Overseerr accounts for DB users missing one ──
  const allDbUsers = db.prepare('SELECT * FROM users').all();
  let overseerrUsers = [];
  try {
    const res = await axios.get(`${OVERSEERR_URL}/api/v1/user?take=100`, {
      headers: { 'X-Api-Key': OVERSEERR_API_KEY },
    });
    overseerrUsers = res.data.results || [];
  } catch (err) {
    errors.push(`Phase 2 fetch: ${err.message}`);
  }

  const overseerrEmailSet = new Set(overseerrUsers.map(u => u.email?.toLowerCase()).filter(Boolean));

  for (const u of allDbUsers) {
    if (overseerrEmailSet.has(u.email.toLowerCase())) continue;
    if (u.overseerr_created) continue;

    try {
      // Try to fetch Discord username for the account name
      let username = u.email.split('@')[0];
      if (u.discord_id && !u.discord_id.startsWith('plex_')) {
        const discordUser = await client.users.fetch(u.discord_id).catch(() => null);
        if (discordUser) username = discordUser.username;
      }

      const overseerrId = await createOverseerrUser(u.email, u.discord_id, username);
      markOverseerrCreated(u.discord_id, overseerrId);
      phase2Created++;
      log.ok(`[Sync P2] Created Overseerr account for ${u.email}`);
    } catch (err) {
      log.warn(`[Sync P2] Failed for ${u.email}: ${err.message}`);
    }
  }

  // ── Phase 3: Repair Discord ID links in Overseerr ────────────
  // Re-fetch after phase 2 creates
  try {
    const res = await axios.get(`${OVERSEERR_URL}/api/v1/user?take=100`, {
      headers: { 'X-Api-Key': OVERSEERR_API_KEY },
    });
    overseerrUsers = res.data.results || [];
  } catch (err) {
    errors.push(`Phase 3 fetch: ${err.message}`);
  }

  for (const ou of overseerrUsers) {
    if (!ou.email) continue;

    const dbUser = getUserByEmail(ou.email);
    if (!dbUser || dbUser.discord_id.startsWith('plex_')) continue;

    // Check if Discord ID is missing or wrong in Overseerr
    try {
      const notifRes = await axios.get(
        `${OVERSEERR_URL}/api/v1/user/${ou.id}/settings/notifications`,
        { headers: { 'X-Api-Key': OVERSEERR_API_KEY } }
      );
      const currentDiscordId = notifRes.data.discordId;

      if (currentDiscordId !== dbUser.discord_id) {
        await axios.post(
          `${OVERSEERR_URL}/api/v1/user/${ou.id}/settings/notifications`,
          { discordId: dbUser.discord_id },
          { headers: { 'X-Api-Key': OVERSEERR_API_KEY } }
        );
        phase3Repaired++;
        log.ok(`[Sync P3] Repaired Discord link for ${ou.email}`);
      }
    } catch (err) {
      log.warn(`[Sync P3] Failed for ${ou.email}: ${err.message}`);
    }
  }

  // ── Results embed ─────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setTitle('✅ Comprehensive Sync Complete')
    .addFields(
      { name: 'Phase 1: Plex',    value: `Added ${phase1Added} users to DB`,        inline: true },
      { name: 'Phase 2: Create',  value: `Created ${phase2Created} accounts`,        inline: true },
      { name: 'Phase 3: Repair',  value: `Fixed ${phase3Repaired} Discord links`,    inline: true },
    )
    .setColor(0x22c55e)
    .setTimestamp();

  if (errors.length) {
    embed.addFields({ name: '⚠️ Errors', value: errors.join('\n'), inline: false });
    embed.setColor(0xf59e0b);
  }

  await interaction.editReply({ content: '', embeds: [embed] });
}

// ============================================================
// /status Command
// ============================================================
async function handleStatusCommand(interaction) {
  if (interaction.user.id !== ADMIN_USER_ID) {
    return interaction.reply({ content: '❌ Only the admin can use this command.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const dbUsers = db.prepare('SELECT * FROM users ORDER BY requested_at ASC').all();

  let overseerrUsers = [];
  try {
    const res = await axios.get(`${OVERSEERR_URL}/api/v1/user?take=100`, {
      headers: { 'X-Api-Key': OVERSEERR_API_KEY },
    });
    overseerrUsers = res.data.results || [];
  } catch (err) {
    log.warn('[Status] Could not fetch Overseerr users:', err.message);
  }

  const dbEmailSet        = new Set(dbUsers.map(u => u.email.toLowerCase()));
  const overseerrEmailSet = new Set(overseerrUsers.map(u => u.email?.toLowerCase()).filter(Boolean));

  const linked         = dbUsers.filter(u => overseerrEmailSet.has(u.email.toLowerCase()));
  const overseerrOnly  = overseerrUsers.filter(u =>
    u.email && !dbEmailSet.has(u.email.toLowerCase()) && u.userType !== 1
  );

  const botId2 = client.user?.id;
  const linkedLines       = linked.filter(u => u.discord_id !== botId2).map(u => {
    const isPlexOnly = u.discord_id.startsWith('plex_');
    const userDisplay = isPlexOnly
      ? `**${u.email.split('@')[0]}** *(no Discord)*`
      : `<@${u.discord_id}>`;
    return `✅ ${userDisplay} — ${u.email}`;
  });
  const overseerrOnlyLines = overseerrOnly.map(u => `🔧 **${u.displayName || u.email}** — ${u.email}`);

  let description = '';
  if (linkedLines.length)        description += `**Active & Linked (${linkedLines.length})**\n${linkedLines.join('\n')}\n\n`;
  if (overseerrOnlyLines.length) description += `**Overseerr Only / Manual (${overseerrOnlyLines.length})**\n${overseerrOnlyLines.join('\n')}\n\n`;
  if (!description)              description = 'No users found.';

  const embed = new EmbedBuilder()
    .setTitle('🗺️ System Status')
    .setDescription(description)
    .setColor(0x6366f1)
    .setFooter({ text: `Total Overseerr Users: ${overseerrUsers.length}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ============================================================
// /sync Command
// ============================================================
async function handleSyncCommand(interaction) {
  if (interaction.user.id !== ADMIN_USER_ID) {
    return interaction.reply({ content: '❌ Only the admin can use this command.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply({ content: '⚙️ Starting Comprehensive Sync (Plex + Overseerr)...' });

  let phase1Added = 0, phase2Created = 0, phase3Repaired = 0;
  const errors = [];

  // ── Phase 1: Scan Plex friends → add missing to DB ──────────
  try {
    const token = await getPlexToken();
    const friendsData = await plexApiGet('/api/v2/friends', token).catch(() => []);
    const friends = Array.isArray(friendsData) ? friendsData : (friendsData.data || []);
    for (const friend of friends) {
      const email = friend.email?.toLowerCase();
      if (!email) continue;
      if (!getUserByEmail(email)) {
        db.prepare('INSERT OR IGNORE INTO users (discord_id, email, invited, requested_at) VALUES (?, ?, 1, ?)')
          .run(`plex_${friend.id}`, email, new Date().toISOString());
        phase1Added++;
        log.info(`[Sync P1] Added: ${email}`);
      }
    }
  } catch (err) {
    errors.push(`Phase 1: ${err.message}`);
  }

  // ── Phase 2: Create Overseerr accounts for unlinked DB users ─
  const allDbUsers = db.prepare('SELECT * FROM users').all();
  let overseerrUsers = [];
  try {
    const res = await axios.get(`${OVERSEERR_URL}/api/v1/user?take=100`, { headers: { 'X-Api-Key': OVERSEERR_API_KEY } });
    overseerrUsers = res.data.results || [];
  } catch (err) { errors.push(`Phase 2 fetch: ${err.message}`); }

  const overseerrEmailSet = new Set(overseerrUsers.map(u => u.email?.toLowerCase()).filter(Boolean));

  for (const u of allDbUsers) {
    if (overseerrEmailSet.has(u.email.toLowerCase()) || u.overseerr_created) continue;
    try {
      let username = u.email.split('@')[0];
      if (u.discord_id && !u.discord_id.startsWith('plex_')) {
        const du = await client.users.fetch(u.discord_id).catch(() => null);
        if (du) username = du.username;
      }
      const overseerrId = await createOverseerrUser(u.email, u.discord_id, username);
      markOverseerrCreated(u.discord_id, overseerrId);
      phase2Created++;
      log.ok(`[Sync P2] Created Overseerr account: ${u.email}`);
    } catch (err) {
      log.warn(`[Sync P2] Failed for ${u.email}: ${err.message}`);
    }
  }

  // ── Phase 3: Repair Discord ID links in Overseerr ───────────
  try {
    const res = await axios.get(`${OVERSEERR_URL}/api/v1/user?take=100`, { headers: { 'X-Api-Key': OVERSEERR_API_KEY } });
    overseerrUsers = res.data.results || [];
  } catch (err) { errors.push(`Phase 3 fetch: ${err.message}`); }

  for (const ou of overseerrUsers) {
    if (!ou.email) continue;
    const dbUser = getUserByEmail(ou.email);
    if (!dbUser || dbUser.discord_id.startsWith('plex_')) continue;
    try {
      const notifRes = await axios.get(
        `${OVERSEERR_URL}/api/v1/user/${ou.id}/settings/notifications`,
        { headers: { 'X-Api-Key': OVERSEERR_API_KEY } }
      );
      if (notifRes.data.discordId !== dbUser.discord_id) {
        await axios.post(
          `${OVERSEERR_URL}/api/v1/user/${ou.id}/settings/notifications`,
          { discordId: dbUser.discord_id },
          { headers: { 'X-Api-Key': OVERSEERR_API_KEY } }
        );
        phase3Repaired++;
        log.ok(`[Sync P3] Repaired Discord link: ${ou.email}`);
      }
    } catch (err) {
      log.warn(`[Sync P3] Failed for ${ou.email}: ${err.message}`);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle('✅ Comprehensive Sync Complete')
    .addFields(
      { name: 'Phase 1: Plex',   value: `Added ${phase1Added} users to DB`,      inline: true },
      { name: 'Phase 2: Create', value: `Created ${phase2Created} accounts`,      inline: true },
      { name: 'Phase 3: Repair', value: `Fixed ${phase3Repaired} Discord links`,  inline: true },
    )
    .setColor(errors.length ? 0xf59e0b : 0x22c55e)
    .setTimestamp();

  if (errors.length) embed.addFields({ name: '⚠️ Errors', value: errors.join('\n') });

  await interaction.editReply({ content: '', embeds: [embed] });
}

// ============================================================
// /cleanup Command
// ============================================================
async function handleCleanupCommand(interaction) {
  if (interaction.user.id !== ADMIN_USER_ID) {
    return interaction.reply({ content: '❌ Only the admin can use this command.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  let overseerrUsers = [];
  try {
    const res = await axios.get(`${OVERSEERR_URL}/api/v1/user?take=100`, {
      headers: { 'X-Api-Key': OVERSEERR_API_KEY },
    });
    overseerrUsers = res.data.results || [];
  } catch (err) {
    return interaction.editReply({ content: `❌ Could not fetch Overseerr users: ${err.message}` });
  }

  // Find deleted/orphaned accounts — display name starts with 'deleted_user' or email contains 'deleted_user'
  const toDelete = overseerrUsers.filter(u =>
    u.userType !== 1 && ( // never delete the admin
      u.displayName?.toLowerCase().startsWith('deleted_user') ||
      u.email?.toLowerCase().startsWith('deleted_user') ||
      u.username?.toLowerCase().startsWith('deleted_user')
    )
  );

  if (!toDelete.length) {
    return interaction.editReply({ content: '✅ No deleted/orphaned accounts found.' });
  }

  let removed = 0;
  const failed = [];

  for (const u of toDelete) {
    try {
      await axios.delete(`${OVERSEERR_URL}/api/v1/user/${u.id}`, {
        headers: { 'X-Api-Key': OVERSEERR_API_KEY },
      });
      // Also remove from our DB if present
      db.prepare('DELETE FROM users WHERE email = ?').run(u.email?.toLowerCase());
      removed++;
      log.ok(`[Cleanup] Removed Overseerr user: ${u.displayName} (${u.email})`);
    } catch (err) {
      failed.push(u.displayName || u.email);
      log.warn(`[Cleanup] Failed to remove ${u.displayName}: ${err.message}`);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle('🧹 Cleanup Complete')
    .addFields(
      { name: 'Removed',  value: `${removed} account(s)`, inline: true },
      { name: 'Failed',   value: `${failed.length} account(s)`, inline: true },
    )
    .setColor(removed > 0 ? 0x22c55e : 0x6366f1)
    .setTimestamp();

  if (failed.length) {
    embed.addFields({ name: '⚠️ Failed', value: failed.join(', ') });
  }

  await interaction.editReply({ embeds: [embed] });
}

// ============================================================
// Button Handlers
// ============================================================
async function handleButton(interaction) {
  const [action, ...parts] = interaction.customId.split(':');

  // ── Plex onboarding: Approve ──────────────────────────────
  if (action === 'plex_approve') {
    const targetDiscordId = parts[0];
    if (interaction.user.id !== ADMIN_USER_ID) {
      return interaction.reply({ content: '❌ Only the admin can approve requests.', ephemeral: true });
    }

    await interaction.deferUpdate();

    const user = getUserByDiscordId(targetDiscordId);
    if (!user) {
      return interaction.editReply({ content: '❌ User not found in database.', components: [] });
    }

    let plexStatus     = '❌ Failed';
    let overseerrStatus = '❌ Failed';

    // Invite to Plex
    try {
      const result = await inviteUserToPlex(user.email);
      plexStatus   = `✅ Invited to ${result.successCount}/${result.total} server(s)`;
      markUserInvited(targetDiscordId);
      log.ok(`Plex invite sent to ${user.email} for ${result.successCount}/${result.total} server(s)`);
    } catch (err) {
      log.error(`Plex invite failed for ${user.email}:`, err.message);
      plexStatus = `❌ ${err.message}`;
    }

    // Create Overseerr user
    try {
      const discordUser  = await client.users.fetch(targetDiscordId);
      const overseerrId  = await createOverseerrUser(user.email, targetDiscordId, discordUser.username);
      markOverseerrCreated(targetDiscordId, overseerrId);
      overseerrStatus = `✅ Created (ID: ${overseerrId})`;
    } catch (err) {
      log.error(`Overseerr user creation failed:`, err.message);
      overseerrStatus = `❌ ${err.message}`;
    }

    // DM the approved user
    try {
      const discordUser = await client.users.fetch(targetDiscordId);
      await discordUser.send(
        `✅ **Your Plex access has been approved!**\n\n` +
        `You should now have access to the Plex library. Sign in at https://plex.tv with \`${user.email}\`.\n\n` +
        `You can also request movies and TV shows through Overseerr. ` +
        `Use \`/download\` in Discord to download files directly without a Plex Pass.`
      );
    } catch (err) {
      log.warn(`Could not DM approved user ${targetDiscordId}: ${err.message}`);
    }

    const discordUserFinal = await client.users.fetch(targetDiscordId).catch(() => null);
    const approvedEmbed = new EmbedBuilder()
      .setTitle('✅ Plex Approved + Overseerr Linked')
      .setThumbnail(discordUserFinal?.displayAvatarURL({ dynamic: true }) || null)
      .addFields(
        { name: 'User',    value: `<@${targetDiscordId}>${discordUserFinal ? '\n' + discordUserFinal.tag : ''}`, inline: true },
        { name: 'Email',   value: `\`${user.email}\``, inline: true },
        { name: 'Plex',    value: plexStatus,             inline: false },
        { name: 'Overseerr', value: overseerrStatus,      inline: false },
      )
      .setColor(0x22c55e)
      .setTimestamp()
      .setFooter({ text: `Approved by ${interaction.user.tag}` });

    await interaction.editReply({ embeds: [approvedEmbed], components: [] });
    return;
  }

  // ── Plex onboarding: Deny ─────────────────────────────────
  if (action === 'plex_deny') {
    const targetDiscordId = parts[0];
    if (interaction.user.id !== ADMIN_USER_ID) {
      return interaction.reply({ content: '❌ Only the admin can deny requests.', ephemeral: true });
    }

    await interaction.deferUpdate();

    const user = getUserByDiscordId(targetDiscordId);
    removeUser(targetDiscordId);

    // DM the denied user
    try {
      const discordUser = await client.users.fetch(targetDiscordId);
      await discordUser.send(
        '❌ Your Plex access request has been declined. ' +
        'Contact the server admin if you believe this is a mistake.'
      );
    } catch (err) {
      log.warn(`Could not DM denied user ${targetDiscordId}: ${err.message}`);
    }

    await interaction.editReply({
      content: `❌ **Declined** <@${targetDiscordId}>${user ? ` (\`${user.email}\`)` : ''}.`,
      components: [],
    });
    return;
  }

  // ── Overseerr media request: Approve ─────────────────────
  if (action === 'overseerr_approve') {
    const requestId = parts[0];
    if (interaction.user.id !== ADMIN_USER_ID) {
      return interaction.reply({ content: '❌ Only the admin can approve requests.', ephemeral: true });
    }
    await approveOverseerrRequest(requestId);
    await interaction.update({
      content: `✅ Request **#${requestId}** approved by <@${interaction.user.id}>.`,
      components: [],
    });
    return;
  }

  // ── Overseerr media request: Deny ────────────────────────
  if (action === 'overseerr_deny') {
    const requestId = parts[0];
    if (interaction.user.id !== ADMIN_USER_ID) {
      return interaction.reply({ content: '❌ Only the admin can deny requests.', ephemeral: true });
    }
    await denyOverseerrRequest(requestId);
    await interaction.update({
      content: `❌ Request **#${requestId}** denied by <@${interaction.user.id}>.`,
      components: [],
    });
    return;
  }

  // ── Deletion: Yes, Delete ─────────────────────────────────
  if (action === 'delete_yes') {
    const [mediaId, encodedTitle, requestorId] = parts;
    const title = decodeURIComponent(encodedTitle);

    if (interaction.user.id !== requestorId && interaction.user.id !== ADMIN_USER_ID) {
      return interaction.reply({
        content: '❌ Only the person who requested this can confirm deletion.',
        ephemeral: true,
      });
    }

    await interaction.deferUpdate();

    await deleteMediaById(mediaId);

    await interaction.editReply({
      content:  `🗑️ **${title}** has been deleted from the server.`,
      embeds:   [],
      components: [],
    });

    log.ok(`Deleted "${title}" (${mediaId}) — confirmed by ${interaction.user.tag}`);
    return;
  }

  // ── Deletion: No, Keep ────────────────────────────────────
  if (action === 'delete_no') {
    const [mediaId, encodedTitle, requestorId] = parts;
    const title     = decodeURIComponent(encodedTitle);
    const mediaType = mediaId.startsWith('tvdb:') ? 'tv' : 'movie';

    if (interaction.user.id !== requestorId && interaction.user.id !== ADMIN_USER_ID) {
      return interaction.reply({
        content: '❌ Only the person who requested this can respond.',
        ephemeral: true,
      });
    }

    addToKeepList(mediaId, mediaType, title, requestorId);

    // Notify admin
    const adminChannel = await safeGetChannel(ADMIN_CHANNEL_ID);
    if (adminChannel) {
      await adminChannel.send(
        `📌 **Keep Requested** — <@${requestorId}> chose to keep **${title}**.\n` +
        `Removed from future watch triggers. Override manually if needed.`
      );
    }

    await interaction.update({
      content:    `📌 Got it — **${title}** will stay on the server.`,
      embeds:     [],
      components: [],
    });
    return;
  }
}

// ============================================================
// Express Server — Webhooks + File Downloads
// ============================================================
function startExpressServer() {
  const app = express();
  const upload = multer();

  // Apply JSON parsing only to non-multipart routes
  app.use((req, res, next) => {
    if (req.is('multipart/form-data')) return next();
    bodyParser.json()(req, res, next);
  });

  // ── Overseerr Webhook ──────────────────────────────────────
  // Seerr may send either JSON or multipart — handle both
  app.post('/webhook/overseerr', upload.any(), async (req, res) => {
    if (WEBHOOK_SECRET) {
      const sig = req.headers['x-webhook-secret'];
      if (sig !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    }

    res.sendStatus(200);

    try {
      let body = req.body;
      if (typeof body.payload === 'string') {
        body = JSON.parse(body.payload);
      }
      await handleOverseerrWebhook(body);
    } catch (err) {
      log.error('[Webhook/Overseerr]', err.message);
    }
  });

  // ── Plex Webhook ───────────────────────────────────────────
  // Plex sends multipart/form-data with a 'payload' JSON field.
  // Fires from all three servers (Durant, Central Iowa, South-Central, California).
  app.post('/webhook/plex', upload.any(), async (req, res) => {
    res.sendStatus(200);

    try {
      const payload = JSON.parse(req.body.payload || '{}');
      await handlePlexWebhook(payload);
    } catch (err) {
      log.error('[Webhook/Plex]', err.message);
    }
  });

  // ── Tautulli Webhook (kept for backwards compatibility) ────
  app.post('/webhook/tautulli', async (req, res) => {
    if (TAUTULLI_SECRET) {
      const sig = req.headers['x-tautulli-secret'];
      if (sig !== TAUTULLI_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    }

    res.sendStatus(200);

    try {
      await handleTautulliWebhook(req.body);
    } catch (err) {
      log.error('[Webhook/Tautulli]', err.message);
    }
  });

  // ── File Download ──────────────────────────────────────────
  app.get('/download/:token', (req, res) => {
    cleanExpiredTokens();

    const record = getDownloadToken(req.params.token);
    if (!record)                       return res.status(404).send('Link not found or expired.');
    if (Date.now() > record.expires_at) {
      deleteDownloadToken(req.params.token);
      return res.status(410).send('This download link has expired.');
    }

    const filePath = record.file_path;
    if (!fs.existsSync(filePath))      return res.status(404).send('File not found on server.');

    const stat     = fs.statSync(filePath);
    const fileSize = stat.size;
    const fileName = path.basename(filePath);
    const mimeType = mimeFor(path.extname(filePath).toLowerCase());

    const range = req.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start     = parseInt(startStr, 10);
      const end       = endStr ? parseInt(endStr, 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range':       `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges':       'bytes',
        'Content-Length':      chunkSize,
        'Content-Type':        mimeType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length':      fileSize,
        'Content-Type':        mimeType,
        'Accept-Ranges':       'bytes',
        'Content-Disposition': `attachment; filename="${fileName}"`,
      });
      fs.createReadStream(filePath).pipe(res);
    }

    log.ok(`Serving "${record.title}" (${fileName})`);
  });

  // ── Health check ───────────────────────────────────────────
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'homepage.html')));

  app.get('/health', (_, res) => res.json({ status: 'ok', uptime: process.uptime() }));

  app.listen(PORT, () => log.ok(`Express server listening on port ${PORT}`));
}

// ============================================================
// Overseerr Webhook Handler
// ============================================================
async function handleOverseerrWebhook(body) {
  const { notification_type, subject, message, media, request } = body;
  if (!notification_type || !media) return;

  const titleMatch = subject?.match(/^.+? - (.+)$/);
  const title      = titleMatch ? titleMatch[1] : (subject || 'Unknown Title');

  const is4k     = media.is4k || false;
  const label    = mediaTypeLabel(media.media_type, is4k);
  const emoji    = mediaTypeEmoji(media.media_type, is4k);

  const mediaId  = media.media_type === 'tv'
    ? `tvdb:${media.tvdbId}`
    : `tmdb:${media.tmdbId}`;

  // Resolve requester Discord ID from DB
  const requesterEmail     = request?.requestedBy_email;
  const dbUser             = requesterEmail ? getUserByEmail(requesterEmail) : null;
  const requesterDiscordId = request?.requestedBy_settings_discordId || dbUser?.discord_id || null;

  // ── New request pending approval ──────────────────────────
  if (notification_type === 'MEDIA_PENDING') {
    const adminChannel = await safeGetChannel(ADMIN_CHANNEL_ID);
    if (!adminChannel) return;

    // Fetch poster + extra details from Seerr
    let posterUrl = null;
    let overview  = message || null;
    let year      = null;
    try {
      const mediaEndpoint = media.media_type === 'tv'
        ? `${OVERSEERR_URL}/api/v1/tv/${media.tvdbId}`
        : `${OVERSEERR_URL}/api/v1/movie/${media.tmdbId}`;
      const mediaRes = await axios.get(mediaEndpoint, {
        headers: { 'X-Api-Key': OVERSEERR_API_KEY },
      });
      const md = mediaRes.data;
      if (md.posterPath) {
        posterUrl = `https://image.tmdb.org/t/p/w200${md.posterPath}`;
      }
      if (md.overview)    overview = md.overview;
      if (md.releaseDate) year = md.releaseDate.slice(0, 4);
      if (md.firstAirDate) year = md.firstAirDate.slice(0, 4);
    } catch (err) {
      log.warn('[Overseerr] Could not fetch media details:', err.message);
    }

    // Resolve requester display
    const requesterDisplay = requesterDiscordId
      ? `<@${requesterDiscordId}>`
      : (requesterEmail || 'Unknown');

    const displayTitle = year ? `${title} (${year})` : title;

    const embed = new EmbedBuilder()
      .setTitle(`${emoji} New Request — ${label}`)
      .setDescription(`**${displayTitle}**${overview ? `

${overview.slice(0, 200)}${overview.length > 200 ? '…' : ''}` : ''}`)
      .addFields(
        { name: 'Requested By', value: requesterDisplay,       inline: true },
        { name: 'Type',         value: label,                  inline: true },
      )
      .setColor(0x3b82f6)
      .setTimestamp();

    if (posterUrl) embed.setThumbnail(posterUrl);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`overseerr_approve:${request.request_id}`)
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`overseerr_deny:${request.request_id}`)
        .setLabel('Deny')
        .setStyle(ButtonStyle.Danger),
    );

    await adminChannel.send({ embeds: [embed], components: [row] });
  }

  // Store request ownership in DB for all relevant events
  if (['MEDIA_PENDING', 'MEDIA_APPROVED', 'MEDIA_AVAILABLE'].includes(notification_type)) {
    const status = notification_type === 'MEDIA_APPROVED' ? 'approved'
      : notification_type === 'MEDIA_AVAILABLE' ? 'available'
      : 'pending';

    upsertRequest(
      request?.request_id?.toString() || null,
      mediaId,
      media.media_type,
      is4k,
      title,
      requesterDiscordId,
      status,
    );
  }

  // ── Media now available — DM the requester ─────────────────
  if (notification_type === 'MEDIA_AVAILABLE' && requesterDiscordId) {
    try {
      const discordUser = await client.users.fetch(requesterDiscordId);
      await discordUser.send(
        `✅ **${title}** (${label}) is now available on Plex!\n` +
        `Use \`/download title:${title}\` in Discord to download it directly.`
      );
    } catch (err) {
      log.warn('[Overseerr] Could not DM requester:', err.message);
    }
  }
}

// ============================================================
// Plex Webhook Handler
// Fires from all Plex servers on media.scrobble (90% watched)
// ============================================================
async function handlePlexWebhook(payload) {
  const { event, Account, Metadata } = payload;

  // Only care about scrobble (90% watched)
  if (event !== 'media.scrobble') return;
  if (!Account || !Metadata)       return;

  const userEmail  = Account.title; // Plex uses username here; email lookup below
  const mediaType  = Metadata.type; // 'movie' or 'episode'
  const title      = Metadata.title;
  const showTitle  = mediaType === 'episode'
    ? (Metadata.grandparentTitle || title)
    : title;

  // Resolve resolution from Metadata streams
  const videoStream = Metadata.Media?.[0]?.Part?.[0]?.Stream?.find(s => s.streamType === 1);
  const resolution  = videoStream?.displayTitle || '';
  const is4k        = resolution.toLowerCase().includes('4k') ||
                      resolution.toLowerCase().includes('2160');

  // Only prompt for 4K movies and TV shows (any res)
  if (mediaType === 'movie' && !is4k) {
    log.info(`[Plex] Skipping non-4K movie "${showTitle}" — no deletion prompt`);
    return;
  }

  // Resolve media ID from TMDB/TVDB GUIDs
  let mediaId;
  const guids = Metadata.Guid || [];

  if (mediaType === 'movie') {
    const tmdbGuid = guids.find(g => g.id?.startsWith('tmdb://'));
    if (!tmdbGuid) return;
    mediaId = `tmdb:${tmdbGuid.id.replace('tmdb://', '')}`;
  } else if (mediaType === 'episode') {
    const tvdbGuid = guids.find(g => g.id?.startsWith('tvdb://'));
    if (!tvdbGuid) return;
    mediaId = `tvdb:${tvdbGuid.id.replace('tvdb://', '')}`;
  } else {
    return;
  }

  // Skip if on the keep list
  if (isInKeepList(mediaId)) {
    log.info(`[Plex] ${mediaId} is in keep list — skipping`);
    return;
  }

  // Only prompt if the file was requested by someone
  const request = getRequestByMediaId(mediaId);
  if (!request || !request.requested_by_discord_id) {
    log.info(`[Plex] ${mediaId} has no known requester — skipping deletion prompt`);
    return;
  }

  // Match watcher to requester — check both by Plex username and email
  const watcherByEmail    = getUserByEmail(Account.title);
  const watcherByUsername = db.prepare('SELECT * FROM users WHERE plex_username = ?').get(Account.title);
  const watcher           = watcherByEmail || watcherByUsername;

  if (!watcher || watcher.discord_id !== request.requested_by_discord_id) {
    return;
  }

  const label = mediaTypeLabel(mediaType === 'episode' ? 'tv' : 'movie', is4k);
  const emoji = mediaTypeEmoji(mediaType === 'episode' ? 'tv' : 'movie', is4k);

  const adminChannel = await safeGetChannel(ADMIN_CHANNEL_ID);
  if (!adminChannel) return;

  const embed = new EmbedBuilder()
    .setTitle(`${emoji} Finished Watching — ${label}`)
    .setDescription(
      `<@${request.requested_by_discord_id}> just finished **${showTitle}**.\n\n` +
      `Would you like to delete it to free up space?`
    )
    .setColor(0xf59e0b)
    .setTimestamp();

  const encodedTitle = encodeURIComponent(showTitle);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`delete_yes:${mediaId}:${encodedTitle}:${request.requested_by_discord_id}`)
      .setLabel('Yes, Delete It')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`delete_no:${mediaId}:${encodedTitle}:${request.requested_by_discord_id}`)
      .setLabel('No, Keep It')
      .setStyle(ButtonStyle.Secondary),
  );

  await adminChannel.send({
    content:    `<@${request.requested_by_discord_id}>`,
    embeds:     [embed],
    components: [row],
  });

  log.ok(`[Plex] Sent deletion prompt for "${showTitle}" to ${request.requested_by_discord_id}`);
}

// ============================================================
// Tautulli Webhook Handler (legacy — kept for compatibility)
// ============================================================
async function handleTautulliWebhook(body) {
  const { event, user_email, media_type, title, grandparent_title, tmdb_id, tvdb_id, is_4k } = body;

  if (event !== 'watched') return;
  if (!user_email)          return;

  const is4k = typeof is_4k === 'string' && is_4k.toLowerCase().includes('4k');

  if (media_type === 'movie' && !is4k) {
    log.info(`[Tautulli] Skipping non-4K movie — no deletion prompt`);
    return;
  }

  let mediaId;
  if (media_type === 'movie') {
    if (!tmdb_id) return;
    mediaId = `tmdb:${tmdb_id}`;
  } else if (media_type === 'episode') {
    if (!tvdb_id) return;
    mediaId = `tvdb:${tvdb_id}`;
  } else {
    return;
  }

  if (isInKeepList(mediaId)) return;

  const request = getRequestByMediaId(mediaId);
  if (!request || !request.requested_by_discord_id) return;

  const watcher = getUserByEmail(user_email);
  if (!watcher || watcher.discord_id !== request.requested_by_discord_id) return;

  const showTitle = media_type === 'episode' ? (grandparent_title || title) : title;
  const label     = mediaTypeLabel(media_type === 'episode' ? 'tv' : 'movie', is4k);
  const emoji     = mediaTypeEmoji(media_type === 'episode' ? 'tv' : 'movie', is4k);

  const adminChannel = await safeGetChannel(ADMIN_CHANNEL_ID);
  if (!adminChannel) return;

  const embed = new EmbedBuilder()
    .setTitle(`${emoji} Finished Watching — ${label}`)
    .setDescription(
      `<@${request.requested_by_discord_id}> just finished **${showTitle}**.\n\n` +
      `Would you like to delete it to free up space?`
    )
    .setColor(0xf59e0b)
    .setTimestamp();

  const encodedTitle = encodeURIComponent(showTitle);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`delete_yes:${mediaId}:${encodedTitle}:${request.requested_by_discord_id}`)
      .setLabel('Yes, Delete It')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`delete_no:${mediaId}:${encodedTitle}:${request.requested_by_discord_id}`)
      .setLabel('No, Keep It')
      .setStyle(ButtonStyle.Secondary),
  );

  await adminChannel.send({
    content:    `<@${request.requested_by_discord_id}>`,
    embeds:     [embed],
    components: [row],
  });

  log.ok(`[Tautulli] Sent deletion prompt for "${showTitle}" to ${request.requested_by_discord_id}`);
}

// ============================================================
// Utilities
// ============================================================
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function mimeFor(ext) {
  const map = {
    '.mkv': 'video/x-matroska',
    '.mp4': 'video/mp4',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.wmv': 'video/x-ms-wmv',
  };
  return map[ext] || 'application/octet-stream';
}

async function safeGetChannel(channelId) {
  try {
    return await client.channels.fetch(channelId);
  } catch (err) {
    log.warn(`Could not fetch channel ${channelId}: ${err.message}`);
    return null;
  }
}

// ============================================================
// Boot
// ============================================================
if (!DISCORD_BOT_TOKEN) {
  log.error('DISCORD_BOT_TOKEN is required');
  process.exit(1);
}

client.login(DISCORD_BOT_TOKEN);
