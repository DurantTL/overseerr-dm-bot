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
  StringSelectMenuBuilder,
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
const { sha256, safeEqual, isSnowflake, canonicalizeEmail, isValidEmail, mediaTypeLabel, mediaTypeEmoji, requestStatusBadge, discordTimestamp, releaseEtaInfo, statusEmoji, pad, fmtDuration, mimeFor, gb, fmtSpace, progressBar, queuePercent, queueItemLooksUnhealthy } = require('./src/util');
const { db, ensureColumn, runMigrations, audit, upsertTierNode, getTierNode, listTierNodes, setTierNodeEnabled, addTierNodeMember, removeTierNodeMember, listTierNodeMembers, setTierAgentToken, getTierAgentTokenHash, replaceTierNodeFiles, listTierNodeFiles, listRequestsByRequesters, getTierPlan, setTierPlan, storeUserEmail, linkUserToEmail, getUserByDiscordId, getUserByCanonicalEmail, markUserInvited, markOverseerrCreated, removeUser, upsertRequest, addToKeepList, isInKeepList, recordPendingDeletion, markPendingDeletion, postponePendingDeletion, recordEscalationWatch, getWatchingEscalations, getEscalationById, setEscalationState, setEscalationTvdbId, markEscalationArrMissingAlerted, touchEscalationApprovedAt, resolveEscalationForMediaKey, recordGrabJob, getGrabJob, getGrabJobByHash, getGrabJobByRelease, listActiveGrabJobs, nextTransferableGrabJob, setGrabJobState, countGrabJobsToday, requeueGrabTransfer, resetInterruptedGrabTransfers, stashGrabOffer, takeGrabOffer, restashGrabOffer, listAdoptedGrabJobs, setAdoptIgnored, clearAdoptIgnored, isAdoptIgnored, listAdoptIgnored, markAdoptOffered, isAdoptOffered, clearAdoptOffered, listAdoptOfferedHashes, setUserHomeServer, enqueueStageJob, getStageJob, nextQueuedStageJob, listActiveStageJobs, markStageJobCopying, finishStageJob, requeueStageJob, resetInterruptedStageJobs, recordStagedItem, getStagedItem, listStagedItems, removeStagedItem, touchStagedItem, setStagedItemPinned, createDownloadToken, getDownloadRecordByRawToken, revokeAllDownloadLinks, cleanExpiredTokens, getSetting, setSetting, stashPendingRequest, takePendingRequest, restashPendingRequest } = require('./src/db');
const { PLEX_CLIENT_ID, getPlexToken, plexApiGet, getPlexServers, inviteUserToPlex, removePlexAccess } = require('./src/plex');
const { setOverseerrDiscordNotification, createOverseerrUser, runSeerrSelfTest, searchSeerr, checkExistingSeerrMedia, fetchSeerrTvdbId, createSeerrRequestAs, verifySeerrRequestCreated, resolveSeerrUserId, approveOverseerrRequest, denyOverseerrRequest, fetchOverseerrUsers } = require('./src/seerr');
const { radarrGetFrom, sonarrGet, arrSources, fetchArrQueues, fetchDiskSpace, searchMovies, searchSeries, getEpisodeFiles, resolveDeletableMedia, executeDeletion, getMovieByTmdbId, getSeriesByTvdbId, applyAvistazTag, escalateMediaToAvistaz, addMediaToArr, pairFilesToEpisodes, verifyAvistazTags, fetchReleaseEta, remapPath } = require('./src/arr');
const { decideEscalationAction, escalationEligible } = require('./src/escalation');
const { tautulliConfigured, tautulliApi, fetchHistory, describeSession } = require('./src/tautulli');
const { planTier, gatherNodeHistories, fetchTierInventory, fetchPlexHistory, parseAtimeMask, maskSuspectAtimes, renderSyncthingStignore, renderRclone } = require('./src/tier');
const { stagingConfigured, classifyServerIdentity, planCacheSpace, resolveStageSource, stageCopy, purgeStagedPath, getCacheStatus, runRclone } = require('./src/staging');
const { grabConfigured, grabImportTarget, findAvistazIndexer, searchAvistaz, fetchTorrentFile, normalizeTitle, rankAvistazResults, grabAllowance, decideGrabJobAction } = require('./src/grab');
const { rtorrentConfigured, computeInfoHash, addTorrentToRtorrent, getRtorrentStatus, listRtorrentTorrents, getRtorrentVersion } = require('./src/rtorrent');
const { matchTorrentsByName, adoptTargetForLabel, remoteSubpathCandidates, parseRemoteListing, indexRemoteListing, remoteSizeMatches, joinRemotePath, decideAdoption, bulkTargetChoices } = require('./src/adopt');
const { premiumizeConfigured, accountInfo, listTransfers, deleteTransfer, retryTransfer, clearFinished, findStuckTransfers, isStuckCandidate } = require('./src/premiumize');
const { detectStuckItems, stuckGroupKey, groupStuckItems, isSeasonGroup } = require('./src/stuck');

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
// Deliberately NOT in RATE_LIMIT_MAPS: its window is 24h and the hourly reaper would wipe the
// counts. It holds at most one small bucket per family member.
const stageCommandLimits = new Map();

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

// "45m" / "1h 30m" — the escalation delay as shown in embeds and logs.
const escalationDelayLabel = () => fmtDuration(CONFIG.ESCALATION_DELAY_MINUTES * 60000);

// Whether this request could be escalated to AvistaZ (feature on, right media type, arr present).
function canEscalate({ mediaType, is4k }) {
  return escalationEligible({ mediaType, is4k }, {
    enabled: CONFIG.ESCALATION_ENABLED,
    radarrConfigured: !!CONFIG.RADARR_URL,
    sonarrConfigured: !!CONFIG.SONARR_URL,
  });
}

// Post the Approve/Deny gate embed for a stashed /request to the requests channel.
async function postPendingRequestNotice(nonce, { label, mediaType, is4k, discordId, email }) {
  const channel = await safeGetChannel(channelFor('requests'));
  if (!channel) return false;
  const azEligible = canEscalate({ mediaType, is4k });
  const embed = brandedEmbed(COLORS.INFO)
    .setTitle(`${mediaTypeEmoji(mediaType, is4k)} New Request`)
    .setDescription(`**${label}**${azEligible ? `\n-# "+ AvistaZ Fallback" pre-authorizes the private tracker if nothing public shows up within ${escalationDelayLabel()}.` : ''}`)
    .addFields(
      { name: 'Requested by', value: `<@${discordId}> · \`${email}\``, inline: true },
      { name: 'Type', value: mediaTypeLabel(mediaType, is4k), inline: true },
      { name: 'Status', value: '⏳ Awaiting approval', inline: true },
    )
    .setFooter({ text: 'Durant Media Server · Not sent to Seerr until approved' });
  const buttons = [
    new ButtonBuilder().setCustomId(`request_approve:${nonce}`).setLabel('Approve').setStyle(ButtonStyle.Success),
  ];
  if (azEligible) buttons.push(new ButtonBuilder().setCustomId(`request_approve_az:${nonce}`).setLabel('Approve + AvistaZ Fallback').setStyle(ButtonStyle.Primary));
  buttons.push(new ButtonBuilder().setCustomId(`request_deny:${nonce}`).setLabel('Deny').setStyle(ButtonStyle.Danger));
  const row = new ActionRowBuilder().addComponents(...buttons);
  await channel.send({ embeds: [embed], components: [row] });
  return true;
}

// Bot-side approval gate: create the stashed Seerr request an admin just approved. Shared by the
// plain Approve button and Approve + AvistaZ Fallback (azPreAuth lets the escalation watchdog
// auto-escalate instead of asking first).
async function handleGateApprove(interaction, nonce, { azPreAuth }) {
  const pending = takePendingRequest(nonce);
  if (!pending) return interaction.update({ content: 'ℹ️ Already handled (or expired).', components: [] });
  await interaction.deferUpdate();
  try {
    const data = await createSeerrRequestAs(pending.seerrUserId, pending.mediaType, pending.tmdbId, pending.is4k);
    const mediaKey = pending.mediaType === 'tv' && data?.media?.tvdbId ? `tvdb:${data.media.tvdbId}` : `tmdb:${pending.tmdbId}`;
    if (data?.id != null) markApprovalNoticePosted(data.id); // suppress the duplicate webhook embed
    // Don't take Seerr's "accepted" at face value — it can lose the request moments later
    // ('Media data not found' in its log). Restash and leave the buttons live (omitting
    // `components` keeps them) so the admin can retry once the Seerr-side problem is fixed.
    const verified = data?.id != null ? await verifySeerrRequestCreated(data.id, pending.mediaType) : { ok: true };
    if (!verified.ok) {
      restashPendingRequest(nonce, pending);
      audit('external_api_error', { provider: 'overseerr', error: `request #${data.id} failed post-create verification: ${verified.reason}`, action: 'gate_approve_verify', targetDiscordId: pending.discordId });
      return interaction.editReply({ embeds: [brandedEmbed(COLORS.WARN)
        .setTitle(`⚠️ Seerr lost the request — ${pending.label}`)
        .setDescription(`Seerr accepted request #${data.id} for <@${pending.discordId}>, but ${verified.reason}.\nNothing will download. Check the Seerr container logs from the last minute for the underlying error, then hit Approve again to retry.`)] });
    }
    // The gate stored the request under tmdb:<id>; keep that row in sync too when the webhook
    // key differs (tv → tvdb).
    upsertRequest(data?.id, mediaKey, pending.mediaType, pending.is4k, pending.label, pending.discordId, 'approved');
    if (mediaKey !== `tmdb:${pending.tmdbId}`) upsertRequest(null, `tmdb:${pending.tmdbId}`, pending.mediaType, pending.is4k, pending.label, pending.discordId, 'approved');
    // Only watch requests Seerr verifiably kept — recording earlier would make the escalation
    // watchdog alert on requests that never reached the arrs at all.
    if (canEscalate(pending)) {
      recordEscalationWatch({ mediaType: pending.mediaType, tmdbId: pending.tmdbId, tvdbId: data?.media?.tvdbId ?? null, title: pending.label, discordId: pending.discordId, preAuthorized: azPreAuth });
      // Pre-authorized = this title is definitely AvistaZ-bound, so put the arr tag on right
      // away instead of waiting for the watchdog — the tag-gated AvistaZ indexer then applies
      // from the very first arr search. Background with retries: Seerr only adds the title to
      // Radarr/Sonarr a few seconds after accepting the request.
      if (azPreAuth) {
        tagPreAuthorizedMedia({ mediaType: pending.mediaType, tmdbId: pending.tmdbId, tvdbId: data?.media?.tvdbId ?? null, title: pending.label })
          .catch(err => log.warn(`Approval-time AvistaZ tagging failed for ${pending.label}: ${err.message}`));
      }
    }
    audit('request_approved_gate', { actorDiscordId: interaction.user.id, targetDiscordId: pending.discordId, title: pending.label, requestId: data?.id ?? null, azPreAuth });
    await dmUser(pending.discordId, { embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle(`${mediaTypeEmoji(pending.mediaType, pending.is4k)} Request Approved`)
      .setDescription(`**${pending.label}** was approved and is being grabbed now. You'll get a DM when it's on Plex! 🍿`)] });
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle(`✅ Approved — ${pending.label}`)
      .setDescription(`Approved by <@${interaction.user.id}> for <@${pending.discordId}> — sent to Seerr${data?.id != null ? ` (request #${data.id})` : ''}.${azPreAuth ? `\n🔐 AvistaZ fallback pre-authorized — tagging it \`${CONFIG.AVISTAZ_TAG}\` now; auto-escalates if nothing public is grabbed within ${escalationDelayLabel()}.` : ''}`)], components: [] });
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

// Put the AvistaZ tag on a just-approved, pre-authorized title. Seerr adds the title to
// Radarr/Sonarr a few seconds after accepting the request, so not_in_arr retries for a few
// minutes; tag_missing aborts immediately (retrying can't create a tag — startup already
// warns about it). Best-effort by design: if this never lands, the escalation itself still
// applies the tag when it fires.
async function tagPreAuthorizedMedia(meta, { attempts = 8, delayMs = 15000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // TV needs the tvdb id to match in Sonarr; Seerr often only knows it after the arr add.
    if (meta.mediaType === 'tv' && !meta.tvdbId) meta.tvdbId = await fetchSeerrTvdbId(meta.tmdbId).catch(() => null);
    const result = await applyAvistazTag(meta);
    if (result.ok) {
      audit('avistaz_tag_applied', { mediaId: `tmdb:${meta.tmdbId}`, title: meta.title, origin: 'approval_preauth', detail: result.detail });
      return result;
    }
    if (result.reason === 'tag_missing') {
      audit('avistaz_tag_failed', { mediaId: `tmdb:${meta.tmdbId}`, title: meta.title, reason: result.reason, origin: 'approval_preauth' });
      return result;
    }
    if (attempt < attempts) await sleepMs(delayMs);
  }
  audit('avistaz_tag_failed', { mediaId: `tmdb:${meta.tmdbId}`, title: meta.title, reason: 'not_in_arr_after_retries', origin: 'approval_preauth' });
  log.warn(`Couldn't tag ${meta.title} for AvistaZ at approval (never appeared in the arr) — the escalation will tag it when it fires.`);
  return { ok: false, reason: 'not_in_arr' };
}

// ---- Stuck-download watchdog ----
// Downloads with no seeders (or import problems) sit in the queue forever with frozen
// progress. Track byte movement per queue item; when one hasn't moved for
// STUCK_AFTER_MINUTES (or the *arr flags it), alert the admin channel with one-click
// actions: remove+blocklist+search another release, remove only, or ignore.
//
// TV episodes now arrive from two download paths (public indexers via Deluge, and the AvistaZ
// private-tracker fallback), each as its own Sonarr queue item — so a whole season stalling
// would flood the channel with one alert per episode. Alerts are consolidated per series+season
// (stuckGroupKey): one message lists every stuck episode, and its buttons act on all of them.
const stuckTracker = new Map(); // `${label}:${queueId}` -> { sizeleft, since }
const stuckAlerted = new Map(); // groupKey -> last alert ts

// Build the consolidated alert embed + action row for one stuck group. Season groups render a
// single "N episodes stuck" summary; movies / lone items keep the original per-item layout.
function buildStuckAlert(group) {
  const minutes = Math.round(group.maxFrozenMs / 60000);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`stuck_retry:${group.key}`).setLabel('Remove & Try Another Release').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`stuck_rm:${group.key}`).setLabel('Remove Only').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`stuck_ignore:${group.key}`).setLabel('Ignore').setStyle(ButtonStyle.Secondary),
  );
  // Unique reported problems across the group (episodes usually share the same "no seeders" note).
  const problems = [...new Set(group.members.flatMap(m => m.item.messages))].filter(Boolean);

  if (isSeasonGroup(group)) {
    const first = group.members[0].item;
    const eps = group.members
      .map(m => m.item.episodeNumber)
      .filter(n => n != null)
      .sort((a, b) => a - b);
    const epList = eps.length
      ? (() => { const shown = eps.slice(0, 25).map(n => `E${pad(n)}`).join(', '); return eps.length > 25 ? `${shown} …+${eps.length - 25} more` : shown; })()
      : '—';
    const count = group.members.length;
    const embed = brandedEmbed(COLORS.WARN)
      .setTitle('🧊 Download Stuck')
      .setDescription(`**${first.seriesTitle}** — Season ${first.seasonNumber}\n${count} episode${count === 1 ? '' : 's'} haven't moved in ~${minutes} minutes.`)
      .addFields(
        { name: 'Stuck episodes', value: epList.slice(0, 1000), inline: false },
        { name: 'Source', value: group.source.label, inline: true },
      );
    if (problems.length) embed.addFields({ name: 'Reported problems', value: problems.map(m => `• ${m}`).join('\n').slice(0, 1000), inline: false });
    return { embed, row };
  }

  const item = group.members[0].item;
  const pct = queuePercent(item);
  const embed = brandedEmbed(COLORS.WARN)
    .setTitle('🧊 Download Stuck')
    .setDescription(`**${item.title}** hasn't moved in ${minutes} minutes.`)
    .addFields(
      { name: 'Progress', value: `${progressBar(pct)} ${pct}%`, inline: true },
      { name: 'Source', value: item.source.label, inline: true },
      { name: 'Status', value: item.trackedStatus || item.status || 'unknown', inline: true },
    );
  if (problems.length) embed.addFields({ name: 'Reported problems', value: problems.map(m => `• ${m}`).join('\n').slice(0, 1000), inline: false });
  return { embed, row };
}

async function sweepStuckDownloads() {
  const items = await fetchArrQueues();
  const now = Date.now();
  const stuck = detectStuckItems(items, stuckTracker, { stuckAfterMs: CONFIG.STUCK_AFTER_MINUTES * 60000, now });
  const groups = groupStuckItems(stuck);

  // Group keys for everything currently in the queue (not just the stuck ones) — used to prune
  // the alert-cooldown map and stale ignore flags once a group leaves the queue entirely.
  const activeGroups = new Set(items.map(stuckGroupKey));
  for (const gk of stuckAlerted.keys()) if (!activeGroups.has(gk)) stuckAlerted.delete(gk);

  for (const [gk, group] of groups) {
    if (getSetting(`stuck_ignore:${gk}`)) continue;
    if (now - (stuckAlerted.get(gk) || 0) < CONFIG.STUCK_ALERT_COOLDOWN_HOURS * 3600000) continue;
    stuckAlerted.set(gk, now);
    const { embed, row } = buildStuckAlert(group);
    notifyChannel('downloads', { embeds: [embed], components: [row] });
    audit('stuck_download_detected', { groupKey: gk, label: group.source.label, count: group.members.length, frozenMinutes: Math.round(group.maxFrozenMs / 60000) });
  }

  // Clear ignore flags whose group has fully left the queue, so a future download reusing the
  // same key can't be silently ignored.
  const ignoreRows = db.prepare("SELECT key FROM app_settings WHERE key LIKE 'stuck_ignore:%'").all();
  for (const r of ignoreRows) {
    if (!activeGroups.has(r.key.slice('stuck_ignore:'.length))) db.prepare('DELETE FROM app_settings WHERE key = ?').run(r.key);
  }
}

// ---- AvistaZ escalation watchdog ----
// Public indexers get first crack at every approved request. When nothing has been grabbed after
// ESCALATION_DELAY_MINUTES, the request either auto-escalates to AvistaZ (admin pre-authorized it
// at approval time) or an admin gets an embed with an "Escalate to AvistaZ" button. Escalation
// tags the movie/series so the tag-gated AvistaZ indexer applies to it, then re-searches.

// The facts decideEscalationAction needs: did the public pipeline already deliver?
async function gatherEscalationFacts(row, queue) {
  const keys = [`tmdb:${row.tmdb_id}`, row.tvdb_id ? `tvdb:${row.tvdb_id}` : null].filter(Boolean);
  const isAvailable = keys.some(k => db.prepare("SELECT 1 FROM requests WHERE media_id = ? AND status = 'available'").get(k));
  if (isAvailable) return { isAvailable: true, hasQueueItem: false, hasFile: false, inArr: true };
  if (row.media_type === 'movie') {
    const hasQueueItem = queue.some(q => q.source.kind === 'movie' && q.movieTmdbId === row.tmdb_id);
    if (hasQueueItem) return { isAvailable: false, hasQueueItem: true, hasFile: false, inArr: true };
    // inArr is three-valued: a definite "the arr does not have this title" (false — Seerr lost
    // the hand-off) must be distinguishable from "couldn't ask" (null — arr down, no alarms).
    let movie = null, inArr = null;
    try { movie = await getMovieByTmdbId(row.tmdb_id); inArr = !!movie; } catch (_e) { /* unreachable arr */ }
    return { isAvailable: false, hasQueueItem: false, hasFile: !!movie?.hasFile, inArr };
  }
  // TV: Sonarr keys off tvdb — backfill it from Seerr once if the request-create response
  // didn't carry it (Seerr sometimes only knows it after the arr add completes).
  if (!row.tvdb_id) {
    const tvdbId = await fetchSeerrTvdbId(row.tmdb_id);
    if (tvdbId) { setEscalationTvdbId(row.id, tvdbId); row.tvdb_id = tvdbId; }
  }
  const hasQueueItem = !!row.tvdb_id && queue.some(q => q.source.kind === 'tv' && q.seriesTvdbId === row.tvdb_id);
  if (hasQueueItem) return { isAvailable: false, hasQueueItem: true, hasFile: false, inArr: true };
  let series = null, inArr = null;
  if (row.tvdb_id) {
    try { series = await getSeriesByTvdbId(row.tvdb_id); inArr = !!series; } catch (_e) { /* unreachable arr */ }
  }
  return { isAvailable: false, hasQueueItem: false, hasFile: (series?.statistics?.episodeFileCount || 0) > 0, inArr };
}

async function runEscalation(row) {
  // Direct-grab pipeline first when configured: the bot searches AvistaZ itself and either
  // auto-grabs or posts scored candidates. The state moves to 'escalated' either way — the
  // grab job (or the posted buttons) owns the follow-through from here. Falls back to the
  // tag-based arr escalation when the search fails or finds nothing.
  if (grabConfigured()) {
    const direct = await runDirectGrabEscalation(row).catch(err => ({ ok: false, why: err.message }));
    if (direct.ok) {
      setEscalationState(row.id, 'escalated');
      // Direct grabs bypass the arrs' indexers, but every escalated title still gets the arr
      // tag: it marks AvistaZ provenance and future upgrade searches then include the indexer.
      applyAvistazTag({ mediaType: row.media_type, tmdbId: row.tmdb_id, tvdbId: row.tvdb_id }).then(t => (t.ok
        ? audit('avistaz_tag_applied', { mediaId: row.media_id, title: row.title, origin: 'escalation_direct', detail: t.detail })
        : audit('avistaz_tag_failed', { mediaId: row.media_id, title: row.title, reason: t.reason, origin: 'escalation_direct' })));
      audit('avistaz_direct_escalation', { mediaId: row.media_id, title: row.title, detail: direct.detail });
      return direct;
    }
    if (direct.deferred) {
      // Allowance exhausted: leave the row's state untouched — a 'watching' pre-authorized
      // row is retried by the sweep and succeeds once the UTC day rolls over. No tag-path
      // fallback either: the arrs would spend the very slots the counter protects.
      audit('avistaz_direct_escalation_deferred', { mediaId: row.media_id, title: row.title, why: direct.why });
      return { ok: false, deferred: true, why: `${direct.why} — the escalation stays queued and retries automatically.` };
    }
    audit('avistaz_direct_escalation_fallback', { mediaId: row.media_id, title: row.title, why: direct.why });
  }
  const result = await escalateMediaToAvistaz({ mediaType: row.media_type, tmdbId: row.tmdb_id, tvdbId: row.tvdb_id });
  if (result.ok) {
    setEscalationState(row.id, 'escalated');
    return result;
  }
  setEscalationState(row.id, 'error');
  const why = {
    tag_missing: `No \`${CONFIG.AVISTAZ_TAG}\` tag exists in ${row.media_type === 'movie' ? 'Radarr' : 'Sonarr'} — see the README section "AvistaZ private-tracker fallback".`,
    not_in_arr: `The title isn't in ${row.media_type === 'movie' ? 'Radarr' : 'Sonarr'} — the Seerr request may not have landed there.`,
    no_tvdb_id: 'No TVDB id could be resolved for this show, so it can\'t be matched in Sonarr.',
  }[result.reason] || `API error: ${result.reason.replace(/^api_error:/, '')}`;
  return { ...result, why };
}

