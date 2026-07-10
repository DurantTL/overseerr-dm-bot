const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { log } = require('./src/log');
const { parseBool, CONFIG, REQUIRED_ENV, validateConfig, configWarnings } = require('./src/config');
const { sha256, safeEqual, isSnowflake, canonicalizeEmail, isValidEmail, mediaTypeLabel, mediaTypeEmoji, requestStatusBadge, discordTimestamp, statusEmoji, pad, mimeFor, gb, fmtSpace, progressBar, queuePercent, queueItemLooksUnhealthy } = require('./src/util');
const { db, ensureColumn, runMigrations, audit, storeUserEmail, linkUserToEmail, getUserByDiscordId, getUserByCanonicalEmail, markUserInvited, markOverseerrCreated, removeUser, upsertRequest, addToKeepList, isInKeepList, recordPendingDeletion, markPendingDeletion, postponePendingDeletion, createDownloadToken, getDownloadRecordByRawToken, revokeAllDownloadLinks, cleanExpiredTokens, getSetting, setSetting, stashPendingRequest, takePendingRequest, restashPendingRequest } = require('./src/db');
const { PLEX_CLIENT_ID, getPlexToken, plexApiGet, getPlexServers, inviteUserToPlex, removePlexAccess } = require('./src/plex');
const { setOverseerrDiscordNotification, createOverseerrUser, runSeerrSelfTest, searchSeerr, checkExistingSeerrMedia, createSeerrRequestAs, resolveSeerrUserId, approveOverseerrRequest, denyOverseerrRequest, fetchOverseerrUsers } = require('./src/seerr');
const { radarrGetFrom, sonarrGet, arrSources, arrSourceByLabel, fetchArrQueues, fetchDiskSpace, searchMovies, searchSeries, getEpisodeFiles, resolveDeletableMedia, executeDeletion, remapPath } = require('./src/arr');
const { tautulliConfigured, tautulliApi, describeSession } = require('./src/tautulli');
const { premiumizeConfigured, accountInfo, listTransfers, deleteTransfer, retryTransfer, clearFinished, findStuckTransfers, isStuckCandidate } = require('./src/premiumize');

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

// Per-topic notification routing. Every kind falls back to ADMIN_CHANNEL_ID when its channel
// isn't configured, so single-channel deployments behave exactly as before. Exception: 'deploy'
// never falls back — a bot-online ping on every Watchtower restart would spam the admin channel.
// 'playback' is reserved for future Tautulli now-playing alerts (nothing emits to it yet).
function channelFor(kind) {
  const map = {
    requests: CONFIG.REQUESTS_CHANNEL_ID,
    system: CONFIG.SYSTEM_ALERTS_CHANNEL_ID,
    downloads: CONFIG.DOWNLOADS_CHANNEL_ID,
    playback: CONFIG.PLAYBACK_CHANNEL_ID,
    cleanup: CONFIG.CLEANUP_CHANNEL_ID,
    audit: CONFIG.AUDIT_CHANNEL_ID,
    deploy: CONFIG.DEPLOY_CHANNEL_ID || null,
  };
  const configured = Object.prototype.hasOwnProperty.call(map, kind) ? map[kind] : undefined;
  if (kind === 'deploy') return configured;
  return configured || CONFIG.ADMIN_CHANNEL_ID;
}

function notifyChannel(kind, msg) {
  const channelId = channelFor(kind);
  if (!channelId) return;
  safeGetChannel(channelId)
    .then(ch => ch && ch.send(msg).catch(() => {}))
    .catch(() => {});
}

function notifyAdmin(msg) {
  notifyChannel('admin', msg);
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
const requestCommandLimits = new Map();

// Keyed by client IP / user id, these maps only ever grew. Drop buckets whose newest hit is
// older than an hour so a scan of unique IPs can't slowly eat memory.
const RATE_LIMIT_MAPS = [routeLimits, userGenerationLimits, requestCommandLimits];
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const map of RATE_LIMIT_MAPS) {
    for (const [key, hits] of map) {
      if (!hits.length || hits[hits.length - 1] < cutoff) map.delete(key);
    }
  }
}, 600000).unref();

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

// Seerr request ids the bot already announced in Discord (admin /request creates and gate
// approvals). The MEDIA_PENDING/MEDIA_AUTO_APPROVED webhook checks this set so those requests
// don't get a second embed. Memory-only: a restart in the seconds between the two at worst
// repeats one embed.
const postedApprovalNotices = new Set();
function markApprovalNoticePosted(requestId) {
  postedApprovalNotices.add(String(requestId));
  if (postedApprovalNotices.size > 500) postedApprovalNotices.delete(postedApprovalNotices.values().next().value);
}

// Post the Approve/Deny gate embed for a stashed /request to the requests channel.
async function postPendingRequestNotice(nonce, { label, mediaType, is4k, discordId, email }) {
  const channel = await safeGetChannel(channelFor('requests'));
  if (!channel) return false;
  const embed = brandedEmbed(COLORS.INFO)
    .setTitle(`${mediaTypeEmoji(mediaType, is4k)} New Request`)
    .setDescription(`**${label}**`)
    .addFields(
      { name: 'Requested by', value: `<@${discordId}> · \`${email}\``, inline: true },
      { name: 'Type', value: mediaTypeLabel(mediaType, is4k), inline: true },
      { name: 'Status', value: '⏳ Awaiting approval', inline: true },
    )
    .setFooter({ text: 'Durant Media Server · Not sent to Seerr until approved' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`request_approve:${nonce}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`request_deny:${nonce}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
  );
  await channel.send({ embeds: [embed], components: [row] });
  return true;
}

// ---- Stuck-download watchdog ----
// Downloads with no seeders (or import problems) sit in the queue forever with frozen
// progress. Track byte movement per queue item; when one hasn't moved for
// STUCK_AFTER_MINUTES (or the *arr flags it), alert the admin channel with one-click
// actions: remove+blocklist+search another release, remove only, or ignore.
const stuckTracker = new Map(); // `${label}:${queueId}` -> { sizeleft, since, alertedAt }

async function sweepStuckDownloads() {
  const items = await fetchArrQueues();
  const now = Date.now();
  const seen = new Set();
  for (const item of items) {
    const key = `${item.source.label}:${item.queueId}`;
    seen.add(key);
    if (getSetting(`stuck_ignore:${key}`)) continue;

    let entry = stuckTracker.get(key);
    if (!entry || entry.sizeleft !== item.sizeleft) {
      entry = { sizeleft: item.sizeleft, since: now, alertedAt: entry?.alertedAt || 0 };
      stuckTracker.set(key, entry);
      continue; // progress (or first sighting) — nothing to flag yet
    }

    const unhealthy = queueItemLooksUnhealthy(item);
    const shouldBeMoving = item.status === 'downloading' || item.trackedState === 'downloading';
    const frozenMs = now - entry.since;
    if (!(unhealthy || shouldBeMoving)) continue;
    if (frozenMs < CONFIG.STUCK_AFTER_MINUTES * 60000) continue;
    if (now - entry.alertedAt < CONFIG.STUCK_ALERT_COOLDOWN_HOURS * 3600000) continue;

    entry.alertedAt = now;
    const pct = queuePercent(item);
    const embed = brandedEmbed(COLORS.WARN)
      .setTitle('🧊 Download Stuck')
      .setDescription(`**${item.title}** hasn't moved in ${Math.round(frozenMs / 60000)} minutes.`)
      .addFields(
        { name: 'Progress', value: `${progressBar(pct)} ${pct}%`, inline: true },
        { name: 'Source', value: item.source.label, inline: true },
        { name: 'Status', value: item.trackedStatus || item.status || 'unknown', inline: true },
      );
    if (item.messages.length) embed.addFields({ name: 'Reported problems', value: item.messages.map(m => `• ${m}`).join('\n').slice(0, 1000), inline: false });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`stuck_retry:${key}`).setLabel('Remove & Try Another Release').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`stuck_rm:${key}`).setLabel('Remove Only').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`stuck_ignore:${key}`).setLabel('Ignore').setStyle(ButtonStyle.Secondary),
    );
    notifyChannel('downloads', { embeds: [embed], components: [row] });
    audit('stuck_download_detected', { label: item.source.label, queueId: item.queueId, title: item.title, frozenMinutes: Math.round(frozenMs / 60000) });
  }

  // Forget items that left the queue, and clear their ignore flags so a future
  // download reusing the same queue id can't be silently ignored.
  for (const key of stuckTracker.keys()) {
    if (!seen.has(key)) stuckTracker.delete(key);
  }
  const ignoreRows = db.prepare("SELECT key FROM app_settings WHERE key LIKE 'stuck_ignore:%'").all();
  for (const r of ignoreRows) {
    if (!seen.has(r.key.slice('stuck_ignore:'.length))) db.prepare('DELETE FROM app_settings WHERE key = ?').run(r.key);
  }
}

// ---- Janitor: grace-period auto-delete, retention rules, disk-space alerts ----

// Alert the playback channel when a session is video-transcoding (the expensive kind; audio-only
// transcodes are cheap and ignored). One alert per session+media per cooldown window.
const transcodeAlerted = new Map(); // `${user}:${rating_key}` -> last alert ts
async function sweepTranscodes() {
  if (!tautulliConfigured()) return;
  const data = await tautulliApi('get_activity');
  const sessions = data?.sessions || [];
  const now = Date.now();
  for (const [key, ts] of transcodeAlerted) {
    if (now - ts > 24 * 3600000) transcodeAlerted.delete(key);
  }
  for (const s of sessions) {
    if (s.video_decision !== 'transcode') continue;
    const key = `${s.user_id || s.user}:${s.rating_key}`;
    const last = transcodeAlerted.get(key) || 0;
    if (now - last < CONFIG.TRANSCODE_ALERT_COOLDOWN_MINUTES * 60000) continue;
    transcodeAlerted.set(key, now);
    notifyChannel('playback', { embeds: [brandedEmbed(COLORS.WARN)
      .setTitle('🔥 Heavy Transcode')
      .setDescription(describeSession(s))
      .addFields({ name: 'Player', value: `${s.player || 'unknown'} (${s.platform || '?'})`, inline: true })] });
    audit('transcode_alert', { user: s.friendly_name || s.user, title: s.full_title, from: s.video_full_resolution, to: s.stream_video_full_resolution });
  }
}

// ---- Premiumize stuck-transfer watchdog ----
// Transfers that error out, or sit with frozen progress (0% forever = no cached source /
// dead torrent), never reach the *arr queue — the stuck-download watchdog can't see them.
// Alert the downloads channel with one-click Retry / Clear / Ignore.
const pmTracker = new Map(); // transfer id -> { progress, since }
const pmAlerted = new Map(); // transfer id -> last alert ts
async function sweepPremiumizeTransfers() {
  if (!premiumizeConfigured()) return;
  const transfers = await listTransfers();
  const now = Date.now();
  const currentIds = new Set(transfers.map(t => String(t.id)));
  for (const [id, ts] of pmAlerted) {
    if (!currentIds.has(id) || now - ts > 48 * 3600000) pmAlerted.delete(id);
  }
  // Ignore flags are per transfer id; drop them once the transfer leaves the list so a reused
  // id can't be silently ignored (same pattern as stuck_ignore:).
  for (const r of db.prepare("SELECT key FROM app_settings WHERE key LIKE 'pm_ignore:%'").all()) {
    if (!currentIds.has(r.key.slice('pm_ignore:'.length))) db.prepare('DELETE FROM app_settings WHERE key = ?').run(r.key);
  }

  const stuck = findStuckTransfers(transfers, pmTracker, { stuckAfterMs: CONFIG.PREMIUMIZE_STUCK_AFTER_MINUTES * 60000, now });
  for (const t of stuck) {
    const id = String(t.id);
    if (getSetting(`pm_ignore:${id}`)) continue;
    if (now - (pmAlerted.get(id) || 0) < CONFIG.PREMIUMIZE_ALERT_COOLDOWN_HOURS * 3600000) continue;
    pmAlerted.set(id, now);
    const pct = Math.round(Number(t.progress || 0) * 100);
    const embed = brandedEmbed(COLORS.WARN)
      .setTitle('🧊 Premiumize Transfer Stuck')
      .setDescription(`**${String(t.name || 'unnamed').slice(0, 200)}**`)
      .addFields(
        { name: 'Status', value: String(t.status || 'unknown'), inline: true },
        { name: 'Progress', value: `${progressBar(pct)} ${pct}%`, inline: true },
      );
    if (t.message) embed.addFields({ name: 'Message', value: String(t.message).slice(0, 500), inline: false });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pm_retry:${id}`).setLabel('Retry').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`pm_clear:${id}`).setLabel('Clear Transfer').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`pm_ignore:${id}`).setLabel('Ignore').setStyle(ButtonStyle.Secondary),
    );
    notifyChannel('downloads', { embeds: [embed], components: [row] });
    audit('premiumize_transfer_stuck', { transferId: id, name: t.name, status: t.status, progress: t.progress });
  }
}

// Enforce the "Auto-deletes in N hours unless you choose Keep" promise. Every guard rail is
// re-checked at execution time: deletion enabled, keep list, never-delete list.
async function sweepGraceDeletions() {
  if (!CONFIG.ENABLE_DELETION) return;
  const due = db.prepare("SELECT * FROM pending_deletions WHERE status = 'pending' AND delete_after < ?").all(Date.now());
  for (const row of due) {
    if (isInKeepList(row.media_id) || CONFIG.NEVER_DELETE_MEDIA_IDS.includes(row.media_id)) {
      markPendingDeletion(row.media_id, 'kept');
      continue;
    }
    const result = await executeDeletion(row.media_id, row.title, { requestorId: row.requestor_discord_id, reason: 'grace_expired' });
    if (result.outcome === 'error') continue; // transient *arr failure — retry next sweep
    if (result.outcome === 'not_found') { markPendingDeletion(row.media_id, 'cancelled'); continue; }
    if (result.outcome === 'dry_run') {
      markPendingDeletion(row.media_id, 'dry_run');
      notifyChannel('cleanup', { embeds: [brandedEmbed(COLORS.WARN)
        .setTitle('🧪 Janitor Dry-Run')
        .setDescription(`Grace period expired for **${row.title}** — would have deleted ${result.paths.length} file(s).\nSet \`DELETION_DRY_RUN=false\` to let the janitor delete for real.`)] });
      continue;
    }
    markPendingDeletion(row.media_id, 'deleted');
    notifyChannel('cleanup', { embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle('🧹 Auto-Deleted After Grace Period')
      .setDescription(`**${row.title}** — no response to the keep prompt within ${CONFIG.DELETION_GRACE_HOURS}h.\n${result.detail}`)] });
    await dmUser(row.requestor_discord_id, { embeds: [brandedEmbed(COLORS.INFO)
      .setTitle('🧹 Freed Up Space')
      .setDescription(`**${row.title}** was removed since we didn't hear back on the keep prompt.\nWant it back? Just request it again anytime!`)] });
  }
}