async function sweepEscalations() {
  const rows = getWatchingEscalations();
  if (!rows.length) return;
  const queue = await fetchArrQueues();
  const cfg = { delayMinutes: CONFIG.ESCALATION_DELAY_MINUTES, maxAgeDays: CONFIG.ESCALATION_MAX_AGE_DAYS, arrGraceMinutes: CONFIG.ESCALATION_ARR_GRACE_MINUTES };
  for (const row of rows) {
    const facts = await gatherEscalationFacts(row, queue);
    const action = decideEscalationAction(row, facts, Date.now(), cfg);
    if (action === 'wait') continue;
    if (action === 'resolve') {
      setEscalationState(row.id, 'resolved');
      audit('escalation_resolved', { mediaId: row.media_id, title: row.title, facts });
      continue;
    }
    if (action === 'expire') {
      setEscalationState(row.id, 'expired');
      audit('escalation_expired', { mediaId: row.media_id, title: row.title });
      continue;
    }
    const waited = fmtDuration(Date.now() - row.approved_at);
    // action === 'alert_missing': Seerr approved the request but the title never landed in its
    // arr (Seerr can accept and then lose a request — 'Media data not found' in its log).
    // Nothing can download until the title exists there, so offer a direct add that bypasses
    // Seerr entirely. One alert per row; the watch then holds until the title appears.
    if (action === 'alert_missing') {
      markEscalationArrMissingAlerted(row.id);
      const arrName = row.media_type === 'movie' ? 'Radarr' : 'Sonarr';
      // Pre-authorized requests don't wait for a button: the admin already said "definitely
      // get this" at approval, so a lost Seerr hand-off is repaired with a direct add on the
      // spot (tag included). Falls through to the button alert only when the add itself fails.
      if (row.pre_authorized) {
        const added = await addMediaToArr({ mediaType: row.media_type, tmdbId: row.tmdb_id, tvdbId: row.tvdb_id, tagLabel: CONFIG.AVISTAZ_TAG });
        if (added.ok) {
          touchEscalationApprovedAt(row.id);
          audit('escalation_arr_missing_autofixed', { mediaId: row.media_id, title: row.title, detail: added.detail });
          notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.INFO)
            .setTitle(`🛠️ Fixed a Lost Request — ${row.title}`)
            .setDescription(`Seerr approved this request **${waited}** ago but never handed it to ${arrName} (\`Media data not found\` in its log — usually a broken TMDB↔TVDB mapping). The AvistaZ fallback was pre-authorized, so I repaired it automatically:\n${added.detail}\nPublic indexers get ${escalationDelayLabel()}; the AvistaZ fallback fires on its own after that if nothing lands.`)] });
          continue;
        }
        audit('escalation_arr_missing_autofix_failed', { mediaId: row.media_id, title: row.title, reason: added.reason });
      }
      audit('escalation_arr_missing', { mediaId: row.media_id, title: row.title, waited });
      notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.WARN)
        .setTitle(`🕳️ Request Never Landed — ${row.title}`)
        .setDescription(`Seerr approved this request **${waited}** ago, but the title isn't in ${arrName} — Seerr most likely lost it right after accepting (its log shows \`Media data not found\` when this happens, usually a broken TMDB↔TVDB mapping). **Nothing will download until it exists in ${arrName}.**\nThe button adds it straight to ${arrName}${row.pre_authorized ? ` with the \`${CONFIG.AVISTAZ_TAG}\` tag` : ''} and starts a search — no Seerr involved.`)
        .addFields({ name: 'Requested by', value: row.requested_by_discord_id ? `<@${row.requested_by_discord_id}>` : 'Unknown', inline: true })],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`arrfix_add:${row.id}`).setLabel(`Add to ${arrName} & Search`).setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`escalate_ignore:${row.id}`).setLabel('Ignore').setStyle(ButtonStyle.Secondary),
        )] });
      continue;
    }
    if (action === 'escalate') {
      const result = await runEscalation(row);
      if (result.deferred) {
        // Quiet by design: this fires every sweep until the allowance frees up, and a
        // Discord warning each half hour would be pure noise. The audit log has it.
        log.info(`AvistaZ escalation deferred for ${row.title}: ${result.why}`);
        continue;
      }
      notifyChannel('downloads', { embeds: [brandedEmbed(result.ok ? COLORS.SUCCESS : COLORS.WARN)
        .setTitle(result.ok ? `🔐 Escalated to AvistaZ — ${row.title}` : `⚠️ AvistaZ Escalation Failed — ${row.title}`)
        .setDescription(result.ok
          ? `Nothing public showed up in ${waited} and the fallback was pre-authorized at approval.\n${result.detail}`
          : `Auto-escalation was pre-authorized but failed: ${result.why}`)] });
      continue;
    }
    // action === 'alert': one embed per title (state moves to 'alerted' and stays there until a
    // button is clicked or the media resolves). Buttons survive restarts — state is in SQLite.
    setEscalationState(row.id, 'alerted');
    audit('escalation_alerted', { mediaId: row.media_id, title: row.title, waited });
    // Escalating a title that isn't out yet is pointless — surface the release timing so the
    // admin can tell "no seeders" apart from "not released".
    const eta = releaseEtaInfo(await fetchReleaseEta({ mediaType: row.media_type, tmdbId: row.tmdb_id, tvdbId: row.tvdb_id }));
    const alertEmbed = brandedEmbed(COLORS.WARN)
      .setTitle(`⏳ Nothing Found Yet — ${row.title}`)
      .setDescription(`No public release grabbed in **${waited}** since approval. Escalate to AvistaZ (private tracker → seedbox)?`)
      .addFields(
        { name: 'Requested by', value: row.requested_by_discord_id ? `<@${row.requested_by_discord_id}>` : 'Unknown', inline: true },
        { name: 'Type', value: mediaTypeLabel(row.media_type, false), inline: true },
      );
    if (eta) alertEmbed.addFields({ name: 'Release timing', value: `${eta.line}${eta.waiting ? '\nEscalating now likely won\'t help — the title isn\'t out yet.' : ''}`, inline: false });
    notifyChannel('downloads', { embeds: [alertEmbed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`escalate_az:${row.id}`).setLabel('Escalate to AvistaZ').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`escalate_ignore:${row.id}`).setLabel('Ignore').setStyle(ButtonStyle.Secondary),
      )] });
  }
}

// ---- AvistaZ direct-grab pipeline ----
// The smarter escalation path: search AvistaZ through Prowlarr, score the candidates, send
// the chosen torrent to the seedbox rTorrent (labeled radarr/sonarr), watch it to
// completion, rclone the files into local staging, and hand them to Radarr/Sonarr for a
// normal import (renaming, notifications, Bazarr subtitle search all follow from there).
// Falls back to the tag-based arr escalation when the pipeline isn't configured or the
// search comes up empty.

// Seerr/escalation titles often carry a trailing year — "My Title (2017)" — which hurts
// tracker search recall; split it into query + year for scoring instead.
function splitTitleYear(title) {
  const m = /^(.*?)\s*\(((?:19|20)\d{2})\)\s*$/.exec(String(title || ''));
  return m ? { query: m[1], year: Number(m[2]) } : { query: String(title || ''), year: null };
}

const grabDailyAllowance = () => grabAllowance(countGrabJobsToday(), CONFIG.AVISTAZ_DAILY_GRAB_LIMIT);

// The candidates embed + Download/Cancel buttons, shared by /avistaz search and the
// escalation flow. The offer behind the buttons lives in SQLite (stashGrabOffer).
function grabCandidatesMessage({ heading, candidates, nonce, allowance, footnote }) {
  const lines = candidates.map((c, i) => {
    const bits = [
      [c.resolution, { webdl: 'WEB-DL', webrip: 'WEBRip', hdtv: 'HDTV', bluray: 'BluRay' }[c.source]].filter(Boolean).join(' ') || 'unknown quality',
      c.seasonPack ? (c.multiSeason ? `complete series${c.seasonEnd != null ? ` (S${pad(c.season)}–S${pad(c.seasonEnd)})` : ''}` : 'season pack') : null,
      fmtSpace(c.size),
      `${c.seeders} seeder${c.seeders === 1 ? '' : 's'}`,
      c.freeleech ? '🆓 freeleech' : null,
    ].filter(Boolean).join(' • ');
    const notes = c.notes.length ? `\n⚠️ ${c.notes.join(', ')}` : '';
    return `**${i + 1}. ${String(c.releaseTitle).slice(0, 200)}**\n${bits}\nConfidence: **${c.confidence}%**${notes}`;
  });
  const allowanceLine = allowance.limited
    ? `\n\nDownloads remaining today: **${allowance.remaining}**${allowance.exhausted ? ' — daily AvistaZ allowance is used up, try again tomorrow.' : ''}`
    : '';
  const embed = brandedEmbed(COLORS.INFO)
    .setTitle(heading)
    .setDescription(`${lines.join('\n\n')}${allowanceLine}${footnote ? `\n\n${footnote}` : ''}`.slice(0, 4000));
  const buttons = allowance.exhausted ? [] : candidates.map((c, i) =>
    new ButtonBuilder().setCustomId(`grab_dl:${nonce}:${i}`).setLabel(`Download ${i + 1}`).setStyle(i === 0 ? ButtonStyle.Success : ButtonStyle.Primary));
  buttons.push(new ButtonBuilder().setCustomId(`grab_cancel:${nonce}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(...buttons)] };
}

// Fetch the .torrent, dedupe, push it to rTorrent with the right label, and record the
// durable grab job. Never throws — callers branch on { ok, why, dup }.
async function executeGrab(candidate, meta) {
  if (!grabImportTarget(meta.mediaType)) {
    return { ok: false, why: `${meta.mediaType === 'tv' ? 'Sonarr' : 'Radarr'} isn't configured — a ${meta.mediaType} grab could never be imported` };
  }
  // Duplicate checks BEFORE fetching: the .torrent download is the metered tracker action
  // this whole feature rations. Prowlarr's info-hash when it reports one, else the exact
  // release title; the post-fetch hash check below stays as the final authority.
  const dupEarly = (candidate.infoHash && getGrabJobByHash(candidate.infoHash)) || getGrabJobByRelease(candidate.releaseTitle);
  if (dupEarly) return { ok: false, dup: true, why: `already grabbed as job #${dupEarly.id} (${dupEarly.state})` };

  let torrent;
  try {
    torrent = await fetchTorrentFile(candidate.downloadUrl);
  } catch (err) {
    audit('external_api_error', { provider: 'prowlarr', error: err.message, action: 'grab_fetch_torrent', title: meta.title });
    return { ok: false, why: `couldn't fetch the .torrent: ${err.message}` };
  }
  // From here the tracker download slot may already be spent, so failures still record a
  // (failed) job — countGrabJobsToday counts every state, keeping the allowance honest.
  const label = meta.mediaType === 'tv' ? CONFIG.RTORRENT_LABEL_TV : CONFIG.RTORRENT_LABEL_MOVIE;
  let infoHash = null;
  try {
    infoHash = computeInfoHash(torrent);
    const dup = getGrabJobByHash(infoHash);
    if (dup) return { ok: false, dup: true, why: `already grabbed as job #${dup.id} (${dup.state})` };
    await addTorrentToRtorrent(torrent, label);
    const job = recordGrabJob({
      mediaId: meta.mediaId || null, mediaType: meta.mediaType, title: meta.title,
      releaseTitle: candidate.releaseTitle, infoHash, sizeBytes: candidate.size, label,
      discordId: meta.discordId, origin: meta.origin,
    });
    audit('avistaz_grab_sent', { actorDiscordId: meta.actorDiscordId || null, targetDiscordId: meta.discordId || null, jobId: job.id, mediaId: meta.mediaId, title: meta.title, release: candidate.releaseTitle, infoHash, label, confidence: candidate.confidence, origin: meta.origin });
    return { ok: true, job };
  } catch (err) {
    const failed = recordGrabJob({
      mediaId: meta.mediaId || null, mediaType: meta.mediaType, title: meta.title,
      releaseTitle: candidate.releaseTitle, infoHash, sizeBytes: candidate.size, label,
      discordId: meta.discordId, origin: meta.origin,
    });
    setGrabJobState(failed.id, 'failed', err.message);
    audit('external_api_error', { provider: 'rtorrent', error: err.message, action: 'grab_send', title: meta.title, jobId: failed.id });
    return { ok: false, why: err.message };
  }
}

// Escalation via the direct pipeline: search, rank, then either auto-grab (GRAB_MODE=auto +
// high confidence + allowance left) or post the candidates to the downloads channel for a
// one-click decision. ok:false lets runEscalation fall back to the tag-based path.
async function runDirectGrabEscalation(row) {
  if (!grabImportTarget(row.media_type)) return { ok: false, why: `${row.media_type === 'tv' ? 'Sonarr' : 'Radarr'} isn't configured — the grab could never be imported` };
  // Allowance first, before spending a Prowlarr/AvistaZ search: an exhausted day defers
  // the escalation instead of posting button-less candidates or falling back to the tag
  // path (which would burn the very slots the counter protects).
  const allowance = grabDailyAllowance();
  if (allowance.exhausted) return { ok: false, deferred: true, why: `daily AvistaZ allowance is used up (${CONFIG.AVISTAZ_DAILY_GRAB_LIMIT}/day)` };
  const indexer = await findAvistazIndexer();
  if (!indexer) return { ok: false, why: 'no AvistaZ indexer found in Prowlarr' };
  const { query, year } = splitTitleYear(row.title);
  const results = await searchAvistaz({ query, mediaType: row.media_type, indexerId: indexer.id });
  const candidates = rankAvistazResults(results, { title: query, year, mediaType: row.media_type });
  if (!candidates.length) return { ok: false, why: 'no AvistaZ results' };

  const top = candidates[0];
  if (CONFIG.GRAB_MODE === 'auto' && top.confidence >= CONFIG.GRAB_AUTO_CONFIDENCE) {
    const grab = await executeGrab(top, { mediaId: row.media_id, mediaType: row.media_type, title: row.title, discordId: row.requested_by_discord_id, origin: 'escalation-auto' });
    if (grab.ok) {
      return { ok: true, detail: `Auto-grabbed **${top.releaseTitle}** (${top.confidence}% confidence) → seedbox rTorrent. I'll transfer and import it when the download finishes.` };
    }
    if (grab.dup) return { ok: true, detail: `Best match **${top.releaseTitle}** was ${grab.why} — nothing new to grab.` };
    // Grab itself failed (rTorrent down, bad torrent) — fall through to human approval.
  }

  const nonce = stashGrabOffer({ mediaId: row.media_id, mediaType: row.media_type, title: row.title, discordId: row.requested_by_discord_id, origin: 'escalation', candidates });
  notifyChannel('downloads', grabCandidatesMessage({
    heading: `🔎 AvistaZ Matches — ${row.title}`,
    candidates, nonce, allowance,
    footnote: `Requested by ${row.requested_by_discord_id ? `<@${row.requested_by_discord_id}>` : 'unknown'}. Downloading sends the torrent to the seedbox rTorrent; the bot copies it home and imports it when done.`,
  }));
  return { ok: true, detail: `Found ${candidates.length} AvistaZ candidate(s) — posted to the downloads channel for approval (best: ${top.confidence}% confidence).` };
}

// Watch active grab jobs against rTorrent and act on the state machine's verdicts.
async function sweepGrabJobs() {
  const jobs = listActiveGrabJobs().filter(j => ['sent', 'downloading'].includes(j.state));
  let anyComplete = false;
  const cfg = { missingAfterMinutes: CONFIG.GRAB_MISSING_AFTER_MINUTES, downloadTimeoutHours: CONFIG.GRAB_DOWNLOAD_TIMEOUT_HOURS };
  for (const job of jobs) {
    let facts;
    try {
      const st = await getRtorrentStatus(job.info_hash);
      facts = { reachable: true, found: st.found, complete: !!st.complete };
    } catch (err) {
      facts = { reachable: false };
      audit('external_api_error', { provider: 'rtorrent', error: err.message, action: 'grab_status', jobId: job.id });
    }
    const action = decideGrabJobAction(job, facts, Date.now(), cfg);
    if (action === 'wait') continue;
    if (action === 'mark_downloading') { setGrabJobState(job.id, 'downloading'); continue; }
    if (action === 'fail_missing' || action === 'fail_timeout') {
      const why = action === 'fail_missing'
        ? 'the torrent never appeared in rTorrent (or was removed externally)'
        : `no completion after ${CONFIG.GRAB_DOWNLOAD_TIMEOUT_HOURS}h — likely dead on AvistaZ`;
      setGrabJobState(job.id, 'failed', why);
      audit('avistaz_grab_failed', { jobId: job.id, title: job.title, release: job.release_title, reason: action });
      notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.DANGER)
        .setTitle(`❌ AvistaZ Grab Failed — ${job.title}`)
        .setDescription(`**${job.release_title}**\n${why}. Check the seedbox, then re-run ${String(job.origin || '').startsWith('adopt') ? '`/rtorrent adopt`' : '`/avistaz search`'} if it's still wanted.`)] });
      continue;
    }
    // action === 'transfer': seedbox finished — queue the copy home. Seeding continues on
    // the seedbox untouched (private-tracker ratio lives there, not here).
    setGrabJobState(job.id, 'complete');
    anyComplete = true;
    audit('avistaz_grab_complete', { jobId: job.id, title: job.title, release: job.release_title });
  }
  if (anyComplete || nextTransferableGrabJob()) pumpGrabTransfers().catch(err => log.warn(`Grab transfer pump failed: ${err.message}`));
}

// One transfer at a time (same reasoning as the stage worker: the WAN link is the
// bottleneck). Durable via grab_jobs; a restart mid-copy re-queues and rclone resumes.
let grabTransferActive = false;
async function pumpGrabTransfers() {
  if (grabTransferActive) return;
  grabTransferActive = true;
  try {
    for (let job = nextTransferableGrabJob(); job; job = nextTransferableGrabJob()) {
      await runGrabTransfer(job).catch(err => {
        setGrabJobState(job.id, 'failed', err.message);
        audit('avistaz_transfer_failed', { jobId: job.id, title: job.title, error: String(err.message).slice(0, 500) });
        notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.DANGER)
          .setTitle(`❌ Seedbox Transfer Failed — ${job.title}`)
          .setDescription(`**${job.release_title}**\n\`\`\`${String(err.message).slice(0, 800)}\`\`\`\nThe torrent is still on the seedbox — Retry re-runs the copy (already-transferred files are skipped).`)],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`grab_retry:${job.id}`).setLabel('Retry Transfer').setStyle(ButtonStyle.Primary),
          )] });
      });
    }
  } finally {
    grabTransferActive = false;
  }
}

async function runGrabTransfer(job) {
  setGrabJobState(job.id, 'transferring');
  // The on-disk name comes from the torrent metadata (d.name), not the release title —
  // they usually match, but the seedbox filesystem is the source of truth.
  const st = await getRtorrentStatus(job.info_hash);
  if (!st.found) throw new Error('torrent vanished from rTorrent before the transfer started');
  const name = st.name;
  if (!name || name.includes('/') || name.includes('..')) throw new Error(`unsafe torrent name: ${name}`);
  const incoming = path.join(CONFIG.GRAB_STAGING_PATH, '.incoming', name);
  const finalPath = path.join(CONFIG.GRAB_STAGING_PATH, name);
  fs.mkdirSync(path.dirname(incoming), { recursive: true });

  // copyto handles both single-file and folder torrents; .incoming keeps half-copied data
  // out of the arr's sight until the rename below. Adopted torrents may live in a per-label
  // subfolder on the seedbox — remote_path (verified at adoption time) points there.
  const remoteSub = job.remote_path && !job.remote_path.includes('..') ? job.remote_path : name;
  const res = await runRclone(['copyto', joinRemotePath(CONFIG.GRAB_RCLONE_REMOTE, remoteSub), incoming],
    { timeoutMs: CONFIG.GRAB_COPY_TIMEOUT_MINUTES * 60000, flags: CONFIG.GRAB_RCLONE_FLAGS });
  if (res.timedOut) throw new Error(`rclone copy timed out after ${CONFIG.GRAB_COPY_TIMEOUT_MINUTES} min`);
  if (res.code !== 0) throw new Error(res.stderr || `rclone exited ${res.code}`);

  // The arr must never see fewer bytes than the torrent contains: a 0-byte placeholder on
  // the seedbox (rTorrent re-allocating after its data was moved) copies "successfully"
  // and then poisons the import as an unreadable file. More bytes than expected is fine —
  // seedboxes sprinkle .nfo/screens next to the payload.
  const gotBytes = localSizeOf(incoming);
  if (st.sizeBytes && gotBytes < st.sizeBytes) {
    throw new Error(`copy landed ${fmtSpace(gotBytes)} but the torrent is ${fmtSpace(st.sizeBytes)} — the seedbox path \`${remoteSub}\` looks like a placeholder or partial data, not the real files`);
  }

  fs.rmSync(finalPath, { recursive: true, force: true }); // leftover from an earlier retry
  fs.renameSync(incoming, finalPath);

  // Hand the finished folder to the right arr as a completed download: it renames, imports
  // into the library, fires its own notifications, and Bazarr picks up subtitle work.
  // importMode Move so staging cleans itself (the seedbox copy keeps seeding).
  const importPath = `${CONFIG.GRAB_IMPORT_PATH}/${name}`;
  const arr = arrForMediaType(job.media_type);
  const cmdRes = await axios.post(`${arr.url}/api/v3/command`, { name: arr.scan, path: importPath, importMode: 'Move' },
    { headers: { 'X-Api-Key': arr.key }, timeout: 15000 });
  // Fire-and-forget verification: an arr scan can complete while silently declining every
  // file, and a wedged command queue completes nothing at all — both used to go unnoticed
  // until someone checked the library by hand. Never blocks or un-does the job.
  verifyArrImport(job, arr, cmdRes.data?.id, importPath, finalPath)
    .catch(err => log.warn(`Import verification failed for job #${job.id}: ${err.message}`));

  setGrabJobState(job.id, 'done');
  const minutes = job.completed_at ? Math.max(1, Math.round((Date.now() - job.completed_at) / 60000)) : null;
  const adopted = String(job.origin || '').startsWith('adopt');
  audit(adopted ? 'rtorrent_adopt_imported' : 'avistaz_grab_imported', { jobId: job.id, mediaId: job.media_id, title: job.title, release: job.release_title, sizeBytes: st.sizeBytes, transferMinutes: minutes });
  if (adopted) {
    // Batch-friendly: a 39-episode adoption must not ping the channel 39 times. One rolling
    // message is edited in place per import (edits don't notify); no requester DM either —
    // the discord id on an adopted job is the adopting admin.
    await updateAdoptTransferProgress(job, st.sizeBytes || job.size_bytes);
    return;
  }
  notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.SUCCESS)
    .setTitle(`📦 AvistaZ Grab Imported — ${job.title}`)
    .setDescription(`**${job.release_title}** (${fmtSpace(st.sizeBytes || job.size_bytes)}) finished on the seedbox, copied home, and was handed to ${job.media_type === 'movie' ? 'Radarr' : 'Sonarr'} for import. It keeps seeding on the seedbox.`)] });
  await dmUser(job.requested_by_discord_id, { embeds: [brandedEmbed(COLORS.SUCCESS)
    .setTitle(`🎉 On Its Way — ${job.title}`)
    .setDescription(`Your request came through the private-tracker route and just finished downloading. It should appear in Plex within a few minutes.`)] });
}

const arrForMediaType = mediaType => (mediaType === 'movie'
  ? { url: CONFIG.RADARR_URL, key: CONFIG.RADARR_API_KEY, scan: 'DownloadedMoviesScan', label: 'Radarr' }
  : { url: CONFIG.SONARR_URL, key: CONFIG.SONARR_API_KEY, scan: 'DownloadedEpisodesScan', label: 'Sonarr' });

// Video files still sitting under a path — after a Move-mode import these should be gone,
// so leftovers are the tell that the arr declined (or never ran) the import.
const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.ts', '.wmv', '.mov']);
function leftoverVideoFiles(p) {
  const out = [];
  const walk = q => {
    let st;
    try { st = fs.statSync(q); } catch (_e) { return; }
    if (!st.isDirectory()) { if (VIDEO_EXTS.has(path.extname(q).toLowerCase())) out.push(q); return; }
    for (const e of fs.readdirSync(q)) walk(path.join(q, e));
  };
  walk(p);
  return out;
}

const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));

// Post-import verification: wait for the scan command, then check the video files actually
// left staging. Three outcomes beyond silent success:
//   - scan never completes → the arr's command queue is wedged; say so (a restart clears it).
//   - scan completed but skipped cleanly-matched files → force them through the arr's
//     ManualImport API (exactly what an admin would do in the Manual Import screen).
//   - files are genuinely rejected → one alert NAMING the rejection reasons, instead of the
//     silence that used to require API spelunking to explain.
async function verifyArrImport(job, arr, commandId, importPath, finalPath) {
  const deadline = Date.now() + 10 * 60000;
  let status = 'unknown';
  while (Date.now() < deadline && commandId) {
    await sleepMs(15000);
    try {
      const r = await axios.get(`${arr.url}/api/v3/command/${commandId}`, { headers: { 'X-Api-Key': arr.key }, timeout: 10000 });
      status = r.data?.status || status;
      if (['completed', 'failed', 'aborted'].includes(status)) break;
    } catch (_e) { /* transient — keep polling until the deadline */ }
  }
  if (!leftoverVideoFiles(finalPath).length) return; // consumed — the import really happened

  if (status !== 'completed') {
    audit('grab_import_unverified', { jobId: job.id, title: job.title, commandId, status });
    notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.WARN)
      .setTitle(`⏳ Import Not Confirmed — ${job.title}`.slice(0, 256))
      .setDescription(`${arr.label}'s scan is still \`${status}\` after 10 minutes and the files are still in staging — its command queue may be wedged (one stuck scan blocks everything behind it). Check ${arr.label} → System → Tasks; restarting ${arr.label} clears the queue, then \`/rtorrent import\` re-triggers this folder.`)] });
    return;
  }

  // Scan finished yet videos remain: ask the arr what it thinks of each file.
  const preview = await axios.get(`${arr.url}/api/v3/manualimport`, {
    params: { folder: importPath, filterExistingFiles: true }, headers: { 'X-Api-Key': arr.key }, timeout: 120000,
  }).then(r => r.data || []);
  const clean = preview.filter(f => !(f.rejections || []).length
    && (job.media_type === 'movie' ? f.movie : (f.series && (f.episodes || []).length)));
  if (clean.length) {
    const files = clean.map(f => (job.media_type === 'movie'
      ? { path: f.path, movieId: f.movie.id, quality: f.quality, languages: f.languages, releaseGroup: f.releaseGroup || undefined, indexerFlags: f.indexerFlags || 0 }
      : { path: f.path, seriesId: f.series.id, episodeIds: f.episodes.map(e => e.id), quality: f.quality, languages: f.languages, releaseGroup: f.releaseGroup || undefined, indexerFlags: f.indexerFlags || 0 }));
    await axios.post(`${arr.url}/api/v3/command`, { name: 'ManualImport', files, importMode: 'move' },
      { headers: { 'X-Api-Key': arr.key }, timeout: 15000 });
    audit('grab_import_forced', { jobId: job.id, title: job.title, files: files.length });
    notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.INFO)
      .setTitle(`🔧 Import Nudged — ${job.title}`.slice(0, 256))
      .setDescription(`${arr.label}'s scan completed but quietly skipped **${files.length}** cleanly-matched file(s); they've been forced through ManualImport (move). They should appear in the library shortly.`)] });
    return;
  }
  const reasons = [...new Set(preview.flatMap(f => (f.rejections || []).map(x => x.reason)))].slice(0, 5);
  audit('grab_import_rejected', { jobId: job.id, title: job.title, reasons });
  // TV declines get the guided-import wizard: pick series + season in Discord, the bot pushes
  // the mapping through ManualImport — covers TVDB filing the show under another title and
  // fansub names Sonarr can't parse, without touching the Sonarr UI.
  const components = [];
  let mapHint = `use ${arr.label}'s Manual Import screen for hand-mapping`;
  if (job.media_type !== 'movie') {
    const nonce = stashMapOffer({ title: job.title, folder: path.basename(finalPath), importPath, finalPath, jobId: job.id });
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mapimp_start:${nonce}`).setLabel('Map to a Series…').setStyle(ButtonStyle.Primary)));
    mapHint = '**Map to a Series…** below walks through picking the series + season right here and pushes the mapping into Sonarr';
  }
  notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.WARN)
    .setTitle(`🚫 ${arr.label} Declined the Import — ${job.title}`.slice(0, 256))
    .setDescription(`The files copied home fine but ${arr.label} won't take them:\n${reasons.length ? reasons.map(r => `• ${r}`).join('\n') : '• (no reason reported — the series may be missing or the names unparseable)'}\n\nThey're still in staging. Fix the cause and re-run \`/rtorrent import target:${job.media_type === 'movie' ? 'radarr' : 'sonarr'} folder:${String(path.basename(finalPath)).slice(0, 80)}\` — or ${mapHint}.`)], components });
}

// ---- Guided manual import ("Map to a Series…") ----
// TVDB often files a foreign show under a different title than the release (sequels listed as
// "season 2 of the original"), and old fansub rips carry no SxxEyy pattern — Sonarr then
// declines the import with "Unknown Series" and an admin used to hand-map files in Sonarr's
// Manual Import screen. The wizard does that conversation in the downloads channel instead:
// the decline alert's button walks series → season → confirm, then pushes the exact mapping
// through Sonarr's ManualImport API. State lives in app_settings (mapimp:<nonce>) so a
// restart mid-conversation doesn't strand the message.
const readMapOffer = nonce => { try { return JSON.parse(getSetting(`mapimp:${String(nonce)}`) || 'null'); } catch (_e) { return null; } };
const writeMapOffer = (nonce, state) => setSetting(`mapimp:${nonce}`, JSON.stringify(state));
const dropMapOffer = nonce => db.prepare('DELETE FROM app_settings WHERE key = ?').run(`mapimp:${nonce}`);
function stashMapOffer(payload) {
  const nonce = crypto.randomBytes(4).toString('hex');
  writeMapOffer(nonce, { ...payload, createdAt: Date.now() });
  return nonce;
}

const mapCancelRow = nonce => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`mapimp_cancel:${nonce}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));

// Step 1: pick the series. Candidates are the whole Sonarr library scored by token overlap
// with the release title (or the admin's typed query), recently-added first on ties — the
// admin usually just added the right series moments ago.
async function mapWizardSeriesStep(nonce, state, query) {
  const all = await sonarrGet('/series');
  if (!all.length) {
    return { content: null, components: [mapCancelRow(nonce)], embeds: [brandedEmbed(COLORS.WARN)
      .setTitle(`🧭 Map & Import — ${state.title}`.slice(0, 256))
      .setDescription('Sonarr\'s library is empty — add the series there first (Series → Add New), then click the decline alert\'s button again.')] };
  }
  const tokens = normalizeTitle(query || state.title).split(' ').filter(Boolean);
  const scored = all.map(s => {
    const hay = ` ${normalizeTitle(`${s.title} ${(s.alternateTitles || []).map(t => t.title).join(' ')}`)} `;
    return { s, score: tokens.filter(t => hay.includes(` ${t} `)).length };
  }).sort((a, b) => b.score - a.score || String(b.s.added || '').localeCompare(String(a.s.added || '')));
  const pool = query ? (scored.filter(x => x.score > 0).length ? scored.filter(x => x.score > 0) : scored) : scored;
  const options = pool.slice(0, 25).map(({ s }) => ({
    label: `${s.title}${s.year ? ` (${s.year})` : ''}`.slice(0, 100),
    value: String(s.id),
    description: `${(s.seasons || []).filter(x => x.seasonNumber > 0).length} season(s) · added ${String(s.added || '').slice(0, 10) || '?'}`.slice(0, 100),
  }));
  const noMatch = query && !scored.some(x => x.score > 0);
  const embed = brandedEmbed(COLORS.INFO)
    .setTitle(`🧭 Map & Import — ${state.title}`.slice(0, 256))
    .setDescription(`**Step 1 of 3 — which Sonarr series should these files land in?**\n${noMatch ? `Nothing matched \`${query}\` — showing the library instead (recently added first).` : query ? `Matches for \`${query}\`.` : 'Best matches from the library, recently added first.'}\n-# TVDB may list this show under a different name (sequels often live as a season of the original) — pick whatever series Sonarr has it as.`);
  return { content: null, embeds: [embed], components: [
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`mapimp_series:${nonce}`).setPlaceholder('Pick the series…').addOptions(...options)),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mapimp_find:${nonce}`).setLabel('Search by name').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`mapimp_cancel:${nonce}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    ),
  ] };
}

// Step 2: pick the season within the chosen series.
function mapWizardSeasonStep(nonce, state, series) {
  const seasons = (series?.seasons || []).slice(0, 25);
  if (!seasons.length) {
    return { content: null, components: [mapCancelRow(nonce)], embeds: [brandedEmbed(COLORS.WARN)
      .setTitle(`🧭 Map & Import — ${state.title}`.slice(0, 256))
      .setDescription(`**${state.seriesTitle}** reports no seasons in Sonarr — refresh the series there, then restart from the decline alert.`)] };
  }
  const options = seasons.map(x => ({
    label: x.seasonNumber === 0 ? 'Specials' : `Season ${x.seasonNumber}`,
    value: String(x.seasonNumber),
    description: `${x.statistics?.totalEpisodeCount ?? '?'} episode(s)`.slice(0, 100),
  }));
  return { content: null, embeds: [brandedEmbed(COLORS.INFO)
    .setTitle(`🧭 Map & Import — ${state.title}`.slice(0, 256))
    .setDescription(`**Step 2 of 3 — which season of ${state.seriesTitle}?**\n-# If TVDB files this show as a continuation, the right season may not be "1" (e.g. a sequel drama as Season 2 of the original).`)],
  components: [
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`mapimp_season:${nonce}`).setPlaceholder('Pick the season…').addOptions(...options)),
    mapCancelRow(nonce),
  ] };
}

// Step 3: preview the file→episode pairing and ask for one confirming click.
async function mapWizardConfirmStep(nonce, state) {
  const arr = arrForMediaType('tv');
  const preview = await axios.get(`${arr.url}/api/v3/manualimport`, {
    params: { folder: state.importPath, filterExistingFiles: true }, headers: { 'X-Api-Key': arr.key }, timeout: 120000,
  }).then(r => r.data || []);
  const files = preview.filter(f => f.path).map(f => ({ path: f.path, quality: f.quality, languages: f.languages, releaseGroup: f.releaseGroup || null, indexerFlags: f.indexerFlags || 0 }));
  if (!files.length) {
    dropMapOffer(nonce);
    return { content: null, components: [], embeds: [brandedEmbed(COLORS.INFO)
      .setTitle(`🧭 Nothing Left to Map — ${state.title}`.slice(0, 256))
      .setDescription('Sonarr sees no importable files in that folder any more — they were probably imported in the meantime. Check the series in Sonarr.')] };
  }
  const episodes = (await sonarrGet('/episode', { seriesId: state.seriesId })).filter(e => e.seasonNumber === state.season);
  if (!episodes.length) {
    return { content: null, components: [mapCancelRow(nonce)], embeds: [brandedEmbed(COLORS.WARN)
      .setTitle(`🧭 Map & Import — ${state.title}`.slice(0, 256))
      .setDescription(`**${state.seriesTitle}** Season ${state.season} has no episodes in Sonarr — refresh the series metadata there, then restart from the decline alert.`)] };
  }
  const mapped = pairFilesToEpisodes(files, episodes.map(e => ({ id: e.id, episodeNumber: e.episodeNumber })));
  state.pairs = mapped.pairs;
  state.strategy = mapped.strategy;
  writeMapOffer(nonce, state);
  const lines = mapped.pairs.slice(0, 15).map(p => `\`S${pad(state.season)}E${pad(p.episodeNumber)}\` ← ${String(p.path).split('/').pop().slice(0, 90)}`);
  if (mapped.pairs.length > 15) lines.push(`…and ${mapped.pairs.length - 15} more`);
  const notes = [];
  notes.push(mapped.strategy === 'numbered'
    ? 'Episode numbers were read from the filenames.'
    : 'Filenames carry no usable episode numbers — files are mapped **in name order** (file 1 → first episode, …). Double-check the first few lines.');
  if (mapped.leftoverFiles > 0) notes.push(`⚠️ ${mapped.leftoverFiles} file(s) have no episode to land in and will be left in staging.`);
  if (mapped.leftoverEpisodes > 0) notes.push(`ℹ️ ${mapped.leftoverEpisodes} episode(s) of the season have no file in this folder.`);
  return { content: null, embeds: [brandedEmbed(COLORS.INFO)
    .setTitle(`🧭 Map & Import — ${state.title}`.slice(0, 256))
    .setDescription(`**Step 3 of 3 — confirm the mapping into ${state.seriesTitle} S${pad(state.season)}**\n${lines.join('\n')}\n\n${notes.join('\n')}`.slice(0, 4000))],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mapimp_go:${nonce}`).setLabel(`Import ${mapped.pairs.length} file(s)`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`mapimp_cancel:${nonce}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  )] };
}

async function mapWizardImport(interaction, nonce, state) {
  const arr = arrForMediaType('tv');
  const files = state.pairs.map(p => ({
    path: p.path, seriesId: state.seriesId, episodeIds: [p.episodeId],
    quality: p.quality, languages: p.languages, releaseGroup: p.releaseGroup || undefined, indexerFlags: p.indexerFlags || 0,
  }));
  await axios.post(`${arr.url}/api/v3/command`, { name: 'ManualImport', files, importMode: 'move' },
    { headers: { 'X-Api-Key': arr.key }, timeout: 15000 });
  dropMapOffer(nonce);
  audit('guided_import', { actorDiscordId: interaction.user.id, title: state.title, seriesId: state.seriesId, seriesTitle: state.seriesTitle, season: state.season, files: files.length, strategy: state.strategy, jobId: state.jobId ?? null });
  return interaction.editReply({ content: null, components: [], embeds: [brandedEmbed(COLORS.SUCCESS)
    .setTitle(`📦 Mapped & Importing — ${state.title}`.slice(0, 256))
    .setDescription(`**${files.length}** file(s) handed to Sonarr as **${state.seriesTitle}** Season ${state.season} (mapped by <@${interaction.user.id}>). Sonarr renames and moves them out of staging; they should appear in the library within a few minutes.`)] });
}

// The rolling progress embed for adopted transfers. State (message id + running import
// count) lives in app_settings so a restart mid-batch keeps editing the same message; the
// message is swapped for a completion summary — and the state cleared — once no adopted job
// remains active, so the next batch starts a fresh message (and a fresh notification).
async function updateAdoptTransferProgress(job, sizeBytes) {
  const remaining = listActiveGrabJobs().filter(j => String(j.origin || '').startsWith('adopt')).length;
  let state = {};
  try { state = JSON.parse(getSetting('adopt_progress_msg') || '{}'); } catch (_e) { state = {}; }
  const imported = (state.imported || 0) + 1;
  const done = remaining === 0;
  const embed = brandedEmbed(done ? COLORS.SUCCESS : COLORS.INFO)
    .setTitle(done ? `📦 Adopted Batch Complete — ${imported} imported` : `📦 Adopted Batch — ${imported} imported, ${remaining} to go`)
    .setDescription(`Latest: **${String(job.title).slice(0, 150)}** (${fmtSpace(sizeBytes)}) → ${job.media_type === 'movie' ? 'Radarr' : 'Sonarr'}.\n${done ? 'Everything keeps seeding on the seedbox.' : 'This message updates in place as each transfer lands.'}`);
  let edited = false;
  if (state.messageId) {
    const ch = await safeGetChannel(state.channelId || channelFor('downloads'));
    const msg = ch && await ch.messages.fetch(state.messageId).catch(() => null);
    if (msg) edited = await msg.edit({ embeds: [embed] }).then(() => true).catch(() => false);
  }
  if (!edited) {
    const ch = await safeGetChannel(channelFor('downloads'));
    const sent = ch && await ch.send({ embeds: [embed] }).catch(() => null);
    if (sent) state = { channelId: sent.channelId, messageId: sent.id };
  }
  if (done) db.prepare('DELETE FROM app_settings WHERE key = ?').run('adopt_progress_msg');
  else setSetting('adopt_progress_msg', JSON.stringify({ ...state, imported }));
}

// ---- rTorrent adoption (/rtorrent adopt + discovery sweep) ----
// Torrents already sitting in the seedbox rTorrent (added manually, by another tracker's
// automation, or before the bot existed) have no grab_jobs row, so the pipeline ignores
// them. Adoption creates the job from the EXISTING torrent — never a tracker download,
// never an AvistaZ allowance slot, never a removal from rTorrent — at 'downloading' (the
// grab sweep watches it to 100%) or 'complete' (the transfer runs immediately). From there
// the normal rclone → .incoming → arr-import chain applies unchanged.

// Everything an adoption needs besides RTORRENT_URL: somewhere to copy from and to.
const adoptPipelineReady = () => !!(rtorrentConfigured() && CONFIG.GRAB_RCLONE_REMOTE && CONFIG.GRAB_STAGING_PATH);

// One rclone stat: does this exact path exist under GRAB_RCLONE_REMOTE, and how big is it?
// Returns { exists, size } — size null for directories or when the stat can't be parsed.
async function remoteStat(sub) {
  const res = await runRclone(['lsjson', '--stat', joinRemotePath(CONFIG.GRAB_RCLONE_REMOTE, sub)],
    { timeoutMs: 60000, flags: CONFIG.GRAB_RCLONE_FLAGS });
  if (res.code !== 0) return { exists: false, size: null };
  try {
    const data = JSON.parse(res.stdout);
    return { exists: true, size: data.IsDir ? null : (Number.isFinite(data.Size) && data.Size >= 0 ? data.Size : null) };
  } catch (_e) {
    return { exists: true, size: null };
  }
}

// Batched remote-path resolver, shared across a bulk adoption. Two layers:
// - pathExists: each unique parent directory is listed ONCE (rclone lsf) and membership is
//   checked in memory — an 80-episode series would otherwise mean 80 per-path stats over
//   SFTP. Falls back to a per-path stat when a listing can't be trusted (nonzero exit, or
//   output at the stdout cap ⇒ possibly truncated).
// - findByName: last resort — one recursive listing of the whole remote, indexed by
//   basename. Catches data that was moved on the seedbox behind rTorrent's back (stale
//   d.base_path, e.g. episodes sorted into a per-series folder). Only a UNIQUE name match
//   counts; partial listings are still usable since matches are only ever positive evidence.
const SHALLOW_LIST_CAP = 1024 * 1024;
const DEEP_LIST_CAP = 8 * 1024 * 1024;
function makeRemotePathResolver() {
  const dirs = new Map(); // parent subpath ('' = remote root) -> Promise<Map<name, size> | null>
  let deepIndex = null; // lazy Promise<Map<basename, [{path, size}]> | null>
  const listDir = async parent => {
    const res = await runRclone(['lsf', joinRemotePath(CONFIG.GRAB_RCLONE_REMOTE, parent), '--format', 'ps', '--separator', ';'],
      { timeoutMs: 120000, flags: CONFIG.GRAB_RCLONE_FLAGS, maxStdoutBytes: SHALLOW_LIST_CAP });
    if (res.code !== 0 || res.stdout.length >= SHALLOW_LIST_CAP) return null;
    return new Map(parseRemoteListing(res.stdout).map(e => [e.path, e.size]));
  };
  // { exists, size } for one candidate subpath, from the cached parent listing when
  // possible, a single stat otherwise.
  const statPath = async sub => {
    const i = sub.lastIndexOf('/');
    const [parent, base] = i === -1 ? ['', sub] : [sub.slice(0, i), sub.slice(i + 1)];
    if (!dirs.has(parent)) dirs.set(parent, listDir(parent).catch(() => null));
    const names = await dirs.get(parent);
    if (names) return names.has(base) ? { exists: true, size: names.get(base) } : { exists: false, size: null };
    return remoteStat(sub);
  };
  const findByName = async (name, expectedBytes) => {
    if (!deepIndex) {
      deepIndex = (async () => {
        const res = await runRclone(['lsf', CONFIG.GRAB_RCLONE_REMOTE, '-R', '--max-depth', '4', '--format', 'ps', '--separator', ';'],
          { timeoutMs: 300000, flags: CONFIG.GRAB_RCLONE_FLAGS, maxStdoutBytes: DEEP_LIST_CAP });
        return res.stdout ? indexRemoteListing(res.stdout) : null;
      })().catch(() => null);
    }
    const idx = await deepIndex;
    // Size filtering happens BEFORE uniqueness: the re-allocated 0-byte placeholder at the
    // old path must not make the real copy elsewhere look ambiguous.
    const hits = (idx ? idx.get(name) || [] : []).filter(h => remoteSizeMatches(h.size, expectedBytes));
    if (hits.length === 1) return { sub: hits[0].path };
    return hits.length ? { ambiguous: hits.length } : null;
  };
  return { statPath, findByName };
}

// Does the torrent's data actually exist under GRAB_RCLONE_REMOTE, and where? Verified
// BEFORE the job is created so adoption can't produce a transfer that was doomed from the
// start. Probes every plausible mapping of d.base_path (remoteSubpathCandidates) — a path
// whose SIZE doesn't match the torrent is treated as not-found (rTorrent re-creates 0-byte
// placeholders at the old path when its data was moved away) — then falls back to the
// size-filtered recursive filename search.
async function findAdoptRemotePath(torrent, resolver) {
  const expected = torrent.sizeBytes || null;
  const tried = remoteSubpathCandidates(torrent.basePath, torrent.name, CONFIG.RTORRENT_REMOTE_ROOT);
  let mismatch = null;
  for (const sub of tried) {
    const st = await resolver.statPath(sub);
    if (!st.exists) continue;
    if (remoteSizeMatches(st.size, expected)) return { sub, tried };
    if (!mismatch) mismatch = { sub, size: st.size };
  }
  const hit = await resolver.findByName(torrent.name, expected);
  if (hit?.sub && !hit.sub.includes('..')) return { sub: hit.sub, tried, viaSearch: true };
  return { sub: null, tried, ambiguous: hit?.ambiguous || 0, mismatch };
}

// Create the grab job for an existing torrent. Never throws — callers branch on
// { ok, why, dup }. An explicit adoption overrides a standing ignore flag.
async function executeAdoption(torrent, target, meta, resolver = null) {
  const verdict = decideAdoption({ torrent, existingJob: torrent.hash ? getGrabJobByHash(torrent.hash) : null, target });
  if (!verdict.ok) return verdict;
  if (!grabImportTarget(verdict.mediaType)) {
    return { ok: false, why: `${target === 'sonarr' ? 'Sonarr' : 'Radarr'} isn't configured — the adopted torrent could never be imported` };
  }
  const { sub: remotePath, tried, viaSearch, ambiguous, mismatch } = await findAdoptRemotePath(torrent, resolver || makeRemotePathResolver());
  if (!remotePath) {
    const probed = tried.slice(0, 3).map(p => `\`${p}\``).join(', ') + (tried.length > 3 ? ', …' : '');
    // rTorrent's own base_path is the key diagnostic: when siblings adopt fine but this one
    // doesn't, the data usually isn't on disk where rTorrent last saw it.
    const searched = ambiguous ? `a filename search found ${ambiguous} same-size matches — can't pick one safely` : 'a size-checked filename search found nothing either';
    const placeholder = mismatch ? ` \`${mismatch.sub}\` exists but is ${fmtSpace(mismatch.size || 0)} instead of ${fmtSpace(torrent.sizeBytes)} — a re-allocated placeholder, not the data.` : '';
    return { ok: false, why: `no full-size copy under \`${CONFIG.GRAB_RCLONE_REMOTE}\` (probed ${probed}; ${searched}).${placeholder} rTorrent has the data at \`${torrent.basePath || 'unknown'}\` — it may have been moved or deleted on the seedbox` };
  }
  if (isAdoptIgnored(torrent.hash)) clearAdoptIgnored(torrent.hash);
  const job = recordGrabJob({
    mediaType: verdict.mediaType, title: torrent.name, releaseTitle: torrent.name,
    infoHash: torrent.hash, sizeBytes: torrent.sizeBytes, label: torrent.label || target,
    discordId: meta.discordId, origin: meta.origin || 'adopt', state: verdict.state, remotePath,
  });
  audit('rtorrent_adopted', { actorDiscordId: meta.actorDiscordId || null, jobId: job.id, infoHash: torrent.hash, name: torrent.name, target, state: verdict.state, remotePath, viaSearch: !!viaSearch, origin: meta.origin || 'adopt' });
  if (verdict.state === 'complete') pumpGrabTransfers().catch(err => log.warn(`Grab transfer pump failed: ${err.message}`));
  return { ok: true, job, state: verdict.state };
}

const adoptProgressPct = t => (t.sizeBytes ? Math.min(100, Math.round((t.doneBytes / t.sizeBytes) * 100)) : 0);

// Total on-disk bytes of a file or directory tree (the post-copy verification).
function localSizeOf(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    total += localSizeOf(path.join(p, e.name));
  }
  return total;
}

// The adopt-candidates embed + buttons, shared by /rtorrent adopt and the discovery sweep.
// The import target rides in each button's customId: a resolved label gets one Adopt
// button, a blank/unknown label gets an explicit per-arr choice — nothing is ever adopted
// on a guessed target.
function adoptCandidatesMessage({ heading, candidates, nonce, footnote }) {
  const lines = candidates.map((t, i) => {
    const bits = [
      t.complete ? '✅ complete' : `⬇️ ${adoptProgressPct(t)}% done`,
      fmtSpace(t.sizeBytes),
      `label: ${t.label ? `\`${t.label}\`` : 'none'}`,
      t.target ? `→ ${t.target}` : '→ pick a target',
    ].join(' • ');
    return `**${i + 1}. ${String(t.name).slice(0, 200)}**\n${bits}`;
  });
  const embed = brandedEmbed(COLORS.INFO)
    .setTitle(heading)
    .setDescription(`${lines.join('\n\n')}${footnote ? `\n\n${footnote}` : ''}`.slice(0, 4000));
  const buttons = [];
  candidates.forEach((t, i) => {
    if (t.target) {
      buttons.push(new ButtonBuilder().setCustomId(`adopt_do:${nonce}:${i}:${t.target}`).setLabel(`Adopt ${i + 1} → ${t.target}`).setStyle(ButtonStyle.Success));
    } else {
      if (CONFIG.SONARR_URL) buttons.push(new ButtonBuilder().setCustomId(`adopt_do:${nonce}:${i}:sonarr`).setLabel(`Adopt ${i + 1} → sonarr`).setStyle(ButtonStyle.Primary));
      if (CONFIG.RADARR_URL) buttons.push(new ButtonBuilder().setCustomId(`adopt_do:${nonce}:${i}:radarr`).setLabel(`Adopt ${i + 1} → radarr`).setStyle(ButtonStyle.Primary));
    }
  });
  buttons.push(new ButtonBuilder().setCustomId(`adopt_cancel:${nonce}`).setLabel('Dismiss').setStyle(ButtonStyle.Secondary));
  const rows = [];
  for (let i = 0; i < buttons.length && rows.length < 5; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(...buttons.slice(i, i + 5)));
  }
  return { embeds: [embed], components: rows };
}

// Adopt a whole cohort (e.g. an 80-episode series stored as individual torrents)
// sequentially, sharing one directory-listing cache for the existence checks. Duplicates
// are skipped quietly — a re-run after a partial failure only adopts what's still untracked.
async function executeBulkAdoption(candidates, target, meta) {
  const resolver = makeRemotePathResolver();
  const outcome = { adopted: 0, complete: 0, downloading: 0, dup: 0, failed: [] };
  for (const t of candidates) {
    const result = await executeAdoption(t, target, meta, resolver);
    if (result.ok) { outcome.adopted++; outcome[result.state]++; }
    else if (result.dup) outcome.dup++;
    else outcome.failed.push({ name: t.name, why: result.why });
  }
  audit('rtorrent_adopt_bulk', { actorDiscordId: meta.actorDiscordId || null, target, requested: candidates.length, adopted: outcome.adopted, dup: outcome.dup, failed: outcome.failed.length });
  return outcome;
}

// The bulk-adopt offer: one embed summarizing the cohort, one Adopt-all button per viable
// target (bulkTargetChoices — a cohort never adopts on a guessed target). Shared by
// /rtorrent adopt and the discovery sweep (heading override).
function adoptBulkMessage({ candidates, search, explicitTarget, nonce, heading, footnote }) {
  const completeCount = candidates.filter(t => t.complete).length;
  const totalBytes = candidates.reduce((a, t) => a + (t.sizeBytes || 0), 0);
  const preview = candidates.slice(0, 8).map(t => `• ${String(t.name).slice(0, 100)}`);
  if (candidates.length > preview.length) preview.push(`…and **${candidates.length - preview.length}** more`);
  const targets = bulkTargetChoices(candidates, explicitTarget);
  const lines = [
    `**${candidates.length}** untracked torrents match — ${completeCount} complete, ${candidates.length - completeCount} still downloading, ${fmtSpace(totalBytes)} total.`,
    '',
    ...preview,
    '',
    'Adopt-all tracks every EXISTING torrent above — no tracker downloads, no AvistaZ allowance slots, nothing removed from rTorrent. Complete ones transfer immediately (one at a time); incomplete ones are watched to 100% first.',
  ];
  if (targets.length > 1) lines.push('Labels are mixed or unresolved, so pick the import target explicitly — it applies to the whole batch.');
  if (footnote) lines.push(footnote);
  const buttons = targets.map(t =>
    new ButtonBuilder().setCustomId(`adopt_bulk:${nonce}:${t}`).setLabel(`Adopt all ${candidates.length} → ${t}`).setStyle(targets.length === 1 ? ButtonStyle.Success : ButtonStyle.Primary));
  buttons.push(new ButtonBuilder().setCustomId(`adopt_cancel:${nonce}`).setLabel('Dismiss').setStyle(ButtonStyle.Secondary));
  return {
    embeds: [brandedEmbed(COLORS.INFO)
      .setTitle(heading || `🧲 Bulk Adopt — “${String(search).slice(0, 80)}”`)
      .setDescription(lines.join('\n').slice(0, 4000))],
    components: [new ActionRowBuilder().addComponents(...buttons)],
  };
}

// Discovery sweep: surface torrents that carry an adoptable label but no grab job. Auto
// mode (RTORRENT_ADOPT_AUTO) adopts label-resolved candidates outright; otherwise (and for
// blank-target labels) it posts Adopt buttons to the downloads channel — once per
// info-hash, tracked durably so restarts don't re-post.
async function sweepAdoptCandidates() {
  const torrents = await listRtorrentTorrents();
  // Markers for torrents that left rTorrent are stale — drop them so a re-added torrent
  // can be offered again (same cleanup pattern as pm_ignore).
  const present = new Set(torrents.map(t => t.hash));
  for (const h of listAdoptOfferedHashes()) if (!present.has(h)) clearAdoptOffered(h);

  const candidates = torrents.filter(t => t.hash
    && CONFIG.RTORRENT_ADOPT_LABELS.includes(String(t.label || '').trim().toLowerCase())
    && !getGrabJobByHash(t.hash) && !isAdoptIgnored(t.hash) && !isAdoptOffered(t.hash));
  if (!candidates.length) return;

  const forButtons = [];
  for (const t of candidates) {
    const target = CONFIG.RTORRENT_ADOPT_AUTO ? adoptTargetForLabel(t.label) : null;
    if (!target) { forButtons.push(t); continue; }
    // Auto mode with a resolved target: adopt now. Offered is marked either way so a
    // failing candidate alerts once instead of every sweep.
    markAdoptOffered(t.hash);
    const result = await executeAdoption(t, target, { origin: 'adopt-auto' });
    if (result.ok) {
      notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.SUCCESS)
        .setTitle(`🧲 Auto-Adopted — ${t.name}`.slice(0, 256))
        .setDescription(`Found in rTorrent with label \`${t.label}\` and no grab job — adopted as job #${result.job.id} (**${result.state}**, ${fmtSpace(t.sizeBytes)}) → ${target === 'sonarr' ? 'Sonarr' : 'Radarr'}. ${result.state === 'complete' ? 'Transferring home now.' : 'I\'ll transfer + import when it hits 100%.'}`)] });
    } else {
      notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.WARN)
        .setTitle(`⚠️ Auto-Adoption Failed — ${t.name}`.slice(0, 256))
        .setDescription(`${result.why}. Fix the cause, then run \`/rtorrent adopt\` manually.`)] });
    }
  }

  if (!forButtons.length) return;
  // One post per TARGET group, every posted candidate marked offered. Two rules interact
  // here: showing 3 and marking 3 meant a channel message every sweep until a 50-episode
  // backlog drained (so post whole cohorts), and one bulk button applies one target to
  // everything under it (so sonarr- and radarr-labeled torrents must never share a button —
  // a movie would be adopted as a TV job or vice versa). Unresolved labels get their own
  // post with explicit per-arr buttons.
  const groups = new Map(); // resolved target ('' = needs an explicit choice) -> torrents
  for (const t of forButtons) {
    const key = adoptTargetForLabel(t.label) || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  for (const [target, group] of groups) {
    const cohort = group.slice(0, 200);
    for (const t of cohort) markAdoptOffered(t.hash);
    if (cohort.length > 3) {
      const candidates = cohort.map(t => ({ hash: t.hash, name: t.name, complete: t.complete, label: t.label, basePath: t.basePath, sizeBytes: t.sizeBytes, doneBytes: t.doneBytes }));
      const nonce = stashGrabOffer({ kind: 'adopt-bulk', candidates, origin: 'adopt', discordId: null });
      notifyChannel('downloads', adoptBulkMessage({
        candidates, nonce, explicitTarget: target || null,
        heading: `🧲 ${candidates.length} Adoptable Torrents Found in rTorrent${target ? ` (label → ${target})` : ''}`,
        footnote: 'For a finer pick, `/rtorrent adopt search:"..."` scopes the batch to one series; `/rtorrent ignore` silences a torrent for good. This won\'t be re-posted unless new torrents appear.',
      }));
    } else {
      const shown = cohort.map(t => ({ ...t, target: target || null }));
      const nonce = stashGrabOffer({ kind: 'adopt', candidates: shown, origin: 'adopt', discordId: null });
      notifyChannel('downloads', adoptCandidatesMessage({
        heading: `🧲 Adoptable Torrent${shown.length === 1 ? '' : 's'} Found in rTorrent`,
        candidates: shown, nonce,
        footnote: 'These carry an adoptable label but no grab job. Adopting tracks the existing torrent — no tracker download, no AvistaZ allowance slot, nothing removed from rTorrent. `/rtorrent ignore` silences a torrent for good.',
      }));
    }
  }
  audit('rtorrent_adopt_discovered', { count: forButtons.length, groups: [...groups.keys()].map(k => k || 'unresolved') });
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

// ---- Plex Home staging worker ----
// One rclone copy at a time (the transpacific uplink is the bottleneck; parallel copies just
// thrash it). The queue is SQLite (stage_jobs) so a 20-minute copy interrupted by a restart is
// re-queued at startup — rclone skips already-transferred files, so resuming is cheap.
let stageWorkerActive = false;

async function pumpStageQueue() {
  if (!stagingConfigured() || stageWorkerActive) return;
  stageWorkerActive = true;
  try {
    for (let job = nextQueuedStageJob(); job; job = nextQueuedStageJob()) {
      await runStageJob(job).catch(err => {
        finishStageJob(job.id, 'failed', err.message);
        audit('external_api_error', { provider: 'staging', error: err.message, action: 'stage_job', mediaId: job.media_id });
      });
    }
  } finally {
    stageWorkerActive = false;
  }
}

// Purge one title from the PH cache and drop its inventory row. Shared by the disk-pressure
// guard, the eviction buttons, and /unpin cleanup paths. Only touches the cache remote.
async function evictStagedItemNow(item, ctx = {}) {
  const res = await purgeStagedPath(item.dest_path);
  if (!res.ok) {
    audit('external_api_error', { provider: 'staging', error: res.error, action: 'evict', mediaId: item.media_id });
    return false;
  }
  removeStagedItem(item.media_id);
  audit('staged_item_evicted', { mediaId: item.media_id, title: item.title, sizeBytes: item.size_bytes, ...ctx });
  return true;
}

async function runStageJob(job) {
  const src = await resolveStageSource(job.media_id);
  if (!src.found) {
    finishStageJob(job.id, 'failed', 'not found in Radarr/Sonarr (or no file on disk)');
    await dmUser(job.requested_by_discord_id, { embeds: [brandedEmbed(COLORS.DANGER)
      .setTitle(`❌ Couldn't Stage — ${job.title}`)
      .setDescription('The file couldn\'t be found in Radarr/Sonarr. If it only just finished downloading, try `/stage` again in a few minutes.')] });
    return;
  }
  if (getStagedItem(job.media_id)) {
    finishStageJob(job.id, 'done');
    return;
  }
  markStageJobCopying(job.id, src.sizeBytes);

  // Disk-pressure guard: the cache is finite and there's no second M.2 slot. Evict LRU unpinned
  // titles (announced, never silent) or refuse with a clear message — never let the drive fill
  // until Plex starts failing in confusing ways from 8,000 miles away.
  const items = listStagedItems();
  const cache = await getCacheStatus(items);
  const plan = planCacheSpace({ freeBytes: cache.freeBytes, neededBytes: src.sizeBytes, minFreeBytes: CONFIG.STAGE_MIN_FREE_GB * 1024 ** 3, items });
  if (plan.unguarded) audit('stage_cache_unguarded', { mediaId: job.media_id, reason: 'rclone about unsupported and STAGE_CACHE_MAX_GB unset' });
  if (!plan.ok) {
    const pinnedCount = items.filter(i => i.pinned).length;
    const msg = `Cache is full: **${job.title}** needs ${fmtSpace(src.sizeBytes)} but only ${fmtSpace(cache.freeBytes)} is free and evicting every unpinned title would still fall ${fmtSpace(plan.shortfallBytes)} short${pinnedCount ? ` (${pinnedCount} pinned title(s) are exempt — \`/unpin\` some to make room)` : ''}.`;
    finishStageJob(job.id, 'failed', 'cache full');
    notifyChannel('cleanup', { embeds: [brandedEmbed(COLORS.DANGER).setTitle('💾 PH Cache Full — Stage Refused').setDescription(msg)] });
    await dmUser(job.requested_by_discord_id, { embeds: [brandedEmbed(COLORS.DANGER)
      .setTitle(`💾 No Room on the Travel Server — ${job.title}`)
      .setDescription('The cache drive is full and nothing more can be evicted. An admin has been notified.')] });
    audit('stage_refused_cache_full', { mediaId: job.media_id, title: job.title, neededBytes: src.sizeBytes, freeBytes: cache.freeBytes });
    return;
  }
  if (plan.evict.length) {
    const evicted = [];
    let evictionsFailed = 0;
    for (const item of plan.evict) {
      if (await evictStagedItemNow(item, { reason: 'lru_pressure', forMediaId: job.media_id })) evicted.push(item);
      else evictionsFailed++;
    }
    if (evicted.length) {
      notifyChannel('cleanup', { embeds: [brandedEmbed(COLORS.WARN)
        .setTitle('📤 Evicted From PH Cache')
        .setDescription(`Freed ${fmtSpace(evicted.reduce((a, i) => a + (i.size_bytes || 0), 0))} to make room for **${job.title}**:\n${evicted.map(i => `• **${i.title}**`).join('\n').slice(0, 3500)}\n\nThe master copies in California are untouched — anything evicted can be re-staged with \`/stage\`.`)] });
    }
    // A failed purge means the space it was supposed to free doesn't exist. Re-check before
    // copying; anything short of a clean pass fails the job instead of filling the drive.
    if (evictionsFailed) {
      const recheckItems = listStagedItems();
      const recheck = planCacheSpace({ freeBytes: (await getCacheStatus(recheckItems)).freeBytes, neededBytes: src.sizeBytes, minFreeBytes: CONFIG.STAGE_MIN_FREE_GB * 1024 ** 3, items: recheckItems });
      if (!recheck.ok || recheck.evict.length) {
        finishStageJob(job.id, 'failed', `${evictionsFailed} planned eviction(s) failed (rclone purge error) — not enough verified space to copy`);
        notifyChannel('system', { embeds: [brandedEmbed(COLORS.DANGER)
          .setTitle(`❌ Stage Aborted — ${job.title}`)
          .setDescription(`${evictionsFailed} planned eviction(s) failed (rclone purge error), so the cache still doesn't have room for **${job.title}**. Check the rclone/audit logs, then retry.`)],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`stage_retry:${job.id}`).setLabel('Retry Stage').setStyle(ButtonStyle.Primary),
          )] });
        await dmUser(job.requested_by_discord_id, { embeds: [brandedEmbed(COLORS.DANGER)
          .setTitle(`💾 No Room on the Travel Server — ${job.title}`)
          .setDescription('Clearing cache space didn\'t fully work, so the copy was aborted rather than risk filling the drive. An admin has been notified.')] });
        audit('stage_refused_eviction_failed', { mediaId: job.media_id, title: job.title, evictionsFailed });
        return;
      }
    }
  }

  const result = await stageCopy(src.srcPath, src.destSubPath, CONFIG.STAGE_JOB_TIMEOUT_MINUTES * 60000);
  if (!result.ok) {
    finishStageJob(job.id, 'failed', result.error);
    audit('stage_job_failed', { mediaId: job.media_id, title: job.title, error: String(result.error).slice(0, 500) });
    notifyChannel('system', { embeds: [brandedEmbed(COLORS.DANGER)
      .setTitle(`❌ Stage Failed — ${job.title}`)
      .setDescription(`rclone copy to the PH cache failed:\n\`\`\`${String(result.error).slice(0, 800)}\`\`\``)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`stage_retry:${job.id}`).setLabel('Retry Stage').setStyle(ButtonStyle.Primary),
      )] });
    await dmUser(job.requested_by_discord_id, { embeds: [brandedEmbed(COLORS.DANGER)
      .setTitle(`❌ Staging Failed — ${job.title}`)
      .setDescription('The copy to the travel server didn\'t finish (flaky link, most likely). An admin has been notified and can retry it.')] });
    return;
  }

  recordStagedItem({ mediaId: job.media_id, mediaType: job.media_type, title: src.title || job.title, destPath: src.destSubPath, sizeBytes: src.sizeBytes, discordId: job.requested_by_discord_id });
  finishStageJob(job.id, 'done');
  const minutes = job.started_at ? Math.max(1, Math.round((Date.now() - job.started_at) / 60000)) : null;
  audit('media_staged', { mediaId: job.media_id, title: job.title, sizeBytes: src.sizeBytes, origin: job.origin, minutes });
  // Bulk seeding would fire dozens of DMs at the admin who fed the list — /staged shows the result.
  if (job.origin !== 'bulk') {
    await dmUser(job.requested_by_discord_id, { embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle(`🔥 Ready on the Travel Server — ${src.title || job.title}`)
      .setDescription(`**${src.title || job.title}** (${fmtSpace(src.sizeBytes)}) is now warm in the local cache — it'll play instantly, no more mystery buffering.`)] });
  }
}