// Age-based cleanup driven by the media_retention_rules table: movie_4k / movie_1080p apply to
// the matching Radarr instance, tv_episode to Sonarr episode files. (tv_season is reserved.)
// Deletes oldest-first, capped per run, and honors keep list / never-delete / kept decisions.
async function sweepRetentionRules() {
  const rules = Object.fromEntries(db.prepare('SELECT media_class, retention_days FROM media_retention_rules WHERE enabled = 1').all().map(r => [r.media_class, r.retention_days]));
  const now = Date.now();
  const candidates = [];

  const movieSources = [
    { url: CONFIG.RADARR_URL, key: CONFIG.RADARR_API_KEY, rule: rules.movie_1080p },
    { url: CONFIG.RADARR_4K_URL, key: CONFIG.RADARR_4K_API_KEY, rule: rules.movie_4k },
  ].filter(s => s.url && s.rule > 0);
  for (const s of movieSources) {
    const movies = await radarrGetFrom(s.url, s.key, '/movie').catch(() => []);
    for (const m of movies) {
      if (!m.hasFile || !m.movieFile?.dateAdded) continue;
      const ageDays = (now - Date.parse(m.movieFile.dateAdded)) / 86400000;
      if (ageDays < s.rule) continue;
      candidates.push({ kind: 'movie', mediaId: `tmdb:${m.tmdbId}`, title: `${m.title}${m.year ? ` (${m.year})` : ''}`, ageDays, sizeBytes: m.movieFile.size || 0 });
    }
  }

  if (CONFIG.SONARR_URL && rules.tv_episode > 0) {
    const seriesList = await sonarrGet('/series').catch(() => []);
    for (const series of seriesList) {
      const files = await getEpisodeFiles(series.id).catch(() => []);
      const old = files.filter(f => f.dateAdded && (now - Date.parse(f.dateAdded)) / 86400000 >= rules.tv_episode);
      if (!old.length) continue;
      const oldest = Math.max(...old.map(f => (now - Date.parse(f.dateAdded)) / 86400000));
      // Only the aged episode files are deleted — never the whole series.
      candidates.push({ kind: 'tv', mediaId: `tvdb:${series.tvdbId}`, title: `${series.title} (${old.length} old episode file(s))`, ageDays: oldest, sizeBytes: old.reduce((a, f) => a + (f.size || 0), 0), fileIds: old.map(f => f.id) });
    }
  }

  // Skip items mid-grace-flow ('pending'); expired keep protection is governed by the
  // keep_list expiry itself, so a historical 'kept' status doesn't block forever.
  const eligible = candidates
    .filter(c => !isInKeepList(c.mediaId) && !CONFIG.NEVER_DELETE_MEDIA_IDS.includes(c.mediaId))
    .filter(c => !db.prepare("SELECT id FROM pending_deletions WHERE media_id = ? AND status = 'pending'").get(c.mediaId))
    .sort((a, b) => b.ageDays - a.ageDays)
    .slice(0, CONFIG.RETENTION_MAX_DELETES_PER_RUN);
  if (!eligible.length) return;

  const totalGb = gb(eligible.reduce((a, c) => a + c.sizeBytes, 0)).toFixed(1);
  const list = eligible.map(c => `• **${c.title}** — ${Math.round(c.ageDays)}d old`).join('\n').slice(0, 3500);

  if (CONFIG.DELETION_DRY_RUN) {
    audit('retention_dry_run', { count: eligible.length, items: eligible.map(c => c.mediaId) });
    notifyChannel('cleanup', { embeds: [brandedEmbed(COLORS.WARN)
      .setTitle('🧪 Retention Dry-Run')
      .setDescription(`These ${eligible.length} item(s) exceed their retention rules (~${totalGb} GB):\n${list}\n\nSet \`DELETION_DRY_RUN=false\` to enforce for real.`)] });
    return;
  }

  let deleted = 0;
  const done = [];
  for (const c of eligible) {
    if (c.kind === 'movie') {
      const result = await executeDeletion(c.mediaId, c.title, { reason: 'retention_rule' });
      if (result.outcome === 'deleted') { deleted++; done.push(c); }
      continue;
    }
    // TV: delete only the aged episode files, never the series (executeDeletion would wipe all files).
    let n = 0;
    for (const id of c.fileIds) {
      try {
        await axios.delete(`${CONFIG.SONARR_URL}/api/v3/episodefile/${id}`, { params: { apikey: CONFIG.SONARR_API_KEY } });
        n++;
      } catch (err) {
        audit('external_api_error', { provider: 'sonarr', error: err.message, action: 'retention_delete', episodeFileId: id });
      }
    }
    if (n) {
      deleted++;
      done.push(c);
      audit('media_deleted', { mediaId: c.mediaId, title: c.title, reason: 'retention_rule', filesDeleted: n, filesAttempted: c.fileIds.length });
    }
  }
  audit('retention_enforced', { deleted, attempted: eligible.length });
  notifyChannel('cleanup', { embeds: [brandedEmbed(COLORS.SUCCESS)
    .setTitle('🧹 Retention Cleanup')
    .setDescription(`Deleted ${deleted}/${eligible.length} item(s) past their retention window (~${totalGb} GB):\n${done.map(c => `• **${c.title}**`).join('\n').slice(0, 3500) || '(none)'}`)] });
}

async function sweepDiskSpace() {
  if (CONFIG.DISK_SPACE_WARN_GB <= 0) return;
  const disks = await fetchDiskSpace();
  const low = disks.filter(d => gb(d.freeSpace || 0) < CONFIG.DISK_SPACE_WARN_GB);
  if (!low.length) { db.prepare('DELETE FROM app_settings WHERE key = ?').run('disk_alert_last'); return; }
  const last = Number(getSetting('disk_alert_last') || '0');
  if (Date.now() - last < 24 * 3600000) return;
  setSetting('disk_alert_last', String(Date.now()));
  notifyChannel('system', { embeds: [brandedEmbed(COLORS.DANGER)
    .setTitle('💾 Low Disk Space')
    .setDescription(low.map(d => `**${d.displayPath || d.path}** — ${fmtSpace(d.freeSpace)} free of ${fmtSpace(d.totalSpace)}`).join('\n') + `\n\nThreshold: ${CONFIG.DISK_SPACE_WARN_GB} GB. Consider \`/queue\`, retention rules, or manual cleanup.`)] });
  audit('disk_space_alert', { disks: low.map(d => ({ path: d.path, freeGb: Math.round(gb(d.freeSpace)) })) });
}