// ---- PH tunnel watchdog ----
// The PH box sits behind CGNAT and a VPS tunnel across an ocean. When that path dies, the
// admin should hear it from Discord — not from a family member texting that Plex is broken.
// State transitions live in app_settings so a bot restart doesn't re-alert or forget an outage.
let tunnelFailStreak = 0;
async function sweepTunnelHealth() {
  // Any HTTP response (even 401 from Plex) proves the tunnel path works; only connect
  // errors/timeouts count as down.
  const ok = await axios.get(CONFIG.PH_TUNNEL_HEALTH_URL, { timeout: 10000, validateStatus: () => true }).then(() => true).catch(() => false);
  const prev = getSetting('ph_tunnel_state');
  if (ok) {
    tunnelFailStreak = 0;
    if (prev === 'down') {
      const downSince = Number(getSetting('ph_tunnel_since') || '0');
      notifyChannel('system', { embeds: [brandedEmbed(COLORS.SUCCESS)
        .setTitle('🛰️ PH Tunnel Recovered')
        .setDescription(`The tunnel to the PH box is reachable again${downSince ? ` (down since ${discordTimestamp(downSince, 'f')})` : ''}.`)] });
      audit('ph_tunnel_recovered', { downSince });
    }
    if (prev !== 'up') { setSetting('ph_tunnel_state', 'up'); setSetting('ph_tunnel_since', String(Date.now())); }
    return;
  }
  tunnelFailStreak++;
  if (prev !== 'down' && tunnelFailStreak >= CONFIG.PH_TUNNEL_FAILS_BEFORE_ALERT) {
    setSetting('ph_tunnel_state', 'down');
    setSetting('ph_tunnel_since', String(Date.now()));
    notifyChannel('system', { embeds: [brandedEmbed(COLORS.DANGER)
      .setTitle('🛰️ PH Tunnel Down')
      .setDescription(`\`${CONFIG.PH_TUNNEL_HEALTH_URL}\` hasn't answered for ${tunnelFailStreak} consecutive checks — Plex on the PH box is likely unreachable for everyone there. Check the VPS tunnel and the NUC.`)] });
    audit('ph_tunnel_down', { failStreak: tunnelFailStreak });
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

// Which Plex server a person belongs to ('primary' | 'ph'), for invite scoping and auto-staging.
// Unknown/unlinked people default to the primary — the PH box is opt-in via /assign-server.
function homeServerFor(discordId) {
  return (discordId && getUserByDiscordId(discordId)?.home_server) === 'ph' ? 'ph' : 'primary';
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
  new SlashCommandBuilder().setName('avistaz').setDescription('AvistaZ direct grab (Prowlarr search → seedbox rTorrent)').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('search').setDescription('Search AvistaZ and pick a release to send to the seedbox')
      .addStringOption(o => o.setName('title').setDescription('Title to search for').setRequired(true))
      .addStringOption(o => o.setName('type').setDescription('Media type').setRequired(true).addChoices({ name: 'movie', value: 'movie' }, { name: 'tv', value: 'tv' }))
      .addIntegerOption(o => o.setName('season').setDescription('Season number (TV) — prefers a matching season pack').setMinValue(0).setMaxValue(99))
      .addIntegerOption(o => o.setName('year').setDescription('Release year (movies) — improves match confidence').setMinValue(1900).setMaxValue(2100)))
    .addSubcommand(s => s.setName('status').setDescription('Grab allowance + active seedbox grabs')),
  new SlashCommandBuilder().setName('rtorrent').setDescription('Seedbox rTorrent: inspect torrents, adopt existing ones into the pipeline').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('status').setDescription('rTorrent connectivity + adoption settings'))
    .addSubcommand(s => s.setName('list').setDescription('List torrents in rTorrent')
      .addStringOption(o => o.setName('search').setDescription('Only names containing these words')))
    .addSubcommand(s => s.setName('adopt').setDescription('Adopt an existing torrent into the transfer/import pipeline (no tracker download)')
      .addStringOption(o => o.setName('search').setDescription('Words from the torrent name').setRequired(true))
      .addStringOption(o => o.setName('target').setDescription('Import target (default: derived from the rTorrent label)').addChoices({ name: 'sonarr', value: 'sonarr' }, { name: 'radarr', value: 'radarr' })))
    .addSubcommand(s => s.setName('ignore').setDescription('Toggle the discovery sweep\'s ignore flag for a torrent')
      .addStringOption(o => o.setName('search').setDescription('Words from the torrent name').setRequired(true)))
    .addSubcommand(s => s.setName('adopted').setDescription('Adopted jobs + ignored torrents'))
    .addSubcommand(s => s.setName('import').setDescription('Trigger a Sonarr/Radarr import scan of the seedbox staging folder')
      .addStringOption(o => o.setName('target').setDescription('Which arr should import').setRequired(true).addChoices({ name: 'sonarr', value: 'sonarr' }, { name: 'radarr', value: 'radarr' }))
      .addStringOption(o => o.setName('folder').setDescription('Subfolder of the staging share (default: the whole staging folder)'))
      .addStringOption(o => o.setName('mode').setDescription('move (default, cleans up staging) or copy (leaves the files in place)').addChoices({ name: 'move', value: 'move' }, { name: 'copy', value: 'copy' })))
    .addSubcommand(s => s.setName('staging').setDescription('Why-won\'t-it-import report: per-folder match/rejection summary of the staging share')
      .addStringOption(o => o.setName('target').setDescription('Which arr to ask (default sonarr)').addChoices({ name: 'sonarr', value: 'sonarr' }, { name: 'radarr', value: 'radarr' }))),
  new SlashCommandBuilder().setName('cleanup-suggestions').setDescription('Largest/oldest media that could be cleaned up').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('stage').setDescription('Copy a title into the travel-server cache so it plays instantly there').addStringOption(o => o.setName('title').setDescription('Start typing — matches what\'s in the library').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('staged').setDescription('Show the travel-server cache: what\'s warm, pinned, and copying'),
  new SlashCommandBuilder().setName('pin').setDescription('Protect a cached title from automatic eviction').addStringOption(o => o.setName('title').setDescription('Cached title — start typing').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('unpin').setDescription('Remove eviction protection from a cached title').addStringOption(o => o.setName('title').setDescription('Pinned title — start typing').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('stage-bulk').setDescription('Seed the travel cache from a list of titles (one per line)').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('assign-server').setDescription('Set which Plex server a user belongs to (drives invites + auto-staging)').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(o => o.setName('server').setDescription('Home server').setRequired(true).addChoices({ name: 'primary (master library)', value: 'primary' }, { name: 'ph (travel cache box)', value: 'ph' })),
  new SlashCommandBuilder().setName('me').setDescription('Show your linked profile'),
  new SlashCommandBuilder().setName('myrequests').setDescription('Show your recent requests'),
  new SlashCommandBuilder().setName('downloads').setDescription('Show your active download links'),
  new SlashCommandBuilder().setName('keep').setDescription('Show your keep list'),
  new SlashCommandBuilder().setName('help').setDescription('How this media server works'),
  new SlashCommandBuilder().setName('tier').setDescription('Regional tiering: per-node edge-cache plans').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('preview').setDescription('Dry-run the planner — shows keep/drop per node, writes nothing').addStringOption(o => o.setName('node').setDescription('Only this node')))
    .addSubcommand(s => s.setName('apply').setDescription('Publish manifests — agents converge on their next run').addStringOption(o => o.setName('node').setDescription('Only this node'))),
  new SlashCommandBuilder().setName('tier-node').setDescription('Manage the tiering node registry').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('add').setDescription('Add or update a node')
      .addStringOption(o => o.setName('name').setDescription('Node name, e.g. california').setRequired(true))
      .addIntegerOption(o => o.setName('usable_gb').setDescription('Pool usable capacity in GB'))
      .addIntegerOption(o => o.setName('headroom_pct').setDescription('Free-space floor % (default 15; ~25 for old drives)'))
      .addStringOption(o => o.setName('access').setDescription('Who may stream from it').addChoices({ name: 'open (all linked users)', value: 'open' }, { name: 'restricted (explicit member set)', value: 'restricted' }))
      .addStringOption(o => o.setName('demand_source').setDescription('Demand signal').addChoices({ name: 'tautulli (watch history)', value: 'tautulli' }, { name: 'plex (PMS watch history, no Tautulli)', value: 'plex' }, { name: 'atime (file last-read LRU)', value: 'atime' }))
      .addStringOption(o => o.setName('transport').setDescription('Sync transport').addChoices({ name: 'syncthing', value: 'syncthing' }, { name: 'rclone', value: 'rclone' }))
      .addStringOption(o => o.setName('folder_root').setDescription('Syncthing folder root on that node'))
      .addStringOption(o => o.setName('tautulli_url').setDescription('That node\'s Tautulli URL'))
      .addStringOption(o => o.setName('tautulli_api_key').setDescription('That node\'s Tautulli API key'))
      .addStringOption(o => o.setName('plex_url').setDescription('That node\'s Plex server URL (for demand_source plex)'))
      .addStringOption(o => o.setName('plex_token').setDescription('That node\'s Plex server token'))
      .addStringOption(o => o.setName('atime_mask').setDescription('UTC window to launder Plex-maintenance reads from atime, e.g. 09:00-13:00'))
      .addBooleanOption(o => o.setName('full').setDescription('Never-pruned master (holds everything)'))
      .addBooleanOption(o => o.setName('sticky').setDescription('Extra-low churn (old drives): longer warm window'))
      .addIntegerOption(o => o.setName('warm_days').setDescription('Override: recently-watched protection window'))
      .addIntegerOption(o => o.setName('fresh_days').setDescription('Override: newly-added grace window')))
    .addSubcommand(s => s.setName('list').setDescription('List all nodes'))
    .addSubcommand(s => s.setName('enable').setDescription('Enable a node').addStringOption(o => o.setName('name').setDescription('Node name').setRequired(true)))
    .addSubcommand(s => s.setName('disable').setDescription('Disable a node (skipped by the planner entirely)').addStringOption(o => o.setName('name').setDescription('Node name').setRequired(true)))
    .addSubcommand(s => s.setName('token').setDescription('(Re)generate the node\'s sync-agent bearer token — shown once').addStringOption(o => o.setName('name').setDescription('Node name').setRequired(true))),
  new SlashCommandBuilder().setName('tier-member').setDescription('Manage a restricted node\'s member set').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('add').setDescription('Add a member').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('node').setDescription('Restricted node name').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a member').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('node').setDescription('Restricted node name').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('List members').addStringOption(o => o.setName('node').setDescription('Restricted node name').setRequired(true))),
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
  if (CONFIG.ESCALATION_ENABLED && (CONFIG.RADARR_URL || CONFIG.SONARR_URL)) {
    // Non-fatal setup check: escalation fails with tag_missing until the AvistaZ tag exists.
    verifyAvistazTags(CONFIG.AVISTAZ_TAG).then(missing => {
      for (const w of missing) log.warn(`Config: ${w.replace(/`/g, '')}`);
      if (missing.length) {
        notifyChannel('system', { embeds: [brandedEmbed(COLORS.WARN)
          .setTitle('⚙️ AvistaZ Escalation Warnings')
          .setDescription(missing.map(w => `• ${w}`).join('\n').slice(0, 4000))] });
      }
    }).catch(err => log.warn(`AvistaZ tag check failed: ${err.message}`));
    if (CONFIG.ESCALATION_CHECK_MINUTES > 0) {
      setInterval(() => sweepEscalations().catch(err => log.warn(`Escalation sweep failed: ${err.message}`)), CONFIG.ESCALATION_CHECK_MINUTES * 60000).unref();
      log.ok(`AvistaZ escalation watchdog running every ${CONFIG.ESCALATION_CHECK_MINUTES} min (delay ${escalationDelayLabel()}, tag '${CONFIG.AVISTAZ_TAG}')`);
    }
  }
  if (grabConfigured()) {
    // A restart mid-transfer leaves 'transferring' rows behind; put them back in the queue
    // (rclone copy skips files that already made it across).
    const resumed = resetInterruptedGrabTransfers();
    if (resumed) log.info(`Re-queued ${resumed} AvistaZ transfer(s) interrupted by restart`);
    if (CONFIG.GRAB_CHECK_MINUTES > 0) {
      setInterval(() => sweepGrabJobs().catch(err => log.warn(`Grab sweep failed: ${err.message}`)), CONFIG.GRAB_CHECK_MINUTES * 60000).unref();
    }
    pumpGrabTransfers().catch(err => log.warn(`Grab transfer pump failed: ${err.message}`));
    log.ok(`AvistaZ direct grab enabled → seedbox rTorrent (sweep every ${CONFIG.GRAB_CHECK_MINUTES} min, mode ${CONFIG.GRAB_MODE}, daily limit ${CONFIG.AVISTAZ_DAILY_GRAB_LIMIT || 'unlimited'})`);
  }
  if (CONFIG.RTORRENT_ADOPT_ENABLED && adoptPipelineReady() && CONFIG.RTORRENT_ADOPT_CHECK_MINUTES > 0) {
    setInterval(() => sweepAdoptCandidates().catch(err => log.warn(`Adoption sweep failed: ${err.message}`)), CONFIG.RTORRENT_ADOPT_CHECK_MINUTES * 60000).unref();
    log.ok(`rTorrent adoption discovery running every ${CONFIG.RTORRENT_ADOPT_CHECK_MINUTES} min (labels: ${CONFIG.RTORRENT_ADOPT_LABELS.join(', ') || 'none'}, auto: ${CONFIG.RTORRENT_ADOPT_AUTO ? 'on' : 'off'})`);
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
  if (stagingConfigured()) {
    // A restart mid-copy leaves 'copying' rows behind; put them back in the queue and let the
    // worker pick them up (rclone skips files that already made it across).
    const resumed = resetInterruptedStageJobs();
    if (resumed) log.info(`Re-queued ${resumed} stage job(s) interrupted by restart`);
    if (CONFIG.STAGE_CHECK_MINUTES > 0) {
      setInterval(() => pumpStageQueue().catch(err => log.warn(`Stage queue pump failed: ${err.message}`)), CONFIG.STAGE_CHECK_MINUTES * 60000).unref();
    }
    pumpStageQueue().catch(err => log.warn(`Stage queue pump failed: ${err.message}`));
    log.ok(`Plex Home staging enabled → ${CONFIG.STAGE_RCLONE_REMOTE} (queue check every ${CONFIG.STAGE_CHECK_MINUTES} min, min free ${CONFIG.STAGE_MIN_FREE_GB} GB)`);
  }
  if (CONFIG.PH_TUNNEL_HEALTH_URL && CONFIG.PH_TUNNEL_CHECK_MINUTES > 0) {
    setInterval(() => sweepTunnelHealth().catch(err => log.warn(`Tunnel health sweep failed: ${err.message}`)), CONFIG.PH_TUNNEL_CHECK_MINUTES * 60000).unref();
    log.ok(`PH tunnel watchdog running every ${CONFIG.PH_TUNNEL_CHECK_MINUTES} min (alert after ${CONFIG.PH_TUNNEL_FAILS_BEFORE_ALERT} failures)`);
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
    if (interaction.isStringSelectMenu()) await handleSelectMenu(interaction);
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
// Everything stageable (has a file on disk), across both Radarrs and Sonarr, cached briefly so
// autocomplete keystrokes don't hammer the *arrs and stay inside Discord's 3s deadline.
let stageLibraryCache = { at: 0, entries: null };
async function getStageLibrary() {
  if (stageLibraryCache.entries && Date.now() - stageLibraryCache.at < 60000) return stageLibraryCache.entries;
  const seen = new Map();
  const movieSources = [
    { url: CONFIG.RADARR_URL, key: CONFIG.RADARR_API_KEY },
    { url: CONFIG.RADARR_4K_URL, key: CONFIG.RADARR_4K_API_KEY },
  ].filter(s => s.url);
  for (const s of movieSources) {
    for (const m of await radarrGetFrom(s.url, s.key, '/movie').catch(() => [])) {
      if (!m.hasFile || !m.tmdbId) continue;
      const mediaId = `tmdb:${m.tmdbId}`;
      if (!seen.has(mediaId)) seen.set(mediaId, { mediaId, kind: 'movie', title: `${m.title}${m.year ? ` (${m.year})` : ''}`, sizeBytes: m.sizeOnDisk || m.movieFile?.size || 0 });
    }
  }
  if (CONFIG.SONARR_URL) {
    for (const s of await sonarrGet('/series').catch(() => [])) {
      if (!(s.statistics?.episodeFileCount > 0) || !s.tvdbId) continue;
      const mediaId = `tvdb:${s.tvdbId}`;
      if (!seen.has(mediaId)) seen.set(mediaId, { mediaId, kind: 'tv', title: s.title, sizeBytes: s.statistics?.sizeOnDisk || 0 });
    }
  }
  stageLibraryCache = { at: Date.now(), entries: [...seen.values()] };
  return stageLibraryCache.entries;
}

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

  // /stage title: — the whole library (anything with a file). /pin and /unpin match only what's
  // currently cached. The library fetch is raced against Discord's deadline: a cold cache may
  // yield no suggestions once, then it's warm.
  if (interaction.commandName === 'stage') {
    const focusedTitle = interaction.options.getFocused(true);
    if (focusedTitle.name !== 'title') return interaction.respond([]).catch(() => {});
    const q = String(focusedTitle.value || '').toLowerCase().trim();
    if (q.length < 2) return interaction.respond([]).catch(() => {});
    const library = await Promise.race([
      getStageLibrary(),
      new Promise(resolve => setTimeout(() => resolve([]), 2500)),
    ]).catch(() => []);
    const choices = library
      .filter(e => e.title.toLowerCase().includes(q))
      .slice(0, 25)
      .map(e => {
        const warm = getStagedItem(e.mediaId) ? ' — 🔥 already cached' : '';
        return { name: `${mediaTypeEmoji(e.kind)} ${e.title} · ${fmtSpace(e.sizeBytes)}${warm}`.slice(0, 100), value: e.mediaId.slice(0, 100) };
      });
    return interaction.respond(choices).catch(() => {});
  }

  if (['pin', 'unpin'].includes(interaction.commandName)) {
    const focusedTitle = interaction.options.getFocused(true);
    if (focusedTitle.name !== 'title') return interaction.respond([]).catch(() => {});
    const q = String(focusedTitle.value || '').toLowerCase().trim();
    const wantPinned = interaction.commandName === 'unpin';
    const choices = listStagedItems()
      .filter(i => !!i.pinned === wantPinned && (!q || String(i.title || '').toLowerCase().includes(q)))
      .slice(0, 25)
      .map(i => ({ name: `${i.title} · ${fmtSpace(i.size_bytes)}`.slice(0, 100), value: String(i.media_id).slice(0, 100) }));
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
  if (n === 'avistaz') return handleAvistazCommand(interaction);
  if (n === 'rtorrent') return handleRtorrentCommand(interaction);
  if (n === 'cleanup-suggestions') return handleCleanupSuggestionsCommand(interaction);
  if (n === 'stage') return handleStageCommand(interaction);
  if (n === 'staged') return handleStagedCommand(interaction);
  if (n === 'pin') return handlePinCommand(interaction, true);
  if (n === 'unpin') return handlePinCommand(interaction, false);
  if (n === 'stage-bulk') return handleStageBulkCommand(interaction);
  if (n === 'assign-server') return handleAssignServerCommand(interaction);
  if (n === 'me') return handleMeCommand(interaction);
  if (n === 'myrequests') return handleMyRequestsCommand(interaction);
  if (n === 'downloads') return handleDownloadsCommand(interaction);
  if (n === 'keep') return handleKeepCommand(interaction);
  if (n === 'help') return handleHelpCommand(interaction);
  if (n === 'tier') return handleTierCommand(interaction);
  if (n === 'tier-node') return handleTierNodeCommand(interaction);
  if (n === 'tier-member') return handleTierMemberCommand(interaction);
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
      const result = await inviteUserToPlex(email, { homeServer: homeServerFor(discordId) });
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
    // Don't take Seerr's "accepted" at face value — it can lose the request moments later
    // ('Media data not found' in its log) and nothing would ever download.
    const verified = data?.id != null ? await verifySeerrRequestCreated(data.id, mediaType) : { ok: true };
    if (!verified.ok) {
      audit('external_api_error', { provider: 'overseerr', error: `request #${data.id} failed post-create verification: ${verified.reason}`, action: 'create_request_verify', actorDiscordId: interaction.user.id, tmdbId, mediaType });
      return interaction.editReply(`⚠️ Seerr accepted **${label}** (request #${data.id}) but ${verified.reason}.\nNothing will download until that's fixed — check the Seerr container logs from the last minute for the underlying error, then try again.`);
    }
    upsertRequest(data?.id, mediaKey, mediaType, is4k, label, interaction.user.id, 'approved');
    // Admin self-requests skip the gate, so there's no "+ AvistaZ Fallback" button to click —
    // pre-authorize the fallback automatically instead (the admin IS the person who'd click
    // it), which also puts the arr tag on right away like a gate pre-auth does.
    const azPreAuth = canEscalate({ mediaType, is4k });
    if (azPreAuth) {
      recordEscalationWatch({ mediaType, tmdbId, tvdbId: data?.media?.tvdbId ?? null, title: label, discordId: interaction.user.id, preAuthorized: true });
      tagPreAuthorizedMedia({ mediaType, tmdbId, tvdbId: data?.media?.tvdbId ?? null, title: label })
        .catch(err => log.warn(`Approval-time AvistaZ tagging failed for ${label}: ${err.message}`));
    }
    audit('media_requested', { actorDiscordId: interaction.user.id, title: label, mediaType, tmdbId, is4k, seerrUserId, requestId: data?.id ?? null, azPreAuth });
    await interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle(`${mediaTypeEmoji(mediaType, is4k)} Request Sent`)
      .setDescription(`**${label}**${is4k ? ' (4K)' : ''}${mediaType === 'tv' ? ' — all seasons' : ''}\nRequested as \`${row.email}\` — approved and grabbing it now! 🚀\nYou\'ll get a DM when it\'s on Plex.${azPreAuth ? `\n🔐 AvistaZ fallback pre-authorized — tagging it \`${CONFIG.AVISTAZ_TAG}\` now; auto-escalates if nothing public is grabbed within ${escalationDelayLabel()}.` : ''}`)] });
  } catch (err) {
    // Seerr answered but said no (rejection body, or the created-nothing shapes from
    // createSeerrRequestAs) vs. never answered at all — show which, so "Couldn't reach Seerr"
    // stops masking rejections.
    const seerrMessage = err.response?.data?.message || (err.response ? err.message : null);
    audit('external_api_error', { provider: 'overseerr', error: seerrMessage || err.message, action: 'create_request', actorDiscordId: interaction.user.id, tmdbId, mediaType });
    await interaction.editReply(seerrMessage
      ? `❌ Seerr rejected the request: ${seerrMessage}`
      : `❌ Couldn't reach Seerr to place the request (${err.message}). Try again in a bit.`);
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

  // PH staging at a glance: cache free space, active stage jobs, tunnel state.
  if (stagingConfigured()) {
    const stagedItems = listStagedItems();
    const jobs = listActiveStageJobs();
    const cache = await getCacheStatus(stagedItems).catch(() => null);
    const copying = jobs.find(j => j.status === 'copying');
    const lines = [
      cache && cache.freeBytes != null
        ? `💾 Cache: ${fmtSpace(cache.freeBytes)} free${cache.totalBytes ? ` of ${fmtSpace(cache.totalBytes)}` : ''}${cache.source === 'budget' ? ' (budget estimate)' : ''}`
        : '💾 Cache: free space unknown ⚠️',
      `🎞️ Staged: ${stagedItems.length} title(s) (${stagedItems.filter(i => i.pinned).length} pinned)`,
      copying ? `📥 Copying: **${copying.title}**${jobs.length > 1 ? ` (+${jobs.length - 1} queued)` : ''}` : `📥 Stage queue: ${jobs.length ? `${jobs.length} queued` : 'idle'}`,
    ];
    if (CONFIG.PH_TUNNEL_HEALTH_URL) {
      const tState = getSetting('ph_tunnel_state') || 'unknown';
      const tSince = Number(getSetting('ph_tunnel_since') || '0');
      lines.push(`🛰️ Tunnel: ${tState === 'up' ? '✅ up' : tState === 'down' ? '❌ down' : '❔ not checked yet'}${tSince ? ` since ${discordTimestamp(tSince)}` : ''}`);
    }
    embed.addFields({ name: 'PH staging', value: lines.join('\n'), inline: false });
  }
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

// Guided-import wizard select menus (series / season picks).
async function handleSelectMenu(interaction) {
  const [action, nonce] = interaction.customId.split(':');
  if (!['mapimp_series', 'mapimp_season'].includes(action)) return;
  if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
  const state = readMapOffer(nonce);
  if (!state) return interaction.update({ content: 'ℹ️ This mapping session expired (or already finished).', embeds: [], components: [] });
  await interaction.deferUpdate();
  if (action === 'mapimp_series') {
    state.seriesId = Number(interaction.values[0]);
    const series = await sonarrGet(`/series/${state.seriesId}`).catch(() => null);
    state.seriesTitle = series?.title || `series #${state.seriesId}`;
    writeMapOffer(nonce, state);
    return interaction.editReply(mapWizardSeasonStep(nonce, state, series));
  }
  state.season = Number(interaction.values[0]);
  writeMapOffer(nonce, state);
  return interaction.editReply(await mapWizardConfirmStep(nonce, state));
}

async function handleModalSubmit(interaction) {
  // Guided-import series search (opened from the wizard's "Search by name" button, so the
  // submit is bound to the wizard message — deferUpdate + editReply steps it in place).
  if (interaction.customId.startsWith('mapimp_findm:')) {
    if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const nonce = interaction.customId.split(':')[1];
    const state = readMapOffer(nonce);
    if (!state) return interaction.reply({ content: 'ℹ️ This mapping session expired (or already finished).', ephemeral: true });
    const query = String(interaction.fields.getTextInputValue('series_query') || '').trim();
    await interaction.deferUpdate();
    return interaction.editReply(await mapWizardSeriesStep(nonce, state, query));
  }
  if (interaction.customId === 'stage_bulk_modal') {
    if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    return handleStageBulkModal(interaction);
  }
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
  const result = await inviteUserToPlex(email, { homeServer: homeServerFor(discordId) });
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
      // Before blaming the indexers, check whether the title is even out yet — Radarr/Sonarr
      // know the digital release / air dates, and "it releases March 14" beats "no release
      // has been grabbed" when the real answer is "it isn't out".
      const idNum = Number(row.media_id.split(':')[1]);
      // TV rows from the /request gate are keyed tmdb: but Sonarr keys off tvdb — backfill it.
      const tvdbId = row.media_id.startsWith('tvdb:') ? idNum
        : (row.media_type === 'tv' ? await fetchSeerrTvdbId(idNum) : null);
      const eta = releaseEtaInfo(await fetchReleaseEta({
        mediaType: row.media_type,
        tmdbId: row.media_id.startsWith('tmdb:') ? idNum : null,
        tvdbId,
      }));
      if (eta?.waiting) {
        lines.push(`⏳ It isn't out yet, so there's nothing to download — it'll be grabbed automatically once it releases.\n${eta.line}`);
      } else {
        lines.push('🔎 Approved, but nothing is downloading for it yet — usually no good release has been grabbed so far. The *arrs keep retrying automatically; an admin can force a search from Radarr/Sonarr.');
        if (eta) lines.push(eta.line);
      }
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

// /avistaz — manual mode of the direct-grab pipeline: search AvistaZ through Prowlarr, show
// scored candidates with Download buttons, and report allowance + active seedbox grabs.
async function handleAvistazCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    await interaction.deferReply({ ephemeral: true });
    const lines = [];
    const allowance = grabDailyAllowance();
    lines.push(allowance.limited
      ? `Daily allowance: **${allowance.remaining}/${CONFIG.AVISTAZ_DAILY_GRAB_LIMIT}** grab(s) remaining today (UTC)`
      : 'Daily allowance: unlimited (`AVISTAZ_DAILY_GRAB_LIMIT=0`)');
    lines.push(`Mode: **${CONFIG.GRAB_MODE === 'auto' ? `auto (≥${CONFIG.GRAB_AUTO_CONFIDENCE}% confidence grabs itself)` : 'approve (every grab needs a button click)'}**`);
    if (rtorrentConfigured()) {
      try {
        const version = await getRtorrentVersion();
        lines.push(`Seedbox rTorrent: ✅ reachable (v${version})`);
      } catch (err) {
        lines.push(`Seedbox rTorrent: ❌ ${err.message}`);
      }
    } else {
      lines.push('Seedbox rTorrent: ⏭️ not configured (`RTORRENT_URL`)');
    }
    if (!grabConfigured()) lines.push('⚠️ Pipeline incomplete — need `PROWLARR_URL`, `RTORRENT_URL`, `GRAB_RCLONE_REMOTE`, and `GRAB_STAGING_PATH`.');
    const active = listActiveGrabJobs();
    if (active.length) {
      lines.push('', '**Active grabs:**');
      for (const j of active.slice(0, 10)) {
        lines.push(`• #${j.id} **${j.title}** — ${j.state} — ${String(j.release_title).slice(0, 80)}`);
      }
    } else {
      lines.push('', 'No active grabs.');
    }
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO).setTitle('🔐 AvistaZ Direct Grab').setDescription(lines.join('\n').slice(0, 4000))] });
  }

  // sub === 'search' — posted in-channel (not ephemeral) so the Download buttons leave a record.
  if (!CONFIG.PROWLARR_URL) return interaction.reply({ content: '❌ Prowlarr isn\'t configured (`PROWLARR_URL` + `PROWLARR_API_KEY`).', ephemeral: true });
  if (!grabConfigured()) return interaction.reply({ content: '❌ The grab pipeline isn\'t fully configured — need `RTORRENT_URL`, `GRAB_RCLONE_REMOTE`, and `GRAB_STAGING_PATH` (see README "AvistaZ direct grab").', ephemeral: true });
  const rawTitle = interaction.options.getString('title');
  const mediaType = interaction.options.getString('type');
  if (!grabImportTarget(mediaType)) return interaction.reply({ content: `❌ ${mediaType === 'tv' ? 'Sonarr' : 'Radarr'} isn't configured — a ${mediaType} grab could never be imported, so it won't be downloaded.`, ephemeral: true });
  await interaction.deferReply();
  const season = interaction.options.getInteger('season');
  const split = splitTitleYear(rawTitle);
  const year = interaction.options.getInteger('year') ?? split.year;
  try {
    const indexer = await findAvistazIndexer();
    if (!indexer) return interaction.editReply(`❌ No Prowlarr indexer matching \`${CONFIG.AVISTAZ_INDEXER_NAME}\` — add AvistaZ in Prowlarr first.`);
    const results = await searchAvistaz({ query: split.query, mediaType, indexerId: indexer.id });
    const candidates = rankAvistazResults(results, { title: split.query, year, mediaType, season });
    if (!candidates.length) return interaction.editReply(`🔍 No AvistaZ results for **${split.query}**${season != null ? ` S${pad(season)}` : ''}. Try alternate spellings or the show's original title.`);
    const allowance = grabDailyAllowance();
    const nonce = stashGrabOffer({ mediaType, title: rawTitle, discordId: interaction.user.id, origin: 'manual', candidates });
    audit('avistaz_search', { actorDiscordId: interaction.user.id, query: split.query, mediaType, season, results: results.length, shown: candidates.length });
    return interaction.editReply(grabCandidatesMessage({
      heading: `🔎 Found ${candidates.length} AvistaZ match${candidates.length === 1 ? '' : 'es'} — ${split.query}`,
      candidates, nonce, allowance,
    }));
  } catch (err) {
    audit('external_api_error', { provider: 'prowlarr', error: err.message, action: 'avistaz_search' });
    return interaction.editReply(`❌ AvistaZ search failed: ${err.message}`);
  }
}

// /rtorrent — provider-independent view of the seedbox rTorrent, plus adoption of torrents
// the bot didn't submit (manual adds, other trackers). Deliberately narrow: adoption only
// creates a grab job for an existing info-hash — nothing is fetched from any tracker, no
// AvistaZ allowance is spent, and nothing is ever removed from rTorrent.
async function handleRtorrentCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  if (!rtorrentConfigured()) return interaction.reply({ content: '❌ rTorrent isn\'t configured (`RTORRENT_URL`).', ephemeral: true });
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    await interaction.deferReply({ ephemeral: true });
    const lines = [];
    let torrents = null;
    try {
      const version = await getRtorrentVersion();
      torrents = await listRtorrentTorrents();
      const complete = torrents.filter(t => t.complete).length;
      lines.push(`Seedbox rTorrent: ✅ reachable (v${version})`);
      lines.push(`Torrents: **${torrents.length}** (${complete} complete, ${torrents.length - complete} downloading)`);
    } catch (err) {
      lines.push(`Seedbox rTorrent: ❌ ${err.message}`);
    }
    // What rclone actually sees at the remote root — the fastest way to spot a broken
    // rclone config or a root/download-folder mismatch when adoptions fail "not found".
    if (CONFIG.GRAB_RCLONE_REMOTE) {
      const res = await runRclone(['lsf', CONFIG.GRAB_RCLONE_REMOTE, '--max-depth', '1'], { timeoutMs: 60000, flags: CONFIG.GRAB_RCLONE_FLAGS })
        .catch(err => ({ code: -1, stderr: err.message }));
      if (res.code === 0) {
        const entries = res.stdout.split('\n').map(s => s.trim()).filter(Boolean);
        lines.push('', `Remote root \`${CONFIG.GRAB_RCLONE_REMOTE}\`: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
        for (const e of entries.slice(0, 8)) lines.push(`• \`${e.slice(0, 100)}\``);
        if (entries.length > 8) lines.push(`…and ${entries.length - 8} more`);
      } else {
        lines.push('', `⚠️ rclone can't list \`${CONFIG.GRAB_RCLONE_REMOTE}\`: ${String(res.stderr || `exit ${res.code}`).slice(0, 300)}`);
      }
    }
    lines.push('', `Adoption discovery sweep: **${CONFIG.RTORRENT_ADOPT_ENABLED ? `on (every ${CONFIG.RTORRENT_ADOPT_CHECK_MINUTES} min, ${CONFIG.RTORRENT_ADOPT_AUTO ? 'auto-adopts' : 'posts Adopt buttons'})` : 'off (`RTORRENT_ADOPT_ENABLED`)'}**`);
    lines.push(`Adoptable labels: ${CONFIG.RTORRENT_ADOPT_LABELS.map(l => `\`${l}\``).join(', ') || 'none'}`);
    if (!adoptPipelineReady()) lines.push('⚠️ Transfer pipeline incomplete — adoption needs `GRAB_RCLONE_REMOTE` and `GRAB_STAGING_PATH` too.');
    const adopted = listAdoptedGrabJobs(5);
    if (adopted.length) {
      lines.push('', '**Recent adopted jobs:**');
      for (const j of adopted) lines.push(`• #${j.id} **${String(j.title).slice(0, 80)}** — ${j.state}`);
    }
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO).setTitle('🧲 Seedbox rTorrent').setDescription(lines.join('\n').slice(0, 4000))] });
  }

  if (sub === 'list') {
    await interaction.deferReply({ ephemeral: true });
    const search = interaction.options.getString('search');
    try {
      const torrents = await listRtorrentTorrents();
      const matched = search ? matchTorrentsByName(torrents, search) : torrents;
      const shown = matched.slice(0, 15);
      if (!shown.length) return interaction.editReply(search ? `🔍 No torrents matching **${search}**.` : 'rTorrent has no torrents.');
      const lines = shown.map(t => {
        const job = t.hash ? getGrabJobByHash(t.hash) : null;
        const tracked = job ? ` — tracked as job #${job.id} (${job.state})` : isAdoptIgnored(t.hash) ? ' — 🙈 ignored' : '';
        // A search that narrows to few torrents gets the seedbox data path too — the thing
        // to compare against the rclone remote when an adoption reports "not found".
        const detail = search && shown.length <= 5 ? `\n  path: \`${String(t.basePath || 'unknown').slice(0, 150)}\`` : '';
        return `• **${String(t.name).slice(0, 120)}**\n  ${t.complete ? '✅ complete' : `⬇️ ${adoptProgressPct(t)}%`} • ${fmtSpace(t.sizeBytes)} • label: ${t.label ? `\`${t.label}\`` : 'none'}${tracked}${detail}`;
      });
      return interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO)
        .setTitle(`🧲 rTorrent — ${matched.length > shown.length ? `${shown.length} of ${matched.length}` : shown.length} torrent${matched.length === 1 ? '' : 's'}${search ? ` matching “${search}”` : ''}`)
        .setDescription(lines.join('\n').slice(0, 4000))] });
    } catch (err) {
      return interaction.editReply(`❌ rTorrent query failed: ${err.message}`);
    }
  }

  if (sub === 'adopt') {
    if (!adoptPipelineReady()) return interaction.reply({ content: '❌ The transfer pipeline isn\'t configured — adoption needs `GRAB_RCLONE_REMOTE` and `GRAB_STAGING_PATH` (see README "AvistaZ direct grab").', ephemeral: true });
    const search = interaction.options.getString('search');
    const explicitTarget = interaction.options.getString('target');
    // Posted in-channel (not ephemeral) so the Adopt buttons leave a record, like /avistaz.
    await interaction.deferReply();
    try {
      const torrents = await listRtorrentTorrents();
      const matches = matchTorrentsByName(torrents, search);
      if (!matches.length) return interaction.editReply(`🔍 No rTorrent torrents matching **${search}**. \`/rtorrent list\` shows what's there.`);
      const fresh = matches.filter(t => !getGrabJobByHash(t.hash));
      if (!fresh.length) {
        const j = getGrabJobByHash(matches[0].hash);
        return interaction.editReply(`ℹ️ Every match is already tracked${j ? ` (e.g. **${String(matches[0].name).slice(0, 100)}** as job #${j.id}, ${j.state})` : ''} — nothing to adopt.`);
      }
      audit('rtorrent_adopt_search', { actorDiscordId: interaction.user.id, search, target: explicitTarget || null, matches: matches.length, untracked: fresh.length });
      // More than a handful of matches (an episode-per-torrent series can be 80+) gets the
      // bulk flow: one Adopt-all button instead of per-torrent picks.
      if (fresh.length > 3) {
        const candidates = fresh.slice(0, 200).map(t => ({ hash: t.hash, name: t.name, complete: t.complete, label: t.label, basePath: t.basePath, sizeBytes: t.sizeBytes, doneBytes: t.doneBytes }));
        const nonce = stashGrabOffer({ kind: 'adopt-bulk', candidates, search, explicitTarget: explicitTarget || null, discordId: interaction.user.id, origin: 'adopt' });
        const msg = adoptBulkMessage({ candidates, search, explicitTarget, nonce });
        if (fresh.length > 200) msg.embeds[0].setFooter({ text: `Capped at 200 of ${fresh.length} matches — re-run after this batch for the rest.` });
        return interaction.editReply(msg);
      }
      const candidates = fresh.map(t => ({ ...t, target: explicitTarget || adoptTargetForLabel(t.label) }));
      const nonce = stashGrabOffer({ kind: 'adopt', candidates, discordId: interaction.user.id, origin: 'adopt' });
      return interaction.editReply(adoptCandidatesMessage({
        heading: `🧲 Adoptable — ${candidates.length} match${candidates.length === 1 ? '' : 'es'} for “${search}”`,
        candidates, nonce,
        footnote: 'Adopting tracks the EXISTING torrent — no tracker download, no AvistaZ allowance slot, nothing removed from rTorrent. Incomplete torrents are watched to 100% first; complete ones transfer immediately.',
      }));
    } catch (err) {
      audit('external_api_error', { provider: 'rtorrent', error: err.message, action: 'rtorrent_adopt' });
      return interaction.editReply(`❌ rTorrent query failed: ${err.message}`);
    }
  }

  if (sub === 'ignore') {
    await interaction.deferReply({ ephemeral: true });
    const search = interaction.options.getString('search');
    try {
      const matches = matchTorrentsByName(await listRtorrentTorrents(), search);
      if (!matches.length) return interaction.editReply(`🔍 No rTorrent torrents matching **${search}**.`);
      if (matches.length > 1) {
        return interaction.editReply(`⚠️ **${matches.length}** torrents match — narrow the search so exactly one does:\n${matches.slice(0, 10).map(t => `• ${String(t.name).slice(0, 120)}`).join('\n')}`.slice(0, 2000));
      }
      const t = matches[0];
      if (isAdoptIgnored(t.hash)) {
        clearAdoptIgnored(t.hash);
        audit('rtorrent_adopt_unignored', { actorDiscordId: interaction.user.id, infoHash: t.hash, name: t.name });
        return interaction.editReply(`👀 **${t.name}** is no longer ignored — the discovery sweep may offer it again.`);
      }
      setAdoptIgnored(t.hash, t.name);
      clearAdoptOffered(t.hash);
      audit('rtorrent_adopt_ignored', { actorDiscordId: interaction.user.id, infoHash: t.hash, name: t.name });
      return interaction.editReply(`🙈 **${t.name}** is now ignored — the discovery sweep will skip it. Run the same command again to undo, or \`/rtorrent adopt\` to adopt it anyway.`);
    } catch (err) {
      return interaction.editReply(`❌ rTorrent query failed: ${err.message}`);
    }
  }

  // Manual import trigger: hand a staging folder straight to the arr — for files that got
  // there outside the pipeline (manual rclone copies, the pre-adoption era). mode:copy
  // leaves the staging files in place; mode:move (default) is what the pipeline itself uses.
  if (sub === 'import') {
    if (!CONFIG.GRAB_STAGING_PATH || !CONFIG.GRAB_IMPORT_PATH) return interaction.reply({ content: '❌ Staging isn\'t configured (`GRAB_STAGING_PATH` + `GRAB_IMPORT_PATH`).', ephemeral: true });
    const target = interaction.options.getString('target');
    const arr = target === 'sonarr'
      ? { url: CONFIG.SONARR_URL, key: CONFIG.SONARR_API_KEY, cmd: 'DownloadedEpisodesScan', label: 'Sonarr' }
      : { url: CONFIG.RADARR_URL, key: CONFIG.RADARR_API_KEY, cmd: 'DownloadedMoviesScan', label: 'Radarr' };
    if (!arr.url) return interaction.reply({ content: `❌ ${arr.label} isn't configured.`, ephemeral: true });
    // Strip wrapping quotes: Discord passes option strings verbatim, and admins used to
    // shell quoting will type folder:"Name With Spaces" — the quotes are not part of the name.
    const clean = String(interaction.options.getString('folder') || '').trim().replace(/^["']+|["']+$/g, '').replace(/^\/+|\/+$/g, '');
    if (clean && clean.split('/').some(p => !p || p === '.' || p === '..')) return interaction.reply({ content: '❌ Unsafe folder path.', ephemeral: true });
    if (clean === '.incoming' || clean.startsWith('.incoming/')) return interaction.reply({ content: '❌ `.incoming` holds in-flight copies — never import from there.', ephemeral: true });
    const mode = interaction.options.getString('mode') === 'copy' ? 'Copy' : 'Move';
    await interaction.deferReply({ ephemeral: true });
    // The bot and the arr see the same share at different mount points; existence is
    // checked through the bot's view before asking the arr to scan its own.
    const localPath = clean ? path.join(CONFIG.GRAB_STAGING_PATH, clean) : CONFIG.GRAB_STAGING_PATH;
    if (!fs.existsSync(localPath)) return interaction.editReply(`❌ \`${clean || '(staging root)'}\` doesn't exist under \`${CONFIG.GRAB_STAGING_PATH}\`.`);
    if (!clean) {
      const incoming = path.join(CONFIG.GRAB_STAGING_PATH, '.incoming');
      const busy = fs.existsSync(incoming) && fs.readdirSync(incoming).length > 0;
      if (busy) return interaction.editReply('❌ A transfer is mid-copy (`.incoming` isn\'t empty) — scanning the whole staging folder now could import half-copied files. Scan a specific `folder:`, or wait for the transfers to finish.');
    }
    const importPath = clean ? `${CONFIG.GRAB_IMPORT_PATH}/${clean}` : CONFIG.GRAB_IMPORT_PATH;
    try {
      const res = await axios.post(`${arr.url}/api/v3/command`, { name: arr.cmd, path: importPath, importMode: mode },
        { headers: { 'X-Api-Key': arr.key }, timeout: 15000 });
      audit('rtorrent_manual_import', { actorDiscordId: interaction.user.id, target, path: importPath, mode });
      // Same post-scan verification the grab pipeline gets: silent declines surface as the
      // decline alert (with the Map to a Series… wizard for TV) instead of nothing happening.
      // Copy mode is excluded — files staying put is expected there, not a decline.
      if (mode === 'Move') {
        verifyArrImport({ id: null, title: clean || 'staging import', media_type: target === 'sonarr' ? 'tv' : 'movie' },
          { url: arr.url, key: arr.key, label: arr.label }, res.data?.id, importPath, localPath)
          .catch(err => log.warn(`Manual-import verification failed: ${err.message}`));
      }
      return interaction.editReply(`📦 ${arr.label} is scanning \`${importPath}\` (import mode: **${mode}**, command #${res.data?.id ?? '?'}). ${mode === 'Copy' ? 'The staging files stay where they are.' : 'Imported files are moved out of staging — if the import is declined, an alert with next steps lands in the downloads channel.'}`);
    } catch (err) {
      audit('external_api_error', { provider: target, error: err.message, action: 'rtorrent_manual_import' });
      return interaction.editReply(`❌ ${arr.label} command failed: ${err.message}`);
    }
  }

  // The "why won't it import" report: the arr's own manual-import preview, aggregated per
  // staging folder — match counts and rejection reasons at a glance, no API spelunking.
  if (sub === 'staging') {
    if (!CONFIG.GRAB_IMPORT_PATH) return interaction.reply({ content: '❌ Staging isn\'t configured (`GRAB_IMPORT_PATH`).', ephemeral: true });
    const target = interaction.options.getString('target') || 'sonarr';
    const arr = arrForMediaType(target === 'radarr' ? 'movie' : 'tv');
    if (!arr.url) return interaction.reply({ content: `❌ ${arr.label} isn't configured.`, ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const preview = await axios.get(`${arr.url}/api/v3/manualimport`, {
        params: { folder: CONFIG.GRAB_IMPORT_PATH, filterExistingFiles: false }, headers: { 'X-Api-Key': arr.key }, timeout: 120000,
      }).then(r => r.data || []);
      if (!preview.length) return interaction.editReply(`Staging looks empty to ${arr.label} — nothing at \`${CONFIG.GRAB_IMPORT_PATH}\`.`);
      const byFolder = new Map();
      for (const f of preview) {
        const rel = f.relativePath || f.path || '';
        const folder = rel.includes('/') ? rel.split('/')[0] : '(loose files)';
        const b = byFolder.get(folder) || { files: 0, matched: 0, reasons: new Map() };
        b.files++;
        if (target === 'radarr' ? f.movie : f.series) b.matched++;
        for (const rej of (f.rejections || [])) b.reasons.set(rej.reason, (b.reasons.get(rej.reason) || 0) + 1);
        byFolder.set(folder, b);
      }
      const lines = [...byFolder.entries()].map(([folder, b]) => {
        const rej = [...b.reasons.entries()].map(([r, n]) => `${r} ×${n}`).join('; ');
        const verdict = !b.reasons.size && b.matched === b.files ? '✅ importable' : rej ? `⚠️ ${rej}` : '⚠️ some files unmatched';
        return `**${folder.slice(0, 80)}** — ${b.files} file(s), ${b.matched} matched\n${verdict}`;
      });
      return interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO)
        .setTitle(`🩺 Staging Report (${arr.label})`)
        .setDescription(`${lines.join('\n\n')}\n\n✅ folders import with \`/rtorrent import\`; "Unknown Series" needs the series added/matched in ${arr.label}; "Invalid season or episode" usually means the series type or numbering doesn't fit (try Series Type: Anime for absolute-numbered dramas); already-imported leftovers show as matched with no rejections.`.slice(0, 4000))] });
    } catch (err) {
      return interaction.editReply(`❌ ${arr.label} manual-import preview failed: ${err.message}`);
    }
  }

  // sub === 'adopted'
  await interaction.deferReply({ ephemeral: true });
  const jobs = listAdoptedGrabJobs(15);
  const ignored = listAdoptIgnored();
  const lines = [];
  lines.push(jobs.length ? '**Adopted jobs:**' : 'No adopted jobs yet — `/rtorrent adopt search:"..."` starts one.');
  for (const j of jobs) lines.push(`• #${j.id} **${String(j.title).slice(0, 100)}** — ${j.state}${j.error ? ` (${String(j.error).slice(0, 80)})` : ''}`);
  if (ignored.length) {
    lines.push('', '**Ignored torrents:**');
    for (const ig of ignored.slice(0, 10)) lines.push(`• ${ig.name ? String(ig.name).slice(0, 100) : ig.infoHash}`);
  }
  return interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO).setTitle('🧲 Adopted Torrents').setDescription(lines.join('\n').slice(0, 4000))] });
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
// ---- Plex Home staging commands ----