async function janitorSweep() {
  await sweepGraceDeletions().catch(err => log.warn(`Grace sweep failed: ${err.message}`));
  await sweepDiskSpace().catch(err => log.warn(`Disk sweep failed: ${err.message}`));
  if (CONFIG.RETENTION_ENFORCEMENT) {
    const last = Number(getSetting('retention_last_run') || '0');
    if (Date.now() - last >= CONFIG.RETENTION_CHECK_HOURS * 3600000) {
      setSetting('retention_last_run', String(Date.now()));
      await sweepRetentionRules().catch(err => log.warn(`Retention sweep failed: ${err.message}`));
    }
  }
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

async function safeGetChannel(channelId) {
  try { return await client.channels.fetch(channelId); } catch (_e) { return null; }
}

function isAdminInteraction(interaction) {
  return interaction.user.id === CONFIG.ADMIN_USER_ID || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

const slashCommands = [
  new SlashCommandBuilder().setName('download').setDescription('Get a secure download link').addStringOption(o => o.setName('title').setDescription('Movie or show title').setRequired(true)).addIntegerOption(o => o.setName('season').setDescription('Season number')).addIntegerOption(o => o.setName('episode').setDescription('Episode number')).addBooleanOption(o => o.setName('one_time').setDescription('One-time download link')),
  new SlashCommandBuilder().setName('request').setDescription('Request a movie or show (searches Seerr)').addStringOption(o => o.setName('title').setDescription('Start typing to search — pick from the list').setRequired(true).setAutocomplete(true)).addBooleanOption(o => o.setName('is4k').setDescription('Request the 4K version')),
  new SlashCommandBuilder().setName('link').setDescription('Link a user to Plex email (invites + sets up Seerr)').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('email').setDescription('Plex email — start typing to search linked/Plex users').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('unlink').setDescription('Unlink a user').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('users').setDescription('List linked users').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('status').setDescription('Show status').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('seerr-test').setDescription('Self-test Seerr Discord linking with a throwaway user').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addBooleanOption(o => o.setName('keep').setDescription('Keep the test user in Seerr so you can inspect its Discord settings')),
  new SlashCommandBuilder().setName('sync').setDescription('Sync users safely').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addStringOption(o => o.setName('mode').setDescription('preview or apply').setRequired(true).addChoices({ name: 'preview', value: 'preview' }, { name: 'apply', value: 'apply' })),
  new SlashCommandBuilder().setName('sync-fix').setDescription('Resolve sync issues found in the preview').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addStringOption(o => o.setName('target').setDescription('Category to fix').setRequired(true).addChoices({ name: 'placeholders', value: 'placeholders' }, { name: 'duplicates', value: 'duplicates' }, { name: 'orphans', value: 'orphans' }, { name: 'mergeemails', value: 'mergeemails' }, { name: 'links', value: 'links' })),
  new SlashCommandBuilder().setName('cleanup').setDescription('Cleanup deleted Overseerr users').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addStringOption(o => o.setName('mode').setDescription('preview or apply').setRequired(false).addChoices({ name: 'preview', value: 'preview' }, { name: 'apply', value: 'apply' })),
  new SlashCommandBuilder().setName('invite').setDescription('Invite a member: bot DMs them for their Plex email and auto-sets them up').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addUserOption(o => o.setName('user').setDescription('Member to invite').setRequired(true)).addStringOption(o => o.setName('email').setDescription('Skip the DM — set them up with this Plex email right away').setAutocomplete(true)),
  new SlashCommandBuilder().setName('invite-post').setDescription('Post a public "Request Plex Access" button in this channel').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('reinvite').setDescription('Re-send a Plex invite to a linked user').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addUserOption(o => o.setName('user').setDescription('Discord user currently in the server')).addStringOption(o => o.setName('email').setDescription('Any linked user — start typing to search the DB').setAutocomplete(true)),
  new SlashCommandBuilder().setName('requests').setDescription('Show the most recent Overseerr requests').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addIntegerOption(o => o.setName('count').setDescription('How many to show (default 10)').setMinValue(1).setMaxValue(25)),
  new SlashCommandBuilder().setName('audit').setDescription('Audit log queries').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('recent').setDescription('Recent entries').addIntegerOption(o => o.setName('count').setDescription('Count').setMinValue(1).setMaxValue(100)))
    .addSubcommand(s => s.setName('user').setDescription('Entries by user').addUserOption(o => o.setName('person').setDescription('User').setRequired(true)).addIntegerOption(o => o.setName('count').setDescription('Count').setMinValue(1).setMaxValue(100)))
    .addSubcommand(s => s.setName('action').setDescription('Entries by action').addStringOption(o => o.setName('action').setDescription('Action name').setRequired(true)).addIntegerOption(o => o.setName('count').setDescription('Count').setMinValue(1).setMaxValue(100))),
  new SlashCommandBuilder().setName('queue').setDescription('Show what is downloading right now'),
  new SlashCommandBuilder().setName('request-status').setDescription('Check why a requested movie or show is not ready yet').addStringOption(o => o.setName('title').setDescription('Start typing — matches your recent requests').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('watching').setDescription('Show current Plex playback (via Tautulli)').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('indexers').setDescription('Prowlarr indexer + Byparr health').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('debrid').setDescription('Premiumize account + transfer status').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('cleanup-suggestions').setDescription('Largest/oldest media that could be cleaned up').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
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
  const warnings = configWarnings();
  for (const w of warnings) log.warn(`Config: ${w.replace(/\*\*/g, '')}`);
  if (warnings.length) {
    notifyChannel('system', { embeds: [brandedEmbed(COLORS.WARN)
      .setTitle('⚙️ Config Warnings')
      .setDescription(warnings.map(w => `• ${w}`).join('\n').slice(0, 4000))] });
  }
  // Deploy ping is opt-in only (channelFor('deploy') is null when unset) — with a fallback,
  // every Watchtower restart would ping the admin channel.
  notifyChannel('deploy', { embeds: [brandedEmbed(COLORS.SUCCESS)
    .setTitle('🚀 Bot Online')
    .setDescription(`Restarted and connected as **${client.user.tag}**${process.env.GIT_SHA ? ` — image \`${process.env.GIT_SHA}\`` : ''}.`)] });
  rehydratePendingEmails();
  await registerSlashCommands();
  startExpressServer();
  if (CONFIG.STUCK_CHECK_MINUTES > 0 && arrSources().length) {
    setInterval(() => sweepStuckDownloads().catch(err => log.warn(`Stuck-download sweep failed: ${err.message}`)), CONFIG.STUCK_CHECK_MINUTES * 60000).unref();
    log.ok(`Stuck-download watchdog running every ${CONFIG.STUCK_CHECK_MINUTES} min (threshold ${CONFIG.STUCK_AFTER_MINUTES} min)`);
  }
  if (CONFIG.JANITOR_CHECK_MINUTES > 0) {
    setInterval(() => janitorSweep(), CONFIG.JANITOR_CHECK_MINUTES * 60000).unref();
    log.ok(`Janitor running every ${CONFIG.JANITOR_CHECK_MINUTES} min (grace deletes: ${CONFIG.ENABLE_DELETION ? 'on' : 'off'}, retention: ${CONFIG.RETENTION_ENFORCEMENT ? 'on' : 'off'}, dry-run: ${CONFIG.DELETION_DRY_RUN ? 'on' : 'off'})`);
  }
  if (tautulliConfigured() && CONFIG.PLAYBACK_CHECK_MINUTES > 0) {
    setInterval(() => sweepTranscodes().catch(err => log.warn(`Transcode sweep failed: ${err.message}`)), CONFIG.PLAYBACK_CHECK_MINUTES * 60000).unref();
    log.ok(`Transcode watchdog running every ${CONFIG.PLAYBACK_CHECK_MINUTES} min`);
  }
  if (premiumizeConfigured() && CONFIG.PREMIUMIZE_CHECK_MINUTES > 0) {
    setInterval(() => sweepPremiumizeTransfers().catch(err => log.warn(`Premiumize sweep failed: ${err.message}`)), CONFIG.PREMIUMIZE_CHECK_MINUTES * 60000).unref();
    log.ok(`Premiumize transfer watchdog running every ${CONFIG.PREMIUMIZE_CHECK_MINUTES} min (stuck after ${CONFIG.PREMIUMIZE_STUCK_AFTER_MINUTES} min)`);
  }
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
    const adminChannel = await safeGetChannel(channelFor('audit'));
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
    notifyChannel('audit', `⚠️ User left Discord: <@${member.id}> (${user.email}). Plex removed: ${result.removed ? 'yes' : 'no'}`);
  } catch (err) {
    audit('external_api_error', { targetDiscordId: member.id, provider: 'plex', error: err.message });
    notifyChannel('audit', `⚠️ Failed to remove Plex access for ${user.email}: ${err.message}`);
  }
});

// Post the Approve/Deny access-request embed to the admin channel. Shared by the DM email flow
// and the public Request Access modal.
async function postAccessRequestToAdmins(user, email) {
  const adminChannel = await safeGetChannel(CONFIG.ADMIN_CHANNEL_ID);
  if (!adminChannel) return;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`plex_approve:${user.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`plex_deny:${user.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
  );
  const requestEmbed = brandedEmbed(COLORS.INFO)
    .setTitle('🔐 New Plex Access Request')
    .addFields({ name: 'User', value: `<@${user.id}>`, inline: true }, { name: 'Email', value: `\`${email}\``, inline: true });
  const avatarUrl = user.displayAvatarURL?.();
  if (avatarUrl) requestEmbed.setThumbnail(avatarUrl);
  await adminChannel.send({ embeds: [requestEmbed], components: [row] });
}

client.on('messageCreate', async message => {
  if (message.author.bot || message.guild) return;
  if (!hasPendingEmail(message.author.id)) return;
  const email = message.content.trim().toLowerCase();
  if (!isValidEmail(email)) return message.reply('That does not look like a valid email. Try again.');
  clearPendingEmail(message.author.id);

  // Admin-initiated invite (/invite): the admin already vouched for this person, so skip the
  // Approve button and run the full chain (absorb + Plex invite + Seerr) the moment they reply.
  if (getSetting(`admin_invited:${message.author.id}`)) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`admin_invited:${message.author.id}`);
    const { absorbed, plexStatus, seerrStatus } = await applyFullChainLink(message.author.id, email, message.author.username);
    audit('user_linked', { targetDiscordId: message.author.id, email, source: 'admin_invite_auto', absorbedPlexRow: absorbed?.discord_id || null });
    const hadAccess = plexStatus.includes('already');
    await message.reply({ embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle('🎉 You\'re In!')
      .setDescription(hadAccess
        ? `You're all set — \`${email}\` already has Plex access. Use \`/help\` here to see everything I can do. 🍿`
        : `📬 A Plex invite was sent to \`${email}\` — accept it and you're set. Use \`/help\` here to see everything I can do. 🍿`)] });
    notifyChannel('audit', { embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle('✅ Admin Invite Completed')
      .setDescription(`<@${message.author.id}> replied with \`${email}\` — auto-approved.`)
      .addFields(
        { name: 'Plex', value: plexStatus, inline: true },
        { name: 'Seerr', value: seerrStatus, inline: true },
      )] });
    return;
  }

  // linkUserToEmail (not storeUserEmail) so an existing plex_ synthetic row with the same email is
  // absorbed instead of becoming a duplicate pair — e.g. an existing Plex friend joining Discord.
  linkUserToEmail(message.author.id, email);
  audit('user_linked', { targetDiscordId: message.author.id, email });
  await message.reply('✅ Thanks! Your request has been sent to the admins for approval. You\'ll get a DM here as soon as you\'re approved.');
  await postAccessRequestToAdmins(message.author, email);
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isAutocomplete()) return handleAutocomplete(interaction);
    if (interaction.isChatInputCommand()) await handleSlashCommand(interaction);
    if (interaction.isButton()) await handleButton(interaction);
    if (interaction.isModalSubmit()) await handleModalSubmit(interaction);
  } catch (err) {
    audit('external_api_error', { actorDiscordId: interaction.user?.id, error: err.message, action: 'interaction' });
    const payload = { content: `❌ ${err.message}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

// Discord's user-picker only suggests locally *cached* members (mostly people recently seen in the
// current channel), so it can't reliably reach everyone — and never reaches plex_ synthetic rows or
// email-only ghost links. Autocomplete the `email` option of /reinvite and /link against every
// invitable DB row instead, matching by email, stored Plex username, or Discord username/display
// name. Member names come from already-cached data only — an autocomplete has a 3s deadline and a
// forced gateway fetch would trip the opcode-8 rate limiter.
async function handleAutocomplete(interaction) {
  // /request title: — live movie/TV search against Seerr. Discord gives autocomplete a 3s
  // deadline, so the search gets a short timeout and any failure degrades to no suggestions.
  if (interaction.commandName === 'request') {
    const focusedTitle = interaction.options.getFocused(true);
    if (focusedTitle.name !== 'title') return interaction.respond([]).catch(() => {});
    const q = String(focusedTitle.value || '').trim();
    if (q.length < 2) return interaction.respond([]).catch(() => {});
    try {
      const results = await searchSeerr(q, 2500);
      const year = d => (d ? ` (${String(d).slice(0, 4)})` : '');
      const choices = results.slice(0, 25).map(r => {
        const title = (r.mediaType === 'movie' ? r.title : r.name) || 'Unknown';
        // Search results carry mediaInfo for titles Seerr already tracks — surface that in the
        // suggestion so people see "requested / on Plex" before they even submit.
        const st = r.mediaInfo?.status;
        const tag = st === 5 ? ' — ✅ on Plex' : st === 4 ? ' — 🌗 partly on Plex' : (st === 2 || st === 3) ? ' — ⏳ requested' : '';
        return {
          name: `${mediaTypeEmoji(r.mediaType)} ${title}${year(r.releaseDate || r.firstAirDate)}${tag}`.slice(0, 100),
          // The picked value carries type+tmdbId+title so the handler needs no second lookup.
          value: `${r.mediaType}:${r.id}:${title}`.slice(0, 100),
        };
      });
      return interaction.respond(choices).catch(() => {});
    } catch (_e) {
      return interaction.respond([]).catch(() => {});
    }
  }

  // /request-status title: — matches locally tracked requests (fed by webhooks + /request).
  // Non-admins only see their own requests; showing everyone's titles/statuses would let any
  // member enumerate what other people requested.
  if (interaction.commandName === 'request-status') {
    const focusedTitle = interaction.options.getFocused(true);
    if (focusedTitle.name !== 'title') return interaction.respond([]).catch(() => {});
    const q = String(focusedTitle.value || '').toLowerCase().trim();
    const rows = isAdminInteraction(interaction)
      ? db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 500').all()
      : db.prepare('SELECT * FROM requests WHERE requested_by_discord_id = ? ORDER BY id DESC LIMIT 500').all(interaction.user.id);
    const seen = new Set();
    const choices = [];
    for (const r of rows) {
      if (q && !String(r.title || '').toLowerCase().includes(q)) continue;
      if (seen.has(r.media_id)) continue;
      seen.add(r.media_id);
      choices.push({ name: `${r.title} · ${r.status}`.slice(0, 100), value: String(r.media_id).slice(0, 100) });
      if (choices.length >= 25) break;
    }
    return interaction.respond(choices).catch(() => {});
  }

  if (!['reinvite', 'link', 'invite'].includes(interaction.commandName)) return interaction.respond([]).catch(() => {});
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'email') return interaction.respond([]).catch(() => {});
  const q = String(focused.value || '').toLowerCase().trim();

  const nameById = new Map();
  const cachedMembers = (guildMemberCache.members && Date.now() - guildMemberCache.at < GUILD_MEMBER_TTL_MS)
    ? guildMemberCache.members
    : Array.from((client.guilds.cache.get(CONFIG.DISCORD_GUILD_ID) || client.guilds.cache.first())?.members.cache.values() || []);
  for (const m of cachedMembers) nameById.set(m.user.id, m.displayName || m.user.username);

  const seen = new Set();
  const choices = [];
  for (const u of db.prepare('SELECT * FROM users ORDER BY requested_at DESC').all()) {
    const email = String(u.email || '').toLowerCase().trim();
    if (!isValidEmail(email) || canonicalizeEmail(email).startsWith('__placeholder__:')) continue;
    const canon = canonicalizeEmail(email);
    if (seen.has(canon)) continue;
    const discordName = isSnowflake(u.discord_id) ? (nameById.get(u.discord_id) || '') : '';
    const plexName = String(u.plex_username || '');
    if (q && ![email, discordName.toLowerCase(), plexName.toLowerCase()].some(s => s.includes(q))) continue;
    seen.add(canon);
    const tags = [];
    if (discordName) tags.push(`@${discordName}`);
    if (plexName && plexName.toLowerCase() !== discordName.toLowerCase()) tags.push(plexName);
    if (u.discord_id.startsWith('plex_')) tags.push('Plex-only');
    if (!u.invited) tags.push('not yet invited');
    const name = `${email}${tags.length ? ` · ${tags.join(' · ')}` : ''}`.slice(0, 100);
    choices.push({ name, value: email.slice(0, 100) });
    if (choices.length >= 25) break;
  }
  await interaction.respond(choices).catch(() => {});
}

async function handleSlashCommand(interaction) {
  const n = interaction.commandName;
  if (n === 'download') return handleDownloadCommand(interaction);
  if (n === 'request') return handleRequestCommand(interaction);
  if (n === 'link') return handleLinkCommand(interaction);
  if (n === 'unlink') return handleUnlinkCommand(interaction);
  if (n === 'users') return handleUsersCommand(interaction);
  if (n === 'status') return handleStatusCommand(interaction);
  if (n === 'seerr-test') return handleSeerrTestCommand(interaction);
  if (n === 'sync') return handleSyncCommand(interaction);
  if (n === 'sync-fix') return handleSyncFixCommand(interaction);
  if (n === 'cleanup') return handleCleanupCommand(interaction);
  if (n === 'invite') return handleInviteCommand(interaction);
  if (n === 'invite-post') return handleInvitePostCommand(interaction);
  if (n === 'reinvite') return handleReinviteCommand(interaction);
  if (n === 'requests') return handleRequestsCommand(interaction);
  if (n === 'audit') return handleAuditCommand(interaction);
  if (n === 'queue') return handleQueueCommand(interaction);
  if (n === 'request-status') return handleRequestStatusCommand(interaction);
  if (n === 'watching') return handleWatchingCommand(interaction);
  if (n === 'indexers') return handleIndexersCommand(interaction);
  if (n === 'debrid') return handleDebridCommand(interaction);
  if (n === 'cleanup-suggestions') return handleCleanupSuggestionsCommand(interaction);
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
  const url = `https://${CONFIG.TUNNEL_DOMAIN}/download/${rawToken}`;
  let sizeLine = '';
  try { sizeLine = `${(fs.statSync(filePath).size / (1024 ** 3)).toFixed(2)} GB`; } catch (_e) {}
  const embed = brandedEmbed(COLORS.INFO)
    .setTitle('📥 Download Ready')
    .setDescription(`**${displayTitle}**`)
    .addFields(
      { name: 'Expires', value: `<t:${Math.floor(expiresAt / 1000)}:R>`, inline: true },
      { name: 'Link type', value: oneTime ? '🔒 One-time use' : '♻️ Multi-use', inline: true },
    );
  if (sizeLine) embed.addFields({ name: 'Size', value: sizeLine, inline: true });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Download').setStyle(ButtonStyle.Link).setURL(url),
  );
  await interaction.editReply({ embeds: [embed], components: [row] });
}

// The full Plex → Discord → Seerr chain for linking one person, shared by /link and the
// /sync-fix links buttons. Absorbs a matching plex_ synthetic row, sends a Plex invite only if
// they don't already have access, and reconciles Seerr: link the existing user (wiring the Discord
// notification ID that Plex-imported users never got) or create a fresh one.
async function applyFullChainLink(discordId, email, username) {
  const { absorbed } = linkUserToEmail(discordId, email);
  const row = getUserByDiscordId(discordId);

  let plexStatus;
  if (row.invited) {
    plexStatus = absorbed ? '✅ already had access (merged Plex row)' : '✅ already invited';
  } else {
    try {
      const result = await inviteUserToPlex(email);
      markUserInvited(discordId);
      plexStatus = result.successCount > 0 ? `✅ invite sent (${result.successCount}/${result.total})` : '⚠️ invite failed on all servers';
    } catch (err) {
      audit('external_api_error', { provider: 'plex', error: err.message, targetDiscordId: discordId });
      plexStatus = '❌ invite failed';
    }
  }

  let seerrStatus;
  try {
    const key = canonicalizeEmail(email);
    const existing = (await fetchOverseerrUsers()).find(ou => canonicalizeEmail(ou.email) === key);
    if (existing) {
      markOverseerrCreated(discordId, existing.id ?? null);
      const notified = existing.id != null ? await setOverseerrDiscordNotification(existing.id, discordId) : false;
      seerrStatus = `✅ linked existing user${notified ? ' + Discord notifications' : ''}`;
    } else {
      const id = await createOverseerrUser(email, discordId, username || email.split('@')[0]);
      markOverseerrCreated(discordId, id);
      seerrStatus = '✅ user created + Discord notifications';
    }
  } catch (err) {
    audit('external_api_error', { provider: 'overseerr', error: err.message, targetDiscordId: discordId });
    seerrStatus = '❌ failed — run /sync apply to retry';
  }

  return { absorbed, plexStatus, seerrStatus };
}