// /stage <title>: the verb the stack doesn't have. Overseerr can't request what's already
// Available and Plex won't copy between servers — the bot resolves the path and queues an
// rclone copy into the PH cache, then DMs the requester when it's warm.
async function handleStageCommand(interaction) {
  if (!stagingConfigured()) return interaction.reply({ content: '❌ Staging isn\'t configured — set `STAGING_ENABLED=true` and `STAGE_RCLONE_REMOTE`.', ephemeral: true });
  if (!getUserByDiscordId(interaction.user.id)) return interaction.reply({ content: '❌ You must be linked first.', ephemeral: true });
  if (!isAdminInteraction(interaction) && !takeRateLimit(stageCommandLimits, interaction.user.id, CONFIG.STAGE_MAX_PER_USER_PER_DAY, 24 * 3600000)) {
    return interaction.reply({ content: `❌ You've hit the staging limit (${CONFIG.STAGE_MAX_PER_USER_PER_DAY}/day) — the uplink to the travel server only moves so fast. Try again tomorrow.`, ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  const raw = interaction.options.getString('title').trim();
  const library = await getStageLibrary().catch(() => []);
  let entry = null;
  if (/^(tmdb|tvdb):\d+$/.test(raw)) {
    entry = library.find(e => e.mediaId === raw) || { mediaId: raw, kind: raw.startsWith('tvdb:') ? 'tv' : 'movie', title: raw, sizeBytes: 0 };
  } else {
    const q = raw.toLowerCase();
    entry = library.find(e => e.title.toLowerCase() === q) || library.find(e => e.title.toLowerCase().includes(q));
  }
  if (!entry) return interaction.editReply(`❌ Nothing in the library matches **${raw}** — start typing and pick from the suggestions. (Not downloaded yet? Use \`/request\` first.)`);
  if (getStagedItem(entry.mediaId)) return interaction.editReply(`🔥 **${entry.title}** is already warm in the travel cache — it should play instantly.`);

  const { duplicate, job } = enqueueStageJob({ mediaId: entry.mediaId, mediaType: entry.kind, title: entry.title, discordId: interaction.user.id, origin: 'command' });
  if (duplicate) {
    return interaction.editReply(`⏳ **${entry.title}** is already ${job.status === 'copying' ? 'copying to the travel server right now' : 'in the staging queue'} — you'll get a DM when it's ready.`);
  }
  const ahead = listActiveStageJobs().filter(j => j.id < job.id).length;
  audit('stage_requested', { actorDiscordId: interaction.user.id, mediaId: entry.mediaId, title: entry.title, sizeBytes: entry.sizeBytes });
  pumpStageQueue().catch(() => {});
  await interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO)
    .setTitle(`📦 Staging — ${entry.title}`)
    .setDescription(`Copying **${entry.title}**${entry.sizeBytes ? ` (${fmtSpace(entry.sizeBytes)})` : ''} to the travel server${ahead ? ` — ${ahead} job(s) ahead in the queue` : ' now'}.\nThe link is slow across the ocean, so this can take a while — you'll get a DM the moment it's warm. 🔥`)] });
}

// /staged: what's warm, what's pinned, what's copying, and how much cache is left.
async function handleStagedCommand(interaction) {
  if (!stagingConfigured()) return interaction.reply({ content: '❌ Staging isn\'t configured.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const items = listStagedItems();
  const jobs = listActiveStageJobs();
  const cache = await getCacheStatus(items);

  const itemLine = i => `${i.pinned ? '📌' : '🎞️'} **${i.title}** — ${fmtSpace(i.size_bytes)}${i.last_streamed_at ? ` · watched ${discordTimestamp(i.last_streamed_at)}` : ''}`;
  const jobLine = j => j.status === 'copying'
    ? `📥 **${j.title}** — copying${j.started_at ? ` since ${discordTimestamp(j.started_at)}` : ''}`
    : `⏳ **${j.title}** — queued`;
  const cacheLine = cache.freeBytes == null
    ? '⚠️ Free space unknown (`rclone about` unsupported and no `STAGE_CACHE_MAX_GB` budget set)'
    : `${fmtSpace(cache.freeBytes)} free${cache.totalBytes ? ` of ${fmtSpace(cache.totalBytes)}` : ''}${cache.source === 'budget' ? ' (budget estimate)' : ''} · ${fmtSpace(cache.usedByCache)} in ${items.length} staged title(s)`;

  const embed = brandedEmbed(COLORS.INFO)
    .setTitle('🧳 Travel Server Cache')
    .addFields(
      { name: 'Cache', value: cacheLine, inline: false },
      { name: `Warm (${items.length})`, value: items.length ? items.sort((a, b) => (b.pinned - a.pinned) || (b.staged_at || 0) - (a.staged_at || 0)).map(itemLine).join('\n').slice(0, 1024) : 'Nothing staged yet — `/stage` a title.', inline: false },
      { name: `Staging queue (${jobs.length})`, value: jobs.length ? jobs.map(jobLine).join('\n').slice(0, 1024) : 'Idle.', inline: false },
    );
  if (CONFIG.PH_TUNNEL_HEALTH_URL) {
    const state = getSetting('ph_tunnel_state') || 'unknown';
    const since = Number(getSetting('ph_tunnel_since') || '0');
    embed.addFields({ name: 'Tunnel', value: `${state === 'up' ? '✅ up' : state === 'down' ? '❌ down' : '❔ not checked yet'}${since ? ` since ${discordTimestamp(since)}` : ''}`, inline: false });
  }
  await interaction.editReply({ embeds: [embed] });
}

// /pin and /unpin: LRU has no idea the same six movies get rewatched weekly. Anyone linked can
// pin; unpin needs the pinner, the stager, or an admin (a pin is someone's promise to themselves).
async function handlePinCommand(interaction, pin) {
  if (!stagingConfigured()) return interaction.reply({ content: '❌ Staging isn\'t configured.', ephemeral: true });
  if (!getUserByDiscordId(interaction.user.id)) return interaction.reply({ content: '❌ You must be linked first.', ephemeral: true });
  const raw = interaction.options.getString('title').trim();
  const items = listStagedItems();
  const item = items.find(i => i.media_id === raw)
    || items.find(i => String(i.title || '').toLowerCase() === raw.toLowerCase())
    || items.find(i => String(i.title || '').toLowerCase().includes(raw.toLowerCase()));
  if (!item) return interaction.reply({ content: `❌ **${raw}** isn't in the travel cache — only staged titles can be ${pin ? 'pinned' : 'unpinned'}.`, ephemeral: true });
  if (pin && item.pinned) return interaction.reply({ content: `📌 **${item.title}** is already pinned${item.pinned_by_discord_id ? ` (by <@${item.pinned_by_discord_id}>)` : ''}.`, ephemeral: true });
  if (!pin && !item.pinned) return interaction.reply({ content: `ℹ️ **${item.title}** isn't pinned.`, ephemeral: true });
  if (!pin && ![item.pinned_by_discord_id, item.staged_by_discord_id].includes(interaction.user.id) && !isAdminInteraction(interaction)) {
    return interaction.reply({ content: `❌ Only the person who pinned it${item.pinned_by_discord_id ? ` (<@${item.pinned_by_discord_id}>)` : ''} or an admin can unpin **${item.title}**.`, ephemeral: true });
  }
  setStagedItemPinned(item.media_id, pin, interaction.user.id);
  audit(pin ? 'staged_item_pinned' : 'staged_item_unpinned', { actorDiscordId: interaction.user.id, mediaId: item.media_id, title: item.title });
  return interaction.reply({ content: pin
    ? `📌 Pinned **${item.title}** — it's exempt from cache eviction until unpinned.`
    : `📍 Unpinned **${item.title}** — it's back in the normal eviction rotation.`, ephemeral: true });
}

// /stage-bulk: seed the cache while still on LAN at gigabit — feed it a list, arrive with a
// warm server instead of an empty one. Admin-only; results land in /staged, not a DM storm.
async function handleStageBulkCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  if (!stagingConfigured()) return interaction.reply({ content: '❌ Staging isn\'t configured.', ephemeral: true });
  const modal = new ModalBuilder()
    .setCustomId('stage_bulk_modal')
    .setTitle('Bulk Stage Titles')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('titles')
        .setLabel('One title per line (max 50)')
        .setPlaceholder('Inception\nSpirited Away\nBluey')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000),
    ));
  return interaction.showModal(modal);
}

async function handleStageBulkModal(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const lines = String(interaction.fields.getTextInputValue('titles') || '')
    .split('\n').map(l => l.trim()).filter(Boolean).slice(0, 50);
  const library = await getStageLibrary().catch(() => []);
  const queued = []; const warm = []; const missing = [];
  for (const line of lines) {
    const q = line.toLowerCase();
    const entry = library.find(e => e.title.toLowerCase() === q) || library.find(e => e.title.toLowerCase().includes(q));
    if (!entry) { missing.push(line); continue; }
    if (getStagedItem(entry.mediaId)) { warm.push(entry.title); continue; }
    const { duplicate } = enqueueStageJob({ mediaId: entry.mediaId, mediaType: entry.kind, title: entry.title, discordId: interaction.user.id, origin: 'bulk' });
    if (!duplicate) queued.push(`${entry.title} (${fmtSpace(entry.sizeBytes)})`);
  }
  audit('stage_bulk_enqueued', { actorDiscordId: interaction.user.id, queued: queued.length, alreadyWarm: warm.length, missing });
  pumpStageQueue().catch(() => {});
  await interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO)
    .setTitle('📦 Bulk Stage Queued')
    .setDescription([
      queued.length ? `**Queued (${queued.length}):**\n${queued.map(t => `• ${t}`).join('\n')}` : '**Queued:** nothing new',
      warm.length ? `**Already warm (${warm.length}):** ${warm.join(', ')}` : null,
      missing.length ? `**Not in the library (${missing.length}):** ${missing.join(', ')} — \`/request\` these first` : null,
      'Track progress with `/staged`.',
    ].filter(Boolean).join('\n\n').slice(0, 4000))] });
}

// /assign-server: Plex never syncs watch state between servers, so each person belongs to
// exactly one. This drives invite scoping and MEDIA_AVAILABLE auto-staging.
async function handleAssignServerCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const target = interaction.options.getUser('user');
  const server = interaction.options.getString('server', true);
  const row = getUserByDiscordId(target.id);
  if (!row) return interaction.reply({ content: `⚠️ ${target.tag} isn't in the DB — \`/link\` them first.`, ephemeral: true });
  if ((row.home_server || 'primary') === server) return interaction.reply({ content: `ℹ️ ${target.tag} is already on **${server}**.`, ephemeral: true });
  setUserHomeServer(target.id, server);
  audit('user_home_server_changed', { actorDiscordId: interaction.user.id, targetDiscordId: target.id, from: row.home_server || 'primary', to: server });
  const notes = [
    `✅ ${target.tag} is now a **${server}** user${server === 'ph' ? ' — their finished-request titles will auto-stage to the travel cache' : ''}.`,
  ];
  if (row.invited) {
    notes.push(`⚠️ They were already invited under the old assignment. Send a fresh invite to the ${server === 'ph' ? 'PH box' : 'primary'} with \`/reinvite\`, and remove their share on the old server from plex.tv if they shouldn't keep it (watch state doesn't sync between servers).`);
  }
  return interaction.reply({ content: notes.join('\n'), ephemeral: true });
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
  if (stagingConfigured()) {
    userCommands.splice(2, 0,
      '`/stage` — Copy a title to the travel server so it plays instantly there',
      '`/staged` — See what\'s warm in the travel cache (and what\'s copying)',
      '`/pin` / `/unpin` — Protect a cached title from automatic eviction');
  }
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
      '`/tier` — Regional tiering: preview/apply per-node edge-cache plans',
      '`/tier-node` — Manage the tiering node registry (capacity, access mode, demand source)',
      '`/tier-member` — Manage a restricted node\'s member set',
    ];
    if (grabConfigured()) {
      adminCommands.push('`/avistaz` — Search AvistaZ directly and send a release to the seedbox');
    }
    if (rtorrentConfigured()) {
      adminCommands.push('`/rtorrent` — Inspect seedbox torrents and adopt existing ones into the pipeline');
    }
    if (stagingConfigured()) {
      adminCommands.push(
        '`/stage-bulk` — Seed the travel cache from a list of titles',
        '`/assign-server` — Set a user\'s home server (primary / ph)');
    }
    embed.addFields({ name: 'Admin commands', value: adminCommands.join('\n'), inline: false });
  }
  await interaction.reply({ embeds: [embed], ephemeral: true });
}
// ---- Regional tiering ("edge cache") ----
// The planner itself lives in src/tier.js (Discord-free, DB-free); this block feeds it real
// data (node registry, per-node Tautulli history, agent atime reports, member requests,
// keep list, previous plans) and turns the result into embeds / published manifests.

function tierKeepListIds() {
  return db.prepare('SELECT DISTINCT media_id FROM keep_list WHERE expires_at IS NULL OR expires_at > ?').all(Date.now()).map(r => r.media_id);
}

async function buildTierPlans() {
  const nodes = listTierNodes();
  const enabled = nodes.filter(n => n.enabled);
  if (!enabled.length) return { manifests: {}, warnings: ['No enabled tier nodes — add one with `/tier-node add`.'], nodes };
  const inventory = await fetchTierInventory({
    sources: arrSources(),
    remap: remapPath,
    sourceRoot: CONFIG.TIER_SOURCE_ROOT,
    onError: (s, err) => audit('external_api_error', { provider: s.label, error: err.message, action: 'tier_inventory' }),
  });
  const historiesByNode = await gatherNodeHistories(enabled, {
    fetchHistory,
    fetchPlexHistory,
    afterDays: CONFIG.TIER_HISTORY_DAYS,
    onError: (n, err) => audit('external_api_error', { provider: `${n.demand_source}:${n.name}`, error: err.message, action: 'tier_history' }),
  });
  const atimeReports = {};
  const memberRequests = {};
  const prevPlans = {};
  for (const n of enabled) {
    if (n.demand_source === 'atime') atimeReports[n.name] = listTierNodeFiles(n.name);
    if (n.access === 'restricted') {
      memberRequests[n.name] = listRequestsByRequesters(listTierNodeMembers(n.name), CONFIG.TIER_REQUEST_GRACE_DAYS);
    }
    const prev = getTierPlan(n.name);
    if (prev) prevPlans[n.name] = prev;
  }
  const result = planTier({
    nodes,
    inventory,
    historiesByNode,
    atimeReports,
    memberRequests,
    keepListIds: tierKeepListIds(),
    neverDeleteIds: CONFIG.NEVER_DELETE_MEDIA_IDS,
    prevPlans,
    config: {
      coreTopK: CONFIG.TIER_CORE_TOP_K,
      halfLifeDays: CONFIG.TIER_HALF_LIFE_DAYS,
      warmDays: CONFIG.TIER_WARM_DAYS,
      freshDays: CONFIG.TIER_FRESH_DAYS,
      requestGraceDays: CONFIG.TIER_REQUEST_GRACE_DAYS,
    },
  });
  return { ...result, nodes, prevPlans };
}

function tierManifestField(node, m, prevPlan) {
  const free = Math.max(0, (node.usable_bytes || 0) - m.stats.keepBytes);
  const lines = [
    `Keep: **${m.stats.keepCount}** titles · ${fmtSpace(m.stats.keepBytes)}`,
    `Drop: **${m.stats.dropCount}** titles · ${fmtSpace(m.stats.dropBytes)}`,
    `Budget ${fmtSpace(m.stats.budgetBytes)} → ${fmtSpace(free)} free of ${fmtSpace(node.usable_bytes || 0)}`,
  ];
  if (m.full) lines.push('🔒 Full master — never pruned');
  if (prevPlan) {
    const prevKeep = new Set(prevPlan.keepMediaIds || []);
    const nowKeep = m.keep.map(e => e.mediaId);
    const added = nowKeep.filter(id => !prevKeep.has(id)).length;
    const removed = [...prevKeep].filter(id => !nowKeep.includes(id)).length;
    lines.push(prevPlan.planHash === m.planHash
      ? 'No change vs applied plan'
      : `Δ vs applied: +${added} / −${removed} titles`);
  } else lines.push('No plan applied yet');
  if (m.forceKept.length) lines.push(`⚠️ ${m.forceKept.length} force-kept (no full-node copy)`);
  return { name: `${m.full ? '🏠' : '📦'} ${m.node} (${m.access}, ${m.demandSource})`, value: lines.join('\n'), inline: false };
}

async function handleTierCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const sub = interaction.options.getSubcommand();
  const only = interaction.options.getString('node')?.toLowerCase() || null;
  await interaction.deferReply({ ephemeral: true });
  let plans;
  try {
    plans = await buildTierPlans();
  } catch (err) {
    return interaction.editReply(`❌ Planning failed: ${err.message}`);
  }
  let names = Object.keys(plans.manifests);
  if (only) names = names.filter(n => n === only);
  if (!names.length) {
    return interaction.editReply(only
      ? `❌ No plan for node \`${only}\` — is it registered and enabled? (\`/tier-node list\`)`
      : `❌ Nothing to plan.\n${(plans.warnings || []).map(w => `• ${w}`).join('\n')}`);
  }

  if (sub === 'apply') {
    for (const name of names) {
      const m = plans.manifests[name];
      const stignore = renderSyncthingStignore(m);
      setSetting(`tier_manifest:${name}`, JSON.stringify({ ...m, stignore, rcloneFilesFrom: m.transport === 'rclone' ? renderRclone(m) : undefined }));
      setTierPlan(name, { planHash: m.planHash, keepMediaIds: m.keep.map(e => e.mediaId), appliedAt: Date.now() });
      audit('tier_plan_applied', { actorDiscordId: interaction.user.id, node: name, planHash: m.planHash, keepCount: m.stats.keepCount, dropCount: m.stats.dropCount, dropBytes: m.stats.dropBytes });
    }
  }

  const embed = brandedEmbed(sub === 'apply' ? COLORS.SUCCESS : COLORS.INFO)
    .setTitle(sub === 'apply' ? '🗺️ Tier Plans Published' : '🗺️ Tier Preview (dry run — nothing written)')
    .setDescription(sub === 'apply'
      ? 'Manifests are live at `/agent/manifest/:node` — each node\'s sync agent converges on its next run (ignore-first, then prune).'
      : 'What `/tier apply` would publish. Drops only ever remove edge copies — every title stays on a full master.');
  for (const name of names.slice(0, 12)) {
    embed.addFields(tierManifestField(plans.nodes.find(n => n.name === name), plans.manifests[name], plans.prevPlans?.[name]));
  }
  if (plans.warnings?.length) embed.addFields({ name: '⚠️ Warnings', value: plans.warnings.slice(0, 8).map(w => `• ${w}`).join('\n').slice(0, 1024), inline: false });
  return interaction.editReply({ embeds: [embed] });
}

async function handleTierNodeCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const nodes = listTierNodes();
    if (!nodes.length) return interaction.reply({ content: 'No tier nodes yet — `/tier-node add name:<node>` creates one.', ephemeral: true });
    const lines = nodes.map(n => {
      const members = n.access === 'restricted' ? ` · ${listTierNodeMembers(n.name).length} member(s)` : '';
      const plan = getTierPlan(n.name);
      return `${n.enabled ? '🟢' : '⚫'} **${n.name}** — ${fmtSpace(n.usable_bytes || 0)}, headroom ${n.headroom_pct}%${n.full ? ', **full master**' : ''}${n.sticky ? ', sticky' : ''} · ${n.access}/${n.demand_source}/${n.transport}${members}${plan ? ` · plan \`${plan.planHash}\`` : ' · no plan applied'}`;
    });
    return interaction.reply({ embeds: [brandedEmbed(COLORS.INFO).setTitle('📦 Tier Nodes').setDescription(lines.join('\n').slice(0, 4000))], ephemeral: true });
  }

  const name = interaction.options.getString('name', true).toLowerCase();

  if (sub === 'enable' || sub === 'disable') {
    if (!getTierNode(name)) return interaction.reply({ content: `❌ Unknown node \`${name}\`.`, ephemeral: true });
    setTierNodeEnabled(name, sub === 'enable');
    audit('tier_node_toggled', { actorDiscordId: interaction.user.id, node: name, enabled: sub === 'enable' });
    return interaction.reply({ content: sub === 'enable' ? `✅ Node \`${name}\` enabled — it joins the next plan.` : `✅ Node \`${name}\` disabled — the planner skips it entirely (no manifest, no pins, history excluded from the universal core).`, ephemeral: true });
  }

  if (sub === 'token') {
    if (!getTierNode(name)) return interaction.reply({ content: `❌ Unknown node \`${name}\` — add it first.`, ephemeral: true });
    const raw = setTierAgentToken(name);
    audit('tier_agent_token_rotated', { actorDiscordId: interaction.user.id, node: name });
    return interaction.reply({ content: `🔑 Agent token for \`${name}\` (shown once, replaces any previous token):\n\`\`\`\n${raw}\n\`\`\`\nSet it as \`TIER_AGENT_TOKEN\` on that node's sync agent.`, ephemeral: true });
  }

  // sub === 'add' (also edits an existing node — only supplied options change)
  const usableGb = interaction.options.getInteger('usable_gb');
  const fields = { name };
  if (usableGb != null) fields.usable_bytes = usableGb * 1024 ** 3;
  for (const [opt, col] of [['headroom_pct', 'headroom_pct'], ['warm_days', 'warm_days'], ['fresh_days', 'fresh_days']]) {
    const v = interaction.options.getInteger(opt);
    if (v != null) fields[col] = v;
  }
  for (const opt of ['access', 'demand_source', 'transport', 'folder_root', 'tautulli_url', 'tautulli_api_key', 'plex_url', 'plex_token', 'atime_mask']) {
    const v = interaction.options.getString(opt);
    if (v != null) fields[opt] = v;
  }
  if (fields.atime_mask !== undefined && fields.atime_mask !== '' && !parseAtimeMask(fields.atime_mask)) {
    return interaction.reply({ content: `❌ \`atime_mask\` must be a UTC time window like \`09:00-13:00\` (may wrap midnight). Got \`${fields.atime_mask}\`.`, ephemeral: true });
  }
  for (const opt of ['full', 'sticky']) {
    const v = interaction.options.getBoolean(opt);
    if (v != null) fields[opt] = v;
  }
  const { created, node } = upsertTierNode(fields);
  audit('tier_node_upserted', { actorDiscordId: interaction.user.id, node: name, created, fields: Object.keys(fields) });
  const embed = brandedEmbed(COLORS.SUCCESS)
    .setTitle(created ? `📦 Node Added: ${name}` : `📦 Node Updated: ${name}`)
    .setDescription([
      `Capacity **${fmtSpace(node.usable_bytes || 0)}**, headroom **${node.headroom_pct}%** → budget ${fmtSpace(Math.floor((node.usable_bytes || 0) * (1 - node.headroom_pct / 100)))}`,
      `Access **${node.access}** · demand **${node.demand_source}** · transport **${node.transport}**${node.full ? ' · **full master**' : ''}${node.sticky ? ' · sticky' : ''}`,
      node.folder_root ? `Folder root \`${node.folder_root}\`` : '⚠️ No `folder_root` set — the agent needs it.',
      node.demand_source === 'tautulli' && !node.tautulli_url ? '⚠️ No Tautulli configured — this node contributes no demand signal (floor + pins only).' : null,
      node.demand_source === 'plex' && !node.plex_url ? '⚠️ `demand_source` is plex but no `plex_url`/`plex_token` set — this node contributes no demand signal until they are.' : null,
      node.demand_source === 'atime' && node.atime_mask ? `atime mask \`${node.atime_mask}\` UTC — reads in that window are treated as Plex maintenance, not watches.` : null,
      node.demand_source === 'atime' && !node.atime_mask ? '💡 Tip: if Plex scheduled tasks read files nightly on this node, set `atime_mask` to that window (UTC) or they will count as watches.' : null,
      created ? `Next: \`/tier-node token name:${name}\` for the agent, then \`/tier preview\`.` : null,
    ].filter(Boolean).join('\n'));
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleTierMemberCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const sub = interaction.options.getSubcommand();
  const nodeName = interaction.options.getString('node', true).toLowerCase();
  const node = getTierNode(nodeName);
  if (!node) return interaction.reply({ content: `❌ Unknown node \`${nodeName}\`.`, ephemeral: true });
  if (node.access !== 'restricted') {
    return interaction.reply({ content: `❌ \`${nodeName}\` is an **open** node — membership doesn't apply (any linked user may stream; its own watch history defines its audience). Use \`/tier-node add name:${nodeName} access:restricted\` first if you mean to close it.`, ephemeral: true });
  }
  if (sub === 'list') {
    const members = listTierNodeMembers(nodeName);
    return interaction.reply({ content: members.length ? `Members of \`${nodeName}\` (${members.length}):\n${members.map(id => `• <@${id}>`).join('\n')}` : `\`${nodeName}\` has no members yet — it curates on demand + core only until you add some.`, ephemeral: true, allowedMentions: { parse: [] } });
  }
  const user = interaction.options.getUser('user', true);
  if (sub === 'add') {
    const added = addTierNodeMember(nodeName, user.id);
    audit('tier_member_added', { actorDiscordId: interaction.user.id, targetDiscordId: user.id, node: nodeName });
    return interaction.reply({ content: added ? `✅ <@${user.id}> added to \`${nodeName}\` — their requests now pin there for ${CONFIG.TIER_REQUEST_GRACE_DAYS} days.` : `<@${user.id}> is already a member of \`${nodeName}\`.`, ephemeral: true, allowedMentions: { parse: [] } });
  }
  const removed = removeTierNodeMember(nodeName, user.id);
  audit('tier_member_removed', { actorDiscordId: interaction.user.id, targetDiscordId: user.id, node: nodeName });
  return interaction.reply({ content: removed ? `✅ <@${user.id}> removed from \`${nodeName}\`.` : `<@${user.id}> wasn't a member of \`${nodeName}\`.`, ephemeral: true, allowedMentions: { parse: [] } });
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

  if (['plex_approve', 'plex_deny', 'overseerr_approve', 'overseerr_deny', 'request_approve', 'request_approve_az', 'request_deny', 'pm_retry', 'pm_clear', 'pm_ignore', 'pm_clearstuck', 'pm_clearfinished', 'grab_dl', 'grab_cancel', 'grab_retry', 'adopt_do', 'adopt_bulk', 'adopt_cancel'].includes(action) && !isAdminInteraction(interaction)) {
    return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
  }

  if (action === 'plex_approve') {
    const targetDiscordId = parts[0];
    await interaction.deferUpdate();
    const user = getUserByDiscordId(targetDiscordId);
    if (!user) return interaction.editReply({ content: 'User not found.', components: [] });
    let plexStatus = 'failed'; let overseerrStatus = 'failed'; let plexOk = false;
    try { const result = await inviteUserToPlex(user.email, { homeServer: homeServerFor(targetDiscordId) }); markUserInvited(targetDiscordId); plexOk = result.successCount > 0; plexStatus = `ok (${result.successCount}/${result.total})`; } catch (err) { audit('external_api_error', { provider: 'plex', error: err.message, targetDiscordId }); }
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
  // Seerr insta-approves it, which is correct since an admin just did approve it. The _az
  // variant additionally pre-authorizes the AvistaZ fallback for the escalation watchdog.
  if (action === 'request_approve') return handleGateApprove(interaction, parts[0], { azPreAuth: false });
  if (action === 'request_approve_az') return handleGateApprove(interaction, parts[0], { azPreAuth: true });
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

  // AvistaZ escalation buttons (from the escalation watchdog's "nothing found yet" alerts).
  if (['escalate_az', 'escalate_ignore'].includes(action)) {
    if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const row = getEscalationById(Number(parts[0]));
    // 'error' stays clickable so a failed escalation (e.g. tag created after the fact) can be retried.
    if (!row || !['alerted', 'watching', 'error'].includes(row.state)) {
      return interaction.update({ content: 'ℹ️ Already handled (escalated, resolved, or dismissed).', components: [] });
    }
    if (action === 'escalate_ignore') {
      setEscalationState(row.id, 'ignored');
      audit('escalation_ignored', { actorDiscordId: interaction.user.id, mediaId: row.media_id, title: row.title });
      return interaction.update({ embeds: [brandedEmbed(COLORS.INFO)
        .setTitle(`🙈 Not Escalating — ${row.title}`)
        .setDescription(`Dismissed by <@${interaction.user.id}>. Public indexers keep trying on the arrs' own schedule; no AvistaZ.`)], components: [] });
    }
    await interaction.deferUpdate();
    const result = await runEscalation(row);
    audit('escalation_button', { actorDiscordId: interaction.user.id, mediaId: row.media_id, title: row.title, ok: result.ok, reason: result.reason || null });
    if (result.ok) {
      return interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS)
        .setTitle(`🔐 Escalated to AvistaZ — ${row.title}`)
        .setDescription(`Escalated by <@${interaction.user.id}>.\n${result.detail}`)], components: [] });
    }
    // Keep the buttons (omit components) so the admin can retry after fixing the cause.
    return interaction.followUp({ content: `❌ Escalation failed: ${result.why} The buttons still work — try again once that's fixed.`, ephemeral: true });
  }

  // "Add to Sonarr/Radarr & Search" (from the request-never-landed alert): add the title
  // directly to the arr, bypassing Seerr's broken metadata. The watch row stays 'watching'
  // with a fresh clock, so public indexers get the full delay before any AvistaZ fallback.
  if (action === 'arrfix_add') {
    if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const row = getEscalationById(Number(parts[0]));
    if (!row || !['watching', 'alerted', 'error'].includes(row.state)) {
      return interaction.update({ content: 'ℹ️ Already handled (escalated, resolved, or dismissed).', components: [] });
    }
    await interaction.deferUpdate();
    const result = await addMediaToArr({ mediaType: row.media_type, tmdbId: row.tmdb_id, tvdbId: row.tvdb_id, tagLabel: row.pre_authorized ? CONFIG.AVISTAZ_TAG : null });
    audit('arr_direct_add_button', { actorDiscordId: interaction.user.id, mediaId: row.media_id, title: row.title, ok: result.ok, reason: result.reason || null });
    if (result.ok) {
      touchEscalationApprovedAt(row.id);
      const arrName = row.media_type === 'movie' ? 'Radarr' : 'Sonarr';
      return interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS)
        .setTitle(`🛠️ Added Directly to ${arrName} — ${row.title}`)
        .setDescription(`${result.detail}\nAdded by <@${interaction.user.id}>. Public indexers get ${escalationDelayLabel()} first; the AvistaZ fallback ${row.pre_authorized ? 'is pre-authorized and fires automatically' : 'will ask before firing'} if nothing lands.`)], components: [] });
    }
    const why = {
      arr_not_configured: 'that arr isn\'t configured',
      no_root_folder: 'the arr reports no root folders',
      no_quality_profile: 'no quality profile matched (check the *_QUALITY_PROFILE config)',
      no_tvdb_id: 'no TVDB id could be resolved for this show — find it on thetvdb.com and add it in Sonarr by hand',
      lookup_empty: 'the arr\'s metadata lookup returned nothing for this id — add it in the arr UI by hand (search by name; the show may be listed under a different title there)',
    }[result.reason] || `API error: ${String(result.reason || '').replace(/^api_error:/, '')}`;
    return interaction.followUp({ content: `❌ Couldn't add it: ${why}. The buttons still work — try again once that's fixed.`, ephemeral: true });
  }

  // Guided-import wizard buttons (from the Sonarr decline alert).
  if (['mapimp_start', 'mapimp_find', 'mapimp_cancel', 'mapimp_go'].includes(action)) {
    if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const nonce = parts[0];
    const state = readMapOffer(nonce);
    if (!state) return interaction.update({ content: 'ℹ️ This mapping session expired (or already finished).', embeds: [], components: [] });
    if (action === 'mapimp_cancel') {
      dropMapOffer(nonce);
      return interaction.update({ content: null, components: [], embeds: [brandedEmbed(COLORS.INFO)
        .setTitle(`🧭 Mapping Cancelled — ${state.title}`.slice(0, 256))
        .setDescription(`The files stay in staging. Re-run \`/rtorrent import target:sonarr folder:${String(state.folder).slice(0, 80)}\` for another try, or use Sonarr's Manual Import screen.`)] });
    }
    if (action === 'mapimp_find') {
      return interaction.showModal(new ModalBuilder()
        .setCustomId(`mapimp_findm:${nonce}`)
        .setTitle('Find the series in Sonarr')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('series_query').setLabel('Series name (as Sonarr knows it)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80))));
    }
    await interaction.deferUpdate();
    if (action === 'mapimp_start') return interaction.editReply(await mapWizardSeriesStep(nonce, state));
    // action === 'mapimp_go'
    if (!state.pairs?.length || state.seriesId == null) return interaction.editReply(await mapWizardSeriesStep(nonce, state));
    return mapWizardImport(interaction, nonce, state);
  }

  // AvistaZ candidate buttons (from /avistaz search or an escalation post). The offer is
  // consumed on click — a second click on the same message just reports "already handled".
  if (action === 'grab_dl') {
    const offer = takeGrabOffer(parts[0]);
    if (!offer) return interaction.update({ content: 'ℹ️ Already handled (or expired).', components: [] });
    const candidate = offer.candidates?.[Number(parts[1])];
    if (!candidate) return interaction.update({ content: 'ℹ️ That option no longer exists.', components: [] });
    const allowance = grabDailyAllowance();
    if (allowance.exhausted) {
      restashGrabOffer(parts[0], offer);
      return interaction.reply({ content: `❌ Daily AvistaZ allowance is used up (${CONFIG.AVISTAZ_DAILY_GRAB_LIMIT}/day) — the buttons will work again tomorrow (UTC).`, ephemeral: true });
    }
    await interaction.deferUpdate();
    const result = await executeGrab(candidate, {
      mediaId: offer.mediaId || null, mediaType: offer.mediaType, title: offer.title,
      discordId: offer.discordId, origin: offer.origin || 'manual', actorDiscordId: interaction.user.id,
    });
    if (!result.ok) {
      if (result.dup) {
        return interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO)
          .setTitle(`ℹ️ Already Grabbed — ${offer.title}`)
          .setDescription(`**${candidate.releaseTitle}** is ${result.why}.`)], components: [] });
      }
      restashGrabOffer(parts[0], offer);
      return interaction.followUp({ content: `❌ Grab failed: ${result.why}\nThe buttons still work — try again once that's fixed.`, ephemeral: true });
    }
    const after = grabDailyAllowance();
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle(`🔐 Sent to Seedbox — ${offer.title}`)
      .setDescription(`**${candidate.releaseTitle}** (${fmtSpace(candidate.size)}) → rTorrent as \`${result.job.label}\`, picked by <@${interaction.user.id}>.\nI'll watch it, copy it home when it finishes, and hand it to ${offer.mediaType === 'movie' ? 'Radarr' : 'Sonarr'} for import.${after.limited ? `\nDownloads remaining today: **${after.remaining}**` : ''}`)], components: [] });
  }
  if (action === 'grab_cancel') {
    const offer = takeGrabOffer(parts[0]);
    if (!offer) return interaction.update({ content: 'ℹ️ Already handled (or expired).', components: [] });
    audit('avistaz_offer_cancelled', { actorDiscordId: interaction.user.id, title: offer.title });
    return interaction.update({ embeds: [brandedEmbed(COLORS.INFO)
      .setTitle(`🙈 Not Grabbing — ${offer.title}`)
      .setDescription(`Dismissed by <@${interaction.user.id}> — no AvistaZ download slot was spent.`)], components: [] });
  }
  if (action === 'grab_retry') {
    const job = getGrabJob(Number(parts[0]));
    if (!job) return interaction.update({ content: 'ℹ️ Job no longer exists.', components: [] });
    if (!requeueGrabTransfer(job.id)) return interaction.update({ content: `ℹ️ Job is ${job.state} — nothing to retry.`, components: [] });
    audit('avistaz_transfer_retried', { actorDiscordId: interaction.user.id, jobId: job.id, title: job.title });
    pumpGrabTransfers().catch(() => {});
    return interaction.update({ content: `🔁 Re-running the transfer for **${job.title}** (already-copied files are skipped).`, components: [] });
  }

  // rTorrent adoption buttons (from /rtorrent adopt or the discovery sweep). Same
  // consumed-offer pattern as grab_dl; the import target rides in the customId so a
  // blank-label torrent is only ever adopted through an explicit per-arr click.
  if (action === 'adopt_do') {
    const offer = takeGrabOffer(parts[0]);
    if (!offer) return interaction.update({ content: 'ℹ️ Already handled (or expired).', components: [] });
    const torrent = offer.candidates?.[Number(parts[1])];
    const target = ['sonarr', 'radarr'].includes(parts[2]) ? parts[2] : null;
    if (!torrent || !target) return interaction.update({ content: 'ℹ️ That option no longer exists.', components: [] });
    await interaction.deferUpdate();
    const result = await executeAdoption(torrent, target, {
      discordId: offer.discordId || interaction.user.id, origin: offer.origin || 'adopt', actorDiscordId: interaction.user.id,
    });
    if (!result.ok) {
      if (result.dup) {
        return interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO)
          .setTitle(`ℹ️ Already Tracked — ${String(torrent.name).slice(0, 200)}`.slice(0, 256))
          .setDescription(`This torrent is ${result.why}.`)], components: [] });
      }
      restashGrabOffer(parts[0], offer);
      return interaction.followUp({ content: `❌ Adoption failed: ${result.why}\nThe buttons still work — try again once that's fixed.`, ephemeral: true });
    }
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle(`🧲 Adopted — ${String(torrent.name).slice(0, 200)}`.slice(0, 256))
      .setDescription(result.state === 'complete'
        ? `Job #${result.job.id} created as **complete** by <@${interaction.user.id}> — transferring home now, then handed to ${target === 'sonarr' ? 'Sonarr' : 'Radarr'} for import. The torrent keeps seeding on the seedbox.`
        : `Job #${result.job.id} created as **downloading** (${adoptProgressPct(torrent)}%) by <@${interaction.user.id}> — I'll watch it and transfer + import via ${target === 'sonarr' ? 'Sonarr' : 'Radarr'} when it hits 100%.`)], components: [] });
  }
  if (action === 'adopt_bulk') {
    const offer = takeGrabOffer(parts[0]);
    if (!offer) return interaction.update({ content: 'ℹ️ Already handled (or expired).', components: [] });
    const target = ['sonarr', 'radarr'].includes(parts[1]) ? parts[1] : null;
    const candidates = offer.candidates || [];
    if (!target || !candidates.length) return interaction.update({ content: 'ℹ️ That option no longer exists.', components: [] });
    await interaction.deferUpdate();
    await interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO)
      .setTitle(`⏳ Adopting ${candidates.length} Torrents → ${target}`)
      .setDescription(`Started by <@${interaction.user.id}>. Verifying seedbox paths and creating jobs — a summary follows here when it's done.`)], components: [] });
    const outcome = await executeBulkAdoption(candidates, target, {
      discordId: offer.discordId || interaction.user.id, origin: offer.origin || 'adopt', actorDiscordId: interaction.user.id,
    });
    const lines = [
      `Adopted **${outcome.adopted}** of ${candidates.length} → ${target === 'sonarr' ? 'Sonarr' : 'Radarr'} (${outcome.complete} complete → transferring one at a time, ${outcome.downloading} watched until 100%).`,
    ];
    if (outcome.dup) lines.push(`Skipped ${outcome.dup} already tracked.`);
    if (outcome.failed.length) {
      lines.push('', `**${outcome.failed.length} failed:**`);
      for (const f of outcome.failed.slice(0, 8)) lines.push(`• ${String(f.name).slice(0, 80)} — ${String(f.why).slice(0, 220)}`);
      if (outcome.failed.length > 8) lines.push(`…and ${outcome.failed.length - 8} more (see the audit log).`);
      lines.push('Re-running the same `/rtorrent adopt` only offers what\'s still untracked.');
    }
    const summary = { embeds: [brandedEmbed(outcome.failed.length ? COLORS.WARN : COLORS.SUCCESS)
      .setTitle(`🧲 Bulk Adoption ${outcome.failed.length ? 'Finished With Failures' : 'Complete'}`)
      .setDescription(lines.join('\n').slice(0, 4000))], components: [] };
    // The interaction token dies after 15 min; a slow stat-fallback batch can outlive it,
    // so the summary falls back to a fresh channel message.
    return interaction.editReply(summary).catch(() => notifyChannel('downloads', summary));
  }
  if (action === 'adopt_cancel') {
    const offer = takeGrabOffer(parts[0]);
    if (!offer) return interaction.update({ content: 'ℹ️ Already handled (or expired).', components: [] });
    audit('rtorrent_adopt_dismissed', { actorDiscordId: interaction.user.id, count: offer.candidates?.length || 0 });
    return interaction.update({ embeds: [brandedEmbed(COLORS.INFO)
      .setTitle('🙈 Not Adopting')
      .setDescription(`Dismissed by <@${interaction.user.id}> — nothing was changed in rTorrent. \`/rtorrent ignore\` silences a torrent for good.`)], components: [] });
  }

  if (['stuck_retry', 'stuck_rm', 'stuck_ignore'].includes(action)) {
    if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    // groupKey may contain colons (`label:s:<seriesId>:<season>` for a consolidated season,
    // or `label:<queueId>` for a movie/lone item) — rejoin the split parts to recover it.
    const groupKey = parts.join(':');
    const itemName = interaction.message.embeds?.[0]?.description || 'this download';

    if (action === 'stuck_ignore') {
      setSetting(`stuck_ignore:${groupKey}`, '1');
      audit('stuck_download_ignored', { actorDiscordId: interaction.user.id, groupKey });
      return interaction.update({ embeds: [brandedEmbed(COLORS.INFO)
        .setTitle('🙈 Ignoring Stuck Download')
        .setDescription(`${itemName}\n\nNo more alerts for this while it stays in the queue.`)], components: [] });
    }

    await interaction.deferUpdate();
    const retry = action === 'stuck_retry';
    // Re-derive the group's members from the live queue so the buttons act on every episode in a
    // stuck season, even ones that entered the queue after the alert fired.
    const queue = await fetchArrQueues().catch(() => []);
    const targets = queue.filter(i => stuckGroupKey(i) === groupKey);
    if (!targets.length) {
      return interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO)
        .setTitle('ℹ️ Nothing Left to Remove')
        .setDescription(`${itemName}\n\nThese downloads already finished or left the queue.`)], components: [] });
    }
    let removed = 0;
    const failures = [];
    for (const t of targets) {
      try {
        await axios.delete(`${t.source.url}/api/v3/queue/${t.queueId}`, {
          params: { removeFromClient: true, blocklist: retry, skipRedownload: !retry },
          headers: { 'X-Api-Key': t.source.key },
          timeout: 15000,
        });
        removed++;
      } catch (err) {
        failures.push(err.message);
        audit('external_api_error', { provider: t.source.label, error: err.message, action: 'stuck_remove', queueId: t.queueId });
      }
    }
    audit('stuck_download_removed', { actorDiscordId: interaction.user.id, groupKey, removed, attempted: targets.length, blocklisted: retry });
    if (!removed) {
      return interaction.editReply({ embeds: [brandedEmbed(COLORS.DANGER)
        .setTitle('❌ Remove Failed')
        .setDescription(`${itemName}\n\n${failures[0] || 'Unknown error'}\n(They may have already finished or been removed.)`)], components: [] });
    }
    const plural = targets.length === 1 ? '' : 's';
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle(retry ? '🔁 Removed — Searching for Another Release' : '🗑️ Removed From Queue')
      .setDescription(`${itemName}\n\n${removed}/${targets.length} download${plural} removed${retry ? ' and blocklisted; a replacement search was triggered.' : ' without blocklisting; nothing new was grabbed.'}${failures.length ? `\n❌ ${failures.length} failed: ${failures.slice(0, 3).join('; ')}` : ''}`)], components: [] });
  }

  // PH cache eviction prompt (the travel-server twin of delete_yes/delete_no). Deliberately a
  // separate action pair: an evict button can never reach executeDeletion, and a stale delete
  // button can never purge the cache. customIds carry no title (`evict_yes:<mediaId>:<snowflake>`)
  // — it's re-read from staged_items so long titles can't blow Discord's 100-char limit.
  if (['evict_yes', 'evict_no'].includes(action)) {
    const requestorId = parts[parts.length - 1];
    const mediaId = parts.slice(0, -1).join(':');
    if (interaction.user.id !== requestorId && !isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Not allowed.', ephemeral: true });
    const staged = getStagedItem(mediaId);
    if (action === 'evict_no') {
      touchStagedItem(mediaId); // an explicit "keep" resets the LRU clock too
      audit('evict_decision_made', { actorDiscordId: interaction.user.id, mediaId, decision: 'keep_cached' });
      return interaction.update({ content: `🔥 Keeping **${staged?.title || 'this title'}** warm in the cache. Tip: \`/pin\` protects it from automatic eviction.`, components: [] });
    }
    if (!staged) return interaction.update({ content: 'ℹ️ Already evicted.', components: [] });
    if (staged.pinned) return interaction.reply({ content: '📌 This title is pinned — `/unpin` it first.', ephemeral: true });
    await interaction.deferUpdate();
    const ok = await evictStagedItemNow(staged, { actorDiscordId: interaction.user.id, reason: 'evict_button' });
    if (!ok) return interaction.followUp({ content: '❌ Eviction failed (rclone error) — the buttons still work, try again.', ephemeral: true });
    return interaction.editReply({ content: `📤 Evicted **${staged.title}** — freed ${fmtSpace(staged.size_bytes)} on the travel server. The California master is untouched; \`/stage\` brings it back anytime.`, components: [] });
  }

  // Retry button on stage-failure alerts (system channel — admin only).
  if (action === 'stage_retry') {
    if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const job = getStageJob(Number(parts[0]));
    if (!job) return interaction.update({ content: 'ℹ️ Job no longer exists.', components: [] });
    if (!requeueStageJob(job.id)) return interaction.update({ content: `ℹ️ Job is ${job.status} — nothing to retry.`, components: [] });
    audit('stage_job_retried', { actorDiscordId: interaction.user.id, jobId: job.id, mediaId: job.media_id });
    pumpStageQueue().catch(() => {});
    return interaction.update({ content: `🔁 Re-queued **${job.title}** for staging.`, components: [] });
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
  // Agent reports can carry a full atime inventory (thousands of file rows), so /agent/ gets a
  // larger JSON limit than the webhook/dashboard routes.
  const agentJsonParser = bodyParser.json({ limit: '25mb' });
  app.use((req, res, next) => {
    if (req.is('multipart/form-data')) return next();
    if (req.path.startsWith('/agent/')) return agentJsonParser(req, res, next);
    bodyParser.json({ limit: '1mb' })(req, res, next);
  });

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

  // ---- Regional tiering: per-node sync-agent API ----
  // Same auth style as download links: only a hash of each node's bearer token is stored;
  // compare in constant time. A node's token only unlocks that node's manifest/report.
  const tierAgentAuth = (req, res, next) => {
    const node = String(req.params.node || '').toLowerCase();
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
    const storedHash = getTierAgentTokenHash(node);
    if (!m || !storedHash || !safeEqual(sha256(m[1]), storedHash)) {
      audit('tier_agent_auth_failed', { node, ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown' });
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };

  app.get('/agent/manifest/:node', tierAgentAuth, (req, res) => {
    const raw = getSetting(`tier_manifest:${String(req.params.node).toLowerCase()}`);
    if (!raw) return res.status(404).json({ error: 'No manifest published for this node — run /tier apply.' });
    res.type('json').send(raw);
  });

  app.post('/agent/report/:node', tierAgentAuth, (req, res) => {
    const node = String(req.params.node).toLowerCase();
    const body = req.body || {};
    const errors = Array.isArray(body.errors) ? body.errors.slice(0, 10).map(e => String(e).slice(0, 300)) : [];
    // The atime demand signal (§3.2a): full local inventory snapshots replace the stored set.
    // An EMPTY array is still a snapshot (the node may have pruned its last media file) —
    // only an absent field means "no inventory in this report". When the node has an
    // atime_mask, suspect (maintenance-window) atimes are laundered against the previously
    // stored rows BEFORE the replace, so the DB always holds the last plausible human read.
    if (Array.isArray(body.inventory)) {
      try {
        let files = body.inventory.slice(0, 200000);
        const mask = parseAtimeMask(getTierNode(node)?.atime_mask);
        if (mask) files = maskSuspectAtimes(files, listTierNodeFiles(node), mask);
        replaceTierNodeFiles(node, files);
      } catch (err) {
        errors.push(`inventory store failed: ${err.message}`);
      }
    }
    audit('tier_agent_report', { node, planHash: body.planHash || null, bytesFreed: body.bytesFreed || 0, droppedCount: (body.dropped || []).length, inventoryCount: Array.isArray(body.inventory) ? body.inventory.length : 0, errors: errors.join('; ').slice(0, 500) || undefined });
    if ((body.bytesFreed || 0) > 0 || errors.length) {
      notifyChannel('cleanup', { embeds: [brandedEmbed(errors.length ? COLORS.WARN : COLORS.SUCCESS)
        .setTitle(`📦 Tier Agent Report — ${node}`)
        .setDescription([
          `Plan \`${body.planHash || '?'}\` converged.`,
          (body.bytesFreed || 0) > 0 ? `Freed **${fmtSpace(body.bytesFreed)}** across ${(body.dropped || []).length} title(s). Master copies untouched.` : null,
          errors.length ? `⚠️ Errors:\n${errors.map(e => `• ${e}`).join('\n')}` : null,
        ].filter(Boolean).join('\n').slice(0, 4000))] });
    }
    res.json({ ok: true });
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
      const now = Date.now();
      // Live activity: every external read is failure-tolerant so one dead integration never
      // takes the dashboard down — null means "couldn't reach it", rendered as such.
      const [health, sessions, queue, disks] = await Promise.all([
        gatherHealth(),
        tautulliConfigured() ? tautulliApi('get_activity').then(d => d?.sessions || []).catch(() => null) : Promise.resolve(null),
        arrSources().length ? fetchArrQueues().catch(() => null) : Promise.resolve(null),
        arrSources().length ? fetchDiskSpace().catch(() => null) : Promise.resolve(null),
      ]);
      const grabJobs = listActiveGrabJobs();
      const stageJobs = listActiveStageJobs();
      const escalations = getWatchingEscalations();
      const pendingDeletions = db.prepare("SELECT * FROM pending_deletions WHERE status = 'pending' ORDER BY delete_after LIMIT 25").all();
      const tierNodes = listTierNodes();
      // Latest agent report per tier node, from the audit log.
      const lastReportByNode = {};
      for (const r of db.prepare("SELECT * FROM audit_log WHERE action = 'tier_agent_report' ORDER BY id DESC LIMIT 100").all()) {
        try {
          const m = JSON.parse(r.metadata_json);
          if (m.node && !lastReportByNode[m.node]) lastReportByNode[m.node] = { ...m, at: r.created_at };
        } catch (_e) {}
      }

      const pendingPlex = db.prepare('SELECT * FROM users WHERE invited = 0 ORDER BY requested_at DESC LIMIT 25').all();
      const pendingRequests = db.prepare('SELECT * FROM requests WHERE status = ? ORDER BY id DESC LIMIT 25').all('pending');
      const linkedUsers = db.prepare('SELECT discord_id, email, invited, requested_at FROM users ORDER BY requested_at DESC LIMIT 100').all();
      const recentDownloads = db.prepare('SELECT * FROM download_access_log ORDER BY id DESC LIMIT 25').all();
      const auditRows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 50').all();
      const linkedTotal = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
      const activeLinks = db.prepare('SELECT COUNT(*) AS c FROM download_tokens WHERE revoked = 0 AND expires_at > ?').get(now).c;

      const stats = [
        renderStat('Streaming', sessions === null ? '—' : sessions.length),
        renderStat('Downloading', queue === null ? '—' : queue.length),
        renderStat('Active jobs', grabJobs.length + stageJobs.length),
        renderStat('Watching', escalations.length),
        renderStat('Tier nodes', `${tierNodes.filter(n => n.enabled).length}/${tierNodes.length}`),
        renderStat('Pending requests', pendingRequests.length),
        renderStat('Linked users', linkedTotal),
        renderStat('Download links', activeLinks),
      ].join('');

      const decisionLabel = s => (s.transcode_decision === 'transcode' || s.video_decision === 'transcode' ? '🔥 transcoding'
        : s.transcode_decision === 'copy' ? '📼 direct stream' : '▶️ direct play');
      const nowPlayingItems = (sessions || []).map(s => ({
        state: (s.transcode_decision === 'transcode' || s.video_decision === 'transcode') ? 'warn' : 'ok',
        title: s.full_title || 'Unknown',
        sub: `${s.friendly_name || s.user || 'Unknown'} · ${decisionLabel(s)}${s.stream_video_full_resolution ? ` · ${s.stream_video_full_resolution}` : ''}${s.player ? ` · ${s.player}` : ''}`,
        pct: Number(s.progress_percent) || 0,
      }));

      const queueItems = (queue || []).map(q => ({
        state: queueItemLooksUnhealthy(q) ? 'warn' : 'ok',
        title: q.title,
        sub: `${q.source.label} · ${q.status}${q.trackedState ? ` (${q.trackedState})` : ''}${q.messages.length ? ` · ⚠️ ${q.messages[0]}` : ''}`,
        right: `${fmtSpace(Math.max(0, q.size - q.sizeleft))} / ${fmtSpace(q.size)}${q.timeleft ? ` · ${q.timeleft}` : ''}`,
        pct: queuePercent(q),
      }));

      const jobItems = [
        ...grabJobs.map(j => ({
          state: j.state === 'failed' ? 'down' : 'ok',
          title: j.release_title || j.title,
          sub: `seedbox grab #${j.id} · ${j.state}${j.error ? ` · ${j.error}` : ''}`,
          right: `${fmtSpace(j.size_bytes || 0)}${j.sent_at ? ` · started ${fmtAgo(j.sent_at)}` : ''}`,
        })),
        ...stageJobs.map(j => ({
          state: j.status === 'failed' ? 'down' : 'ok',
          title: j.title,
          sub: `PH stage #${j.id} · ${j.status}`,
          right: `${fmtSpace(j.size_bytes || 0)}${j.started_at ? ` · started ${fmtAgo(j.started_at)}` : ''}`,
        })),
      ];
      const watchItems = [
        ...escalations.map(e => ({
          state: 'warn',
          title: e.title,
          sub: `escalation watch · ${e.state}${e.pre_authorized ? ' · pre-authorized' : ''}`,
          right: `approved ${fmtAgo(e.approved_at)}`,
        })),
        ...pendingDeletions.map(p => ({
          state: 'skip',
          title: p.title || p.media_id,
          sub: 'pending deletion (finished-watching prompt)',
          right: `deletes ${fmtAgo(p.delete_after)}`,
        })),
      ];

      const tierItems = tierNodes.map(n => {
        const plan = getTierPlan(n.name);
        const rep = lastReportByNode[n.name];
        const repBits = rep
          ? `agent ${fmtAgo(sqliteUtcMs(rep.at))}${rep.bytesFreed ? ` · freed ${fmtSpace(rep.bytesFreed)}` : ''}${rep.errors ? ' · ⚠️ errors' : ''}`
          : 'no agent report yet';
        return {
          state: !n.enabled ? 'skip' : (rep && rep.errors ? 'warn' : 'ok'),
          title: `${n.name}${n.full ? ' · full master' : ''}${n.sticky ? ' · sticky' : ''}`,
          sub: `${n.access} · ${n.demand_source}${n.demand_source === 'atime' && n.atime_mask ? ` (mask ${n.atime_mask})` : ''} · ${n.transport} · ${fmtSpace(n.usable_bytes || 0)} @ ${n.headroom_pct}% headroom`,
          right: `${plan ? `plan ${plan.planHash} · applied ${fmtAgo(plan.appliedAt)}` : 'no plan applied'} · ${repBits}`,
        };
      });

      const diskItems = (disks || []).map(d => {
        const used = (d.totalSpace || 0) - (d.freeSpace || 0);
        const pct = d.totalSpace ? Math.round((used / d.totalSpace) * 100) : 0;
        return {
          state: (d.freeSpace || 0) < CONFIG.DISK_SPACE_WARN_GB * 1024 ** 3 ? 'warn' : 'ok',
          title: d.displayPath || d.path,
          sub: `${fmtSpace(d.freeSpace || 0)} free of ${fmtSpace(d.totalSpace || 0)}`,
          right: `${pct}% used`,
          pct,
        };
      });

      const plexUserRows = pendingPlex.map(u => ({ email: u.email, discord: u.discord_id, requested: fmtAgo(u.requested_at) }));
      const requestRows = pendingRequests.map(r => ({ title: r.title, type: mediaTypeLabel(r.media_type, r.is_4k), requester: r.requested_by_discord_id || '—', when: fmtAgo(sqliteUtcMs(r.created_at)) }));
      const linkedRows = linkedUsers.map(u => ({ email: u.email, discord: u.discord_id, invited: u.invited ? '✅' : '⏳', since: fmtAgo(u.requested_at) }));
      const downloadRows = recentDownloads.map(d => ({ when: fmtAgo(sqliteUtcMs(d.created_at)), file: (d.file_path || '').split('/').pop() || '—', status: d.status, sent: d.bytes_sent ? fmtSpace(d.bytes_sent) : '', ip: d.ip || '' }));
      const auditTableRows = auditRows.map(a => ({ when: fmtAgo(sqliteUtcMs(a.created_at)), action: a.action, details: String(a.metadata_json || '').slice(0, 160) }));

      const unavailable = which => `<p class="muted">${escapeHtml(which)} unreachable or not configured.</p>`;
      const nav = [['now', 'Now'], ['jobs', 'Jobs'], ['tier', 'Tiering'], ['disks', 'Disks'], ['users', 'Users'], ['requests', 'Requests'], ['logs', 'Logs']];

      const body = `
        <div class="overall ${health.overall === 'ok' ? 'ok' : 'warn'}">
          <span>Overall: <strong>${escapeHtml(String(health.overall).toUpperCase())}</strong></span>
          <span class="updated">updated ${new Date(now).toISOString().slice(11, 19)} UTC · auto-refreshes</span>
        </div>
        <div class="stats">${stats}</div>
        <div class="card">
          <h2>Integrations</h2>
          <div class="badges">${renderHealthBadges(health)}</div>
        </div>
        <div class="card" id="now">
          <h2>▶️ Now Streaming</h2>
          ${sessions === null ? unavailable('Tautulli') : renderItemList(nowPlayingItems, 'Nobody is streaming right now.')}
        </div>
        <div class="card">
          <h2>⬇️ Downloading</h2>
          ${queue === null ? unavailable('Radarr/Sonarr') : renderItemList(queueItems, 'Nothing in the download queues.')}
        </div>
        <div class="card" id="jobs">
          <h2>⚙️ Active Jobs</h2>
          ${renderItemList(jobItems, 'No seedbox grabs or staging copies running.')}
        </div>
        <div class="card">
          <h2>👀 Watching / Scheduled</h2>
          ${renderItemList(watchItems, 'No escalation watches or pending deletions.')}
        </div>
        <div class="card" id="tier">
          <h2>📦 Tier Nodes</h2>
          ${renderItemList(tierItems, 'No tier nodes registered — /tier-node add creates one.')}
        </div>
        <div class="card" id="disks">
          <h2>💾 Disk Space</h2>
          ${disks === null ? unavailable('*arr diskspace') : renderItemList(diskItems, 'No disks reported.')}
        </div>
        <div class="card">
          <h2>Manual Actions</h2>
          <div class="actions">
            <a class="btn" href="/admin/health">Health JSON</a>
            <a class="btn" href="/admin/action/sync-preview">Sync Preview</a>
            <a class="btn" href="/admin/action/cleanup-preview">Cleanup Preview</a>
            <button class="btn danger" type="button" onclick="revokeAll()">Revoke All Download Links</button>
          </div>
        </div>
        <div class="card" id="users">
          <h2>Pending Plex Users</h2>
          ${renderTable(plexUserRows)}
        </div>
        <div class="card">
          <h2>Linked Users</h2>
          ${renderTable(linkedRows)}
        </div>
        <div class="card" id="requests">
          <h2>Pending Media Requests</h2>
          ${renderTable(requestRows)}
        </div>
        <div class="card">
          <h2>Recent Downloads</h2>
          ${renderTable(downloadRows)}
        </div>
        <div class="card" id="logs">
          <h2>Recent Audit Log</h2>
          ${renderTable(auditTableRows)}
        </div>
        <script>
          async function revokeAll() {
            if (!confirm('Revoke ALL active download links? This cannot be undone.')) return;
            const r = await fetch('/admin/action/revoke-all', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
            alert(r.ok ? 'All active download links revoked.' : 'Failed: ' + r.status);
            if (r.ok) location.reload();
          }
        </script>`;
      res.type('html').send(renderPage('Dashboard', body, { showLogout: true, nav, autoRefresh: true }));
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

// Mobile-first: sticky header with a horizontally-scrolling section nav, activity rendered as
// touch-friendly item rows with progress bars, and tables that collapse into labeled cards on
// narrow screens. All inline, no build step, dark Plex/Overseerr look.
const DASHBOARD_CSS = `
  :root { --bg:#131316; --panel:#1d1e23; --panel2:#26272e; --accent:#e5a00d; --text:#ececf0; --muted:#9aa0a6; --border:#33343c; --ok:#22c55e; --warn:#f59e0b; --down:#ef4444; --skip:#6b7280; }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--text); padding-bottom:env(safe-area-inset-bottom); }
  header.hdr { position:sticky; top:0; z-index:20; background:rgba(19,19,22,.94); backdrop-filter:blur(10px); border-bottom:1px solid var(--border); padding-top:env(safe-area-inset-top); }
  .topbar { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px 16px 8px; }
  .topbar h1 { margin:0; font-size:16px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .topbar .brand { color:var(--accent); }
  .nav { display:flex; gap:8px; overflow-x:auto; padding:4px 16px 10px; scrollbar-width:none; }
  .nav::-webkit-scrollbar { display:none; }
  .chip { flex:0 0 auto; padding:7px 14px; border-radius:999px; background:var(--panel2); border:1px solid var(--border); color:var(--text); font-size:13px; text-decoration:none; }
  .chip:hover, .chip:active { border-color:var(--accent); }
  .container { max-width:1100px; margin:0 auto; padding:16px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:14px 16px; margin-bottom:14px; scroll-margin-top:110px; }
  .card h2 { margin:0 0 10px; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; }
  .overall { display:flex; flex-wrap:wrap; gap:6px 14px; align-items:baseline; justify-content:space-between; padding:12px 16px; border-radius:14px; margin-bottom:14px; font-size:14px; }
  .overall.ok { background:rgba(34,197,94,.10); border:1px solid rgba(34,197,94,.5); }
  .overall.warn { background:rgba(245,158,11,.10); border:1px solid rgba(245,158,11,.5); }
  .overall .updated { color:var(--muted); font-size:12px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(118px,1fr)); gap:10px; margin-bottom:14px; }
  .stat { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:12px 14px; }
  .stat .n { font-size:22px; font-weight:700; color:var(--accent); line-height:1.2; }
  .stat .l { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; margin-top:2px; }
  .badges { display:flex; flex-wrap:wrap; gap:8px; }
  .badge { display:inline-flex; align-items:center; gap:6px; padding:7px 11px; border-radius:999px; font-size:12.5px; background:var(--panel2); border:1px solid var(--border); }
  .dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; }
  .dot.ok { background:var(--ok); } .dot.warn { background:var(--warn); } .dot.down { background:var(--down); } .dot.skip { background:var(--skip); }
  .items { display:flex; flex-direction:column; }
  .item { display:flex; gap:10px; align-items:flex-start; padding:10px 0; border-bottom:1px solid var(--border); }
  .item:last-child { border-bottom:none; }
  .item > .dot { margin-top:6px; }
  .item-main { flex:1 1 auto; min-width:0; }
  .item-title { font-size:14px; font-weight:600; overflow-wrap:anywhere; }
  .item-sub { font-size:12.5px; color:var(--muted); margin-top:2px; overflow-wrap:anywhere; }
  .item-right { flex:0 0 auto; font-size:12px; color:var(--muted); text-align:right; max-width:42%; overflow-wrap:anywhere; }
  .bar { height:6px; background:var(--panel2); border-radius:999px; margin-top:7px; overflow:hidden; }
  .bar-fill { height:100%; background:var(--accent); border-radius:999px; }
  .bar-fill.hot { background:var(--ok); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border); white-space:nowrap; max-width:340px; overflow:hidden; text-overflow:ellipsis; }
  th { color:var(--muted); font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:.04em; }
  tbody tr:nth-child(odd) { background:rgba(255,255,255,.02); }
  .table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
  .muted { color:var(--muted); font-style:italic; font-size:13px; }
  .actions { display:flex; flex-wrap:wrap; gap:10px; }
  .btn { display:inline-flex; align-items:center; justify-content:center; min-height:42px; padding:10px 16px; border-radius:10px; background:var(--panel2); color:var(--text); border:1px solid var(--border); text-decoration:none; font-size:13px; cursor:pointer; }
  .btn:hover { border-color:var(--accent); }
  .btn.danger { border-color:var(--down); color:#fca5a5; }
  .btn.primary { background:var(--accent); color:#131316; border-color:var(--accent); font-weight:600; }
  form.logout { margin:0; }
  .login-wrap { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px; }
  .login-card { width:100%; max-width:360px; background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:28px; }
  .login-card h1 { margin:0 0 4px; font-size:20px; }
  .login-card h1 .brand { color:var(--accent); }
  .login-card p { margin:0 0 20px; color:var(--muted); font-size:13px; }
  .login-card label { display:block; font-size:12px; color:var(--muted); margin-bottom:6px; }
  .login-card input { width:100%; padding:12px; border-radius:10px; border:1px solid var(--border); background:#131316; color:var(--text); font-size:16px; margin-bottom:16px; }
  .login-card .btn.primary { width:100%; text-align:center; }
  .error { background:rgba(239,68,68,.12); border:1px solid var(--down); color:#fca5a5; padding:10px 12px; border-radius:10px; font-size:13px; margin-bottom:16px; }
  @media (max-width:560px) {
    .item { flex-wrap:wrap; }
    .item-right { flex-basis:100%; max-width:none; text-align:left; margin-left:19px; margin-top:2px; }
    .actions .btn { flex:1 1 45%; }
  }
  @media (max-width:640px) {
    table, tbody, tr, td { display:block; }
    thead { display:none; }
    tbody tr { border:1px solid var(--border); border-radius:12px; margin-bottom:10px; padding:8px 12px; background:var(--panel2); }
    tbody tr:nth-child(odd) { background:var(--panel2); }
    td { border:none; padding:3px 0; white-space:normal; max-width:none; display:flex; gap:10px; overflow:visible; }
    td::before { content:attr(data-label); flex:0 0 84px; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; padding-top:2px; }
  }
`;

function renderPage(title, bodyHtml, { showLogout = false, nav = [], autoRefresh = false } = {}) {
  const navHtml = nav.length
    ? `<nav class="nav">${nav.map(([id, label]) => `<a class="chip" href="#${escapeHtml(id)}">${escapeHtml(label)}</a>`).join('')}</nav>`
    : '';
  // Auto-refresh pauses while the tab is hidden so a backgrounded phone doesn't burn
  // battery/API calls re-checking every integration.
  const refreshScript = autoRefresh ? `<script>
    (function () {
      var t;
      function arm() { t = setTimeout(function () { location.reload(); }, 60000); }
      document.addEventListener('visibilitychange', function () { if (document.hidden) clearTimeout(t); else arm(); });
      if (!document.hidden) arm();
    })();
  </script>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#131316">
  <title>${escapeHtml(title)} — Durant Media Server</title>
  <style>${DASHBOARD_CSS}</style></head><body>
  <header class="hdr">
    <div class="topbar">
      <h1><span class="brand">Durant</span> Media Server</h1>
      ${showLogout ? '<form class="logout" method="post" action="/admin/logout"><button class="btn" type="submit">Log out</button></form>' : ''}
    </div>
    ${navHtml}
  </header>
  <div class="container">${bodyHtml}</div>
  ${refreshScript}
  </body></html>`;
}

// Epoch ms from a SQLite CURRENT_TIMESTAMP string ('YYYY-MM-DD HH:MM:SS', UTC) or anything
// Date.parse understands; null when unparseable.
function sqliteUtcMs(v) {
  if (typeof v === 'number') return v;
  const s = String(v || '');
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  return Number.isFinite(t) ? t : null;
}

// '3m ago' / 'in 2h' for dashboard rows; empty string when the timestamp is unknown.
function fmtAgo(ts) {
  const t = typeof ts === 'number' ? ts : sqliteUtcMs(ts);
  if (!Number.isFinite(t) || !t) return '';
  const d = Date.now() - t;
  return d >= 0 ? `${fmtDuration(d)} ago` : `in ${fmtDuration(-d)}`;
}

function renderBar(pct) {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  return `<div class="bar"><div class="bar-fill${p >= 95 ? ' hot' : ''}" style="width:${p}%"></div></div>`;
}

// Touch-friendly activity rows: state dot, title + sub, optional right-side metric and
// progress bar. Wraps gracefully on small screens (see the 560px media query).
function renderItemList(items, emptyText = 'Nothing right now.') {
  if (!items || !items.length) return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  return `<div class="items">${items.map(i => `
    <div class="item">
      <span class="dot ${['ok', 'warn', 'down', 'skip'].includes(i.state) ? i.state : 'skip'}"></span>
      <div class="item-main">
        <div class="item-title">${escapeHtml(i.title || '')}</div>
        ${i.sub ? `<div class="item-sub">${escapeHtml(i.sub)}</div>` : ''}
        ${typeof i.pct === 'number' ? renderBar(i.pct) : ''}
      </div>
      ${i.right ? `<div class="item-right">${escapeHtml(i.right)}</div>` : ''}
    </div>`).join('')}</div>`;
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

// data-label on every cell powers the mobile collapse: under 640px the table becomes a stack
// of labeled cards (CSS-only, no JS).
function renderTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '<p class="muted">No records.</p>';
  const cols = Object.keys(rows[0]);
  const head = cols.map(c => `<th>${escapeHtml(c)}</th>`).join('');
  const bodyRows = rows.map(r => `<tr>${cols.map(c => {
    const v = r[c];
    const text = escapeHtml(v == null ? '' : String(v));
    return `<td data-label="${escapeHtml(c)}" title="${text}">${text}</td>`;
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
    // Available/declined means there's nothing left to escalate — resolve the watch row now
    // instead of waiting for the next sweep.
    if (['MEDIA_AVAILABLE', 'MEDIA_DECLINED'].includes(notification_type)) resolveEscalationForMediaKey(mediaId);
  }

  if (['MEDIA_APPROVED', 'MEDIA_AUTO_APPROVED'].includes(notification_type) && requesterDiscordId) {
    // Radarr/Sonarr know the digital release / air dates by now (Seerr adds the title on
    // approval) — set expectations up front instead of promising a grab that can't happen
    // until the title is actually out. Best-effort: no ETA just means the plain copy.
    const eta = releaseEtaInfo(await fetchReleaseEta({
      mediaType: media.media_type === 'tv' ? 'tv' : 'movie',
      tmdbId: media.tmdbId ?? null,
      tvdbId: media.tvdbId ?? null,
    }));
    const embed = brandedEmbed(COLORS.SUCCESS)
      .setTitle('🎉 Request Approved')
      .setDescription(eta?.waiting
        ? `**${title}** was approved! It isn't out yet, so it'll be grabbed automatically the moment it releases.\n${eta.line}\nYou'll get another DM when it's ready to watch.`
        : `**${title}** was approved and is being grabbed now.\nYou'll get another DM the moment it's ready to watch.${eta ? `\n\n${eta.line}` : ''}`);
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
    // Close the loop for PH users: the import just finished in California, so kick the cache
    // copy now instead of making them /stage a title Overseerr already calls "Available".
    let autoStaged = false;
    if (stagingConfigured() && homeServerFor(requesterDiscordId) === 'ph' && !getStagedItem(mediaId)) {
      const { duplicate } = enqueueStageJob({ mediaId, mediaType: media.media_type === 'tv' ? 'tv' : 'movie', title, discordId: requesterDiscordId, origin: 'auto' });
      autoStaged = true;
      if (!duplicate) audit('stage_auto_enqueued', { targetDiscordId: requesterDiscordId, mediaId, title });
      pumpStageQueue().catch(() => {});
    }
    const embed = brandedEmbed(COLORS.SUCCESS)
      .setTitle(autoStaged ? '🍿 Downloaded — Copying to Your Server' : '🍿 Now Available on Plex')
      .setDescription(autoStaged
        ? `**${title}** finished downloading and is being copied to your home server now.\nThe link across the ocean takes a while — you'll get another DM the moment it's ready to play. 🔥`
        : `**${title}** is ready to watch — enjoy!\n\nWant something else? Use \`/download\` or request more anytime.`);
    if (poster) embed.setImage(poster);
    const sent = await dmUser(requesterDiscordId, { embeds: [embed] });
    if (sent) audit('media_available_notification_sent', { targetDiscordId: requesterDiscordId, title, autoStaged });
  }
}

async function handlePlexWebhook(payload) {
  const { event, Account, Metadata, Server } = payload;
  if (event !== 'media.scrobble' || !Account || !Metadata) return;
  // Every scrobble is gated on which server it came from BEFORE anything destructive can
  // happen: a PH viewer finishing a movie must never reach the delete flow against the master.
  const origin = classifyServerIdentity({ serverName: Server?.title, machineId: Server?.uuid });
  if (origin === 'unknown') {
    audit('webhook_server_unmatched', { source: 'plex', serverName: Server?.title || null, machineId: Server?.uuid || null, event });
    return;
  }
  const mediaType = Metadata.type;
  const title = mediaType === 'episode' ? (Metadata.grandparentTitle || Metadata.title) : Metadata.title;
  const videoStream = Metadata.Media?.[0]?.Part?.[0]?.Stream?.find(s => s.streamType === 1);
  const resolution = (videoStream?.displayTitle || '').toLowerCase();
  const is4k = resolution.includes('4k') || resolution.includes('2160');

  const guids = Metadata.Guid || [];
  const mediaId = mediaType === 'movie' ? `tmdb:${(guids.find(g => g.id?.startsWith('tmdb://'))?.id || '').replace('tmdb://', '')}` : `tvdb:${(guids.find(g => g.id?.startsWith('tvdb://'))?.id || '').replace('tvdb://', '')}`;
  if (!mediaId || mediaId.endsWith(':')) return;
  if (origin === 'ph') {
    return handlePhWatchedEvent({ event: 'watched', mediaId, title, mediaType: mediaType === 'episode' ? 'tv' : 'movie' });
  }
  if (mediaType === 'movie' && !is4k) return;
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
  const { event, user_email, media_type, title, grandparent_title, tmdb_id, tvdb_id, is_4k, server_name, machine_id } = body;
  // Server-aware routing: the payload's server identity decides which flow an event may reach.
  // PH events go to the eviction flow (cache only), primary events to the delete flow, and
  // unidentifiable events are dropped — a delete prompt fired for the wrong server costs a
  // master file; a skipped prompt costs nothing.
  const origin = classifyServerIdentity({ serverName: server_name, machineId: machine_id });
  if (origin === 'unknown') {
    audit('webhook_server_unmatched', { source: 'tautulli', serverName: server_name || null, machineId: machine_id || null, event });
    return;
  }
  const mediaId = media_type === 'movie' ? `tmdb:${tmdb_id}` : `tvdb:${tvdb_id}`;
  if (!tmdb_id && media_type === 'movie') return;
  if (!tvdb_id && media_type === 'episode') return;
  if (origin === 'ph') {
    return handlePhWatchedEvent({ event, mediaId, title: media_type === 'episode' ? (grandparent_title || title) : title, mediaType: media_type === 'episode' ? 'tv' : 'movie', watcherEmail: user_email });
  }
  if (event !== 'watched' || !user_email) return;
  const is4k = String(is_4k || '').toLowerCase().includes('4k');
  if (media_type === 'movie' && !is4k) return;
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

// A playback event from the PH box. Any event bumps the LRU clock for a cached title; a
// finished watch re-uses the familiar 90% prompt UX, but pointed at the CACHE: "Yes" frees
// local cache space and the master file in California is untouched either way.
async function handlePhWatchedEvent({ event, mediaId, title, mediaType, watcherEmail }) {
  const staged = getStagedItem(mediaId);
  if (!staged) return; // not cache-managed (e.g. pre-seeded by hand) — nothing to track or evict
  touchStagedItem(mediaId);
  if (event !== 'watched') return;
  if (staged.pinned) return; // pinned = weekly rewatch material; don't even ask
  // One prompt per title per cooldown window — a nightly episode binge shouldn't re-ask daily.
  const lastPrompt = Number(getSetting(`evict_prompt_last:${mediaId}`) || '0');
  if (Date.now() - lastPrompt < 12 * 3600000) return;

  // Address the prompt to the watcher when their Plex email is linked, else whoever staged it.
  const watcher = watcherEmail ? getUserByCanonicalEmail(watcherEmail) : null;
  const reqRow = db.prepare('SELECT requested_by_discord_id FROM requests WHERE media_id = ? ORDER BY created_at DESC LIMIT 1').get(mediaId);
  const targetId = [watcher?.discord_id, staged.staged_by_discord_id, reqRow?.requested_by_discord_id, CONFIG.ADMIN_USER_ID].find(isSnowflake);
  if (!targetId) return;
  const channel = await safeGetChannel(channelFor('cleanup'));
  if (!channel) return;
  setSetting(`evict_prompt_last:${mediaId}`, String(Date.now()));
  // Unlike the delete buttons, no title in the customId: mediaId + snowflake alone leave
  // headroom under Discord's 100-char limit, and a long encoded title would make channel.send
  // reject the whole prompt. The handlers re-read the title from staged_items.
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`evict_no:${mediaId}:${targetId}`).setLabel('Keep It Cached').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`evict_yes:${mediaId}:${targetId}`).setLabel('Free Up Space').setStyle(ButtonStyle.Primary),
  );
  await channel.send({ content: `<@${targetId}>`, embeds: [brandedEmbed(COLORS.WARN)
    .setTitle(`${mediaTypeEmoji(mediaType, false)} Finished Watching (Travel Server)`)
    .setDescription(`Looks like you finished **${staged.title || title}**. Free up ${fmtSpace(staged.size_bytes)} of cache space?\n\nEither way the master copy in California is untouched — \`/stage\` brings it back anytime.`)], components: [row] });
  audit('evict_prompt_sent', { mediaId, title: staged.title || title, targetDiscordId: targetId });
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