async function handleLinkCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const target = interaction.options.getUser('user');
  const email = interaction.options.getString('email').toLowerCase().trim();
  if (!isValidEmail(email) || canonicalizeEmail(email).startsWith('__placeholder__:')) {
    return interaction.reply({ content: `❌ \`${email}\` isn't a valid email address.`, ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  const { absorbed, plexStatus, seerrStatus } = await applyFullChainLink(target.id, email, target.username);
  audit('user_linked', { actorDiscordId: interaction.user.id, targetDiscordId: target.id, email, source: 'slash_link', absorbedPlexRow: absorbed?.discord_id || null });
  const embed = brandedEmbed(COLORS.SUCCESS)
    .setTitle('🔗 User Linked')
    .setDescription(`${target.tag} → \`${email}\``)
    .addFields(
      { name: 'DB', value: absorbed ? `✅ linked (merged \`${absorbed.discord_id}\` row)` : '✅ linked', inline: false },
      { name: 'Plex', value: plexStatus, inline: true },
      { name: 'Seerr', value: seerrStatus, inline: true },
    );
  await interaction.editReply({ embeds: [embed] });
}

async function handleUnlinkCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const target = interaction.options.getUser('user');
  const record = getUserByDiscordId(target.id);
  if (!record) return interaction.reply({ content: '⚠️ Not in DB.', ephemeral: true });
  removeUser(target.id);
  audit('user_unlinked', { actorDiscordId: interaction.user.id, targetDiscordId: target.id, email: record.email });
  await interaction.reply({ content: `✅ Removed ${target.tag} from DB. Plex access and the Seerr account were left untouched — revoke from the leave-notification button or the Plex/Seerr admin UIs if needed.`, ephemeral: true });
}

// /request — place a Seerr request AS the linked user, so it's attributed to the real person
// (unlike Requestrr, which submits everything under its own configured Seerr account).
async function handleRequestCommand(interaction) {
  const row = getUserByDiscordId(interaction.user.id);
  if (!row) return interaction.reply({ content: '❌ You need to be linked first — ask an admin to run `/link` for you.', ephemeral: true });
  if (!takeRateLimit(requestCommandLimits, interaction.user.id, 5, 3600000)) {
    return interaction.reply({ content: '❌ Request limit reached (5 per hour). Try again later.', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });

  const is4k = interaction.options.getBoolean('is4k') || false;
  const raw = String(interaction.options.getString('title') || '').trim();
  // Autocomplete picks arrive as "movie:<tmdbId>:<title>"; free-typed text falls back to search.
  let mediaType, tmdbId, label;
  const picked = raw.match(/^(movie|tv):(\d+)(?::(.*))?$/);
  if (picked) {
    mediaType = picked[1];
    tmdbId = Number(picked[2]);
    label = (picked[3] || '').trim() || raw;
  } else {
    let hit = null;
    try { hit = (await searchSeerr(raw))[0]; } catch (_e) {}
    if (!hit) return interaction.editReply(`❌ Couldn't find anything on Seerr matching **${raw}**. Start typing and pick a suggestion from the list.`);
    mediaType = hit.mediaType;
    tmdbId = hit.id;
    label = (hit.mediaType === 'movie' ? hit.title : hit.name) || raw;
  }

  // Fail fast on duplicates instead of making an admin approve something Seerr will only reject
  // (or, for TV with no seasons left, silently drop — see createSeerrRequestAs). First the bot's
  // own gate, since Seerr can't know about requests still awaiting approval here; then Seerr
  // itself (requested there directly, already downloading, or already on Plex).
  const pendingDupe = db.prepare("SELECT * FROM requests WHERE media_id = ? AND is_4k = ? AND status = 'pending' LIMIT 1").get(`tmdb:${tmdbId}`, is4k ? 1 : 0);
  if (pendingDupe) {
    const who = pendingDupe.requested_by_discord_id === interaction.user.id ? 'you' : 'someone else';
    return interaction.editReply(`⏳ **${label}**${is4k ? ' (4K)' : ''} was already requested by ${who} and is waiting for admin approval — no need to request it again.`);
  }
  const existing = await checkExistingSeerrMedia(mediaType, tmdbId, is4k);
  if (existing) {
    audit('media_request_duplicate', { actorDiscordId: interaction.user.id, title: label, mediaType, tmdbId, is4k, reason: existing });
    return interaction.editReply(`ℹ️ **${label}**${is4k ? ' (4K)' : ''} is ${existing} — no need to request it again.${existing.includes('available on Plex') ? ' 🍿' : ' Use `/request-status` to track it.'}`);
  }

  let seerrUserId = null;
  try { seerrUserId = await resolveSeerrUserId(row); } catch (_e) {}
  if (seerrUserId == null) {
    return interaction.editReply('❌ No Seerr account is linked to you yet — ask an admin to run `/link` for you.');
  }

  // Non-admins go through the bot-side approval gate: Seerr sees nothing until an admin clicks
  // Approve (Seerr insta-approves anything the bot's admin API key creates, so approval has to
  // happen here). Admins skip the gate — they'd only be approving themselves.
  if (!isAdminInteraction(interaction)) {
    const payload = { discordId: interaction.user.id, email: row.email, seerrUserId, mediaType, tmdbId, is4k, label };
    const nonce = stashPendingRequest(payload);
    const posted = await postPendingRequestNotice(nonce, payload)
      .catch(err => { log.warn(`Approval notice failed: ${err.message}`); return false; });
    if (!posted) {
      takePendingRequest(nonce);
      return interaction.editReply('❌ Couldn\'t post the approval request to the admins — try again in a bit.');
    }
    upsertRequest(null, `tmdb:${tmdbId}`, mediaType, is4k, label, interaction.user.id, 'pending');
    audit('media_request_gated', { actorDiscordId: interaction.user.id, title: label, mediaType, tmdbId, is4k, nonce });
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO)
      .setTitle(`${mediaTypeEmoji(mediaType, is4k)} Request Submitted`)
      .setDescription(`**${label}**${is4k ? ' (4K)' : ''}${mediaType === 'tv' ? ' — all seasons' : ''}\nWaiting for admin approval — you'll get a DM either way.`)] });
  }

  try {
    const data = await createSeerrRequestAs(seerrUserId, mediaType, tmdbId, is4k);
    // Same media-key convention as the webhook handler, so the rows merge cleanly.
    const mediaKey = mediaType === 'tv' && data?.media?.tvdbId ? `tvdb:${data.media.tvdbId}` : `tmdb:${tmdbId}`;
    if (data?.id != null) markApprovalNoticePosted(data.id); // suppress the duplicate webhook embed
    upsertRequest(data?.id, mediaKey, mediaType, is4k, label, interaction.user.id, 'approved');
    audit('media_requested', { actorDiscordId: interaction.user.id, title: label, mediaType, tmdbId, is4k, seerrUserId, requestId: data?.id ?? null });
    await interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle(`${mediaTypeEmoji(mediaType, is4k)} Request Sent`)
      .setDescription(`**${label}**${is4k ? ' (4K)' : ''}${mediaType === 'tv' ? ' — all seasons' : ''}\nRequested as \`${row.email}\` — approved and grabbing it now! 🚀\nYou\'ll get a DM when it\'s on Plex.`)] });
  } catch (err) {
    const seerrMessage = err.response?.data?.message;
    audit('external_api_error', { provider: 'overseerr', error: seerrMessage || err.message, action: 'create_request', actorDiscordId: interaction.user.id, tmdbId, mediaType });
    await interaction.editReply(seerrMessage
      ? `❌ Seerr rejected the request: ${seerrMessage}`
      : `❌ Couldn't reach Seerr to place the request. Try again in a bit.`);
  }
}

async function handleSeerrTestCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  await interaction.deferReply({ ephemeral: true });
  const keep = interaction.options.getBoolean('keep') || false;
  // Test with the invoking admin's own ID — a pass also proves their account is linkable.
  const { steps } = await runSeerrSelfTest(interaction.user.id, { keep });
  const allOk = steps.every(s => s.ok);
  const embed = brandedEmbed(allOk ? COLORS.SUCCESS : COLORS.WARN)
    .setTitle(allOk ? '✅ Seerr Self-Test Passed' : '⚠️ Seerr Self-Test Found Problems')
    .setDescription(steps.map(s => `${s.ok ? '✅' : '❌'} **${s.name}** — ${s.detail}`).join('\n').slice(0, 4000));
  await interaction.editReply({ embeds: [embed] });
}

async function handleUsersCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  await interaction.deferReply({ ephemeral: true });
  const rows = db.prepare('SELECT * FROM users ORDER BY requested_at ASC').all();
  // Resolve which snowflake links point at a real, present guild member. A snowflake row whose
  // user isn't in the server is an "email-only" ghost link — flag it with 👻 so it's obvious the
  // mention won't resolve to a person.
  const memberIds = new Set((await getGuildMembers().catch(() => [])).map(m => m.user.id));
  const line = u => {
    if (!isSnowflake(u.discord_id)) return `${u.invited ? '✅' : '⏳'} \`${u.discord_id}\` — \`${u.email}\``;
    const ghost = !memberIds.has(u.discord_id);
    const who = ghost ? `👻 \`${u.discord_id}\`` : `<@${u.discord_id}>`;
    return `${u.invited ? '✅' : '⏳'} ${who} — \`${u.email}\``;
  };
  const ghostCount = rows.filter(u => isSnowflake(u.discord_id) && !memberIds.has(u.discord_id)).length;
  const shown = rows.slice(0, 50);
  const embed = brandedEmbed(COLORS.INFO)
    .setTitle(`👥 Linked Users (${rows.length})`)
    .setDescription(shown.map(line).join('\n') || 'No users yet.');
  if (ghostCount) embed.addFields({ name: 'Email-only links', value: `👻 ${ghostCount} linked to a Discord ID that isn't in the server (mention won't resolve).`, inline: false });
  if (rows.length > shown.length) embed.setFooter({ text: `Durant Media Server · Showing ${shown.length} of ${rows.length}` });
  await interaction.editReply({ embeds: [embed] });
}

async function handleStatusCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  await interaction.deferReply({ ephemeral: true });
  const health = await gatherHealth();
  const invitedUsers = db.prepare('SELECT COUNT(*) AS c FROM users WHERE invited = 1').get().c;
  const pendingRequests = db.prepare("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'").get().c;
  const activeLinks = db.prepare('SELECT COUNT(*) AS c FROM download_tokens WHERE revoked = 0 AND expires_at > ?').get(Date.now()).c;

  const integrationKeys = ['discord', 'sqlite', 'plex', 'overseerr', 'radarr', 'radarr4k', 'sonarr', 'prowlarr', 'byparr', 'raidPath', 'tunnelDomain'];
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

  const disks = await fetchDiskSpace().catch(() => []);
  const storageLines = disks.map(d => {
    const lowFlag = gb(d.freeSpace || 0) < CONFIG.DISK_SPACE_WARN_GB ? ' ⚠️' : '';
    const pctUsed = d.totalSpace ? Math.round(((d.totalSpace - d.freeSpace) / d.totalSpace) * 100) : 0;
    return `\`${d.displayPath || d.path}\` — ${fmtSpace(d.freeSpace)} free of ${fmtSpace(d.totalSpace)} (${pctUsed}% used)${lowFlag}`;
  });

  const embed = brandedEmbed(health.overall === 'ok' ? COLORS.SUCCESS : COLORS.WARN)
    .setTitle('📊 Durant Media Server Status')
    .setDescription(`Overall: **${String(health.overall).toUpperCase()}**`)
    .addFields(
      { name: 'Integrations', value: integrationLines.join('\n') || 'none', inline: false },
      { name: 'Users', value: usersSummary, inline: true },
      { name: 'Pending requests', value: `${pendingRequests}`, inline: true },
      { name: 'Active download links', value: `${activeLinks}`, inline: true },
      { name: 'Storage', value: storageLines.join('\n') || 'No *arr diskspace data', inline: false },
      { name: 'DB ↔ Overseerr', value: reconcileLine, inline: false },
      { name: 'Fixable sync issues', value: fixableLine, inline: false },
    );
  audit('status_checked', { actorDiscordId: interaction.user.id, overall: health.overall });
  await interaction.editReply({ embeds: [embed] });
}

// A full member fetch uses gateway opcode 8 (Request Guild Members), which Discord rate-limits
// aggressively (~120/min). /sync preview, /sync apply and /sync-fix each rebuild the preview, and
// /users now needs the roster too — without caching, back-to-back admin actions trip the limiter
// ("Request with opcode 8 was rate limited"). Cache the roster briefly so they share one fetch.
let guildMemberCache = { at: 0, members: null };
const GUILD_MEMBER_TTL_MS = 60 * 1000;
async function getGuildMembers({ force = false } = {}) {
  if (!force && guildMemberCache.members && Date.now() - guildMemberCache.at < GUILD_MEMBER_TTL_MS) {
    return guildMemberCache.members;
  }
  const guild = client.guilds.cache.get(CONFIG.DISCORD_GUILD_ID) || client.guilds.cache.first();
  if (!guild) return guildMemberCache.members || [];
  const members = Array.from((await guild.members.fetch()).values());
  guildMemberCache = { at: Date.now(), members };
  return members;
}

async function buildSyncPreview() {
  // Exclude the bot's own account from all matching.
  const dbUsers = db.prepare('SELECT * FROM users').all().filter(u => u.discord_id !== CONFIG.DISCORD_CLIENT_ID);
  const discordMembers = (await getGuildMembers()).filter(m => !m.user.bot);
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

  // Rows keyed on a real Discord snowflake whose user is no longer in the guild — the link is
  // "email only", so /users renders a bare <@id> mention instead of a name. Includes placeholder
  // (@plex.local) rows, which orphans deliberately excludes, so admins can spot every ghost link.
  const linkedNotMember = dbUsers
    .filter(u => isSnowflake(u.discord_id) && !discordIds.has(u.discord_id))
    .map(u => `${u.email}`);

  const wouldAdd = plexNotInDiscord.slice();
  // Only rows the apply loop actually touches: real Discord logins (not plex_ synthetics, not the
  // bot, not @plex.local placeholders) that exist in Overseerr but aren't flagged linked yet. The
  // old count included plex_ rows the apply loop skips, so "Would update: 1" never matched the
  // "Links repaired" result.
  const wouldUpdate = dbUsers.filter(u =>
    !u.discord_id.startsWith('plex_')
    && !isPlaceholderKey(canonicalizeEmail(u.email))
    && overseerrEmails.has(canonicalizeEmail(u.email))
    && !u.overseerr_created,
  ).map(u => u.email);

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

  // Suggested links for plex_ friends with no real Discord link. Never auto-applied in /sync apply,
  // but /sync-fix links offers per-pair Link/Dismiss buttons. Dismissed pairs are remembered via
  // suggestlink_ack:<discordId>:<plexId>.
  const suggestedLinks = [];
  for (const f of plexFriends) {
    const plexRow = dbUsers.find(u => u.discord_id === `plex_${f.id}`);
    if (!plexRow) continue;
    const name = String(f.username || f.title || '').toLowerCase().trim();
    if (!name) continue;
    const match = discordMembers.find(m => {
      const uname = String(m.user.username || '').toLowerCase();
      return uname && (uname === name || uname.includes(name) || name.includes(uname));
    });
    if (!match) continue;
    if (getSetting(`suggestlink_ack:${match.user.id}:${f.id}`)) continue;
    suggestedLinks.push({ plexFriend: f.username || f.title, plexId: f.id, discordTag: match.user.tag, discordId: match.user.id, plexEmail: plexRow.email });
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

  return { discordNotLinkedToPlex, plexNotInDiscord, overseerrNotLinkedToDiscord, dbMissingFromPlex, linkedNotMember, wouldAdd, wouldRemove: [], wouldUpdate, risky, unmatchablePlaceholders, duplicateEmails, orphans, suggestedLinks, emailMergeCandidates };
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
    const plexName = String(friend.username || friend.title || '').trim() || null;
    // Keep plex_username fresh on existing plex_ rows so autocomplete can label them by name.
    db.prepare('UPDATE users SET plex_username = ? WHERE discord_id = ? AND (plex_username IS NULL OR plex_username != ?)').run(plexName, `plex_${friend.id}`, plexName);
    const key = canonicalizeEmail(friend.email);
    if (!key || existingCanon.has(key)) continue;
    db.prepare('INSERT OR IGNORE INTO users (discord_id, email, invited, requested_at, plex_username) VALUES (?, ?, 1, ?, ?)').run(`plex_${friend.id}`, email, new Date().toISOString(), plexName);
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
        const existing = overseerrByCanon.get(key);
        markOverseerrCreated(u.discord_id, existing.id ?? null);
        // Existing (usually Plex-imported) Seerr users never had their Discord ID set, so
        // Seerr-side Discord notifications silently didn't work for them. Wire it on repair.
        if (existing.id != null) await setOverseerrDiscordNotification(existing.id, u.discord_id);
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

  if (target === 'links') {
    if (!preview.suggestedLinks.length) return interaction.editReply('✅ No suggested links to review.');
    const embeds = []; const components = [];
    for (const s of preview.suggestedLinks.slice(0, 5)) {
      const key = pendingFixKey('slink', `${s.discordId}|${s.plexId}|${s.plexEmail}`);
      const embed = brandedEmbed(COLORS.INFO)
        .setTitle('Suggested link')
        .setDescription(
          `Plex friend **${s.plexFriend}** (\`${s.plexEmail}\`) looks like Discord member <@${s.discordId}> (${s.discordTag}).\n\n` +
          '**Link** merges the Plex row onto the Discord user and wires up Plex + Seerr (invite if needed, Discord notifications).');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`syncfix_linkapply:${key}`).setLabel('Link them').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`syncfix_linkdismiss:${key}`).setLabel('Not the same — dismiss').setStyle(ButtonStyle.Secondary),
      );
      embeds.push(embed); components.push(row);
    }
    return interaction.editReply({ content: `Found ${preview.suggestedLinks.length} suggested link(s). Nothing is applied until you click:`, embeds, components });
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
    hints.push(`${p.suggestedLinks.length} suggested link(s) — run /sync-fix links to apply or dismiss:\n${pairs.join('\n')}`);
  }
  return hints.length ? `\n\n${hints.join('\n')}` : '';
}

function formatSyncPreview(p, header) {
  return `${header}\n\n` +
    `Discord not linked to Plex: ${p.discordNotLinkedToPlex.length}\n` +
    `Plex users not in Discord links: ${p.plexNotInDiscord.length}\n` +
    `Overseerr users not linked to Discord: ${p.overseerrNotLinkedToDiscord.length}\n` +
    `DB users missing from Plex: ${p.dbMissingFromPlex.length}\n` +
    `Linked to a Discord ID not in the server: ${p.linkedNotMember?.length || 0}\n` +
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

// Admin-initiated onboarding for members with no DB row (they never show in /reinvite or /link
// autocomplete). Without an email, the bot DMs the member asking for their Plex email and flags
// them admin_invited so the reply auto-approves — no Approve button. With an email, the full
// chain runs immediately.
async function handleInviteCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  await interaction.deferReply({ ephemeral: true });
  const target = interaction.options.getUser('user', true);
  const emailOpt = interaction.options.getString('email');
  if (target.bot) return interaction.editReply('❌ Can\'t invite a bot.');
  const existing = getUserByDiscordId(target.id);
  const existingNote = existing ? `\nNote: they were already linked to \`${existing.email}\` — this updates it.` : '';

  if (emailOpt) {
    const email = emailOpt.toLowerCase().trim();
    if (!isValidEmail(email) || canonicalizeEmail(email).startsWith('__placeholder__:')) {
      return interaction.editReply(`❌ \`${email}\` isn't a valid email address.`);
    }
    const { absorbed, plexStatus, seerrStatus } = await applyFullChainLink(target.id, email, target.username);
    audit('user_linked', { actorDiscordId: interaction.user.id, targetDiscordId: target.id, email, source: 'slash_invite', absorbedPlexRow: absorbed?.discord_id || null });
    const hadAccess = plexStatus.includes('already');
    await dmUser(target.id, { embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle('🎉 You\'re In!')
      .setDescription(hadAccess
        ? `An admin set you up on the media server — \`${email}\` already has Plex access. Use \`/help\` here to see everything I can do. 🍿`
        : `An admin set you up on the media server! 📬 A Plex invite was sent to \`${email}\` — accept it and you're set. Use \`/help\` here to see everything I can do. 🍿`)] });
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle('🔗 User Invited')
      .setDescription(`${target.tag} → \`${email}\`${existingNote}`)
      .addFields(
        { name: 'DB', value: absorbed ? `✅ linked (merged \`${absorbed.discord_id}\` row)` : '✅ linked', inline: false },
        { name: 'Plex', value: plexStatus, inline: true },
        { name: 'Seerr', value: seerrStatus, inline: true },
      )] });
  }

  try {
    await target.send({ embeds: [brandedEmbed(COLORS.PLEX)
      .setTitle('👋 You\'ve been invited to Durant Media Server!')
      .setDescription(`An admin has invited you! To get set up, just **reply to this message with the email on your Plex account** — I'll handle the rest automatically. 🍿`)] });
  } catch (_e) {
    return interaction.editReply(`❌ ${target.tag}'s DMs are closed — use \`/invite user:${target.tag} email:<their Plex email>\` to set them up directly.`);
  }
  setPendingEmail(target.id);
  setSetting(`admin_invited:${target.id}`, '1');
  audit('admin_invite_sent', { actorDiscordId: interaction.user.id, targetDiscordId: target.id });
  await interaction.editReply(`📨 DM sent to ${target.tag} — when they reply with their Plex email I'll set them up automatically (no approval needed).${existingNote}`);
}

// Post a persistent public "Request Plex Access" button in the current channel. The customId
// carries no state, so the button keeps working across restarts — pin the message and forget it.
async function handleInvitePostCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('request_access').setLabel('Request Plex Access').setStyle(ButtonStyle.Success).setEmoji('🎬'),
  );
  const embed = brandedEmbed(COLORS.PLEX)
    .setTitle('🎬 Durant Media Server — Get Access')
    .setDescription('Want in? Click the button below and enter the email on your **Plex account**.\nAn admin will approve you and you\'ll get a Plex invite by email, plus a DM here when you\'re in. 🍿');
  await interaction.channel.send({ embeds: [embed], components: [row] });
  audit('invite_post_created', { actorDiscordId: interaction.user.id, channelId: interaction.channelId });
  await interaction.reply({ content: '✅ Posted. Tip: pin the message so it\'s easy to find — the button keeps working forever.', ephemeral: true });
}

async function handleModalSubmit(interaction) {
  if (interaction.customId !== 'request_access_modal') return;
  const email = String(interaction.fields.getTextInputValue('plex_email') || '').toLowerCase().trim();
  if (!isValidEmail(email)) {
    return interaction.reply({ content: '❌ That doesn\'t look like a valid email address — click the button and try again.', ephemeral: true });
  }
  clearPendingEmail(interaction.user.id); // a DM ask may be outstanding; the modal supersedes it
  linkUserToEmail(interaction.user.id, email);
  audit('user_linked', { targetDiscordId: interaction.user.id, email, source: 'request_access_button' });
  await interaction.reply({ content: `✅ Thanks! Your request for \`${email}\` was sent to the admins. You'll get a DM as soon as you're approved.`, ephemeral: true });
  await postAccessRequestToAdmins(interaction.user, email);
}

// Re-send a Plex invite. Resolves an email from either a linked Discord user or a raw email —
// useful for the "DB users missing from Plex" bucket, where an invite was never accepted or the
// friend was removed on the Plex side.
async function handleReinviteCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  await interaction.deferReply({ ephemeral: true });
  const target = interaction.options.getUser('user');
  const emailOpt = interaction.options.getString('email');
  let email; let discordId = null; let label;
  if (target) {
    const row = getUserByDiscordId(target.id);
    if (!row) return interaction.editReply(`⚠️ ${target.tag} isn't in the DB. Link them first with \`/link\`.`);
    email = row.email; discordId = target.id; label = target.tag;
  } else if (emailOpt) {
    email = emailOpt.toLowerCase().trim();
    const match = getUserByCanonicalEmail(email);
    if (match) { discordId = match.discord_id; }
    label = email;
  } else {
    return interaction.editReply('❌ Provide a `user` or an `email` to re-invite.');
  }
  if (!isValidEmail(email) || canonicalizeEmail(email).startsWith('__placeholder__:')) {
    return interaction.editReply(`⚠️ \`${email}\` isn't a real email address — can't send a Plex invite (managed/placeholder account).`);
  }
  const result = await inviteUserToPlex(email);
  // markUserInvited keys on the discord_id string, so it works for plex_ synthetic rows too.
  if (discordId) markUserInvited(discordId);
  audit('plex_reinvite_sent', { actorDiscordId: interaction.user.id, targetDiscordId: discordId, email, successCount: result.successCount, total: result.total });
  const ok = result.successCount > 0;
  await interaction.editReply(
    `${ok ? '✅' : '⚠️'} Re-sent Plex invite for **${label}** → \`${email}\` (${result.successCount}/${result.total} server${result.total === 1 ? '' : 's'}).`
    + (ok ? '' : '\nNo servers accepted the invite — they may already have pending/active access.'),
  );
}

// Most recent requests across everyone, drawn from the local requests table (populated by Overseerr
// webhooks) so titles and requester attribution are already resolved.
async function handleRequestsCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  await interaction.deferReply({ ephemeral: true });
  const count = interaction.options.getInteger('count') || 10;
  const rows = db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT ?').all(count);
  const line = r => {
    const who = r.requested_by_discord_id
      ? (isSnowflake(r.requested_by_discord_id) ? `<@${r.requested_by_discord_id}>` : `\`${r.requested_by_discord_id}\``)
      : '_unknown_';
    return `${requestStatusBadge(r.status)} ${mediaTypeEmoji(r.media_type, r.is_4k)} **${r.title}** — ${who}`;
  };
  const embed = brandedEmbed(COLORS.INFO)
    .setTitle('🎬 Most Recent Requests')
    .setDescription(rows.length ? rows.map(line).join('\n') : 'No requests recorded yet.');
  audit('requests_viewed', { actorDiscordId: interaction.user.id, count: rows.length });
  await interaction.editReply({ embeds: [embed] });
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

async function handleQueueCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const items = await fetchArrQueues();
  if (!items.length) {
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle('📭 Download Queue')
      .setDescription('Nothing downloading right now — the queue is clear.')] });
  }
  const lines = items.slice(0, 12).map(i => {
    const pct = queuePercent(i);
    const flag = queueItemLooksUnhealthy(i) ? ' ⚠️' : '';
    const eta = i.timeleft ? ` · ETA \`${i.timeleft}\`` : '';
    const size = i.size ? ` · ${(i.size / (1024 ** 3)).toFixed(1)} GB` : '';
    const problem = queueItemLooksUnhealthy(i) && i.messages[0] ? `\n└ ⚠️ ${String(i.messages[0]).slice(0, 120)}` : '';
    return `**${i.title}**${flag}\n└ ${progressBar(pct)} ${pct}%${eta}${size}${problem}`;
  });
  const embed = brandedEmbed(COLORS.INFO)
    .setTitle(`⬇️ Download Queue (${items.length})`)
    .setDescription(lines.join('\n'));
  if (items.length > 12) embed.setFooter({ text: `Durant Media Server · Showing 12 of ${items.length}` });
  if (items.some(queueItemLooksUnhealthy)) {
    embed.addFields({ name: 'Legend', value: '⚠️ = the *arr reports a problem with this download (stalled, missing, import issue)', inline: false });
  }
  await interaction.editReply({ embeds: [embed] });
}

// /request-status — trace a tracked request through the pipeline: DB status (fed by webhooks)
// → live *arr queue match with progress/stall reason → plain-English next step.
async function handleRequestStatusCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const raw = String(interaction.options.getString('title') || '').trim();
  // Autocomplete sends media_id values (tmdb:123 / tvdb:456); free text falls back to title
  // match. Same scoping as the autocomplete: non-admins can only look up their own requests.
  const admin = isAdminInteraction(interaction);
  const row = /^(tmdb|tvdb):\d+$/.test(raw)
    ? (admin
      ? db.prepare('SELECT * FROM requests WHERE media_id = ? ORDER BY id DESC LIMIT 1').get(raw)
      : db.prepare('SELECT * FROM requests WHERE media_id = ? AND requested_by_discord_id = ? ORDER BY id DESC LIMIT 1').get(raw, interaction.user.id))
    : (admin
      ? db.prepare('SELECT * FROM requests WHERE title LIKE ? ORDER BY id DESC LIMIT 1').get(`%${raw}%`)
      : db.prepare('SELECT * FROM requests WHERE title LIKE ? AND requested_by_discord_id = ? ORDER BY id DESC LIMIT 1').get(`%${raw}%`, interaction.user.id));
  if (!row) {
    return interaction.editReply(`❌ None of your tracked requests match **${raw}**. Try picking a suggestion from the list, or \`/myrequests\` to see what's tracked.`);
  }

  const lines = [`${requestStatusBadge(row.status)}${isSnowflake(row.requested_by_discord_id) ? ` — requested by <@${row.requested_by_discord_id}>` : ''}`];
  if (row.status === 'available') {
    lines.push('It\'s on Plex — go watch it! 🍿');
  } else if (row.status === 'declined') {
    lines.push('An admin declined this request.');
  } else if (row.status === 'pending') {
    lines.push('Waiting for an admin to approve it. You\'ll get a DM the moment that happens.');
  } else {
    const items = await fetchArrQueues().catch(() => []);
    const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const target = norm(row.title);
    const match = items.find(i => { const n = norm(i.title); return target && n && (n.includes(target) || target.includes(n)); });
    if (match) {
      const pct = queuePercent(match);
      lines.push(`⬇️ Downloading via ${match.source.label}: ${progressBar(pct)} ${pct}%${match.timeleft ? ` · ETA \`${match.timeleft}\`` : ''}`);
      if (queueItemLooksUnhealthy(match)) {
        lines.push(`⚠️ The download has a problem: ${String(match.messages[0] || match.trackedStatus || match.status).slice(0, 200)}`);
        lines.push('Often this means no seeders. The stuck-download watchdog will offer admins a one-click "try another release" fix.');
      }
    } else {
      lines.push('🔎 Approved, but nothing is downloading for it yet — usually no good release has been grabbed so far. The *arrs keep retrying automatically; an admin can force a search from Radarr/Sonarr.');
    }
  }
  await interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO)
    .setTitle(`📊 ${row.title}${row.is_4k ? ' (4K)' : ''}`)
    .setDescription(lines.join('\n'))] });
}

// /watching — live Plex sessions via Tautulli.
async function handleWatchingCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  await interaction.deferReply({ ephemeral: true });
  if (!tautulliConfigured()) return interaction.editReply('❌ Tautulli isn\'t configured — set `TAUTULLI_URL` and `TAUTULLI_API_KEY`.');
  try {
    const data = await tautulliApi('get_activity');
    const sessions = data?.sessions || [];
    if (!sessions.length) {
      return interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS).setTitle('📺 Now Playing').setDescription('Nobody is watching right now.')] });
    }
    const embed = brandedEmbed(COLORS.INFO)
      .setTitle(`📺 Now Playing (${sessions.length})`)
      .setDescription(sessions.slice(0, 15).map(describeSession).join('\n').slice(0, 4000));
    const bw = Number(data.total_bandwidth || 0);
    if (bw) embed.addFields({ name: 'Total bandwidth', value: `${(bw / 1000).toFixed(1)} Mbps`, inline: true });
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply(`❌ Tautulli error: ${err.message}`);
  }
}

// /indexers — per-indexer Prowlarr health (definition list + failure/backoff statuses) + Byparr.
async function handleIndexersCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  await interaction.deferReply({ ephemeral: true });
  if (!CONFIG.PROWLARR_URL && !CONFIG.BYPARR_URL) return interaction.editReply('❌ Neither Prowlarr nor Byparr is configured.');
  const lines = [];
  if (CONFIG.PROWLARR_URL) {
    try {
      const headers = { 'X-Api-Key': CONFIG.PROWLARR_API_KEY };
      const [indexers, statuses] = await Promise.all([
        axios.get(`${CONFIG.PROWLARR_URL}/api/v1/indexer`, { headers, timeout: 10000 }).then(r => r.data || []),
        axios.get(`${CONFIG.PROWLARR_URL}/api/v1/indexerstatus`, { headers, timeout: 10000 }).then(r => r.data || []).catch(() => []),
      ]);
      const failing = new Map(statuses.map(s => [s.indexerId, s]));
      for (const ix of indexers) {
        const st = failing.get(ix.id);
        const icon = !ix.enable ? '⏸️' : st?.disabledTill ? '❌' : '✅';
        const note = !ix.enable ? ' — disabled' : st?.disabledTill ? ` — failing, retrying after \`${String(st.disabledTill).slice(0, 16).replace('T', ' ')}\`` : '';
        lines.push(`${icon} ${ix.name}${note}`);
      }
      if (!indexers.length) lines.push('▫️ No indexers defined in Prowlarr');
    } catch (err) {
      lines.push(`❌ Prowlarr unreachable: ${err.message}`);
    }
  }
  if (CONFIG.BYPARR_URL) {
    try {
      await axios.get(`${CONFIG.BYPARR_URL}/health`, { timeout: 8000 });
      lines.push('✅ Byparr');
    } catch (err) {
      lines.push(`⚠️ Byparr unavailable: ${err.message}`);
    }
  }
  await interaction.editReply({ embeds: [brandedEmbed(lines.some(l => l.startsWith('❌')) ? COLORS.WARN : COLORS.SUCCESS)
    .setTitle('🔍 Indexer Health')
    .setDescription(lines.join('\n').slice(0, 4000))] });
}

// /debrid — Premiumize account usage + active transfers.
async function handleDebridCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  await interaction.deferReply({ ephemeral: true });
  if (!premiumizeConfigured()) return interaction.editReply('❌ Premiumize isn\'t configured — set `PREMIUMIZE_API_KEY`.');
  try {
    const [info, transfers] = await Promise.all([accountInfo(), listTransfers()]);
    const lines = [];
    if (info?.limit_used != null) lines.push(`Fair-use limit: **${Math.round(Number(info.limit_used) * 100)}%** used`);
    if (info?.space_used) lines.push(`Cloud storage used: ${fmtSpace(Number(info.space_used))}`);
    if (info?.premium_until) lines.push(`Premium until: ${new Date(Number(info.premium_until) * 1000).toISOString().slice(0, 10)}`);
    const active = transfers.filter(t => !['finished', 'seeding'].includes(String(t.status)));
    const failed = transfers.filter(t => String(t.status) === 'error');
    const zeroPct = transfers.filter(t => isStuckCandidate(t) && Number(t.progress || 0) <= 0.01);
    lines.push(`Transfers: ${active.length} active, ${failed.length} failed (${zeroPct.length} at 0%), ${transfers.length} total`);
    for (const t of active.slice(0, 8)) {
      const pct = t.progress != null ? ` — ${Math.round(Number(t.progress) * 100)}%` : '';
      lines.push(`• ${String(t.name || 'unnamed').slice(0, 60)} — ${t.status}${pct}`);
    }
    for (const t of failed.slice(0, 4)) {
      lines.push(`• ❌ ${String(t.name || 'unnamed').slice(0, 60)}${t.message ? ` — ${String(t.message).slice(0, 80)}` : ''}`);
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pm_clearstuck').setLabel(`Clear Stuck/0% (${zeroPct.length})`).setStyle(ButtonStyle.Danger).setDisabled(!zeroPct.length),
      new ButtonBuilder().setCustomId('pm_clearfinished').setLabel('Clear Finished').setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({ embeds: [brandedEmbed(failed.length ? COLORS.WARN : COLORS.SUCCESS)
      .setTitle('☁️ Premiumize')
      .setDescription(lines.join('\n').slice(0, 4000))], components: [row] });
  } catch (err) {
    await interaction.editReply(`❌ Premiumize error: ${err.message}`);
  }
}

// /cleanup-suggestions — read-only list of the largest disk hogs, oldest-friendly, honoring the
// keep list and never-delete list. Suggestions only: deletion still goes through the existing
// prompts / *arr UIs, so this can't remove anything by itself.
async function handleCleanupSuggestionsCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  await interaction.deferReply({ ephemeral: true });
  if (!arrSources().length) return interaction.editReply('❌ No Radarr/Sonarr configured.');
  const now = Date.now();
  const candidates = [];
  for (const s of arrSources()) {
    try {
      if (s.kind === 'movie') {
        const movies = await axios.get(`${s.url}/api/v3/movie`, { headers: { 'X-Api-Key': s.key }, timeout: 20000 }).then(r => r.data || []);
        for (const m of movies) {
          if (!m.sizeOnDisk) continue;
          const addedMs = Date.parse(m.movieFile?.dateAdded || m.added || '') || now;
          candidates.push({ mediaId: `tmdb:${m.tmdbId}`, title: `${m.title}${s.label === 'radarr-4k' ? ' (4K)' : ''}`, sizeBytes: m.sizeOnDisk, ageDays: (now - addedMs) / 86400000 });
        }
      } else {
        const series = await axios.get(`${s.url}/api/v3/series`, { headers: { 'X-Api-Key': s.key }, timeout: 20000 }).then(r => r.data || []);
        for (const t of series) {
          const size = t.statistics?.sizeOnDisk || 0;
          if (!size) continue;
          const addedMs = Date.parse(t.added || '') || now;
          candidates.push({ mediaId: `tvdb:${t.tvdbId}`, title: t.title, sizeBytes: size, ageDays: (now - addedMs) / 86400000 });
        }
      }
    } catch (err) {
      audit('external_api_error', { provider: s.label, error: err.message, action: 'cleanup_suggestions' });
    }
  }
  const eligible = candidates
    .filter(c => !isInKeepList(c.mediaId) && !CONFIG.NEVER_DELETE_MEDIA_IDS.includes(c.mediaId))
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 12);
  if (!eligible.length) return interaction.editReply('Nothing sizable to suggest — everything is either small, keep-listed, or never-delete.');
  const total = fmtSpace(eligible.reduce((a, c) => a + c.sizeBytes, 0));
  await interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO)
    .setTitle(`🧹 Cleanup Suggestions (top ${eligible.length} ≈ ${total})`)
    .setDescription(eligible.map(c => `• **${c.title}** — ${fmtSpace(c.sizeBytes)} — ${Math.round(c.ageDays)}d old`).join('\n').slice(0, 4000))
    .setFooter({ text: 'Durant Media Server · Suggestions only — nothing is deleted. Keep list & never-delete already excluded.' })] });
}

async function handleMeCommand(interaction) {
  const row = getUserByDiscordId(interaction.user.id);
  if (!row) {
    return interaction.reply({ embeds: [brandedEmbed(COLORS.WARN)
      .setTitle('👤 Not Linked Yet')
      .setDescription('You aren\'t linked to a Plex account yet.\nDM me your Plex email to request access!')], ephemeral: true });
  }
  const requestCount = db.prepare('SELECT COUNT(*) AS c FROM requests WHERE requested_by_discord_id = ?').get(interaction.user.id).c;
  const embed = brandedEmbed(COLORS.PLEX)
    .setTitle('👤 Your Profile')
    .setThumbnail(interaction.user.displayAvatarURL?.() || null)
    .addFields(
      { name: 'Plex email', value: `\`${row.email}\``, inline: false },
      { name: 'Plex invite', value: row.invited ? '✅ Sent' : '⏳ Pending approval', inline: true },
      { name: 'Requests (Seerr)', value: row.overseerr_created ? '✅ Enabled' : '❌ Not set up', inline: true },
      { name: 'Total requests', value: `${requestCount}`, inline: true },
    );
  await interaction.reply({ embeds: [embed], ephemeral: true });
}
async function handleMyRequestsCommand(interaction) {
  const rows = db.prepare('SELECT * FROM requests WHERE requested_by_discord_id = ? ORDER BY id DESC LIMIT 15').all(interaction.user.id);
  const embed = brandedEmbed(COLORS.INFO)
    .setTitle('🎬 Your Recent Requests')
    .setDescription(rows.length
      ? rows.map(r => `${requestStatusBadge(r.status)} — **${r.title}** (${mediaTypeLabel(r.media_type, r.is_4k)})`).join('\n')
      : 'No requests yet. Request something in Overseerr and it\'ll show up here!');
  await interaction.reply({ embeds: [embed], ephemeral: true });
}
async function handleDownloadsCommand(interaction) {
  const rows = db.prepare('SELECT title, expires_at, one_time_use, created_at, revoked FROM download_tokens WHERE discord_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 20').all(interaction.user.id, Date.now());
  const active = rows.filter(r => !r.revoked);
  const embed = brandedEmbed(COLORS.INFO)
    .setTitle('📥 Your Active Download Links')
    .setDescription(active.length
      ? active.map(r => `**${r.title}**\n└ ${r.one_time_use ? '🔒 one-time' : '♻️ multi-use'} · expires ${discordTimestamp(r.expires_at)}`).join('\n')
      : 'No active links. Use `/download` to create one.');
  await interaction.reply({ embeds: [embed], ephemeral: true });
}
async function handleKeepCommand(interaction) {
  const rows = db.prepare('SELECT title, media_id, expires_at FROM keep_list WHERE kept_by_discord_id = ? ORDER BY created_at DESC LIMIT 20').all(interaction.user.id);
  const embed = brandedEmbed(COLORS.SUCCESS)
    .setTitle('📌 Your Keep List')
    .setDescription(rows.length
      ? rows.map(r => `**${r.title}**${r.expires_at ? ` — protected until ${discordTimestamp(r.expires_at, 'D')}` : ' — protected'}`).join('\n')
      : 'Nothing on your keep list. Media you choose to **Keep** shows up here, protected from cleanup.');
  await interaction.reply({ embeds: [embed], ephemeral: true });
}
async function handleHelpCommand(interaction) {
  const userCommands = [
    '`/request` — Search and request a movie or show; an admin approves it in Discord',
    '`/request-status` — Check why a request isn\'t ready yet',
    '`/download` — Get a secure download link for a movie or episode',
    '`/me` — Show your linked profile and access status',
    '`/myrequests` — Show your recent Seerr requests',
    '`/queue` — See what\'s downloading right now (progress + ETA)',
    '`/downloads` — Show your active download links',
    '`/keep` — Show your keep list (media saved from cleanup)',
    '`/help` — Show this help message',
  ];
  const embed = brandedEmbed(COLORS.PLEX)
    .setTitle('🎬 Durant Media Server — Help')
    .setDescription('DM the bot your Plex account email → an admin approves → you get Plex + Seerr (request) access.')
    .addFields({ name: 'Commands', value: userCommands.join('\n'), inline: false });
  if (isAdminInteraction(interaction)) {
    const adminCommands = [
      '`/invite` — DM a member for their Plex email and auto-set them up',
      '`/invite-post` — Post a public Request Access button in this channel',
      '`/link` — Link a Discord user to a Plex email (invites + sets up Seerr)',
      '`/unlink` — Remove a user from the DB',
      '`/users` — List linked users',
      '`/status` — Show system health and stats',
      '`/sync` — Preview or apply user sync',
      '`/sync-fix` — Resolve duplicates / placeholders / orphans / suggested links',
      '`/reinvite` — Re-send a Plex invite to a linked user',
      '`/requests` — Show the most recent Overseerr requests',
      '`/cleanup` — Remove deleted Overseerr users',
      '`/audit` — Query the audit log',
      '`/revoke-downloads` — Revoke active download links',
      '`/seerr-test` — Self-test Seerr Discord linking with a throwaway user',
      '`/watching` — Current Plex playback (via Tautulli)',
      '`/indexers` — Prowlarr indexer + Byparr health',
      '`/debrid` — Premiumize account + transfer status',
      '`/cleanup-suggestions` — Largest/oldest media that could be cleaned up',
    ];
    embed.addFields({ name: 'Admin commands', value: adminCommands.join('\n'), inline: false });
  }
  await interaction.reply({ embeds: [embed], ephemeral: true });
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

// customIds look like `delete_yes:tmdb:123:My%20Title:1234567890`. mediaId itself contains a
// ':' (tmdb:/tvdb: prefix), so naive positional destructuring shifted every field — requestorId
// ended up holding the encoded title, which silently broke the permission check and made the
// media lookup fail. The title is URI-encoded (':' becomes %3A) and the requestor is a plain
// snowflake, so parsing from the end is unambiguous.
function parseDeleteCustomId(parts) {
  const requestorId = parts[parts.length - 1];
  const encodedTitle = parts[parts.length - 2];
  const mediaId = parts.slice(0, -2).join(':');
  return { mediaId, title: decodeURIComponent(encodedTitle), requestorId };
}

async function handleButton(interaction) {
  const [action, ...parts] = interaction.customId.split(':');

  // Public self-service button from /invite-post — open to everyone, pops an email modal.
  if (action === 'request_access') {
    const existing = getUserByDiscordId(interaction.user.id);
    if (existing && !canonicalizeEmail(existing.email).startsWith('__placeholder__:')) {
      return interaction.reply({ content: `✅ You're already set up with \`${existing.email}\`. Use \`/me\` to check your access, or ask an admin if the email needs changing.`, ephemeral: true });
    }
    const modal = new ModalBuilder()
      .setCustomId('request_access_modal')
      .setTitle('Request Plex Access')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('plex_email')
          .setLabel('Email on your Plex account')
          .setPlaceholder('you@example.com')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100),
      ));
    return interaction.showModal(modal);
  }

  if (['plex_approve', 'plex_deny', 'overseerr_approve', 'overseerr_deny', 'request_approve', 'request_deny', 'pm_retry', 'pm_clear', 'pm_ignore', 'pm_clearstuck', 'pm_clearfinished'].includes(action) && !isAdminInteraction(interaction)) {
    return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
  }

  if (action === 'plex_approve') {
    const targetDiscordId = parts[0];
    await interaction.deferUpdate();
    const user = getUserByDiscordId(targetDiscordId);
    if (!user) return interaction.editReply({ content: 'User not found.', components: [] });
    let plexStatus = 'failed'; let overseerrStatus = 'failed'; let plexOk = false;
    try { const result = await inviteUserToPlex(user.email); markUserInvited(targetDiscordId); plexOk = result.successCount > 0; plexStatus = `ok (${result.successCount}/${result.total})`; } catch (err) { audit('external_api_error', { provider: 'plex', error: err.message, targetDiscordId }); }
    try { const du = await client.users.fetch(targetDiscordId); const oid = await createOverseerrUser(user.email, targetDiscordId, du.username); markOverseerrCreated(targetDiscordId, oid); overseerrStatus = `ok (${oid})`; } catch (err) { audit('external_api_error', { provider: 'overseerr', error: err.message, targetDiscordId }); }
    audit('admin_command_executed', { actorDiscordId: interaction.user.id, targetDiscordId, command: 'plex_approve' });
    // The welcome DM promises a confirmation — deliver it.
    await dmUser(targetDiscordId, { embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle('🎉 You\'re In!')
      .setDescription(`Your access request was approved!\n\n${plexOk ? `📬 A Plex invite was sent to \`${user.email}\` — accept it and you're set.` : `⚠️ Your Plex invite to \`${user.email}\` hit a snag — an admin is on it.`}\n\nOnce you're in, use \`/help\` here to see everything I can do. 🍿`)] });
    await interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle('✅ Access Approved')
      .addFields(
        { name: 'User', value: `<@${targetDiscordId}>`, inline: true },
        { name: 'Plex', value: plexStatus, inline: true },
        { name: 'Overseerr', value: overseerrStatus, inline: true },
      )], components: [] });
    return;
  }

  if (action === 'plex_deny') {
    const targetDiscordId = parts[0];
    removeUser(targetDiscordId);
    audit('admin_command_executed', { actorDiscordId: interaction.user.id, targetDiscordId, command: 'plex_deny' });
    await dmUser(targetDiscordId, { embeds: [brandedEmbed(COLORS.DANGER)
      .setTitle('Access Request Declined')
      .setDescription('Sorry — your Plex access request was declined. Reach out to an admin if you think this was a mistake.')] });
    await interaction.update({ embeds: [brandedEmbed(COLORS.DANGER)
      .setTitle('🚫 Access Declined')
      .setDescription(`Declined <@${targetDiscordId}>`)], components: [] });
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

  // Bot-side approval gate (/request from non-admins). Approve creates the Seerr request now —
  // Seerr insta-approves it, which is correct since an admin just did approve it.
  if (action === 'request_approve') {
    const nonce = parts[0];
    const pending = takePendingRequest(nonce);
    if (!pending) return interaction.update({ content: 'ℹ️ Already handled (or expired).', components: [] });
    await interaction.deferUpdate();
    try {
      const data = await createSeerrRequestAs(pending.seerrUserId, pending.mediaType, pending.tmdbId, pending.is4k);
      const mediaKey = pending.mediaType === 'tv' && data?.media?.tvdbId ? `tvdb:${data.media.tvdbId}` : `tmdb:${pending.tmdbId}`;
      if (data?.id != null) markApprovalNoticePosted(data.id); // suppress the duplicate webhook embed
      // The gate stored the request under tmdb:<id>; keep that row in sync too when the webhook
      // key differs (tv → tvdb).
      upsertRequest(data?.id, mediaKey, pending.mediaType, pending.is4k, pending.label, pending.discordId, 'approved');
      if (mediaKey !== `tmdb:${pending.tmdbId}`) upsertRequest(null, `tmdb:${pending.tmdbId}`, pending.mediaType, pending.is4k, pending.label, pending.discordId, 'approved');
      audit('request_approved_gate', { actorDiscordId: interaction.user.id, targetDiscordId: pending.discordId, title: pending.label, requestId: data?.id ?? null });
      await dmUser(pending.discordId, { embeds: [brandedEmbed(COLORS.SUCCESS)
        .setTitle(`${mediaTypeEmoji(pending.mediaType, pending.is4k)} Request Approved`)
        .setDescription(`**${pending.label}** was approved and is being grabbed now. You'll get a DM when it's on Plex! 🍿`)] });
      return interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS)
        .setTitle(`✅ Approved — ${pending.label}`)
        .setDescription(`Approved by <@${interaction.user.id}> for <@${pending.discordId}> — sent to Seerr${data?.id != null ? ` (request #${data.id})` : ''}.`)], components: [] });
    } catch (err) {
      const status = err.response?.status;
      const seerrMessage = err.response?.data?.message;
      audit('external_api_error', { provider: 'overseerr', error: seerrMessage || err.message, action: 'gate_approve', targetDiscordId: pending.discordId });
      // 409 duplicate and 202 no-seasons-left (see createSeerrRequestAs) mean the title is
      // already in Seerr's pipeline — retrying can never succeed, so resolve the gate instead of
      // leaving live buttons the admin will click forever.
      if (status === 202 || status === 409 || /already (exists|available|requested)/i.test(seerrMessage || '')) {
        upsertRequest(null, `tmdb:${pending.tmdbId}`, pending.mediaType, pending.is4k, pending.label, pending.discordId, 'approved');
        await dmUser(pending.discordId, { embeds: [brandedEmbed(COLORS.INFO)
          .setTitle(`${mediaTypeEmoji(pending.mediaType, pending.is4k)} Already Requested`)
          .setDescription(`Good news — **${pending.label}** is already in the system (requested earlier or already available), so there was nothing new to send. Check Plex, or track it with \`/request-status\`.`)] });
        return interaction.editReply({ embeds: [brandedEmbed(COLORS.WARN)
          .setTitle(`ℹ️ Already in Seerr — ${pending.label}`)
          .setDescription(`Approved by <@${interaction.user.id}> for <@${pending.discordId}>, but Seerr says: *${seerrMessage || err.message}*. Nothing new was created — it's already requested or available.`)], components: [] });
      }
      // Anything else (network, 5xx) is retryable: put the stash back so the button still works.
      restashPendingRequest(nonce, pending);
      return interaction.followUp({ content: `❌ Approving failed: ${seerrMessage || err.message}. The buttons still work — try again.`, ephemeral: true });
    }
  }
  if (action === 'request_deny') {
    const pending = takePendingRequest(parts[0]);
    if (!pending) return interaction.update({ content: 'ℹ️ Already handled (or expired).', components: [] });
    upsertRequest(null, `tmdb:${pending.tmdbId}`, pending.mediaType, pending.is4k, pending.label, pending.discordId, 'declined');
    audit('request_denied_gate', { actorDiscordId: interaction.user.id, targetDiscordId: pending.discordId, title: pending.label });
    await dmUser(pending.discordId, { embeds: [brandedEmbed(COLORS.DANGER)
      .setTitle('Request Declined')
      .setDescription(`Sorry — **${pending.label}** was declined. Reach out to an admin if you think this was a mistake.`)] });
    return interaction.update({ embeds: [brandedEmbed(COLORS.DANGER)
      .setTitle(`🚫 Denied — ${pending.label}`)
      .setDescription(`Denied by <@${interaction.user.id}> (requested by <@${pending.discordId}>). Nothing was sent to Seerr.`)], components: [] });
  }

  // Premiumize stuck-transfer actions (from watchdog alerts and /debrid).
  if (action === 'pm_retry') {
    await interaction.deferUpdate();
    try {
      await retryTransfer(parts[0]);
      pmTracker.delete(String(parts[0])); // fresh progress window after the retry
      audit('premiumize_transfer_retried', { actorDiscordId: interaction.user.id, transferId: parts[0] });
      return interaction.editReply({ content: `🔁 Transfer retried by <@${interaction.user.id}>.`, components: [] });
    } catch (err) {
      return interaction.followUp({ content: `❌ Retry failed: ${err.message}`, ephemeral: true });
    }
  }
  if (action === 'pm_clear') {
    await interaction.deferUpdate();
    try {
      await deleteTransfer(parts[0]);
      pmTracker.delete(String(parts[0]));
      audit('premiumize_transfer_cleared', { actorDiscordId: interaction.user.id, transferId: parts[0] });
      return interaction.editReply({ content: `🧹 Transfer cleared by <@${interaction.user.id}>.`, components: [] });
    } catch (err) {
      return interaction.followUp({ content: `❌ Clear failed: ${err.message}`, ephemeral: true });
    }
  }
  if (action === 'pm_ignore') {
    setSetting(`pm_ignore:${parts[0]}`, '1');
    audit('premiumize_transfer_ignored', { actorDiscordId: interaction.user.id, transferId: parts[0] });
    return interaction.update({ content: `🔕 Ignoring this transfer (flag clears when it leaves the list).`, components: [] });
  }
  // Bulk: delete every transfer that is error/queued/running at ≤1% progress — "clear the 0% ones".
  if (action === 'pm_clearstuck') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const transfers = await listTransfers();
      const targets = transfers.filter(t => isStuckCandidate(t) && Number(t.progress || 0) <= 0.01);
      let cleared = 0;
      const failures = [];
      for (const t of targets) {
        try { await deleteTransfer(t.id); pmTracker.delete(String(t.id)); cleared++; }
        catch (err) { failures.push(`${String(t.name || t.id).slice(0, 40)}: ${err.message}`); }
      }
      audit('premiumize_stuck_cleared_bulk', { actorDiscordId: interaction.user.id, cleared, attempted: targets.length });
      return interaction.editReply(`🧹 Cleared ${cleared}/${targets.length} stuck/0% transfer(s).${failures.length ? `\n❌ ${failures.slice(0, 3).join('\n❌ ')}` : ''}`);
    } catch (err) {
      return interaction.editReply(`❌ Couldn't list transfers: ${err.message}`);
    }
  }
  if (action === 'pm_clearfinished') {
    await interaction.deferReply({ ephemeral: true });
    try {
      await clearFinished();
      audit('premiumize_finished_cleared', { actorDiscordId: interaction.user.id });
      return interaction.editReply('🧹 Finished transfers cleared.');
    } catch (err) {
      return interaction.editReply(`❌ Clear finished failed: ${err.message}`);
    }
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

  if (['syncfix_linkapply', 'syncfix_linkdismiss'].includes(action)) {
    if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const stored = getSetting(`syncfix_pending:${parts[0]}`);
    if (!stored) return interaction.reply({ content: '❌ This action expired. Re-run /sync-fix links.', ephemeral: true });
    const [discordId, plexId, ...emailParts] = stored.split('|');
    const plexEmail = emailParts.join('|');

    if (action === 'syncfix_linkdismiss') {
      setSetting(`suggestlink_ack:${discordId}:${plexId}`, '1');
      audit('sync_fix_link_dismissed', { actorDiscordId: interaction.user.id, targetDiscordId: discordId, plexId });
      return interaction.reply({ content: `✅ Dismissed — won't suggest linking <@${discordId}> to \`plex_${plexId}\` again.`, ephemeral: true });
    }

    // Re-validate against the live DB — the plex_ row may have been merged or removed since.
    if (!getUserByDiscordId(`plex_${plexId}`)) return interaction.reply({ content: '❌ Plex row no longer exists. Re-run /sync-fix links.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const du = await client.users.fetch(discordId).catch(() => null);
    const { absorbed, plexStatus, seerrStatus } = await applyFullChainLink(discordId, plexEmail, du?.username);
    audit('user_linked', { actorDiscordId: interaction.user.id, targetDiscordId: discordId, email: plexEmail, source: 'syncfix_links', absorbedPlexRow: absorbed?.discord_id || null });
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle('🔗 User Linked')
      .setDescription(`<@${discordId}> → \`${plexEmail}\``)
      .addFields(
        { name: 'DB', value: absorbed ? `✅ linked (merged \`${absorbed.discord_id}\` row)` : '✅ linked', inline: false },
        { name: 'Plex', value: plexStatus, inline: true },
        { name: 'Seerr', value: seerrStatus, inline: true },
      )] });
  }

  if (['stuck_retry', 'stuck_rm', 'stuck_ignore'].includes(action)) {
    if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const [label, queueId] = parts;
    const itemName = interaction.message.embeds?.[0]?.description || 'this download';

    if (action === 'stuck_ignore') {
      setSetting(`stuck_ignore:${label}:${queueId}`, '1');
      audit('stuck_download_ignored', { actorDiscordId: interaction.user.id, label, queueId });
      return interaction.update({ embeds: [brandedEmbed(COLORS.INFO)
        .setTitle('🙈 Ignoring Stuck Download')
        .setDescription(`${itemName}\n\nNo more alerts for this item while it stays in the queue.`)], components: [] });
    }

    const src = arrSourceByLabel(label);
    if (!src) return interaction.reply({ content: `❌ ${label} is not configured anymore.`, ephemeral: true });
    await interaction.deferUpdate();
    const retry = action === 'stuck_retry';
    try {
      await axios.delete(`${src.url}/api/v3/queue/${queueId}`, {
        params: { removeFromClient: true, blocklist: retry, skipRedownload: !retry },
        headers: { 'X-Api-Key': src.key },
        timeout: 15000,
      });
      audit('stuck_download_removed', { actorDiscordId: interaction.user.id, label, queueId, blocklisted: retry });
      return interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS)
        .setTitle(retry ? '🔁 Removed — Searching for Another Release' : '🗑️ Removed From Queue')
        .setDescription(`${itemName}\n\n${retry ? 'The release was blocklisted and a search for a replacement was triggered.' : 'Removed without blocklisting; nothing new was grabbed.'}`)], components: [] });
    } catch (err) {
      audit('external_api_error', { provider: label, error: err.message, action: 'stuck_remove', queueId });
      return interaction.editReply({ embeds: [brandedEmbed(COLORS.DANGER)
        .setTitle('❌ Remove Failed')
        .setDescription(`${itemName}\n\n${err.message}\n(It may have already finished or been removed.)`)], components: [] });
    }
  }

  if (action === 'delete_yes') {
    const { mediaId, title, requestorId } = parseDeleteCustomId(parts);
    if (interaction.user.id !== requestorId && !isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Not allowed.', ephemeral: true });
    if (!CONFIG.ENABLE_DELETION) return interaction.reply({ content: '⚠️ Deletion is disabled by config.', ephemeral: true });
    if (CONFIG.NEVER_DELETE_MEDIA_IDS.includes(mediaId)) return interaction.reply({ content: '⚠️ This media is in never-delete override list.', ephemeral: true });
    if (isInKeepList(mediaId)) return interaction.reply({ content: '⚠️ This media is in the keep list — not deleting.', ephemeral: true });
    audit('keep_delete_decision_made', { actorDiscordId: interaction.user.id, requestorId, mediaId, decision: 'delete_now' });
    await interaction.deferUpdate();

    const result = await executeDeletion(mediaId, title, { actorDiscordId: interaction.user.id, requestorId, reason: 'user_button' });
    if (result.outcome === 'error') return interaction.editReply({ content: `❌ Delete failed for **${title}**: ${result.error}`, components: [] });
    if (result.outcome === 'not_found') { markPendingDeletion(mediaId, 'cancelled'); return interaction.editReply({ content: `⚠️ Could not find **${title}** in Radarr/Sonarr — nothing to delete.`, components: [] }); }
    if (result.outcome === 'dry_run') {
      markPendingDeletion(mediaId, 'dry_run');
      const fileList = result.paths.length ? result.paths.slice(0, 5).map(p => `• \`${p}\``).join('\n') : '• (no files on disk)';
      return interaction.editReply({ content: `🧪 **Dry-run** — would delete **${title}** (${result.kind}, ${result.paths.length} file(s)).\n${fileList}\nWould call: \`${result.apiCall}\`\n\nSet \`DELETION_DRY_RUN=false\` to perform real deletes.`, components: [] });
    }
    markPendingDeletion(mediaId, 'deleted');
    return interaction.editReply({ content: `🗑️ Deleted **${title}**. ${result.detail}`, components: [] });
  }

  if (action === 'delete_no') {
    const { mediaId, title, requestorId } = parseDeleteCustomId(parts);
    if (interaction.user.id !== requestorId && !isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Not allowed.', ephemeral: true });
    addToKeepList(mediaId, mediaId.startsWith('tvdb:') ? 'tv' : 'movie', title, requestorId);
    markPendingDeletion(mediaId, 'kept');
    audit('keep_delete_decision_made', { actorDiscordId: interaction.user.id, requestorId, mediaId, decision: 'keep' });
    await interaction.update({ content: `📌 Keeping **${title}**.`, components: [] });
    return;
  }

  if (action === 'delete_later') {
    const { mediaId, requestorId } = parseDeleteCustomId(parts);
    if (interaction.user.id !== requestorId && !isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Not allowed.', ephemeral: true });
    const nextPromptAt = Date.now() + CONFIG.DELETION_REMINDER_COOLDOWN_HOURS * 3600 * 1000;
    setSetting(`delete_prompt_snooze:${mediaId}:${requestorId}`, String(nextPromptAt));
    // Give a fresh grace window after the reminder fires, so snoozing never means
    // waking up to an already-deleted file.
    postponePendingDeletion(mediaId, nextPromptAt + CONFIG.DELETION_GRACE_HOURS * 3600000);
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
    apiCheck('prowlarr', async () => { if (!CONFIG.PROWLARR_URL) return 'skipped'; await axios.get(`${CONFIG.PROWLARR_URL}/api/v1/system/status`, { headers: { 'X-Api-Key': CONFIG.PROWLARR_API_KEY }, timeout: 5000 }); }),
    apiCheck('byparr', async () => { if (!CONFIG.BYPARR_URL) return 'skipped'; await axios.get(`${CONFIG.BYPARR_URL}/health`, { timeout: 5000 }); }),
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
  const passOk = CONFIG.DASHBOARD_ADMIN_PASSWORD && safeEqual(pwd, CONFIG.DASHBOARD_ADMIN_PASSWORD);
  const tokenOk = CONFIG.DASHBOARD_ADMIN_TOKEN && safeEqual(token, CONFIG.DASHBOARD_ADMIN_TOKEN);
  if (!sessionOk && !passOk && !tokenOk) {
    // Browsers hitting a page get sent to the login form; API/non-GET callers get 401.
    if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
      return res.redirect('/admin/login');
    }
    return res.status(401).send('Unauthorized');
  }

  if (CONFIG.STRICT_DASHBOARD_POST_AUTH && req.method !== 'GET') {
    // Exact host match. Substring matching allowed e.g. https://myhost.com.evil.net through.
    const sameHost = headerValue => {
      if (!headerValue) return true; // header absent — nothing to compare
      try { return new URL(headerValue).host === req.get('host'); } catch (_e) { return false; }
    };
    if (!sameHost(req.get('origin')) || !sameHost(req.get('referer'))) {
      return res.status(403).send('Cross-site POST denied');
    }
  }
  return next();
}

function startExpressServer() {
  const app = express();
  app.disable('x-powered-by');
  const upload = multer({ limits: { fileSize: 5 * 1024 * 1024, files: 5 } });
  app.use((req, res, next) => { if (req.is('multipart/form-data')) return next(); bodyParser.json({ limit: '1mb' })(req, res, next); });

  app.get('/health', async (_req, res) => res.json(await gatherHealth()));

  app.post('/webhook/overseerr', upload.any(), async (req, res) => {
    if (CONFIG.WEBHOOK_SECRET && !safeEqual(req.headers['x-webhook-secret'], CONFIG.WEBHOOK_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
    res.sendStatus(200);
    try {
      let body = req.body;
      if (typeof body.payload === 'string') body = JSON.parse(body.payload);
      audit('webhook_received', { source: 'overseerr', type: body.notification_type });
      await handleOverseerrWebhook(body);
    } catch (err) { audit('external_api_error', { provider: 'overseerr_webhook', error: err.message }); }
  });

  app.post('/webhook/plex', upload.any(), async (req, res) => {
    if (CONFIG.WEBHOOK_SECRET && !safeEqual(req.headers['x-webhook-secret'], CONFIG.WEBHOOK_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
    res.sendStatus(200);
    try {
      const payload = JSON.parse(req.body.payload || '{}');
      audit('webhook_received', { source: 'plex', event: payload.event });
      await handlePlexWebhook(payload);
    } catch (err) { audit('external_api_error', { provider: 'plex_webhook', error: err.message }); }
  });

  app.post('/webhook/tautulli', async (req, res) => {
    if (CONFIG.TAUTULLI_WEBHOOK_SECRET && !safeEqual(req.headers['x-tautulli-secret'], CONFIG.TAUTULLI_WEBHOOK_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
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
      notifyChannel('downloads', `📥 Large download started by <@${record.discord_id}>: ${record.title} (${(stat.size / (1024 ** 3)).toFixed(2)} GB)`);
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
      // Validate before touching the filesystem: a malformed header (NaN start, start > end,
      // start past EOF) used to reach createReadStream and throw mid-response.
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      let start; let end;
      if (m && m[1] === '' && m[2] !== '') {
        // suffix form: last N bytes
        start = Math.max(fileSize - Number.parseInt(m[2], 10), 0);
        end = fileSize - 1;
      } else {
        start = m && m[1] !== '' ? Number.parseInt(m[1], 10) : NaN;
        end = m && m[2] !== '' ? Math.min(Number.parseInt(m[2], 10), fileSize - 1) : fileSize - 1;
      }
      if (!m || Number.isNaN(start) || start > end || start >= fileSize) {
        res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
        return res.end();
      }
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
    RATE_LIMIT_MAPS.push(loginLimits);
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
      const passOk = CONFIG.DASHBOARD_ADMIN_PASSWORD && safeEqual(pwd, CONFIG.DASHBOARD_ADMIN_PASSWORD);
      const tokenOk = CONFIG.DASHBOARD_ADMIN_TOKEN && safeEqual(pwd, CONFIG.DASHBOARD_ADMIN_TOKEN);
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
  const keys = ['discord', 'sqlite', 'plex', 'overseerr', 'radarr', 'radarr4k', 'sonarr', 'prowlarr', 'byparr', 'raidPath', 'tunnelDomain'];
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

// Resolve who actually made an Overseerr request.
//
// The old logic trusted `requestedBy_settings_discordId` from the webhook payload first.
// If the webhook template is configured with {{notifyuser_*}} variables (or the request was
// placed via the admin API key), that field carries the ADMIN's identity for every event —
// which is how every request ended up attributed to the server owner. Our own DB, keyed by
// the requester's email, is the source of truth; the webhook field is only a fallback, and
// anything that isn't a real snowflake (or is the bot itself) is ignored.
//
// Seerr 3.3 renamed the template variable to `requestedBy_settings_discordIds`, which can carry
// several IDs (array, or a comma/semicolon-joined string) — and an outdated template leaves the
// literal `{{...}}` placeholder behind. Accept both variables, split list values, and take the
// first real snowflake; the placeholder and other junk fail isSnowflake and fall through.
function webhookDiscordId(value) {
  const parts = (Array.isArray(value) ? value : String(value || '').split(/[,;\s]+/)).map(v => String(v || '').trim());
  return parts.find(p => isSnowflake(p) && p !== CONFIG.DISCORD_CLIENT_ID) || null;
}
function resolveRequester(request) {
  const email = (request?.requestedBy_email || '').trim() || null;
  const dbUser = email ? getUserByCanonicalEmail(email) : null;
  if (dbUser && isSnowflake(dbUser.discord_id)) {
    return { discordId: dbUser.discord_id, email, source: 'db-email' };
  }
  const hookId = webhookDiscordId(request?.requestedBy_settings_discordIds) || webhookDiscordId(request?.requestedBy_settings_discordId);
  if (hookId) {
    return { discordId: hookId, email, source: 'webhook' };
  }
  return { discordId: null, email, source: 'none' };
}

// Poster URL from the webhook payload ({{image}} in the Overseerr template), if sane.
function posterUrl(body) {
  const url = String(body?.image || '').trim();
  return /^https:\/\//.test(url) ? url : null;
}

async function dmUser(discordId, payload) {
  if (!isSnowflake(discordId)) return false;
  try {
    const user = await client.users.fetch(discordId);
    await user.send(payload);
    return true;
  } catch (_e) {
    return false;
  }
}

async function handleOverseerrWebhook(body) {
  const { notification_type, subject, media, request } = body;
  if (!notification_type || !media) return;
  const titleMatch = subject?.match(/^.+? - (.+)$/);
  const title = titleMatch ? titleMatch[1] : (subject || 'Unknown Title');
  const is4k = !!media.is4k;
  const mediaId = media.media_type === 'tv' ? `tvdb:${media.tvdbId}` : `tmdb:${media.tmdbId}`;
  const requester = resolveRequester(request);
  let requesterDiscordId = requester.discordId;
  // Later events (approved/declined/available) often arrive without requestedBy_* fields.
  // The DB row keeps the original requester (COALESCE in upsertRequest), so fall back to it —
  // otherwise the approval/decline/available DMs silently never fire for those payloads.
  if (!requesterDiscordId) {
    const stored = request?.request_id
      ? db.prepare('SELECT requested_by_discord_id FROM requests WHERE overseerr_request_id = ?').get(String(request.request_id))
      : db.prepare('SELECT requested_by_discord_id FROM requests WHERE media_id = ? ORDER BY id DESC LIMIT 1').get(mediaId);
    if (isSnowflake(stored?.requested_by_discord_id)) {
      requesterDiscordId = stored.requested_by_discord_id;
      requester.source = 'db-request';
    }
  }
  const poster = posterUrl(body);
  const requesterLine = requesterDiscordId
    ? `<@${requesterDiscordId}>${requester.email ? ` · \`${requester.email}\`` : ''}`
    : (requester.email ? `\`${requester.email}\`` : 'Unknown');

  if (['MEDIA_PENDING', 'MEDIA_AUTO_APPROVED'].includes(notification_type)) {
    // /request already posted the Approve/Deny notice for this id — don't double-post.
    const alreadyPosted = request?.request_id && postedApprovalNotices.has(String(request.request_id));
    const adminChannel = alreadyPosted ? null : await safeGetChannel(channelFor('requests'));
    if (adminChannel) {
      const autoApproved = notification_type === 'MEDIA_AUTO_APPROVED';
      const embed = brandedEmbed(autoApproved ? COLORS.SUCCESS : COLORS.INFO)
        .setTitle(`${mediaTypeEmoji(media.media_type, is4k)} ${autoApproved ? 'Request Auto-Approved' : 'New Request'}`)
        .setDescription(`**${title}**`)
        .addFields(
          { name: 'Requested by', value: requesterLine, inline: true },
          { name: 'Type', value: mediaTypeLabel(media.media_type, is4k), inline: true },
          { name: 'Status', value: autoApproved ? '✅ Auto-approved' : '⏳ Awaiting approval', inline: true },
        );
      if (poster) embed.setThumbnail(poster);
      if (request?.request_id) embed.setFooter({ text: `Durant Media Server · Request #${request.request_id}` });
      // Requestrr submits through Seerr as its configured default user unless per-user mapping
      // is enabled. When everything resolves to the admin, surface it instead of silently
      // pinning requests on the server owner.
      if (requesterDiscordId === CONFIG.ADMIN_USER_ID) {
        embed.addFields({ name: '⚠️ Attribution', value: 'Resolved to the admin account. If someone else requested this (e.g. via Requestrr without per-user mapping), Seerr recorded the wrong requester.', inline: false });
      }
      const components = [];
      if (!autoApproved && request?.request_id) {
        components.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`overseerr_approve:${request.request_id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`overseerr_deny:${request.request_id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
        ));
      }
      await adminChannel.send({ embeds: [embed], components });
    }
    audit('seerr_request_received', { requestId: request?.request_id, requesterDiscordId, requesterSource: requester.source, title, mediaId });
  }

  if (['MEDIA_PENDING', 'MEDIA_AUTO_APPROVED', 'MEDIA_APPROVED', 'MEDIA_AVAILABLE', 'MEDIA_DECLINED'].includes(notification_type)) {
    const status = { MEDIA_PENDING: 'pending', MEDIA_AUTO_APPROVED: 'approved', MEDIA_APPROVED: 'approved', MEDIA_AVAILABLE: 'available', MEDIA_DECLINED: 'declined' }[notification_type];
    upsertRequest(request?.request_id, mediaId, media.media_type, is4k, title, requesterDiscordId, status);
  }

  if (['MEDIA_APPROVED', 'MEDIA_AUTO_APPROVED'].includes(notification_type) && requesterDiscordId) {
    const embed = brandedEmbed(COLORS.SUCCESS)
      .setTitle('🎉 Request Approved')
      .setDescription(`**${title}** was approved and is being grabbed now.\nYou'll get another DM the moment it's ready to watch.`);
    if (poster) embed.setThumbnail(poster);
    await dmUser(requesterDiscordId, { embeds: [embed] });
  }

  if (notification_type === 'MEDIA_DECLINED' && requesterDiscordId) {
    const embed = brandedEmbed(COLORS.DANGER)
      .setTitle('🚫 Request Declined')
      .setDescription(`Sorry — your request for **${title}** was declined.\nReach out to an admin if you think this was a mistake.`);
    if (poster) embed.setThumbnail(poster);
    await dmUser(requesterDiscordId, { embeds: [embed] });
  }

  if (notification_type === 'MEDIA_FAILED') {
    const embed = brandedEmbed(COLORS.DANGER)
      .setTitle('⚠️ Request Failed')
      .setDescription(`**${title}** failed to process in ${media.media_type === 'tv' ? 'Sonarr' : 'Radarr'}.`)
      .addFields({ name: 'Requested by', value: requesterLine, inline: true });
    if (poster) embed.setThumbnail(poster);
    notifyChannel('requests', { embeds: [embed] });
    audit('seerr_request_failed', { requestId: request?.request_id, requesterDiscordId, title, mediaId });
  }

  if (notification_type === 'MEDIA_AVAILABLE' && requesterDiscordId) {
    const embed = brandedEmbed(COLORS.SUCCESS)
      .setTitle('🍿 Now Available on Plex')
      .setDescription(`**${title}** is ready to watch — enjoy!\n\nWant something else? Use \`/download\` or request more anytime.`);
    if (poster) embed.setImage(poster);
    const sent = await dmUser(requesterDiscordId, { embeds: [embed] });
    if (sent) audit('media_available_notification_sent', { targetDiscordId: requesterDiscordId, title });
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
  if (!isSnowflake(reqRow?.requested_by_discord_id)) return;
  const snoozeUntil = Number(getSetting(`delete_prompt_snooze:${mediaId}:${reqRow.requested_by_discord_id}`) || '0');
  if (snoozeUntil > Date.now()) return;

  const adminChannel = await safeGetChannel(channelFor('cleanup'));
  if (!adminChannel) return;
  const encodedTitle = encodeURIComponent(title);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`delete_no:${mediaId}:${encodedTitle}:${reqRow.requested_by_discord_id}`).setLabel('Keep').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`delete_yes:${mediaId}:${encodedTitle}:${reqRow.requested_by_discord_id}`).setLabel('Delete Now').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`delete_later:${mediaId}:${encodedTitle}:${reqRow.requested_by_discord_id}`).setLabel('Remind Me Later').setStyle(ButtonStyle.Primary),
  );
  const autoLine = CONFIG.ENABLE_DELETION ? `\n\n⏳ Auto-deletes in ${CONFIG.DELETION_GRACE_HOURS} hour(s) unless you choose **Keep**.` : '';
  await adminChannel.send({ content: `<@${reqRow.requested_by_discord_id}>`, embeds: [brandedEmbed(COLORS.WARN).setTitle(`${mediaTypeEmoji(mediaType === 'episode' ? 'tv' : 'movie', is4k)} Finished Watching`).setDescription(`Looks like you finished **${title}**. Should we keep it or free up space?${autoLine}`)], components: [row] });
  recordPendingDeletion(mediaId, mediaType === 'episode' ? 'tv' : 'movie', title, reqRow.requested_by_discord_id);
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
  if (!isSnowflake(reqRow?.requested_by_discord_id) || isInKeepList(mediaId)) return;
  const snoozeUntil = Number(getSetting(`delete_prompt_snooze:${mediaId}:${reqRow.requested_by_discord_id}`) || '0');
  if (snoozeUntil > Date.now()) return;
  const adminChannel = await safeGetChannel(channelFor('cleanup'));
  if (!adminChannel) return;
  const showTitle = media_type === 'episode' ? (grandparent_title || title) : title;
  const encodedTitle = encodeURIComponent(showTitle);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`delete_no:${mediaId}:${encodedTitle}:${reqRow.requested_by_discord_id}`).setLabel('Keep').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`delete_yes:${mediaId}:${encodedTitle}:${reqRow.requested_by_discord_id}`).setLabel('Delete Now').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`delete_later:${mediaId}:${encodedTitle}:${reqRow.requested_by_discord_id}`).setLabel('Remind Me Later').setStyle(ButtonStyle.Primary),
  );
  const tautulliAutoLine = CONFIG.ENABLE_DELETION ? `\n\n⏳ Auto-deletes in ${CONFIG.DELETION_GRACE_HOURS} hour(s) unless you choose **Keep**.` : '';
  await adminChannel.send({ content: `<@${reqRow.requested_by_discord_id}>`, embeds: [brandedEmbed(COLORS.WARN).setTitle('📺 Finished Watching').setDescription(`Looks like you finished **${showTitle}**. Keep it, or free up space?${tautulliAutoLine}`)], components: [row] });
  recordPendingDeletion(mediaId, media_type === 'episode' ? 'tv' : 'movie', showTitle, reqRow.requested_by_discord_id);
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
