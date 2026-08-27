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
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const bodyParser = require('body-parser');
const multer = require('multer');
const { createBodyConcurrencyLimiter } = require('./src/routes/body-concurrency-limit');
const { sanitizeNodeTelemetry, assessNodeTelemetry, telemetrySummary } = require('./src/node-telemetry');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { log } = require('./src/log');
const { parseBool, CONFIG, REQUIRED_ENV, validateConfig, configWarnings } = require('./src/config');
const runtimeSettings = require('./src/runtime-settings');
const { sha256, safeEqual, isSnowflake, canonicalizeEmail, isValidEmail, mediaTypeLabel, mediaTypeEmoji, requestStatusBadge, discordTimestamp, quotaLine, releaseEtaInfo, statusEmoji, pad, fmtDuration, mimeFor, gb, fmtSpace, progressBar, queuePercent, queueItemLooksUnhealthy } = require('./src/util');
const { db, DB_PATH, ensureColumn, runMigrations, audit, upsertTierNode, getTierNode, listTierNodes, setTierNodeEnabled, addTierNodeMember, removeTierNodeMember, listTierNodeMembers, listTierNodeFolders, addTierNodeFolder, removeTierNodeFolder, replaceTierNodeFolders, setTierAgentToken, getTierAgentTokenHash, replaceTierNodeFiles, listTierNodeFiles, listRequestsByRequesters, getTierPlan, setTierPublishedPlan, markTierPlanConverged, recordTierAgentReport, recordTierAgentHeartbeat, countRecentPromotions, recordPromotion, storeUserEmail, linkUserToEmail, findConflictingRealUser, getUserByDiscordId, getUserByCanonicalEmail, markUserInvited, markOverseerrCreated, removeUser, upsertRequest, addToKeepList, isInKeepList, recordPendingDeletion, markPendingDeletion, postponePendingDeletion, recordEscalationWatch, getWatchingEscalations, getEscalationById, setEscalationState, setEscalationTvdbId, setEscalationAvistazFit, markEscalationArrMissingAlerted, touchEscalationApprovedAt, resolveEscalationForMediaKey, recordGrabJob, setGrabJobIdentity, getGrabJob, getGrabJobByHash, getGrabJobByRelease, listActiveGrabJobs, nextTransferableGrabJob, setGrabJobState, countGrabJobsToday, requeueGrabTransfer, resetInterruptedGrabTransfers, stashGrabOffer, takeGrabOffer, restashGrabOffer, listAdoptedGrabJobs, setAdoptIgnored, clearAdoptIgnored, isAdoptIgnored, listAdoptIgnored, markAdoptOffered, isAdoptOffered, clearAdoptOffered, listAdoptOfferedHashes, getSeasonSearchTimes, getSeasonSearchStalls, recordSeasonSearch, listRecentSeasonSearches, listSeriesIdsWithSeasonSearches, listRequestedTvdbIds, setUserHomeServer, enqueueStageJob, getStageJob, nextQueuedStageJob, listActiveStageJobs, markStageJobCopying, finishStageJob, requeueStageJob, resetInterruptedStageJobs, recordStagedItem, getStagedItem, listStagedItems, removeStagedItem, touchStagedItem, setStagedItemPinned, createDownloadToken, getDownloadRecordByRawToken, revokeAllDownloadLinks, cleanExpiredTokens, takePersistentRateLimit, getAlertedAt, setAlertedAt, listAlertCooldowns, clearAlertCooldown, pruneAlertCooldowns, recordSeasonNoGrab, clearSeasonAlertState, listSeasonAlertStates, getSetting, setSetting, deleteSetting, listPasskeys, getPasskey, savePasskey, updatePasskeyUse, renamePasskey, revokePasskey, listMediaPriority, mediaPriorityMap, setMediaPriority, clearMediaPriority, stashPendingRequest, takePendingRequest, restashPendingRequest, findPendingRequestNonce, recordWebhookEvent, forgetWebhookEvent, pruneWebhookEvents, addRequestSubscriber, listRequestSubscribers, countRequestSubscribers, clearRequestSubscribers, pruneRequestSubscribers, getTrustScore, bumpTrustScore, resetTrustScore } = require('./src/db');
const { reconcileRequestStatuses } = require('./src/db');
const { listPendingRequests, setPendingRequestNotice } = require('./src/db');
const { recordSeasonEpisodeFallbackEvidence, getSeasonEpisodeFallback, listSeasonEpisodeFallbacks,
  markSeasonEpisodeFallbackSubmitted, attachSeasonEpisodeFallbackCommand, finishSeasonEpisodeFallback, deferSubmittedSeasonEpisodeFallback,
  clearSeasonEpisodeFallback } = require('./src/db');
const { recordDeadReleaseGroupSighting, getReleaseGroupSighting, markReleaseGroupSuggested, markReleaseGroupBlocklisted, dismissReleaseGroupSuggestion } = require('./src/db');
const { PLEX_CLIENT_ID, getPlexToken, plexApiGet, getPlexServers, inviteUserToPlex, removePlexAccess, fetchPlexFriends } = require('./src/plex');
const { setOverseerrDiscordNotification, createOverseerrUser, runSeerrSelfTest, searchSeerr, checkExistingSeerrMedia, fetchSeerrTvdbId, fetchSeerrMediaOrigin, fetchSeerrMediaId, fetchSeerrMediaIdByRequest, createSeerrIssue, createSeerrRequestAs, verifySeerrRequestCreated, resolveSeerrUserId, approveOverseerrRequest, denyOverseerrRequest, deleteOverseerrRequest, fetchUserQuota, fetchOverseerrUsers } = require('./src/seerr');
const { fetchSeerrRequests } = require('./src/seerr');
const { radarrGetFrom, sonarrGet, arrSources, fetchArrQueues, fetchDiskSpace, fetchDiskSpaceReport, searchMovies, searchSeries, listRadarrMovies, listSonarrMissingEpisodes, getEpisodeFiles, executeDeletion, getMovieByTmdbId, getSeriesByTvdbId, applyAvistazTag, escalateMediaToAvistaz, addMediaToArr, pairFilesToEpisodes, verifyAvistazTags, fetchReleaseEta, remapPath, triggerSeasonSearch, triggerEpisodeSearch, getSonarrCommand, getSeriesEpisodes, getSeasonDownloadHistory, interactiveSeasonSearch, forceGrabRelease, listSonarrSeries, resolveSonarrSeriesIdentity, sonarrSeriesAliases,
  getArrTagId, addTagToSeries, listSonarrCustomFormats, createSonarrCustomFormat, scoreSonarrCustomFormatInAllProfiles } = require('./src/arr');
const { decideEscalationAction, escalationEligible, autoEscalateAllowed, usesDirectGrabEscalation } = require('./src/escalation');
const { assessSeriesAge, seasonSearchTargets, describeSeasonSearch, summarizeSeasonFillActivity } = require('./src/season-pack');
const { rankSeasonReleases, chooseSeasonPack, describeRejections } = require('./src/season-release');
const { classifyEpisodeFallbackEvidence, planEpisodeFallback, orderPendingFallbacks } = require('./src/season-episode-fallback');
const { assessAsianOrigin, describeAvistazFit, isAsianLanguageName } = require('./src/asian');
const { tautulliConfigured, tautulliApi, fetchHistory, describeSession } = require('./src/tautulli');
const { planTier, gatherNodeHistories, fetchTierInventory, fetchPlexHistory, parseAtimeMask, maskSuspectAtimes, assessApplyImpact, computeTierActionPreview, tierApplyConfirmCode, renderSyncthingStignore, renderFolderStignore, renderRclone } = require('./src/tier');
const { stagingConfigured, classifyServerIdentity, planCacheSpace, planPlayPromotion, resolveStageSource, stageCopy, purgeStagedPath, getCacheStatus, runRclone, reconcileStagedItems, fetchStagedPresence } = require('./src/staging');
const { runEdgeDiagnostics } = require('./src/edge-diagnostics');
const { escapeHtml, renderPage, sqliteUtcMs, fmtAgo, renderItemList, renderLogin, renderStat, renderHealthBadges, renderSettingsGroup, renderTable, tierInstallCommand, tierNodeStatus, renderTierNodeSetup, renderPasskeyManagement } = require('./src/dashboard-render');
const { grabConfigured, grabImportTarget, findAvistazIndexer, searchAvistaz, fetchTorrentFile, normalizeTitle, splitTitleYear, parseReleaseName, seriesToken, extractReleaseGroup, releaseContentClaim, contentClaimsOverlap, describeContentClaim, planSeriesGrab, describeGrabPlan, rankAvistazResults, grabAllowance, decideGrabJobAction, seriesAliasMatch } = require('./src/grab');
const { rtorrentConfigured, computeInfoHash, addTorrentToRtorrent, getRtorrentStatus, listRtorrentTorrents, getRtorrentVersion } = require('./src/rtorrent');
const { runBackup, rotateBackups, backupState, rehearseLatestBackup } = require('./scripts/backup-db');
const { recordDiskSamples, pruneDiskSamples, forecastDisks, pathIsOnRoot, forecastLabel } = require('./src/capacity');
const { webhookEventKey } = require('./src/webhook-events');
const { createWebhookHandlers, requireWebhookSecret } = require('./src/routes/webhooks');
const { createTierAgentAuth } = require('./src/routes/tier-agent-auth');
const { createTierAgentReportLimiter } = require('./src/routes/tier-agent-report-limit');
const { registerHealthAndDownloadRoutes } = require('./src/routes/health-download');
const { createApp } = require('./src/app');
const { matchTorrentsByName, adoptTargetForLabel, remoteSubpathCandidates, parseRemoteListing, indexRemoteListing, remoteSizeMatches, joinRemotePath, decideAdoption, bulkTargetChoices } = require('./src/adopt');
const { premiumizeConfigured, accountInfo, listTransfers, deleteTransfer, retryTransfer, clearFinished, findStuckTransfers, isStuckCandidate, planStuckTransferActions } = require('./src/premiumize');
const { detectStuckItems, stuckGroupKey, groupStuckItems, isSeasonGroup } = require('./src/stuck');
const { summarizeSeriesGaps, describeGaps, describeActivity, rankIncomplete } = require('./src/incomplete');
const { priorityKey, orderByPriority, isPinned, nextRank } = require('./src/priority');
const { summarizeImportRejections, renderRejectionLines, looksLikeMappingProblem } = require('./src/import-rejections');
const { normalizeSearchQuery, searchDashboard } = require('./src/search');
const { runEpisodeRecoverySweep, previewEpisodeRecoverySweep } = require('./src/episode-recovery');
const { createRequestGate } = require('./src/request-gate');
const { passkeyRp, createPasskeyService } = require('./src/passkeys');
const { prepareTierNodeInstall } = require('./src/tier-node-setup');
const { OPERATOR_EMBED_LIMITS, boundOperatorLabel, formatOperatorError } = require('./src/operator-error');
const { HEALTH_KEYS, healthLabel, statusOverall, createHealthChecker } = require('./src/health');
const { fetchRequestInventoryWithRetry, requestReconcileStage } = require('./src/request-reconcile');

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

// Secret used to sign dashboard session cookies. validateConfig() refuses to start with
// DASHBOARD_ENABLED=true unless SESSION_SECRET is set, so this is never derived from the admin
// password/token (a captured cookie would otherwise hand an attacker a known HMAC message/
// signature pair, guessable offline at SHA-256 speed) and never falls back to a per-process value
// (which would silently invalidate every session on restart instead of failing loudly).
function sessionSecret() {
  return CONFIG.SESSION_SECRET;
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

function setDashboardSessionCookie(req, res) {
  const ttlMs = CONFIG.SESSION_TTL_HOURS * 3600000;
  const secure = req.secure || (req.headers['x-forwarded-proto'] || '').includes('https');
  res.setHeader('Set-Cookie', `dm_session=${signSession(ttlMs)}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${Math.floor(ttlMs / 1000)}${secure ? '; Secure' : ''}`);
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
// Automation knobs that the dashboard can override at runtime (see src/runtime-settings.js).
// Read through this at the point of use, never cached at boot — a value captured in a closure
// would ignore every override until the next restart.
const settingsStore = { get: getSetting, set: setSetting, del: deleteSetting };
const tunable = key => runtimeSettings.resolveRuntime(key, { config: CONFIG, store: settingsStore });
const PASSKEY_RP = passkeyRp(CONFIG.TUNNEL_DOMAIN);
const passkeyService = createPasskeyService({
  store: { listPasskeys, getPasskey, savePasskey, updatePasskeyUse },
  ...PASSKEY_RP,
});
// A sweep whose cadence and on/off state are runtime-tunable. setInterval is wrong for these:
// its period is fixed when it is created, so a cadence changed from the dashboard would not take
// effect until the process restarted, and a sweep whose env value was 0 at boot would never exist
// to be re-enabled at all. This re-reads both on every tick instead. While paused (interval 0, or
// `enabled` false) it keeps waking once a minute purely to notice being switched back on.
function scheduleTunableSweep({ label, minutesKey, enabledKey, fn, firstRunDelayMs }) {
  const paused = () => (enabledKey && !tunable(enabledKey)) || tunable(minutesKey) <= 0;
  const tick = () => {
    if (!paused()) Promise.resolve().then(fn).catch(err => log.warn(`${label} failed: ${err.message}`));
    setTimeout(tick, (paused() ? 1 : tunable(minutesKey)) * 60000).unref();
  };
  setTimeout(tick, firstRunDelayMs ?? (paused() ? 60000 : tunable(minutesKey) * 60000)).unref();
}

const runningSweeps = new Set();
const automationRuns = new Map();
function recordAutomationRun(name, state) {
  automationRuns.set(name, state);
  setSetting(`automation_run:${name}`, JSON.stringify(state));
}
async function runGuardedSweep(name, fn) {
  if (runningSweeps.has(name)) return { ok: false, busy: true };
  runningSweeps.add(name);
  try {
    recordAutomationRun(name, { status: 'running', startedAt: Date.now(), finishedAt: null, error: null });
    const result = await fn();
    recordAutomationRun(name, { status: 'ok', startedAt: automationRuns.get(name).startedAt, finishedAt: Date.now(), error: null });
    return { ok: true, result };
  } catch (err) {
    recordAutomationRun(name, { status: 'failed', startedAt: automationRuns.get(name).startedAt, finishedAt: Date.now(), error: err.message });
    throw err;
  } finally {
    runningSweeps.delete(name);
  }
}

function channelFor(kind) {
  const map = {
    requests: CONFIG.REQUESTS_CHANNEL_ID,
    system: CONFIG.SYSTEM_ALERTS_CHANNEL_ID,
    downloads: CONFIG.DOWNLOADS_CHANNEL_ID,
    playback: CONFIG.PLAYBACK_CHANNEL_ID,
    cleanup: CONFIG.CLEANUP_CHANNEL_ID,
    audit: CONFIG.AUDIT_CHANNEL_ID,
    deploy: CONFIG.DEPLOY_CHANNEL_ID || null,
    whats_new: CONFIG.WHATS_NEW_CHANNEL_ID,
  };
  const configured = Object.prototype.hasOwnProperty.call(map, kind) ? map[kind] : undefined;
  if (kind === 'deploy') return configured;
  return configured || CONFIG.ADMIN_CHANNEL_ID;
}

// Returns a promise resolving true when the message actually reached Discord. Callers are free to
// ignore it — but the failure is never silent: a bad channel ID, a channel in another guild, or a
// missing Send Messages permission gets logged instead of being swallowed, which is what made a
// dead DEPLOY_CHANNEL_ID look like a perfectly healthy startup.
async function notifyChannel(kind, msg) {
  const channelId = channelFor(kind);
  if (!channelId) return false;
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    log.warn(`Notification to '${kind}' channel ${channelId} dropped: ${describeChannelError(err)}`);
    return false;
  }
  if (!channel) {
    log.warn(`Notification to '${kind}' channel ${channelId} dropped: channel not found (wrong ID, or the bot isn't in that server)`);
    return false;
  }
  if (typeof channel.send !== 'function') {
    log.warn(`Notification to '${kind}' channel ${channelId} dropped: that channel type can't receive messages (category or forum parent?)`);
    return false;
  }
  try {
    await channel.send(msg);
    return true;
  } catch (err) {
    log.warn(`Notification to '${kind}' channel ${channelId} failed to send: ${describeChannelError(err)}`);
    return false;
  }
}

// Discord's REST errors are numeric codes; the two that matter here are indistinguishable from
// each other (and from a network blip) in a bare error message.
function describeChannelError(err) {
  const code = err?.code;
  if (code === 10003) return 'Unknown Channel (10003) — the ID doesn\'t exist, or the bot isn\'t in that server';
  if (code === 50001) return 'Missing Access (50001) — the bot can\'t see that channel; give its role View Channel';
  if (code === 50013) return 'Missing Permissions (50013) — the bot can see the channel but lacks Send Messages / Embed Links';
  return `${err?.message || err}${code ? ` (code ${code})` : ''}`;
}

function notifyAdmin(msg) {
  notifyChannel('admin', msg);
}

// request_subscribers is always keyed tmdb:<id>, with a :4k suffix — a standard and a 4K
// request for the same title are tracked (and quota'd) separately by Seerr, so they need
// separate subscriber lists too; a shared key would let one edition's availability wrongly
// notify and clear subscribers still waiting on the other.
function subscriberKeyFor(tmdbId, is4k) {
  return `tmdb:${tmdbId}${is4k ? ':4k' : ''}`;
}

// Seerr's own quota only counts requests that have actually reached it — this bot's approval
// gate means a request can sit as a local 'pending' row for a while before (if ever) it's
// created there. Checking live Seerr quota alone lets someone queue several gated requests in a
// row that all pass, since none of the earlier ones have touched Seerr's counter yet. Reserving
// against this user's own still-outstanding 'pending' rows for the same media type closes that:
// each additional /request sees its predecessors as already spent, matching what would happen
// once an admin actually approves them one by one. Returns an error string to show the user, or
// null if the request is within quota.
// `exclude` lets a caller that already has its own row counted in 'pending' status (the
// approval-time recheck below) leave that one out — otherwise a request would count as its own
// reservation and every quota=1 approval would look exhausted by itself.
async function quotaBlockReason(seerrUserId, discordId, mediaType, exclude = null, surfaceFetchError = false) {
  let quota = null;
  try { quota = await fetchUserQuota(seerrUserId); } catch (err) {
    if (surfaceFetchError) throw err;
  }
  const q = quota?.[mediaType];
  if (!q || !q.limit) return null;
  const liveRemaining = Number.isFinite(q.remaining) ? q.remaining : q.limit - (q.used || 0);
  let sql = "SELECT COUNT(*) AS c FROM requests WHERE requested_by_discord_id = ? AND media_type = ? AND status = 'pending'";
  const params = [discordId, mediaType];
  if (exclude) {
    sql += ' AND NOT (media_id = ? AND is_4k = ?)';
    params.push(`tmdb:${exclude.tmdbId}`, exclude.is4k ? 1 : 0);
  }
  const reserved = db.prepare(sql).get(...params).c;
  if (liveRemaining - reserved > 0) return null;
  return `❌ You're out of ${mediaType === 'tv' ? 'series' : 'movie'} request quota for now — ${quotaLine(quota, mediaType)}${reserved ? ` (${reserved} of your other requests are still awaiting approval)` : ''}. Check \`/me\` for your current standing.`;
}

// Resolves the real tmdbId for a requests row regardless of which form its media_id is
// currently in. Rows start out tmdb:-keyed (the only identifier available at /request time), but
// a TV row gets a second, tvdb:-keyed row once Seerr assigns a tvdbId — so a tvdb:-keyed row's
// own media_id is not a tmdbId at all, and must never be treated as one (that mistake is what
// broke #75 handoff for approved TV requests).
//
// The sibling tmdb:-keyed row can't be found via overseerr_request_id: handleGateApprove's
// second upsertRequest call (the one that keeps that row in sync) deliberately passes a null
// request id, because overseerr_request_id is UNIQUE and the tvdb:-keyed row already claims the
// real one. Both rows are written back-to-back from the same `pending` object, so
// (requested_by_discord_id, media_type, is_4k, title) is what's actually shared and reliable —
// unlike a shared request id, which was never true in the first place.
function resolveTmdbId(row) {
  if (row.media_id.startsWith('tmdb:')) return Number(row.media_id.split(':')[1]);
  const sibling = db.prepare(`
    SELECT media_id FROM requests
    WHERE media_id LIKE 'tmdb:%' AND media_type = ? AND is_4k = ? AND title = ?
      AND requested_by_discord_id IS ?
    ORDER BY id DESC LIMIT 1
  `).get(row.media_type, row.is_4k, row.title, row.requested_by_discord_id);
  return sibling ? Number(sibling.media_id.split(':')[1]) : null;
}

function findRequestQueueItem(row, items, tvdbId = null) {
  const sourceMatches = item => row.media_type === 'tv'
    ? item.source.kind === 'tv'
    : item.source.kind === 'movie' && (row.is_4k ? item.source.label === 'radarr-4k' : item.source.label !== 'radarr-4k');
  const mediaId = row.media_id.startsWith('tvdb:') ? Number(row.media_id.split(':')[1]) : tvdbId;
  const tmdbId = row.media_type === 'movie' ? resolveTmdbId(row) : null;
  const byId = items.find(item => sourceMatches(item)
    && (row.media_type === 'movie' ? Number(item.movieTmdbId) === tmdbId : Number(item.seriesTvdbId) === mediaId));
  if (byId) return byId;
  const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const title = norm(row.title);
  return items.find(item => {
    const candidate = norm(item.title);
    return sourceMatches(item) && title && candidate && (candidate.includes(title) || title.includes(candidate));
  }) || null;
}

function requestProgressDmEnabled(discordId) {
  return getSetting(`request_progress_dm:${discordId}`) !== '0';
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
  const row = db.prepare('SELECT updated_at FROM app_settings WHERE key = ?').get(`pending_email:${discordId}`);
  if (!row) return false;
  if (Date.now() - Date.parse(`${row.updated_at.replace(' ', 'T')}Z`) > CONFIG.PENDING_EMAIL_EXPIRY_DAYS * 86400000) {
    clearPendingEmail(discordId);
    return false;
  }
  return true;
}
function clearPendingEmail(discordId) {
  pendingEmailRequests.delete(discordId);
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(`pending_email:${discordId}`);
  clearPendingHomeServer(discordId);
}
function rehydratePendingEmails() {
  const rows = db.prepare("SELECT key FROM app_settings WHERE key LIKE 'pending_email:%'").all();
  for (const r of rows) pendingEmailRequests.set(r.key.slice('pending_email:'.length), true);
  if (rows.length) log.info(`Rehydrated ${rows.length} pending onboarding request(s)`);
}

// A DM onboarding requester's server pick, made via the "Main / Philippines" buttons before they
// reply with their email — read once the email lands, then discarded. Absence just means primary
// (the pre-PH default), so this only ever needs to persist the 'ph' case.
function phServerConfigured() { return CONFIG.PH_SERVER_NAMES.length > 0; }
function setPendingHomeServer(discordId, server) {
  if (server === 'ph') setSetting(`pending_home_server:${discordId}`, 'ph');
  else clearPendingHomeServer(discordId);
}
function takePendingHomeServer(discordId) {
  const server = getSetting(`pending_home_server:${discordId}`) === 'ph' ? 'ph' : 'primary';
  clearPendingHomeServer(discordId);
  return server;
}
function clearPendingHomeServer(discordId) {
  deleteSetting(`pending_home_server:${discordId}`);
}
const requestCommandLimits = new Map();
// Deliberately NOT in RATE_LIMIT_MAPS: its window is 24h and the hourly reaper would wipe the
// counts. It holds at most one small bucket per family member.
const stageCommandLimits = new Map();

// Keyed by client IP / user id, these maps only ever grew. Drop buckets whose newest hit is
// older than an hour so a scan of unique IPs can't slowly eat memory.
const RATE_LIMIT_MAPS = [requestCommandLimits];
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

function httpRateLimitKey(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return ip === 'unknown' ? ip : ipKeyGenerator(ip);
}

const plexWebhookAccountCache = { expiresAt: 0, emails: new Map() };
async function resolvePlexWebhookEmail(accountId) {
  const key = String(accountId ?? '');
  if (!key) return null;
  if (Date.now() < plexWebhookAccountCache.expiresAt) return plexWebhookAccountCache.emails.get(key) || null;

  const token = await getPlexToken();
  const [friendsResult, ownerResult] = await Promise.allSettled([
    fetchPlexFriends(token),
    plexApiGet('/api/v2/user', token),
  ]);
  if (friendsResult.status === 'rejected') log.warn(`Could not resolve Plex webhook friends: ${friendsResult.reason.message}`);
  if (ownerResult.status === 'rejected') log.warn(`Could not resolve Plex webhook owner: ${ownerResult.reason.message}`);
  if (friendsResult.status === 'rejected' && ownerResult.status === 'rejected') return null;

  const friends = friendsResult.status === 'fulfilled' ? friendsResult.value : [];
  const ownerData = ownerResult.status === 'fulfilled' ? ownerResult.value : null;
  const owner = ownerData?.user || ownerData?.data || ownerData;
  const emails = new Map();
  for (const account of [...friends, owner].filter(Boolean)) {
    if (account.id != null && isValidEmail(account.email)) emails.set(String(account.id), account.email.toLowerCase().trim());
  }
  plexWebhookAccountCache.emails = emails;
  plexWebhookAccountCache.expiresAt = Date.now() + 10 * 60000;
  return emails.get(key) || null;
}

function webhookUserKey(email) {
  if (!isValidEmail(email)) return null;
  const canonical = canonicalizeEmail(email);
  if (!canonical || canonical.startsWith('__placeholder__:')) return null;
  const user = getUserByCanonicalEmail(email);
  return isSnowflake(user?.discord_id) ? `discord:${user.discord_id}` : `email:${canonical}`;
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
const gatherHealth = createHealthChecker({
  config: CONFIG,
  client,
  db,
  fs,
  axios,
  audit,
  getSetting,
  backupState,
  getPlexToken,
  plexApiGet,
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

// Discord IDs with a plex_approve/plex_deny click currently in flight. Unlike request_approve/
// request_deny (which claim a nonce with an atomic SELECT+DELETE), this button acts straight on
// the users table across several awaited API calls — without this, two admins double-clicking (or
// one admin double-clicking) both pass the initial lookup before either finishes, producing
// duplicate Plex invites / Seerr users / DMs for the same person.
const plexGateInFlight = new Set();
const buttonActionsInFlight = new Set();

// "45m" / "1h 30m" — the escalation delay as shown in embeds and logs.
const escalationDelayLabel = () => fmtDuration(tunable('ESCALATION_DELAY_MINUTES') * 60000);

// What pre-authorization actually buys, per media type — auto-escalation is narrower than the
// flag (see autoEscalateAllowed in src/escalation.js), so the approval embeds have to promise
// the narrower thing or an admin reads the later button prompt as a bug.
const preAuthOutcomeLabel = () => 'escalates on its own if the title looks like Asian content (AvistaZ carries nothing else), otherwise it asks first';

// Whether this request could be escalated to AvistaZ (feature on, right media type, arr present).
function canEscalate({ mediaType, is4k }) {
  return escalationEligible({ mediaType, is4k }, {
    enabled: tunable('ESCALATION_ENABLED'),
    radarrConfigured: !!CONFIG.RADARR_URL,
    sonarrConfigured: !!CONFIG.SONARR_URL,
  });
}

// Post the Approve/Deny gate embed for a stashed /request to the requests channel.
async function postPendingRequestNotice(nonce, { label, mediaType, is4k, discordId, email, seerrUserId, tmdbId }) {
  const channel = await safeGetChannel(channelFor('requests'));
  if (!channel) return false;
  const azEligible = canEscalate({ mediaType, is4k });
  let quota = null;
  try { quota = await fetchUserQuota(seerrUserId); } catch (_e) {}
  const quotaText = quotaLine(quota, mediaType);
  const subscriberCount = tmdbId != null ? countRequestSubscribers(subscriberKeyFor(tmdbId, is4k)) : 0;
  const embed = brandedEmbed(COLORS.INFO)
    .setTitle(`${mediaTypeEmoji(mediaType, is4k)} New Request`)
    .setDescription(`**${label}**${azEligible ? `\n-# "+ AvistaZ Fallback" pre-authorizes the private tracker if nothing public shows up within ${escalationDelayLabel()} — it then ${preAuthOutcomeLabel(mediaType)}.` : ''}`)
    .addFields(
      { name: 'Requested by', value: `<@${discordId}> · \`${email}\``, inline: true },
      { name: 'Type', value: mediaTypeLabel(mediaType, is4k), inline: true },
      { name: 'Status', value: '⏳ Awaiting approval', inline: true },
      ...(quotaText ? [{ name: 'Requester quota', value: quotaText, inline: false }] : []),
      ...(subscriberCount > 0 ? [{ name: 'Also wanted by', value: `${subscriberCount} other member${subscriberCount === 1 ? '' : 's'}`, inline: false }] : []),
    )
    .setFooter({ text: 'Durant Media Server · Not sent to Seerr until approved' });
  const buttons = [
    new ButtonBuilder().setCustomId(`request_approve:${nonce}`).setLabel('Approve').setStyle(ButtonStyle.Success),
  ];
  if (azEligible) buttons.push(new ButtonBuilder().setCustomId(`request_approve_az:${nonce}`).setLabel('Approve + AvistaZ Fallback').setStyle(ButtonStyle.Primary));
  buttons.push(new ButtonBuilder().setCustomId(`request_deny:${nonce}`).setLabel('Deny').setStyle(ButtonStyle.Danger));
  const row = new ActionRowBuilder().addComponents(...buttons);
  const message = await channel.send({ embeds: [embed], components: [row] });
  if (!setPendingRequestNotice(nonce, message.channelId, message.id)) {
    await message.edit({ components: [] });
    return 'handled';
  }
  return true;
}

async function closePendingRequestNotice(pending) {
  if (!pending.approvalChannelId || !pending.approvalMessageId) return;
  const channel = await client.channels.fetch(pending.approvalChannelId);
  const message = await channel.messages.fetch(pending.approvalMessageId);
  await message.edit({ components: [] });
}

async function sweepPendingApprovals() {
  const now = Date.now();
  const pending = listPendingRequests();
  let expired = 0; let requesterUpdates = 0;
  for (const item of pending) {
    const age = now - Number(item.createdAt || 0);
    if (age >= tunable('PENDING_APPROVAL_EXPIRE_DAYS') * 86400000) {
      const claimed = takePendingRequest(item.nonce);
      if (!claimed) continue;
      db.prepare("UPDATE requests SET status = 'cancelled' WHERE requested_by_discord_id = ? AND media_id = ? AND is_4k = ? AND status = 'pending'")
        .run(claimed.discordId, `tmdb:${claimed.tmdbId}`, claimed.is4k ? 1 : 0);
      await dmUser(claimed.discordId, { embeds: [brandedEmbed(COLORS.WARN)
        .setTitle('Request Approval Expired')
        .setDescription(`**${claimed.label}** was not reviewed within ${tunable('PENDING_APPROVAL_EXPIRE_DAYS')} days, so it expired without reaching Seerr. You can submit it again with \`/request\`.`)] });
      await closePendingRequestNotice(claimed).catch(err => log.warn(`Could not close expired approval notice for ${claimed.label}: ${err.message}`));
      deleteSetting(`pending_requester_update:${item.nonce}`);
      audit('request_approval_expired', { targetDiscordId: claimed.discordId, title: claimed.label, nonce: item.nonce });
      expired++;
      continue;
    }
    if (age >= tunable('PENDING_APPROVAL_REQUESTER_HOURS') * 3600000 && !getSetting(`pending_requester_update:${item.nonce}`)) {
      await dmUser(item.discordId, `⏳ **${item.label}** is still waiting for an admin to review it. Nothing has been sent to Seerr yet.`);
      setSetting(`pending_requester_update:${item.nonce}`, String(now));
      requesterUpdates++;
    }
  }

  const overdue = listPendingRequests().filter(item => now - Number(item.createdAt || 0) >= tunable('PENDING_APPROVAL_NUDGE_HOURS') * 3600000);
  const fingerprint = overdue.map(item => item.nonce).sort().join(',');
  if (fingerprint && fingerprint !== getSetting('pending_approval_nudge_fingerprint')) {
    const oldest = Math.max(...overdue.map(item => now - Number(item.createdAt || now)));
    const sent = await notifyChannel('requests', `⏳ **${overdue.length} request${overdue.length === 1 ? '' : 's'} waiting for approval** · oldest ${fmtDuration(oldest)}\n${overdue.slice(0, 10).map(item => `• **${item.label}** — <@${item.discordId}>`).join('\n')}\nRun \`/pending\` to review them.`);
    if (sent) setSetting('pending_approval_nudge_fingerprint', fingerprint);
  } else if (!fingerprint) {
    deleteSetting('pending_approval_nudge_fingerprint');
  }
  return { acted: expired + requesterUpdates, expired, requesterUpdates, waiting: overdue.length };
}

const { approveGatedRequest, denyGatedRequest } = createRequestGate({
  takePendingRequest,
  restashPendingRequest,
  quotaBlockReason,
  createSeerrRequestAs,
  verifySeerrRequestCreated,
  markApprovalNoticePosted,
  upsertRequest,
  canEscalate,
  recordEscalationWatch,
  tagPreAuthorizedMedia,
  bumpTrustScore,
  resetTrustScore,
  addRequestSubscriber,
  subscriberKeyFor,
  audit,
  log,
  closePendingRequestNotice,
  notifyApproved: pending => dmUser(pending.discordId, { embeds: [brandedEmbed(COLORS.SUCCESS)
    .setTitle(`${mediaTypeEmoji(pending.mediaType, pending.is4k)} Request Approved`)
    .setDescription(`**${pending.label}** was approved and is being grabbed now. You'll get a DM when it's on Plex! 🍿`)] }),
  notifyAlreadyRequested: (pending, subscribed) => dmUser(pending.discordId, { embeds: [brandedEmbed(COLORS.INFO)
    .setTitle(`${mediaTypeEmoji(pending.mediaType, pending.is4k)} Already Requested`)
    .setDescription(`Good news — **${pending.label}** is already in the system (requested earlier or already available).${subscribed ? ' I\'ll DM you when it lands.' : ''} Check Plex, or track it with \`/request-status\`.`)] }),
  notifyDenied: pending => dmUser(pending.discordId, { embeds: [brandedEmbed(COLORS.DANGER)
    .setTitle('Request Declined')
    .setDescription(`Sorry — **${pending.label}** was declined. Reach out to an admin if you think this was a mistake.`)] }),
});

async function handleGateApprove(interaction, nonce, { azPreAuth }) {
  await interaction.deferUpdate();
  const actor = { kind: 'discord', id: interaction.user.id, label: interaction.user.tag || interaction.user.username || interaction.user.id };
  const result = await approveGatedRequest({ nonce, actor, azPreAuth });
  if (result.error === 'already_handled') return interaction.editReply({ content: 'ℹ️ Already handled (or expired).', components: [] });
  const pending = result.pending;
  if (!result.verified && result.restashed && result.requestId != null) {
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.WARN)
      .setTitle(`⚠️ Seerr lost the request — ${pending.label}`)
      .setDescription(`Seerr accepted request #${result.requestId} for <@${pending.discordId}>, but ${result.error}.\nNothing will download. Check the Seerr container logs from the last minute for the underlying error, then hit Approve again to retry.`)] });
  }
  if (result.collision) {
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.WARN)
      .setTitle(`ℹ️ Already in Seerr — ${pending.label}`)
      .setDescription(`Approved by <@${interaction.user.id}> for <@${pending.discordId}>, but Seerr says: *${result.error}*. Nothing new was created — it's already requested or available. <@${pending.discordId}> is now subscribed to the availability DM.`)], components: [] });
  }
  if (!result.ok) return interaction.followUp({ content: `❌ Approving failed: ${result.error}. The buttons still work — try again.`, ephemeral: true });
  return interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS)
    .setTitle(`✅ Approved — ${pending.label}`)
    .setDescription(`Approved by <@${interaction.user.id}> for <@${pending.discordId}> — sent to Seerr${result.requestId != null ? ` (request #${result.requestId})` : ''}.${azPreAuth ? `\n🔐 AvistaZ fallback pre-authorized — tagging it \`${CONFIG.AVISTAZ_TAG}\` now. If nothing public is grabbed within ${escalationDelayLabel()} it ${preAuthOutcomeLabel(pending.mediaType)}.` : ''}${result.quotaWarning ? `\n⚠️ Note: <@${pending.discordId}> is over quota as of this approval — ${result.quotaWarning.replace(/^❌\s*/, '')}` : ''}`)], components: [] });
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
  const groups = planStuckDownloads(items, stuckTracker, tunable('STUCK_AFTER_MINUTES'), now);

  // Group keys for everything currently in the queue (not just the stuck ones) — used to prune
  // alert-cooldown rows and stale ignore flags once a group leaves the queue entirely.
  const activeGroups = new Set(items.map(stuckGroupKey));
  for (const row of listAlertCooldowns('stuck')) if (!activeGroups.has(row.alert_key)) clearAlertCooldown('stuck', row.alert_key);

  let alerted = 0;
  for (const [gk, group] of groups) {
    if (getSetting(`stuck_ignore:${gk}`)) continue;
    if (now - getAlertedAt('stuck', gk) < tunable('STUCK_ALERT_COOLDOWN_HOURS') * 3600000) continue;
    setAlertedAt('stuck', gk, now);
    const { embed, row } = buildStuckAlert(group);
    notifyChannel('downloads', { embeds: [embed], components: [row] });
    audit('stuck_download_detected', { groupKey: gk, label: group.source.label, count: group.members.length, frozenMinutes: Math.round(group.maxFrozenMs / 60000) });
    alerted++;
  }

  // Clear ignore flags whose group has fully left the queue, so a future download reusing the
  // same key can't be silently ignored.
  const ignoreRows = db.prepare("SELECT key FROM app_settings WHERE key LIKE 'stuck_ignore:%'").all();
  for (const r of ignoreRows) {
    if (!activeGroups.has(r.key.slice('stuck_ignore:'.length))) db.prepare('DELETE FROM app_settings WHERE key = ?').run(r.key);
  }
  return { detected: groups.size, alerted };
}

function planStuckDownloads(items, tracker, afterMinutes, now = Date.now()) {
  return groupStuckItems(detectStuckItems(items, tracker, { stuckAfterMs: afterMinutes * 60000, now }));
}

function previewRuntimeValue(values, key) {
  if (!Object.prototype.hasOwnProperty.call(values || {}, key)) return tunable(key);
  const setting = runtimeSettings.settingByKey(key);
  const parsed = runtimeSettings.validate(setting, values[key]);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

// Previewing should be useful without allowing one dashboard click to walk an unbounded remote
// library or watch list. Individual preview functions may stop sooner when their own result set
// is complete, but none should perform more than this many per-item lookups.
const PREVIEW_ITEM_LIMIT = 60;

async function previewStuckDownloads(values = {}) {
  const items = await fetchArrQueues();
  const now = Date.now();
  const afterMinutes = previewRuntimeValue(values, 'STUCK_AFTER_MINUTES');
  const cooldownHours = previewRuntimeValue(values, 'STUCK_ALERT_COOLDOWN_HOURS');
  const groups = planStuckDownloads(items, new Map(stuckTracker), afterMinutes, now);
  return [...groups.entries()].map(([key, group]) => {
    const lastAlerted = getAlertedAt('stuck', key);
    const ignored = !!getSetting(`stuck_ignore:${key}`);
    const cooling = !ignored && now - lastAlerted < cooldownHours * 3600000;
    return {
      title: isSeasonGroup(group)
        ? `${group.members[0].item.seriesTitle} Season ${group.members[0].item.seasonNumber}`
        : group.members[0].item.title,
      reason: ignored
        ? 'ignored by administrator'
        : cooling
          ? `alert cooldown until ${new Date(lastAlerted + cooldownHours * 3600000).toISOString()}`
          : `${group.members.length} queue item(s) frozen for ${Math.round(group.maxFrozenMs / 60000)} minutes at the ${afterMinutes}-minute threshold`,
      stage: ignored ? 'ignored' : cooling ? 'cooldown' : 'alert',
    };
  });
}

// ---- AvistaZ escalation watchdog ----
// Public indexers get first crack at every approved request. When nothing has been grabbed after
// ESCALATION_DELAY_MINUTES, the request either auto-escalates to AvistaZ (admin pre-authorized it
// at approval time) or an admin gets an embed with an "Escalate to AvistaZ" button. Escalation
// tags the movie/series so the tag-gated AvistaZ indexer applies to it, then re-searches.

// The facts decideEscalationAction needs: did the public pipeline already deliver?
async function gatherEscalationFacts(row, queue, { persist = true } = {}) {
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
    if (tvdbId) {
      if (persist) setEscalationTvdbId(row.id, tvdbId);
      row.tvdb_id = tvdbId;
    }
  }
  const hasQueueItem = !!row.tvdb_id && queue.some(q => q.source.kind === 'tv' && q.seriesTvdbId === row.tvdb_id);
  if (hasQueueItem) return { isAvailable: false, hasQueueItem: true, hasFile: false, inArr: true };
  let series = null, inArr = null;
  if (row.tvdb_id) {
    try { series = await getSeriesByTvdbId(row.tvdb_id); inArr = !!series; } catch (_e) { /* unreachable arr */ }
  }
  return { isAvailable: false, hasQueueItem: false, hasFile: (series?.statistics?.episodeFileCount || 0) > 0, inArr };
}

// The AvistaZ-plausibility verdict for one watch row: the cached column when it's already
// decided, otherwise one Seerr origin lookup. Only a decided verdict is cached — 'unknown'
// (Seerr unreachable, bare TMDB record) is left NULL so a blip can't permanently strand a show
// on the "ask a human" path. The reasons ride along on the row for this sweep's embed only.
async function resolveAvistazFit(row, { persist = true } = {}) {
  if (row.avistaz_fit) return row.avistaz_fit;
  const meta = await fetchSeerrMediaOrigin(row.media_type, row.tmdb_id);
  const { verdict, reasons } = meta ? assessAsianOrigin(meta) : { verdict: 'unknown', reasons: [] };
  row.avistazFitReasons = reasons;
  if (persist && verdict !== 'unknown') {
    setEscalationAvistazFit(row.id, verdict);
    row.avistaz_fit = verdict;
    audit('avistaz_fit_assessed', { mediaId: row.media_id, title: row.title, verdict, reasons });
  }
  return verdict;
}

function escalationPreviewReason(action, row, facts, now, cfg) {
  const arrName = row.media_type === 'movie' ? 'Radarr' : 'Sonarr';
  switch (action) {
    case 'wait':
      if (now - row.approved_at < cfg.delayMinutes * 60000) {
        return `waiting on delay until ${new Date(row.approved_at + cfg.delayMinutes * 60000).toISOString()}`;
      }
      if (facts.inArr === false && row.arr_missing_alerted) return `already alerted that title is missing from ${arrName}`;
      if (facts.inArr === false) return `waiting for ${arrName} hand-off grace period`;
      return 'waiting for the public pipeline';
    case 'escalate': return 'pre-authorized and eligible for AvistaZ now';
    case 'alert': return 'ready for administrator approval now';
    case 'resolve': return 'public pipeline already has the title';
    case 'expire': return `older than ${cfg.maxAgeDays} days`;
    case 'alert_missing': return `missing from ${arrName}`;
    default: throw new Error(`Unmapped escalation preview action: ${action}`);
  }
}

async function previewEscalations(values = {}) {
  if (!previewRuntimeValue(values, 'ESCALATION_ENABLED')) return [];
  const cfg = {
    delayMinutes: previewRuntimeValue(values, 'ESCALATION_DELAY_MINUTES'),
    maxAgeDays: previewRuntimeValue(values, 'ESCALATION_MAX_AGE_DAYS'),
    arrGraceMinutes: CONFIG.ESCALATION_ARR_GRACE_MINUTES,
  };
  const rows = getWatchingEscalations().map(row => ({ ...row }));
  if (!rows.length) return [];
  const queue = await fetchArrQueues();
  const now = Date.now();
  const items = [];
  for (const row of rows) {
    if (items.length >= PREVIEW_ITEM_LIMIT) break;
    const facts = await gatherEscalationFacts(row, queue, { persist: false });
    const age = now - row.approved_at;
    if (!facts.isAvailable && !facts.hasQueueItem && !facts.hasFile && age >= cfg.delayMinutes * 60000) {
      facts.avistazFit = await resolveAvistazFit(row, { persist: false });
    }
    const action = decideEscalationAction(row, facts, now, cfg);
    const reason = escalationPreviewReason(action, row, facts, now, cfg);
    items.push({ title: row.title, reason, stage: action });
  }
  return items;
}

async function runEscalation(row) {
  // TV can use the direct-grab pipeline first: the bot searches AvistaZ itself and either
  // auto-grabs or posts scored candidates, then falls back to the tag-based Sonarr path when
  // the search finds nothing. Movies deliberately skip this branch and go straight to Radarr's
  // tag + MoviesSearch path so Radarr remains responsible for accepting the release.
  if (usesDirectGrabEscalation(row) && grabConfigured()) {
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
  if (!rows.length) return { acted: 0 };
  const queue = await fetchArrQueues();
  const cfg = { delayMinutes: tunable('ESCALATION_DELAY_MINUTES'), maxAgeDays: tunable('ESCALATION_MAX_AGE_DAYS'), arrGraceMinutes: CONFIG.ESCALATION_ARR_GRACE_MINUTES };
  let acted = 0;
  for (const row of rows) {
    const facts = await gatherEscalationFacts(row, queue);
    // Whether AvistaZ could plausibly have this title gates auto-escalation (and colours the
    // alert). Resolved only for rows the public pipeline hasn't served that are old enough to
    // be decided this sweep — a row still inside its delay never pays for the lookup.
    if (!facts.isAvailable && !facts.hasQueueItem && !facts.hasFile && Date.now() - row.approved_at >= cfg.delayMinutes * 60000) {
      facts.avistazFit = await resolveAvistazFit(row);
    }
    const action = decideEscalationAction(row, facts, Date.now(), cfg);
    if (action === 'wait') continue;
    acted++;
    if (action === 'resolve') {
      setEscalationState(row.id, 'resolved');
      audit('escalation_resolved', { mediaId: row.media_id, title: row.title, facts });
      continue;
    }
    if (action === 'expire') {
      setEscalationState(row.id, 'expired');
      audit('escalation_expired', { mediaId: row.media_id, title: row.title });
      if (row.requested_by_discord_id && requestProgressDmEnabled(row.requested_by_discord_id)) {
        await dmUser(row.requested_by_discord_id, `⚠️ **${row.title}** could not be found by any configured source within ${cfg.maxAgeDays} days. It is no longer being escalated automatically; ask an admin if you want it retried.`);
        audit('request_exhausted_notified', { targetDiscordId: row.requested_by_discord_id, mediaId: row.media_id, title: row.title });
      }
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
          ? `Nothing public showed up in ${waited}, the fallback was pre-authorized at approval, and this looks like Asian content — so it went automatically.\n${result.detail}`
          : `Auto-escalation was pre-authorized but failed: ${result.why}`)] });
      continue;
    }
    // action === 'alert': one embed per title (state moves to 'alerted' and stays there until a
    // button is clicked or the media resolves). Buttons survive restarts — state is in SQLite.
    setEscalationState(row.id, 'alerted');
    audit('escalation_alerted', { mediaId: row.media_id, title: row.title, waited, avistazFit: facts.avistazFit || null, preAuthorized: !!row.pre_authorized });
    // Escalating a title that isn't out yet is pointless — surface the release timing so the
    // admin can tell "no seeders" apart from "not released".
    const eta = releaseEtaInfo(await fetchReleaseEta({ mediaType: row.media_type, tmdbId: row.tmdb_id, tvdbId: row.tvdb_id }));
    // A pre-authorized row that lands here was held back because its origin was not clearly in
    // AvistaZ's remit. Say so — otherwise "I pre-authorized this" and "it's asking me anyway"
    // look like a bug.
    const heldBack = row.pre_authorized
      ? '\n🔐 The AvistaZ fallback was pre-authorized, but this does not clearly look like Asian content, and only obviously-Asian titles escalate on their own. Your call:'
      : '';
    const alertEmbed = brandedEmbed(COLORS.WARN)
      .setTitle(`⏳ Nothing Found Yet — ${row.title}`)
      .setDescription(`No public release grabbed in **${waited}** since approval.${heldBack} Escalate to AvistaZ (private tracker → seedbox)?`)
      .addFields(
        { name: 'Requested by', value: row.requested_by_discord_id ? `<@${row.requested_by_discord_id}>` : 'Unknown', inline: true },
        { name: 'Type', value: mediaTypeLabel(row.media_type, false), inline: true },
        { name: 'AvistaZ fit', value: describeAvistazFit(facts.avistazFit, row.avistazFitReasons), inline: false },
      );
    if (eta) alertEmbed.addFields({ name: 'Release timing', value: `${eta.line}${eta.waiting ? '\nEscalating now likely won\'t help — the title isn\'t out yet.' : ''}`, inline: false });
    notifyChannel('downloads', { embeds: [alertEmbed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`escalate_az:${row.id}`).setLabel('Escalate to AvistaZ').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`escalate_ignore:${row.id}`).setLabel('Ignore').setStyle(ButtonStyle.Secondary),
      )] });
  }
  return { acted };
}

// ---- Season-pack-first searching (all indexers) ----
// Sonarr hunts missing episodes one at a time. For a show that stopped airing years ago that's
// the expensive way to get a season that exists as a single torrent, so this sweep finds old
// shows with gaps and asks Sonarr for a SeasonSearch per incomplete season instead. Shows still
// airing are skipped entirely — no pack exists for a season that's still going out weekly.
function seasonPackConfig() {
  return {
    dormantDays: tunable('SEASON_PACK_DORMANT_DAYS'),
    minMissing: tunable('SEASON_PACK_MIN_MISSING'),
    cooldownHours: CONFIG.SEASON_PACK_COOLDOWN_HOURS,
    includeRequested: tunable('SEASON_PACK_REQUESTED'),
    maxBackoffSteps: tunable('SEASON_PACK_STALL_BACKOFF_MAX_STEPS'),
  };
}

function seasonSearchCooldown(lastSearchedAt, now = Date.now()) {
  const last = Number(lastSearchedAt);
  const nextEligible = last + CONFIG.SEASON_PACK_COOLDOWN_HOURS * 3600000;
  return Number.isFinite(last) && nextEligible > now
    ? { cooling: true, nextEligible }
    : { cooling: false, nextEligible: null };
}

// Season numbers already downloading for a series, so a season mid-grab is never re-searched.
function queuedSeasons(queue, seriesId) {
  return queue.filter(q => q.source.kind === 'tv' && q.seriesId === seriesId && q.seasonNumber != null).map(q => q.seasonNumber);
}

// Both the admin button and default-off automation must recheck live state immediately before
// overriding Sonarr. Interactive-search results can be minutes old by the time verification runs,
// and a different pipeline may have started covering the season in the meantime.
async function seasonPackForceBlocker({ seriesId, seasonNumber, releaseTitle }) {
  const fallback = getSeasonEpisodeFallback(seriesId, seasonNumber);
  if (fallback?.state === 'submitted') return { reason: 'episode_fallback', fallback };
  const duplicate = findActiveContentDuplicate({ releaseTitle, mediaType: 'tv', mediaId: null });
  if (duplicate) return { reason: 'active_grab', duplicate };
  const queue = await fetchArrQueues();
  const queued = queue.find(item => item.source.kind === 'tv' && Number(item.seriesId) === Number(seriesId)
    && Number(item.seasonNumber) === Number(seasonNumber));
  return queued ? { reason: 'sonarr_queue', queued } : null;
}

async function autoForceSeasonPack({ seriesId, seriesTitle, seasonNumber, candidate }) {
  // Manual force-grab buttons deliberately surface a Sonarr-rejected pack — an admin reviewing
  // it can judge whether the rejection reason (undersized for its claimed resolution, wrong
  // language, cutoff not met, ...) still makes sense to override. Automatic force-grab has no
  // human in that loop, so it must never silently push through a release Sonarr already turned
  // down; that's exactly how an undersized 2160p pack it flagged as too small could otherwise
  // get grabbed anyway.
  if (candidate.sonarrApproved === false) {
    audit('season_pack_auto_force_refused', {
      seriesId, title: seriesTitle, season: seasonNumber, releaseTitle: candidate.title, reason: 'sonarr_rejected',
    });
    return { status: 'covered', reason: 'sonarr_rejected' };
  }
  let blocked;
  try {
    blocked = await seasonPackForceBlocker({ seriesId, seasonNumber, releaseTitle: candidate.title });
  } catch (err) {
    audit('season_pack_auto_force_failed', { seriesId, title: seriesTitle, season: seasonNumber, releaseTitle: candidate.title, stage: 'safety_check', error: err.message });
    return { status: 'failed', error: err.message };
  }
  if (blocked) {
    audit('season_pack_auto_force_refused', {
      seriesId, title: seriesTitle, season: seasonNumber, releaseTitle: candidate.title, reason: blocked.reason,
      jobId: blocked.duplicate?.job?.id ?? null,
    });
    return { status: 'covered', reason: blocked.reason, blocked };
  }
  clearSeasonEpisodeFallback(seriesId, seasonNumber);
  try {
    await forceGrabRelease({ guid: candidate.guid, indexerId: candidate.indexerId });
  } catch (err) {
    audit('season_pack_auto_force_failed', { seriesId, title: seriesTitle, season: seasonNumber, releaseTitle: candidate.title, stage: 'force_grab', error: err.message });
    return { status: 'failed', error: err.message };
  }
  audit('season_pack_auto_force_grabbed', {
    seriesId, title: seriesTitle, season: seasonNumber, releaseTitle: candidate.title,
    indexer: candidate.indexer, seeders: candidate.seeders, confidence: candidate.confidence,
  });
  return { status: 'grabbed' };
}

async function verifySeasonSearchCommand({ seriesId, seriesTitle, seriesYear = null, seriesAliases = null, seasonNumber, missingAtSearch, commandId, searchedAt = 0, stallCount = 0 }) {
  const command = await pollArrCommand({ url: CONFIG.SONARR_URL, key: CONFIG.SONARR_API_KEY }, commandId, 10 * 60000);
  const status = command.status || 'unknown';
  const [episodes, queue, history] = await Promise.all([
    getSeriesEpisodes(seriesId),
    fetchArrQueues(),
    getSeasonDownloadHistory(seriesId, seasonNumber, searchedAt).catch(err => {
      audit('external_api_error', { provider: 'sonarr', error: err.message, action: 'season_search_history', seriesId, season: seasonNumber });
      return [];
    }),
  ]);
  const missingEpisodes = episodes.filter(ep => Number(ep.seasonNumber) === seasonNumber && ep.monitored && !ep.hasFile
    && Date.parse(ep.airDateUtc || ep.airDate || '') <= Date.now());
  const remaining = missingEpisodes.length;
  const matchingQueue = queue.filter(item => item.source.kind === 'tv' && item.seriesId === seriesId && Number(item.seasonNumber) === seasonNumber);
  const queued = matchingQueue.length;
  const fill = summarizeSeasonFillActivity([...matchingQueue, ...history]);
  const commandText = [command.message, command.result, command.exception].filter(Boolean).join(' ');
  const downloadedMatch = /(\d+)\s+reports?\s+downloaded/i.exec(commandText);
  const downloaded = downloadedMatch ? Number(downloadedMatch[1]) : null;
  const label = `${seriesTitle} S${pad(seasonNumber)}`;
  let outcome;
  let title;
  let description;
  let nextStep;
  let color = COLORS.WARN;

  if (!['completed', 'failed', 'aborted'].includes(status)) {
    outcome = 'timed_out';
    title = `⏱️ Season Search Not Confirmed — ${label}`;
    description = `Sonarr's search command is still \`${status}\` after 10 minutes — its task queue may be wedged.`;
    nextStep = 'Check Sonarr → System → Tasks. Restarting Sonarr clears a stuck command queue; the season can be searched again after the cooldown.';
  } else if (status !== 'completed') {
    outcome = status;
    title = `❌ Season Search ${status === 'aborted' ? 'Aborted' : 'Failed'} — ${label}`;
    description = `Sonarr ended the season search as \`${status}\`.${commandText ? `\n\`\`\`${commandText.slice(0, 900)}\`\`\`` : ''}`;
    nextStep = 'Check Sonarr → System → Events and Logs before retrying.';
    color = COLORS.DANGER;
  } else if (remaining < missingAtSearch) {
    outcome = remaining === 0 ? 'verified' : 'partial';
    const method = fill.mode === 'pack' ? 'Season Pack'
      : fill.mode === 'episodes' ? 'Episode Releases'
        : fill.mode === 'mixed' ? 'Mixed Releases'
          : 'Season Search';
    title = `${remaining === 0 ? `✅ ${method} Verified` : `🟡 ${method} Partially Filled`} — ${label}`;
    description = remaining
      ? `Sonarr completed the search and filled some of the gap${fill.mode === 'pack' ? ' with a season pack' : fill.mode === 'episodes' ? ' with individual episode releases' : ''}.`
      : `Sonarr completed the search and every aired monitored episode now has a file${fill.mode === 'pack' ? ' from a season pack' : fill.mode === 'episodes' ? ' from individual episode releases' : ''}.`;
    if (remaining) nextStep = 'The remaining episodes still need an Interactive Search review in Sonarr.';
    color = COLORS.SUCCESS;
  } else if (queued || (downloaded != null && downloaded > 0)) {
    outcome = 'grabbed';
    // A repeat of the exact same non-outcome — Sonarr "grabbed" something last time too, and the
    // missing count still hasn't moved — is the dead-release-churn pattern, not a real success.
    // Say so plainly rather than reporting a queued item as good news every single sweep.
    title = stallCount > 0 ? `📥 Season Release Grabbed (still stalled) — ${label}` : `📥 Season Release Grabbed — ${label}`;
    description = `Sonarr accepted ${downloaded != null ? `**${downloaded}** release${downloaded === 1 ? '' : 's'}` : 'a release'}${queued ? ` and **${queued}** matching queue item${queued === 1 ? '' : 's'} ${queued === 1 ? 'is' : 'are'} active` : ''}.`
      + (stallCount > 0 ? ` This makes **${stallCount + 1}** consecutive sweeps without the missing count actually shrinking — whatever got queued before likely never resolved.` : '');
    // On a repeat stall, Sonarr's own queue often already names the reason (import rejection,
    // stalled transfer, upgrade blocked) via trackedDownloadStatus/statusMessages — the same
    // fields the stuck-download watchdog reads. Surface it here so the alert is self-diagnosing
    // instead of sending an admin to Sonarr's queue to find the same message.
    if (stallCount > 0) {
      const unhealthy = matchingQueue.find(item => queueItemLooksUnhealthy({ messages: [], ...item }));
      if (unhealthy) {
        const reason = String((unhealthy.messages || [])[0] || unhealthy.trackedStatus || unhealthy.status).slice(0, 300);
        description += `\nSonarr's queue reports: \`${reason}\``;
      }
    }
    nextStep = 'Import verification comes from Sonarr; the stuck-download watchdog reports a stalled queue item.';
    color = stallCount > 0 ? COLORS.WARN : COLORS.INFO;
  } else {
    outcome = 'no_grab';
    title = `🔍 No Season Release Accepted — ${label}`;
    description = 'Sonarr completed the search, but nothing entered its queue and the whole season is still missing.';
    nextStep = 'Run an Interactive Search from this season\'s header in Sonarr — that distinguishes "no indexer results" from releases rejected for quality, language, custom formats, size, seeders, blocklist, categories, or tags.';
  }

  // A completed search that made no (or only partial) progress is the one useful time to pay for
  // Sonarr's interactive release query. Eligible candidates are offered to an admin by default;
  // the separate SEASON_PACK_FORCE_GRAB switch can opt into forcing the single best candidate.
  //
  // 'grabbed' normally means the search worked and needs no further reporting — but a season
  // whose missing count keeps failing to shrink despite Sonarr repeatedly "grabbing" something is
  // exactly the dead-release-churn case (0% Premiumize transfers, defunct trackers): Sonarr
  // accepted a release into its queue, it just never resolves. Once that's happened stallCount
  // times in a row, pull the interactive report anyway — the admin sees Sonarr's own rejection
  // reasons and any better candidate it passed over, instead of the sweep silently reporting a
  // "success" that's actually a stuck season.
  const stalledGrab = outcome === 'grabbed' && stallCount > 0;
  let interactive = null;
  let interactiveError = null;
  let interactiveFingerprint = null;
  let seasonGrabCandidates = null;
  let seasonGrabOffer = null;
  let autoForceResult = null;
  let episodeFallbackEvidence = null;
  if ((['no_grab', 'partial'].includes(outcome) || stalledGrab) && tunable('SEASON_PACK_INTERACTIVE')) {
    try {
      const anchorEpisode = missingEpisodes.find(episode => Number.isInteger(Number(episode.id)) && Number(episode.id) > 0);
      const releases = await interactiveSeasonSearch(seriesId, seasonNumber, anchorEpisode?.id);
      // Sonarr titles can carry a trailing year ("Full House (2004)"), which would otherwise
      // become a required token in the title score.
      const { query: seriesQuery, year: parsedYear } = splitTitleYear(seriesTitle);
      const ranked = rankSeasonReleases(releases, {
        title: seriesQuery, season: seasonNumber, year: seriesYear ?? parsedYear, aliases: seriesAliases,
      });
      interactiveFingerprint = ranked.map(release => ({
        id: release.guid || `${release.indexerId ?? ''}:${release.title}`,
        approved: release.approved,
        downloadAllowed: release.downloadAllowed,
        rejections: release.rejections,
        customFormatScore: release.raw?.customFormatScore ?? null,
        qualityWeight: release.raw?.qualityWeight ?? null,
      })).sort((a, b) => a.id.localeCompare(b.id));
      interactive = {
        releaseCount: ranked.length,
        packCount: ranked.filter(release => release.isPack && release.coversSeason).length,
        candidates: ranked.slice(0, 3),
        anchorEpisodeNumber: Number(anchorEpisode?.episodeNumber) || null,
      };
      const choice = chooseSeasonPack(ranked, {
        minSeeders: tunable('SEASON_PACK_MIN_SEEDERS'),
        maxSizeGb: tunable('SEASON_PACK_MAX_SIZE_GB'),
        minConfidence: tunable('SEASON_PACK_MIN_CONFIDENCE'),
      });
      episodeFallbackEvidence = classifyEpisodeFallbackEvidence({
        ranked,
        packChoice: choice,
        anchorEpisode,
      });
      if (episodeFallbackEvidence.status === 'approved_episode') {
        recordSeasonEpisodeFallbackEvidence({
          seriesId, seasonNumber, seriesTitle, evidence: episodeFallbackEvidence,
        });
        audit('episode_fallback_pending', {
          seriesId, title: seriesTitle, season: seasonNumber,
          anchorEpisodeId: episodeFallbackEvidence.anchorEpisodeId,
          anchorEpisodeNumber: episodeFallbackEvidence.anchorEpisodeNumber,
          evidenceFingerprint: episodeFallbackEvidence.fingerprint,
          evidenceObservedAt: episodeFallbackEvidence.observedAt,
          remaining,
        });
      } else if (episodeFallbackEvidence.status === 'eligible_pack') {
        clearSeasonEpisodeFallback(seriesId, seasonNumber);
      }
      const eligible = [choice.pick, ...choice.runnersUp].filter(Boolean);
      if (eligible.length) {
        seasonGrabCandidates = eligible.map(release => ({
          guid: release.guid,
          indexerId: release.indexerId,
          title: release.title,
          size: release.size,
          seeders: release.seeders,
          indexer: release.indexer,
          confidence: release.confidence,
          displayedRank: ranked.indexOf(release) + 1,
          sonarrApproved: !(release.rejections || []).length,
        }));
      }
      if (seasonGrabCandidates?.length && tunable('SEASON_PACK_FORCE_GRAB')) {
        const candidate = seasonGrabCandidates[0];
        autoForceResult = await autoForceSeasonPack({ seriesId, seriesTitle, seasonNumber, candidate });
        if (autoForceResult.status === 'grabbed') {
          outcome = 'auto_forced';
          title = `📥 Season Pack Auto-Forced — ${label}`;
          description = `Sonarr's original search made incomplete progress, so the highest-ranked eligible full-season pack was automatically forced.`;
          color = COLORS.SUCCESS;
          nextStep = 'Import verification remains with Sonarr; the stuck-download watchdog reports a stalled queue item.';
          seasonGrabCandidates = null;
        } else if (autoForceResult.status === 'covered' && autoForceResult.reason === 'sonarr_rejected') {
          // Not actually resolved — leave the manual buttons in place so an admin can still
          // choose to override Sonarr's rejection with full visibility into why it happened.
          nextStep = 'Automatic force-grab declined to override Sonarr\'s rejection of the top candidate. An admin can still force one eligible pack below after reviewing the reason.';
        } else if (autoForceResult.status === 'covered') {
          outcome = 'grabbed';
          title = `ℹ️ Season Already Covered — ${label}`;
          description = autoForceResult.reason === 'active_grab'
            ? 'Automatic force-grab was skipped because another active grab job already covers this season.'
            : autoForceResult.reason === 'episode_fallback'
              ? 'Automatic force-grab was skipped because a bounded episode fallback command already owns this season.'
              : 'Automatic force-grab was skipped because Sonarr now has this season in its live queue.';
          color = COLORS.INFO;
          nextStep = 'The existing download remains responsible for filling the season.';
          seasonGrabCandidates = null;
        } else {
          nextStep = `Automatic force-grab failed: ${autoForceResult.error}. An admin can retry an eligible pack below.`;
        }
      } else nextStep = eligible.length
        ? 'An admin can force one eligible pack below. This bypasses Sonarr’s rejection; review the reason first.'
        : episodeFallbackEvidence.status === 'approved_episode' && tunable('SEASON_PACK_EPISODE_FALLBACK')
          ? `Approved episode evidence recorded. The guarded sweep will search up to ${tunable('SEASON_PACK_EPISODE_BATCH_SIZE')} live missing episodes in the next bounded batch.`
        : ranked.length
          ? `No full-season candidate passed the force-grab safety limits: ${choice.why}`
          : 'No interactive releases were returned. Check Sonarr indexers or retry after the cooldown.';
    } catch (err) {
      interactiveError = err.message;
      nextStep = 'Interactive search details could not be loaded. Check Sonarr and its indexers before retrying.';
    }
  }

  // Fields rather than one paragraph: these land in #media-alerts in batches (one per season per
  // sweep), so the numbers have to be scannable without reading a wall of prose.
  const fields = [
    { name: 'Aired missing', value: remaining === missingAtSearch ? `${remaining}` : `${missingAtSearch} → **${remaining}**`, inline: true },
    { name: 'Sonarr command', value: `\`${status}\``, inline: true },
    { name: 'In queue', value: queued ? `${queued}` : '—', inline: true },
  ];
  if (fill.mode !== 'none') {
    const fillLabels = { pack: 'Season pack', episodes: 'Individual episodes', mixed: 'Pack + episodes', unknown: 'Release shape unavailable' };
    fields.push({ name: 'Fill method', value: `${fillLabels[fill.mode]} · ${fill.releaseCount} release${fill.releaseCount === 1 ? '' : 's'}`, inline: true });
  }
  if (interactive) {
    fields.push({
      name: 'Interactive search',
      value: `${interactive.releaseCount} release${interactive.releaseCount === 1 ? '' : 's'}${interactive.anchorEpisodeNumber != null ? ` via E${pad(interactive.anchorEpisodeNumber)}` : ''} · ${interactive.packCount} full-season pack${interactive.packCount === 1 ? '' : 's'}`,
      inline: false,
    });
    for (const [index, release] of interactive.candidates.entries()) {
      const safeTitle = release.title.replace(/`/g, '\u02cb').slice(0, 700);
      const source = `${fmtSpace(release.size)} · ${release.seeders} seeder${release.seeders === 1 ? '' : 's'} · ${release.indexer}`;
      fields.push({
        name: `Candidate ${index + 1} · ${release.confidence}% match`,
        value: `\`${safeTitle}\`\n${source.slice(0, 250)}\nSonarr: ${describeRejections(release)}`.slice(0, 1024),
        inline: false,
      });
    }
  } else if (interactiveError) {
    fields.push({ name: 'Interactive search', value: `Unavailable: ${interactiveError}`.slice(0, 1024), inline: false });
  }
  if (episodeFallbackEvidence?.status === 'approved_episode') {
    fields.push({
      name: 'Episode fallback',
      value: tunable('SEASON_PACK_EPISODE_FALLBACK')
        ? `Pending · capped at ${tunable('SEASON_PACK_EPISODE_BATCH_SIZE')} episode searches for this season and ${tunable('SEASON_PACK_EPISODE_MAX_PER_RUN')} per guarded run.`
        : 'Eligible evidence recorded, but the fallback is disabled.',
      inline: false,
    });
  }
  if (autoForceResult) {
    const autoText = autoForceResult.status === 'grabbed' ? 'Best eligible pack sent to Sonarr.'
      : autoForceResult.status === 'covered' ? 'Skipped because another download already covers the season.'
        : `Failed safely: ${autoForceResult.error}`;
    fields.push({ name: 'Automatic force-grab', value: autoText.slice(0, 1024), inline: false });
  }
  let alertDecision = null;
  let shouldNotify = true;
  if (outcome === 'no_grab') {
    const fingerprint = sha256(JSON.stringify({
      missing: remaining,
      releases: interactiveFingerprint ?? (interactiveError ? 'unavailable' : 'disabled'),
      episodeFallback: episodeFallbackEvidence?.status || null,
    }));
    alertDecision = recordSeasonNoGrab({
      seriesId, seasonNumber, seriesTitle, fingerprint, missingCount: remaining,
      releaseCount: interactive?.releaseCount ?? null,
    });
    shouldNotify = alertDecision.shouldAlert;
    if (alertDecision.stoodDown) {
      fields.push({ name: 'Alert status', value: `Standing down after ${alertDecision.attemptCount} identical results. Searches continue; alerts resume when releases, rejection reasons, or the missing count change, or after a manual retry.`, inline: false });
    } else if (alertDecision.nextAlertAttempt) {
      fields.push({ name: 'Alert status', value: `Identical result ${alertDecision.attemptCount}; next repeat at attempt ${alertDecision.nextAlertAttempt}.`, inline: false });
    }
  } else {
    clearSeasonAlertState(seriesId, seasonNumber);
    if (outcome !== 'partial') clearSeasonEpisodeFallback(seriesId, seasonNumber);
  }
  // Do not create an offer that nobody can see during a backed-off alert. A changed candidate
  // list changes the fingerprint, re-arms the alert, and reaches this block normally.
  if (seasonGrabCandidates && shouldNotify) {
    const nonce = stashGrabOffer({ kind: 'season-pack-force', seriesId, seriesTitle, seasonNumber, candidates: seasonGrabCandidates });
    seasonGrabOffer = { nonce, candidates: seasonGrabCandidates };
    audit('season_pack_force_offered', {
      seriesId, title: seriesTitle, season: seasonNumber, candidateCount: seasonGrabCandidates.length,
      candidates: seasonGrabCandidates.map(candidate => ({ title: candidate.title, indexer: candidate.indexer, seeders: candidate.seeders, confidence: candidate.confidence })),
    });
  }
  if (nextStep) fields.push({ name: 'Next step', value: nextStep.slice(0, 1024), inline: false });

  audit('season_pack_search_result', { seriesId, title: seriesTitle, season: seasonNumber, commandId, status, outcome, missingAtSearch, remaining, queued, downloaded, fillMode: fill.mode, releaseCount: fill.releaseCount, packReleases: fill.packReleases, episodeReleases: fill.episodeReleases, interactiveSearched: interactive !== null || interactiveError !== null, interactiveReleaseCount: interactive?.releaseCount ?? null, interactivePackCount: interactive?.packCount ?? null, interactiveError, episodeFallbackEvidence: episodeFallbackEvidence?.status ?? null, episodeFallbackFingerprint: episodeFallbackEvidence?.fingerprint ?? null, autoForceStatus: autoForceResult?.status ?? null, autoForceReason: autoForceResult?.reason ?? null, autoForceError: autoForceResult?.error ?? null, alertPosted: shouldNotify, noGrabAttempts: alertDecision?.attemptCount ?? null, alertStoodDown: alertDecision?.stoodDown ?? false, message: commandText.slice(0, 1000) || null });
  const message = { embeds: [brandedEmbed(color)
    .setTitle(title.slice(0, 256))
    .setDescription(description.slice(0, 4000))
    .addFields(...fields)] };
  if (seasonGrabOffer) {
    message.components = [new ActionRowBuilder().addComponents(...seasonGrabOffer.candidates.map((candidate, index) =>
      new ButtonBuilder()
        .setCustomId(`season_grab:${seasonGrabOffer.nonce}:${index}`)
        .setLabel(`Grab pack ${candidate.displayedRank}`)
        .setStyle(index === 0 ? ButtonStyle.Danger : ButtonStyle.Secondary)))];
  }
  if (shouldNotify) notifyChannel('downloads', message);
  return { outcome, status, remaining, queued, downloaded, fill, interactive, interactiveError, autoForceResult, seasonGrabOffer: shouldNotify ? seasonGrabOffer : null, alerted: shouldNotify, alertDecision };
}

// Manual fallback for the default-off automation. The offer carries only a short nonce; Sonarr's
// long guid stays in SQLite, and consuming it makes stale/double clicks harmless.
async function handleSeasonPackGrab(interaction, nonce, candidateIndex) {
  if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
  const offer = takeGrabOffer(nonce);
  if (!offer) return interaction.update({ content: 'ℹ️ Already handled (or expired).', components: [] });
  if (offer.kind !== 'season-pack-force') {
    restashGrabOffer(nonce, offer);
    return interaction.reply({ content: '❌ This button does not match the cached offer.', ephemeral: true });
  }
  const candidate = offer.candidates?.[Number(candidateIndex)];
  if (!candidate?.guid || candidate.indexerId == null) {
    return interaction.update({ content: 'ℹ️ That pack is no longer available.', components: [] });
  }
  await interaction.deferUpdate();

  const blocked = await seasonPackForceBlocker({ seriesId: offer.seriesId, seasonNumber: offer.seasonNumber, releaseTitle: candidate.title });
  if (blocked?.reason === 'active_grab') {
    const duplicate = blocked.duplicate;
    audit('season_pack_force_refused', { actorDiscordId: interaction.user.id, seriesId: offer.seriesId, title: offer.seriesTitle, season: offer.seasonNumber, reason: 'active_grab', jobId: duplicate.job.id, releaseTitle: candidate.title });
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO)
      .setTitle(`ℹ️ Season Already Covered — ${offer.seriesTitle} S${pad(offer.seasonNumber)}`.slice(0, 256))
      .setDescription(`Skipped **${candidate.title}** because ${duplicate.label} is already tracked as grab job #${duplicate.job.id} (${duplicate.job.state}).`)], components: [] });
  }

  if (blocked?.reason === 'sonarr_queue') {
    audit('season_pack_force_refused', { actorDiscordId: interaction.user.id, seriesId: offer.seriesId, title: offer.seriesTitle, season: offer.seasonNumber, reason: 'sonarr_queue', releaseTitle: candidate.title });
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO)
      .setTitle(`ℹ️ Season Already Downloading — ${offer.seriesTitle} S${pad(offer.seasonNumber)}`.slice(0, 256))
      .setDescription('Sonarr now has a matching queue item, so the rejected pack was not forced.')], components: [] });
  }

  if (blocked?.reason === 'episode_fallback') {
    audit('season_pack_force_refused', { actorDiscordId: interaction.user.id, seriesId: offer.seriesId, title: offer.seriesTitle, season: offer.seasonNumber, reason: 'episode_fallback', releaseTitle: candidate.title });
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO)
      .setTitle(`ℹ️ Episode Fallback Already Submitted — ${offer.seriesTitle} S${pad(offer.seasonNumber)}`.slice(0, 256))
      .setDescription('A bounded Sonarr episode command already owns this season, so the pack was not forced alongside it.')], components: [] });
  }

  clearSeasonEpisodeFallback(offer.seriesId, offer.seasonNumber);
  try {
    await forceGrabRelease({ guid: candidate.guid, indexerId: candidate.indexerId });
  } catch (err) {
    restashGrabOffer(nonce, offer);
    audit('season_pack_force_failed', { actorDiscordId: interaction.user.id, seriesId: offer.seriesId, title: offer.seriesTitle, season: offer.seasonNumber, releaseTitle: candidate.title, error: err.message });
    return interaction.followUp({ content: `❌ Sonarr could not grab that pack: ${err.message}\nThe buttons still work — retry after fixing the Sonarr/indexer problem.`, ephemeral: true });
  }
  audit('season_pack_force_grabbed', { actorDiscordId: interaction.user.id, seriesId: offer.seriesId, title: offer.seriesTitle, season: offer.seasonNumber, releaseTitle: candidate.title, indexer: candidate.indexer, seeders: candidate.seeders, confidence: candidate.confidence });
  return interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS)
    .setTitle(`📥 Season Pack Forced — ${offer.seriesTitle} S${pad(offer.seasonNumber)}`.slice(0, 256))
    .setDescription(`**${candidate.title}** (${fmtSpace(candidate.size)}) was sent to Sonarr by <@${interaction.user.id}>. Sonarr's rejection was deliberately overridden; import verification remains with Sonarr.`)], components: [] });
}

function monitorSeasonSearch(args) {
  verifySeasonSearchCommand(args).catch(err => {
    audit('external_api_error', { provider: 'sonarr', error: err.message, action: 'season_search_monitor', seriesId: args.seriesId, season: args.seasonNumber, commandId: args.commandId || null });
    notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.WARN)
      .setTitle(`Season Search Verification Failed — ${args.seriesTitle} S${pad(args.seasonNumber)}`.slice(0, 256))
      .setDescription(`The search was accepted, but its outcome could not be verified: ${err.message}`.slice(0, 4000))] });
  });
}

function episodeFallbackRetryMs() {
  return tunable('SEASON_PACK_EPISODE_RETRY_MINUTES') * 60000;
}

function episodeFallbackEvidenceFromRow(row) {
  return row ? {
    status: row.evidence_status,
    fingerprint: row.evidence_fingerprint,
    observedAt: row.evidence_observed_at,
    anchorEpisodeId: row.anchor_episode_id,
    anchorEpisodeNumber: row.anchor_episode_number,
  } : null;
}

function episodeFallbackPendingState(row) {
  return row ? {
    cursorEpisodeNumber: row.cursor_episode_number,
    cursorEpisodeId: row.cursor_episode_id,
    nextEligibleAt: row.next_eligible_at,
  } : null;
}

function episodeFallbackCoverage({ series, seasonNumber, episodes, queue }) {
  const seasonQueue = (queue || []).filter(item => item.source.kind === 'tv'
    && Number(item.seriesId) === Number(series.id)
    && Number(item.seasonNumber) === Number(seasonNumber));
  const episodeByNumber = new Map((episodes || []).filter(ep => Number(ep.seasonNumber) === Number(seasonNumber))
    .map(ep => [Number(ep.episodeNumber), Number(ep.id)]));
  const queuedEpisodeIds = new Set();
  let seasonQueued = false;
  for (const item of seasonQueue) {
    const numbers = new Set([item.episodeNumber, ...(item.episodeNumbers || [])].map(Number).filter(Number.isFinite));
    if (item.fullSeason || numbers.size > 1 || !numbers.size) seasonQueued = true;
    for (const number of numbers) {
      const id = episodeByNumber.get(number);
      if (id) queuedEpisodeIds.add(id);
    }
  }

  const claimedEpisodeIds = new Set();
  let seasonClaimed = false;
  // Sonarr titles routinely carry a trailing year ("Full House (2004)"), which
  // normalizeTitle would turn into a required token no release claim can ever equal —
  // compare through the alias gate instead of a bare string match.
  const wantedAliases = sonarrSeriesAliases(series);
  for (const job of listActiveGrabJobs().filter(row => row.media_type === 'tv')) {
    const claim = releaseContentClaim(job.release_title);
    if (!claim || !seriesAliasMatch(claim.series, wantedAliases).ok) continue;
    if (claim.whole || claim.seasons.has(Number(seasonNumber))) seasonClaimed = true;
    for (const key of claim.episodes) {
      const [season, episode] = key.split('.').map(Number);
      if (season !== Number(seasonNumber)) continue;
      const id = episodeByNumber.get(episode);
      if (id) claimedEpisodeIds.add(id);
    }
  }
  return { queuedEpisodeIds, claimedEpisodeIds, seasonQueued, seasonClaimed };
}

async function finishEpisodeFallbackCommand(row, command) {
  const status = command?.status || 'unknown';
  const now = Date.now();
  const episodes = await getSeriesEpisodes(row.series_id);
  const queue = await fetchArrQueues();
  const remaining = episodes.filter(ep => Number(ep.seasonNumber) === Number(row.season_number)
    && ep.monitored && !ep.hasFile && Date.parse(ep.airDateUtc || ep.airDate || '') <= now).length;
  const queued = queue.filter(item => item.source.kind === 'tv' && Number(item.seriesId) === Number(row.series_id)
    && Number(item.seasonNumber) === Number(row.season_number)).length;
  let outcome;
  let color = COLORS.INFO;
  if (!['completed', 'failed', 'aborted'].includes(status)) outcome = 'timed_out';
  else if (status !== 'completed') { outcome = 'failed'; color = COLORS.DANGER; }
  else if (!remaining) outcome = 'filled';
  else if (queued) outcome = 'grabbed';
  else outcome = 'no_episode_release';

  let nextEligibleAt = null;
  if (outcome === 'filled') clearSeasonEpisodeFallback(row.series_id, row.season_number);
  else {
    const completedCycle = Number(row.deferred_count) === 0;
    nextEligibleAt = now + (completedCycle ? CONFIG.SEASON_PACK_COOLDOWN_HOURS * 3600000 : episodeFallbackRetryMs());
    finishSeasonEpisodeFallback({
      seriesId: row.series_id,
      seasonNumber: row.season_number,
      outcome,
      error: outcome === 'failed' ? [command?.message, command?.exception].filter(Boolean).join(' ').slice(0, 500) : null,
      nextEligibleAt,
      resetCursor: completedCycle,
      now,
    });
  }
  if (['filled', 'grabbed'].includes(outcome)) clearSeasonAlertState(row.series_id, row.season_number);
  let shouldNotify = true;
  let alertDecision = null;
  if (outcome === 'no_episode_release') {
    alertDecision = recordSeasonNoGrab({
      seriesId: row.series_id,
      seasonNumber: row.season_number,
      seriesTitle: row.series_title,
      fingerprint: sha256(JSON.stringify({ phase: 'episode_fallback', status, remaining, queued,
        submitted: row.submitted_count, deferred: row.deferred_count, cursor: row.cursor_episode_number })),
      missingCount: remaining,
      releaseCount: 0,
    });
    shouldNotify = alertDecision.shouldAlert;
  }
  const auditAction = outcome === 'filled' ? 'episode_fallback_complete'
    : outcome === 'grabbed' ? 'episode_fallback_partial'
      : outcome === 'no_episode_release' ? 'episode_fallback_no_grab'
        : outcome === 'timed_out' ? 'episode_fallback_timed_out'
          : 'episode_fallback_failed';
  audit(auditAction, {
    seriesId: row.series_id, title: row.series_title, season: row.season_number,
    commandId: row.last_command_id, status, outcome, submitted: row.submitted_count,
    deferred: row.deferred_count, remaining, queued, nextRetryAt: nextEligibleAt,
    alertPosted: shouldNotify, noGrabAttempts: alertDecision?.attemptCount ?? null,
  });
  if (shouldNotify) notifyChannel('downloads', { embeds: [brandedEmbed(color)
    .setTitle(`${outcome === 'failed' ? '❌' : outcome === 'filled' ? '✅' : '🔎'} Episode Fallback ${outcome === 'filled' ? 'Filled Season' : outcome === 'grabbed' ? 'Grabbed Releases' : outcome === 'failed' ? 'Failed' : 'Completed'} — ${row.series_title} S${pad(row.season_number)}`.slice(0, 256))
    .setDescription(`Sonarr command \`${status}\`. Submitted **${row.submitted_count}**, deferred **${row.deferred_count}**, live missing **${remaining}**, in queue **${queued}**.${outcome === 'filled' ? '' : ` Next retry: ${new Date(nextEligibleAt).toISOString()}.`}`.slice(0, 4000))] });
  return { outcome, status, remaining, queued };
}

function monitorEpisodeFallback(row) {
  pollArrCommand({ url: CONFIG.SONARR_URL, key: CONFIG.SONARR_API_KEY }, row.last_command_id, 10 * 60000)
    .then(command => finishEpisodeFallbackCommand(row, command))
    .catch(err => {
      finishSeasonEpisodeFallback({
        seriesId: row.series_id, seasonNumber: row.season_number, outcome: 'verification_failed',
        error: err.message, nextEligibleAt: Date.now() + episodeFallbackRetryMs(),
      });
      audit('episode_fallback_failed', { seriesId: row.series_id, title: row.series_title, season: row.season_number, commandId: row.last_command_id, outcome: 'verification_failed', error: err.message });
    });
}

async function drainSeasonEpisodeFallbacks({ seriesList, queue, preview = false, values = {} } = {}) {
  const setting = key => preview ? previewRuntimeValue(values, key) : tunable(key);
  const enabled = setting('SEASON_PACK_EPISODE_FALLBACK');
  const perSeason = setting('SEASON_PACK_EPISODE_BATCH_SIZE');
  let remainingGlobal = setting('SEASON_PACK_EPISODE_MAX_PER_RUN');
  const now = Date.now();
  const rows = orderPendingFallbacks(listSeasonEpisodeFallbacks());
  const items = [];
  for (const row of rows) {
    if (row.state === 'submitted') {
      if (preview) {
        items.push({ title: `${row.series_title} S${pad(row.season_number)}`, reason: `episode fallback command ${row.last_command_id || 'unknown'} is still submitted`, stage: 'episode fallback monitoring' });
        continue;
      }
      if (Number(row.next_eligible_at) > now) continue;
      let command = null;
      try { command = await getSonarrCommand(row.last_command_id); } catch (_err) {}
      if (command && ['completed', 'failed', 'aborted'].includes(command.status)) {
        await finishEpisodeFallbackCommand(row, command);
      } else if (command) {
        deferSubmittedSeasonEpisodeFallback(row.series_id, row.season_number, now + episodeFallbackRetryMs());
      } else {
        finishSeasonEpisodeFallback({
          seriesId: row.series_id, seasonNumber: row.season_number, outcome: 'command_unknown',
          nextEligibleAt: now + episodeFallbackRetryMs(),
        });
        audit('episode_fallback_timed_out', { seriesId: row.series_id, title: row.series_title, season: row.season_number, commandId: row.last_command_id, outcome: 'command_unknown' });
      }
      continue;
    }

    const series = (seriesList || []).find(item => Number(item.id) === Number(row.series_id));
    if (!series || !series.monitored) {
      if (!preview) clearSeasonEpisodeFallback(row.series_id, row.season_number);
      continue;
    }
    let episodes;
    try { episodes = await getSeriesEpisodes(row.series_id); } catch (err) {
      items.push({ title: `${row.series_title} S${pad(row.season_number)}`, reason: `episodes could not be read: ${err.message}`, stage: 'unknown' });
      continue;
    }
    const coverage = episodeFallbackCoverage({ series, seasonNumber: row.season_number, episodes, queue });
    let decision = planEpisodeFallback({
      seasonNumber: row.season_number,
      episodes,
      evidence: episodeFallbackEvidenceFromRow(row),
      ...coverage,
      pendingState: episodeFallbackPendingState(row),
      enabled,
      now,
      budget: { perSeason, remainingGlobal },
    });
    items.push({
      title: `${row.series_title} S${pad(row.season_number)}`,
      reason: `${decision.reason}; ${decision.submitted} submit, ${decision.deferred} deferred; evidence observed ${new Date(row.evidence_observed_at).toISOString()}`,
      stage: decision.action === 'submit' ? (preview ? 'episode fallback search' : 'episode fallback submitted') : `episode fallback ${decision.action}`,
    });
    if (preview) {
      if (decision.action === 'submit') remainingGlobal -= decision.submitted;
      continue;
    }
    if (decision.reason === 'season_complete') {
      clearSeasonEpisodeFallback(row.series_id, row.season_number);
      continue;
    }
    if (decision.reason === 'cycle_complete') {
      finishSeasonEpisodeFallback({ seriesId: row.series_id, seasonNumber: row.season_number, outcome: 'cycle_complete', nextEligibleAt: now + CONFIG.SEASON_PACK_COOLDOWN_HOURS * 3600000, resetCursor: true });
      continue;
    }
    if (decision.action !== 'submit') continue;

    // Final live race check. A pack/manual grab or import may have landed since the first read.
    const liveRow = getSeasonEpisodeFallback(row.series_id, row.season_number);
    if (!liveRow || liveRow.state === 'submitted') continue;
    const [liveEpisodes, liveQueue] = await Promise.all([getSeriesEpisodes(row.series_id), fetchArrQueues()]);
    decision = planEpisodeFallback({
      seasonNumber: row.season_number,
      episodes: liveEpisodes,
      evidence: episodeFallbackEvidenceFromRow(liveRow),
      ...episodeFallbackCoverage({ series, seasonNumber: row.season_number, episodes: liveEpisodes, queue: liveQueue }),
      pendingState: episodeFallbackPendingState(liveRow),
      enabled,
      now: Date.now(),
      budget: { perSeason, remainingGlobal },
    });
    if (decision.action !== 'submit') continue;
    const nextEligibleAt = Date.now() + episodeFallbackRetryMs();
    const claimed = markSeasonEpisodeFallbackSubmitted({
      seriesId: row.series_id, seasonNumber: row.season_number, commandId: null,
      cursorEpisodeNumber: decision.cursorEpisodeNumber, cursorEpisodeId: decision.cursorEpisodeId,
      submittedCount: decision.submitted, deferredCount: decision.deferred, nextEligibleAt,
    });
    if (!claimed) continue;
    let command;
    try { command = await triggerEpisodeSearch(decision.episodeIds); } catch (err) {
      finishSeasonEpisodeFallback({ seriesId: row.series_id, seasonNumber: row.season_number, outcome: 'command_failed', error: err.message, nextEligibleAt: Date.now() + episodeFallbackRetryMs() });
      audit('episode_fallback_failed', { seriesId: row.series_id, title: row.series_title, season: row.season_number, submitted: decision.submitted, deferred: decision.deferred, outcome: 'command_failed', error: err.message });
      continue;
    }
    attachSeasonEpisodeFallbackCommand(row.series_id, row.season_number, command?.id);
    const submittedRow = getSeasonEpisodeFallback(row.series_id, row.season_number);
    remainingGlobal -= decision.submitted;
    audit('episode_fallback_submitted', { seriesId: row.series_id, title: row.series_title, season: row.season_number, commandId: command?.id || null, submitted: decision.submitted, deferred: decision.deferred, cursorEpisodeNumber: decision.cursorEpisodeNumber, evidenceFingerprint: liveRow.evidence_fingerprint, nextRetryAt: nextEligibleAt });
    notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.INFO)
      .setTitle(`🔎 Episode Fallback Submitted — ${row.series_title} S${pad(row.season_number)}`.slice(0, 256))
      .setDescription(`Sonarr accepted a bounded search for **${decision.submitted}** live missing episode${decision.submitted === 1 ? '' : 's'}; **${decision.deferred}** remain deferred. Command: \`${command?.id || 'unknown'}\`. Next eligible retry: ${new Date(nextEligibleAt).toISOString()}.`.slice(0, 4000))] });
    if (submittedRow) monitorEpisodeFallback(submittedRow);
  }
  return { submitted: setting('SEASON_PACK_EPISODE_MAX_PER_RUN') - remainingGlobal, items };
}

async function sweepSeasonPacks({ rearmAlerts = false } = {}) {
  if (!tunable('SEASON_PACK_FIRST') || !CONFIG.SONARR_URL) return;
  const cfg = seasonPackConfig();
  const now = Date.now();
  const [seriesList, queue] = await Promise.all([listSonarrSeries(), fetchArrQueues()]);
  const fallback = await drainSeasonEpisodeFallbacks({ seriesList, queue });
  const fallbackSeasons = new Map();
  for (const row of listSeasonEpisodeFallbacks()) {
    if (!fallbackSeasons.has(Number(row.series_id))) fallbackSeasons.set(Number(row.series_id), []);
    fallbackSeasons.get(Number(row.series_id)).push(Number(row.season_number));
  }
  // Season search only runs against series carrying AVISTAZ_TAG — otherwise SeasonSearch/
  // EpisodeSearch hits every configured Sonarr indexer (public trackers included) and routes to
  // whatever download client those indexers use, which is how a season search ends up grabbing
  // dozens of dead public releases. Untagged series can opt back into the old all-indexer
  // behavior via SEASON_PACK_SONARR_UNTAGGED.
  const source = { url: CONFIG.SONARR_URL, key: CONFIG.SONARR_API_KEY, label: 'sonarr' };
  const tagId = await getArrTagId(source, CONFIG.AVISTAZ_TAG).catch(() => null);
  const allowUntagged = tunable('SEASON_PACK_SONARR_UNTAGGED');
  if (tagId == null && !allowUntagged) {
    audit('season_pack_skipped', { reason: 'tag_missing', tag: CONFIG.AVISTAZ_TAG });
    return { searched: 0, skipped: 'tag_missing', episodeFallbackSubmitted: fallback.submitted };
  }
  const directEnabled = tunable('SEASON_PACK_AVISTAZ_DIRECT') && grabConfigured();
  const indexer = directEnabled ? await findAvistazIndexer().catch(() => null) : null;
  // One rTorrent listing for the whole sweep (not per series) so a season already sitting there
  // — downloading or fully transferred, added manually or still waiting on the independent
  // adoption sweep to notice it — isn't invisible to activeGrabSeasonsFor/GRAB_CONTENT_DEDUPE
  // (both grab_jobs-only) and re-searched/re-grabbed. Best-effort: an unreachable seedbox must
  // not block the whole sweep, it just loses this one extra check for this run.
  const rtorrentTorrents = directEnabled && rtorrentConfigured() ? await listRtorrentTorrents().catch(() => []) : [];
  // Shows somebody actually asked for get the pack treatment whatever their age — most releases
  // are "S01" packs regardless of how old the show is, and a requester is waiting on this one.
  const requestedTvdbIds = tunable('SEASON_PACK_REQUESTED') ? listRequestedTvdbIds() : new Set();
  // Pinned shows are moved to the front, so when the per-run cap bites it bites the shows nobody
  // asked to prioritize. The cap itself is unchanged — pinning buys position, not extra searches.
  const priority = mediaPriorityMap();
  const ordered = orderByPriority(seriesList || [], { keyFor: series => priorityKey({ tvdbId: series.tvdbId }), priority });
  // A series that has never had a season swept before goes first (within its pin bracket — this
  // is a stable sort on top of orderByPriority's own stable sort, so pin order survives inside
  // each group). Without this, a large stalled backlog can spend SEASON_PACK_MAX_PER_RUN every
  // single run re-polling shows that already have nothing available, and a newly-added or
  // newly-missing show never gets a turn.
  const everSwept = listSeriesIdsWithSeasonSearches();
  ordered.sort((a, b) => (everSwept.has(Number(a.id)) ? 1 : 0) - (everSwept.has(Number(b.id)) ? 1 : 0));
  const searched = [];
  let avistazAllowanceExhausted = false;
  for (const series of ordered) {
    if (searched.length >= tunable('SEASON_PACK_MAX_PER_RUN')) break;
    if (!series.monitored) continue;
    const tagged = tagId != null && (series.tags || []).includes(tagId);
    if (!tagged && !allowUntagged) continue;
    // A tagged series with direct grab enabled must never fall back to Sonarr's all-indexer
    // search — that fallback is exactly the public-indexer fan-out this scope exists to remove.
    if (tagged && directEnabled && !indexer) {
      audit('season_pack_skipped', { reason: 'indexer_missing', seriesId: series.id, title: series.title });
      continue;
    }
    const route = tagged && directEnabled ? 'avistaz' : 'sonarr';
    // Cheap pre-filters before spending an /episode call per series: a show that's complete has
    // no gaps to fill, and one that's neither old nor requested isn't eligible whatever its
    // episodes say.
    const stats = series.statistics || {};
    if (stats.episodeCount != null && stats.episodeFileCount != null && stats.episodeFileCount >= stats.episodeCount) continue;
    const requested = requestedTvdbIds.has(Number(series.tvdbId));
    if (!requested && !assessSeriesAge(series, now, cfg).old) continue;
    let episodes;
    try {
      episodes = await getSeriesEpisodes(series.id);
    } catch (err) {
      audit('external_api_error', { provider: 'sonarr', error: err.message, action: 'season_pack_episodes', seriesId: series.id });
      continue;
    }
    const activeGrabSeasons = route === 'avistaz' ? activeGrabSeasonsFor(series, episodes) : [];
    const rtorrentSeasons = route === 'avistaz' ? rtorrentSeasonsFor(series, episodes, rtorrentTorrents) : [];
    const { eligible, reason, seasons } = seasonSearchTargets({
      series, episodes, requested,
      inQueue: [...queuedSeasons(queue, series.id), ...(fallbackSeasons.get(Number(series.id)) || []), ...activeGrabSeasons, ...rtorrentSeasons],
      searchedAt: getSeasonSearchTimes(series.id),
      stallCounts: getSeasonSearchStalls(series.id),
    }, now, cfg);
    if (!eligible) continue;
    for (const season of seasons) {
      if (searched.length >= tunable('SEASON_PACK_MAX_PER_RUN')) break;
      const pinned = isPinned(series, { keyFor: x => priorityKey({ tvdbId: x.tvdbId }), priority });

      if (route === 'avistaz') {
        if (avistazAllowanceExhausted) continue;
        const allowance = grabDailyAllowance();
        if (allowance.exhausted) { avistazAllowanceExhausted = true; continue; }
        const result = await runSeasonDirectGrab({ series, season, indexer, allowance });
        // Recorded only for a completed attempt — not for an allowance defer or a transient
        // search error — so a failed search retries next sweep instead of sitting out the
        // cooldown, same as the Sonarr route below.
        if (result.status !== 'allowance' && result.status !== 'error') {
          recordSeasonSearch({ seriesId: series.id, seasonNumber: season.season, seriesTitle: series.title, missing: season.missing });
        }
        if (result.status === 'allowance') { avistazAllowanceExhausted = true; continue; }
        if (rearmAlerts || result.status === 'grabbed') clearSeasonAlertState(series.id, season.season);
        audit('season_pack_search', { seriesId: series.id, title: series.title, season: season.season, missing: season.missing, aired: season.aired, reason, requested, route, status: result.status });
        searched.push({ series, season, reason, pinned, route, detail: result.detail || result.status });
        continue;
      }

      let command;
      const searchedAt = Date.now();
      try {
        command = await triggerSeasonSearch(series.id, season.season);
      } catch (err) {
        audit('external_api_error', { provider: 'sonarr', error: err.message, action: 'season_search', seriesId: series.id, season: season.season });
        continue;
      }
      if (rearmAlerts) clearSeasonAlertState(series.id, season.season);
      // Recorded only after the command is accepted, so a failed search retries next sweep
      // instead of sitting out the cooldown.
      const stallCount = recordSeasonSearch({ seriesId: series.id, seasonNumber: season.season, seriesTitle: series.title, missing: season.missing });
      // An untagged season whose missing count never shrinks across repeated sweeps is stuck on
      // dead public releases (defunct trackers, no real seeders) — Sonarr happily re-grabs the
      // same corpses forever. Tag it for AvistaZ so the *next* sweep routes it there instead,
      // closing the loop without anyone having to remember to tag it by hand.
      // AvistaZ is an Asian-content-only tracker (src/asian.js) — tagging a Western show for it
      // would never find anything and would just waste a metered search. Sonarr's own record
      // already names the show's original language, so this needs no extra API call to check.
      const autoTagThreshold = tunable('SEASON_PACK_AUTO_TAG_AFTER_STALLS');
      if (!tagged && autoTagThreshold > 0 && stallCount >= autoTagThreshold && tagId != null && directEnabled && indexer
        && isAsianLanguageName(series.originalLanguage?.name)) {
        try {
          await addTagToSeries(series.id, tagId);
          audit('season_pack_auto_tagged', { seriesId: series.id, title: series.title, season: season.season, stallCount, tag: CONFIG.AVISTAZ_TAG });
          notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.INFO)
            .setTitle(`🔐 Auto-tagged for AvistaZ — ${series.title} S${pad(season.season)}`)
            .setDescription(`Sonarr's own indexers grabbed something **${stallCount}** sweeps in a row without ever shrinking the missing-episode count — those releases look dead (no seeders / defunct trackers). Tagged \`${CONFIG.AVISTAZ_TAG}\` so the next sweep searches AvistaZ directly instead of retrying the same public releases.`)] });
        } catch (err) {
          audit('external_api_error', { provider: 'sonarr', error: err.message, action: 'season_pack_auto_tag', seriesId: series.id, season: season.season });
        }
      }
      audit('season_pack_search', { seriesId: series.id, title: series.title, season: season.season, missing: season.missing, aired: season.aired, reason, requested, route, commandId: command?.id || null, stallCount });
      monitorSeasonSearch({ seriesId: series.id, seriesTitle: series.title, seriesYear: series.year, seriesAliases: sonarrSeriesAliases(series), seasonNumber: season.season, missingAtSearch: season.missing, commandId: command?.id, searchedAt, stallCount });
      searched.push({ series, season, reason, pinned, route });
    }
  }
  if (searched.length) {
    const avistazCount = searched.filter(s => s.route === 'avistaz').length;
    notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.INFO)
      .setTitle(`📦 Season-Pack Search — ${searched.length} season(s)`)
      .setDescription([
        avistazCount
          ? `${avistazCount} tagged season(s) were searched directly on AvistaZ; the rest went through Sonarr's own search. Fully missing Sonarr seasons can use one pack; partially missing seasons may still be searched episode by episode:`
          : 'Sonarr was asked to search each listed season. Fully missing seasons can use one pack; partially missing seasons may still be searched episode by episode:',
        '',
        ...searched.map(s => `${s.pinned ? '📌 ' : ''}${s.route === 'avistaz' ? `📦 AvistaZ — ${s.series.title} S${pad(s.season.season)}: ${s.detail}` : `🔍 ${describeSeasonSearch(s.series.title, s.season)}`} _(${s.reason})_`),
        '',
        avistazAllowanceExhausted ? '⚠️ Today\'s AvistaZ allowance ran out partway through this run — the remaining tagged seasons will retry next sweep.' : null,
        'Whatever Sonarr grabs still imports normally. Seasons with nothing available are retried after '
          + `${CONFIG.SEASON_PACK_COOLDOWN_HOURS}h.`,
      ].filter(Boolean).join('\n').slice(0, 4000))] });
  }
  return { searched: searched.length, episodeFallbackSubmitted: fallback.submitted };
}

async function previewSeasonPacks(values = {}) {
  if (!previewRuntimeValue(values, 'SEASON_PACK_FIRST') || !CONFIG.SONARR_URL) return [];
  const cfg = {
    ...seasonPackConfig(),
    dormantDays: previewRuntimeValue(values, 'SEASON_PACK_DORMANT_DAYS'),
    minMissing: previewRuntimeValue(values, 'SEASON_PACK_MIN_MISSING'),
    includeRequested: previewRuntimeValue(values, 'SEASON_PACK_REQUESTED'),
    maxBackoffSteps: previewRuntimeValue(values, 'SEASON_PACK_STALL_BACKOFF_MAX_STEPS'),
  };
  const maxPerRun = previewRuntimeValue(values, 'SEASON_PACK_MAX_PER_RUN');
  const now = Date.now();
  const [seriesList, queue] = await Promise.all([listSonarrSeries(), fetchArrQueues()]);
  const fallbackPreview = await drainSeasonEpisodeFallbacks({ seriesList, queue, preview: true, values });
  const fallbackSeasons = new Map();
  for (const row of listSeasonEpisodeFallbacks()) {
    if (!fallbackSeasons.has(Number(row.series_id))) fallbackSeasons.set(Number(row.series_id), []);
    fallbackSeasons.get(Number(row.series_id)).push(Number(row.season_number));
  }
  const requestedTvdbIds = cfg.includeRequested ? listRequestedTvdbIds() : new Set();
  const priority = mediaPriorityMap();
  const ordered = orderByPriority(seriesList || [], { keyFor: series => priorityKey({ tvdbId: series.tvdbId }), priority });
  const items = [...fallbackPreview.items];
  let eligibleCount = 0;
  // Mirror the real sweep's tag gate so the preview never promises a search the sweep would
  // actually skip. Best-effort — a lookup failure reports 'unknown' rather than throwing.
  const source = { url: CONFIG.SONARR_URL, key: CONFIG.SONARR_API_KEY, label: 'sonarr' };
  const tagId = await getArrTagId(source, CONFIG.AVISTAZ_TAG).catch(() => null);
  const allowUntagged = previewRuntimeValue(values, 'SEASON_PACK_SONARR_UNTAGGED');
  const directEnabled = previewRuntimeValue(values, 'SEASON_PACK_AVISTAZ_DIRECT') && grabConfigured();
  const rtorrentTorrents = directEnabled && rtorrentConfigured() ? await listRtorrentTorrents().catch(() => []) : [];
  if (tagId == null && !allowUntagged) {
    return [...items, { title: '(all)', reason: `the \`${CONFIG.AVISTAZ_TAG}\` tag does not exist in Sonarr — nothing is eligible until it does, or SEASON_PACK_SONARR_UNTAGGED is enabled`, stage: 'unknown' }];
  }
  for (const series of ordered) {
    if (items.length >= PREVIEW_ITEM_LIMIT) break;
    if (!series.monitored) continue;
    const tagged = tagId != null && (series.tags || []).includes(tagId);
    if (!tagged && !allowUntagged) continue;
    const route = tagged && directEnabled ? 'avistaz season grab' : 'season search';
    const stats = series.statistics || {};
    if (stats.episodeCount != null && stats.episodeFileCount != null && stats.episodeFileCount >= stats.episodeCount) continue;
    const requested = requestedTvdbIds.has(Number(series.tvdbId));
    if (!requested && !assessSeriesAge(series, now, cfg).old) continue;
    let episodes;
    try {
      episodes = await getSeriesEpisodes(series.id);
    } catch (err) {
      // The sweep skips a series whose episodes won't load and carries on; a preview that threw
      // instead would report nothing at all because one series in the library is unreadable.
      items.push({ title: series.title, reason: `episodes could not be read: ${err.message}`, stage: 'unknown' });
      continue;
    }
    const activeGrabSeasons = route === 'avistaz season grab' ? activeGrabSeasonsFor(series, episodes) : [];
    const rtorrentSeasons = route === 'avistaz season grab' ? rtorrentSeasonsFor(series, episodes, rtorrentTorrents) : [];
    const { eligible, reason, seasons, held } = seasonSearchTargets({
      series, episodes, requested,
      inQueue: [...queuedSeasons(queue, series.id), ...(fallbackSeasons.get(Number(series.id)) || []), ...activeGrabSeasons, ...rtorrentSeasons],
      searchedAt: getSeasonSearchTimes(series.id),
      stallCounts: getSeasonSearchStalls(series.id),
    }, now, cfg);
    if (!eligible) continue;
    for (const season of held || []) {
      items.push({
        title: `${series.title} S${pad(season.season)}`,
        reason: `${reason}; cooldown until ${new Date(season.nextEligible).toISOString()}`,
        stage: 'cooldown',
      });
    }
    for (const season of seasons) {
      eligibleCount++;
      items.push({
        title: `${series.title} S${pad(season.season)}`,
        reason: route === 'avistaz season grab'
          ? `${reason}; ${season.missing} of ${season.aired} aired episode(s) missing; would search AvistaZ directly`
          : `${reason}; ${season.missing} of ${season.aired} aired episode(s) missing; episode fallback evidence_not_observed until a real search completes`,
        stage: eligibleCount <= maxPerRun ? route : `held by per-run cap ${maxPerRun}`,
      });
    }
  }
  return items;
}

async function previewAutomation(name, values = {}) {
  if (name === 'stuck') return previewStuckDownloads(values);
  if (name === 'escalation') return previewEscalations(values);
  if (name === 'season-pack') return previewSeasonPacks(values);
  if (name === 'episode-recovery') return (await previewEpisodeRecoverySweep(values)).items || [];
  throw new Error('Unknown sweep.');
}

// ---- AvistaZ direct-grab pipeline ----
// The smarter escalation path: search AvistaZ through Prowlarr, score the candidates, send
// the chosen torrent to the seedbox rTorrent (labeled radarr/sonarr), watch it to
// completion, rclone the files into local staging, and hand them to Radarr/Sonarr for a
// normal import (renaming, notifications, Bazarr subtitle search all follow from there).
// Falls back to the tag-based arr escalation when the pipeline isn't configured or the
// search comes up empty.

const grabDailyAllowance = () => grabAllowance(countGrabJobsToday(), CONFIG.AVISTAZ_DAILY_GRAB_LIMIT);

// How many releases a whole-series grab may take right now: the config ceiling, tightened by
// whatever is left of today's AvistaZ allowance (0/unset = unlimited, so the ceiling stands).
function seriesGrabBudget(allowance = grabDailyAllowance()) {
  const cap = Math.max(1, CONFIG.GRAB_TV_MAX_RELEASES);
  return allowance.limited ? Math.max(0, Math.min(cap, allowance.remaining)) : cap;
}

// The whole-series plan for a TV offer, or null when the feature is off, the media isn't TV,
// or there's nothing beyond the single best release to add. Releases already in flight are
// excluded, so re-running a search after a partial grab only plans the gaps.
function buildSeriesPlan({ candidates, mediaType, season = null, allowance = grabDailyAllowance(), aliases = null }) {
  if (!CONFIG.GRAB_TV_COMPLETE || mediaType !== 'tv') return null;
  const max = seriesGrabBudget(allowance);
  if (max < 1) return null;
  const plan = planSeriesGrab(candidates, {
    season,
    max,
    minConfidence: CONFIG.GRAB_TV_COMPLETE_MIN_CONFIDENCE,
    exclude: listActiveGrabJobs().filter(j => j.media_type === 'tv').map(j => j.release_title || j.title),
    aliases,
  });
  if (!plan.picks.length) return null;
  return { ...plan, coverage: describeGrabPlan(plan.picks) };
}

// The candidates embed + Download/Cancel buttons, shared by /avistaz search and the
// escalation flow. The offer behind the buttons lives in SQLite (stashGrabOffer).
// `plan` (from buildSeriesPlan) adds the one-click whole-series button for TV.
function grabCandidatesMessage({ heading, candidates, nonce, allowance, footnote, plan = null }) {
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
  // A Download button grabs exactly one release and consumes the offer; for a show that's
  // usually one season (or one episode) out of several, so spell out what the bulk button adds.
  const multi = plan && plan.picks.length > 1;
  const planLine = multi
    ? `\n\n**Grab Everything** takes all **${plan.picks.length}** non-overlapping releases covering **${plan.coverage}** in a single click${plan.trimmed ? ` — **${plan.trimmed}** more won't fit in today's budget and stay for later` : ''}.${plan.covered ? ` ${plan.covered} other release(s) cover episodes the plan already has, so they'd only spend slots twice.` : ''}`
    : '';
  const embed = brandedEmbed(COLORS.INFO)
    .setTitle(heading)
    .setDescription(`${lines.join('\n\n')}${allowanceLine}${planLine}${footnote ? `\n\n${footnote}` : ''}`.slice(0, 4000));
  const buttons = allowance.exhausted ? [] : candidates.map((c, i) =>
    new ButtonBuilder().setCustomId(`grab_dl:${nonce}:${i}`).setLabel(`Download ${i + 1}`)
      .setStyle(i === 0 && !multi ? ButtonStyle.Success : ButtonStyle.Primary));
  // A Discord action row holds 5 buttons; Cancel and (when it applies) Grab Everything are
  // worth more than the tail of the numbered list, so they win the seats. Grab Everything
  // takes the green highlight — for a series it's almost always the intended action.
  if (!allowance.exhausted && multi) {
    buttons.length = Math.min(buttons.length, 3);
    buttons.push(new ButtonBuilder().setCustomId(`grab_all:${nonce}`).setLabel(`Grab Everything (${plan.picks.length})`).setStyle(ButtonStyle.Success));
  }
  buttons.push(new ButtonBuilder().setCustomId(`grab_cancel:${nonce}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(...buttons.slice(0, 5))] };
}

// Content-level duplicate: an active grab job that already covers the same episode(s) as this
// release, even under a different hash/name/encoding. TV is matched by parsed episode-space
// (series + seasons/episodes); movies by resolved media id when both jobs carry one. Returns the
// blocking job + a label, or null (also null when the check is disabled or the name is
// unparseable — fail-open so a genuinely different release is never wrongly blocked).
function findActiveContentDuplicate({ releaseTitle, mediaType, mediaId, excludeHash }) {
  if (!CONFIG.GRAB_CONTENT_DEDUPE) return null;
  const norm = h => String(h || '').toUpperCase();
  const active = listActiveGrabJobs().filter(j => !excludeHash || norm(j.info_hash) !== norm(excludeHash));
  if (mediaType === 'tv') {
    const claim = releaseContentClaim(releaseTitle);
    if (!claim) return null;
    for (const j of active) {
      if (j.media_type !== 'tv') continue;
      const jc = releaseContentClaim(j.release_title || j.title);
      if (jc && contentClaimsOverlap(claim, jc)) return { job: j, label: describeContentClaim(claim) };
    }
    return null;
  }
  if (mediaId) {
    for (const j of active) {
      if (j.media_type === 'tv') continue;
      if (j.media_id && j.media_id === mediaId) return { job: j, label: 'this movie' };
    }
  }
  return null;
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
  // Same content under a different release/encoding (different hash + name + size): block before
  // spending the metered .torrent fetch so only one copy of an episode/pack ever enters the pipeline.
  const contentDup = findActiveContentDuplicate({ releaseTitle: candidate.releaseTitle, mediaType: meta.mediaType, mediaId: meta.mediaId, excludeHash: candidate.infoHash });
  if (contentDup) return { ok: false, dup: true, why: `already grabbing ${contentDup.label} as job #${contentDup.job.id} (${contentDup.job.state}) — skipping this duplicate release` };

  let torrent;
  try {
    torrent = await fetchTorrentFile(candidate.downloadUrl);
  } catch (err) {
    audit('external_api_error', { provider: 'prowlarr', error: err.message, action: 'grab_fetch_torrent', title: meta.title });
    return { ok: false, why: `couldn't fetch the .torrent: ${err.message}` };
  }
  // A request grab already knows which TVDB series it's for (meta.mediaId is 'tvdb:<id>') —
  // pin the job to Sonarr's matching seriesId up front instead of leaving Sonarr to guess
  // from the release filename, same as adoption's resolver. Best-effort: an unresolved id
  // here still isn't fatal, it just leaves the job unpinned like before this existed.
  let identity = {};
  if (meta.mediaType === 'tv' && String(meta.mediaId || '').startsWith('tvdb:')) {
    const tvdbId = Number(String(meta.mediaId).slice('tvdb:'.length));
    if (Number.isFinite(tvdbId)) {
      const resolved = await resolveSonarrSeriesIdentity({ tvdbId }).catch(() => null);
      if (resolved?.series) identity = { targetArrId: resolved.series.id, tvdbId, matchType: 'tvdb' };
    }
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
      discordId: meta.discordId, origin: meta.origin, ...identity,
    });
    audit('avistaz_grab_sent', { actorDiscordId: meta.actorDiscordId || null, targetDiscordId: meta.discordId || null, jobId: job.id, mediaId: meta.mediaId, title: meta.title, release: candidate.releaseTitle, infoHash, label, confidence: candidate.confidence, origin: meta.origin });
    return { ok: true, job };
  } catch (err) {
    const failed = recordGrabJob({
      mediaId: meta.mediaId || null, mediaType: meta.mediaType, title: meta.title,
      releaseTitle: candidate.releaseTitle, infoHash, sizeBytes: candidate.size, label,
      discordId: meta.discordId, origin: meta.origin, ...identity,
    });
    setGrabJobState(failed.id, 'failed', err.message);
    audit('external_api_error', { provider: 'rtorrent', error: err.message, action: 'grab_send', title: meta.title, jobId: failed.id });
    return { ok: false, why: err.message };
  }
}

// Run a whole-series plan: one executeGrab per picked release, sequentially so the daily
// allowance is re-checked between them and rTorrent isn't hit with a burst. Never throws —
// a failure on one release doesn't abandon the rest, and the caller reports the mix.
async function executeSeriesGrab(picks, meta) {
  const sent = [];
  const dup = [];
  const failed = [];
  let stopped = null;
  for (const candidate of picks) {
    // Re-checked per release: a parallel escalation or a hand-clicked Download can exhaust the
    // day mid-plan, and spending past the limit is exactly what the counter exists to prevent.
    if (grabDailyAllowance().exhausted) { stopped = 'allowance'; break; }
    const result = await executeGrab(candidate, meta);
    if (result.ok) sent.push({ candidate, job: result.job });
    else if (result.dup) dup.push({ candidate, why: result.why });
    else failed.push({ candidate, why: result.why });
  }
  const remaining = picks.length - sent.length - dup.length - failed.length;
  audit('avistaz_series_grab', {
    actorDiscordId: meta.actorDiscordId || null, title: meta.title, origin: meta.origin,
    planned: picks.length, sent: sent.length, dup: dup.length, failed: failed.length, stopped,
  });
  return { sent, dup, failed, stopped, remaining };
}

// The multi-line body shared by the button summary and the auto-grab escalation notice.
function seriesGrabSummary(outcome, { planned, trimmed = 0 }) {
  const lines = [];
  if (outcome.sent.length) {
    lines.push(`Sent **${outcome.sent.length}** of ${planned} release${planned === 1 ? '' : 's'} to the seedbox:`);
    for (const s of outcome.sent.slice(0, 10)) lines.push(`• **${String(s.candidate.releaseTitle).slice(0, 140)}** (${fmtSpace(s.candidate.size)})`);
    if (outcome.sent.length > 10) lines.push(`…and ${outcome.sent.length - 10} more.`);
  } else {
    lines.push(`Nothing new was sent — none of the ${planned} planned release${planned === 1 ? '' : 's'} could be grabbed.`);
  }
  if (outcome.dup.length) lines.push('', `Skipped **${outcome.dup.length}** already in the pipeline (same episodes under another release).`);
  if (outcome.failed.length) {
    lines.push('', `**${outcome.failed.length} failed:**`);
    for (const f of outcome.failed.slice(0, 5)) lines.push(`• ${String(f.candidate.releaseTitle).slice(0, 100)} — ${String(f.why).slice(0, 200)}`);
  }
  if (outcome.stopped === 'allowance') {
    lines.push('', `⏸️ Stopped early — the daily AvistaZ allowance (${CONFIG.AVISTAZ_DAILY_GRAB_LIMIT}/day) ran out with **${outcome.remaining}** release(s) left. Re-run \`/avistaz search\` tomorrow to pick up the rest.`);
  } else if (trimmed) {
    lines.push('', `ℹ️ **${trimmed}** further release(s) didn't fit today's budget — re-run \`/avistaz search\` once the allowance resets.`);
  }
  return lines.join('\n');
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
  // Resolve the real Sonarr record when we have a tvdbId, so the scorer can gate on every
  // title this series actually answers to — not just the requested string — and so a
  // same-titled different show ("Full House" 1987 vs 2004) can be told apart by year.
  let aliases;
  let seriesYear = year;
  if (row.media_type === 'tv' && row.tvdb_id) {
    const series = await getSeriesByTvdbId(row.tvdb_id).catch(() => null);
    if (series) { aliases = sonarrSeriesAliases(series); seriesYear = series.year || year; }
  }
  const results = await searchAvistaz({ query, mediaType: row.media_type, indexerId: indexer.id });
  // A show needs a wider pool than the three shown: the whole-series plan is built from every
  // usable release (a pack per season), not just the podium.
  const ranked = rankAvistazResults(results, { title: query, year: seriesYear, mediaType: row.media_type, aliases }, { limit: avistazRankLimit(row.media_type) });
  if (!ranked.length) return { ok: false, why: 'no AvistaZ results' };
  const candidates = ranked.slice(0, 3);
  const plan = buildSeriesPlan({ candidates: ranked, mediaType: row.media_type, allowance, aliases });

  const top = ranked[0];
  const meta = { mediaId: row.media_id, mediaType: row.media_type, title: row.title, discordId: row.requested_by_discord_id, origin: 'escalation-auto' };
  if (CONFIG.GRAB_MODE === 'auto' && top.confidence >= CONFIG.GRAB_AUTO_CONFIDENCE) {
    // Auto mode takes the whole plan for a series, not just the best release — the top pick
    // still has to clear GRAB_AUTO_CONFIDENCE, so a weak search never triggers a bulk grab.
    if (plan && plan.picks.length > 1) {
      const outcome = await executeSeriesGrab(plan.picks, meta);
      if (outcome.sent.length || outcome.dup.length) {
        return { ok: true, detail: `Auto-grabbed the available run of this series (**${plan.coverage}**, best match ${top.confidence}% confidence).\n${seriesGrabSummary(outcome, { planned: plan.picks.length, trimmed: plan.trimmed })}` };
      }
      // Every release failed (rTorrent down, bad torrents) — fall through to human approval.
    } else {
      const grab = await executeGrab(top, meta);
      if (grab.ok) {
        return { ok: true, detail: `Auto-grabbed **${top.releaseTitle}** (${top.confidence}% confidence) → seedbox rTorrent. I'll transfer and import it when the download finishes.` };
      }
      if (grab.dup) return { ok: true, detail: `Best match **${top.releaseTitle}** was ${grab.why} — nothing new to grab.` };
      // Grab itself failed (rTorrent down, bad torrent) — fall through to human approval.
    }
  }

  // The full ranked list is stashed, not just the three shown: Grab Everything re-plans from it
  // against live state on click, so an offer that outlived a restart can't re-grab what landed.
  const nonce = stashGrabOffer({ mediaId: row.media_id, mediaType: row.media_type, title: row.title, discordId: row.requested_by_discord_id, origin: 'escalation', candidates: ranked, aliases });
  notifyChannel('downloads', grabCandidatesMessage({
    heading: `🔎 AvistaZ Matches — ${row.title}`,
    candidates, nonce, allowance, plan,
    footnote: `Requested by ${row.requested_by_discord_id ? `<@${row.requested_by_discord_id}>` : 'unknown'}. Downloading sends the torrent to the seedbox rTorrent; the bot copies it home and imports it when done.`,
  }));
  return { ok: true, detail: `Found ${ranked.length} AvistaZ candidate(s) — posted to the downloads channel for approval (best: ${top.confidence}% confidence${plan && plan.picks.length > 1 ? `, Grab Everything covers ${plan.coverage}` : ''}).` };
}

// How deep to rank a search. Movies only ever need the podium; a series is planned across every
// usable release, so the pool has to be big enough to hold a pack per season.
const avistazRankLimit = mediaType => (mediaType === 'tv' && CONFIG.GRAB_TV_COMPLETE ? 25 : 3);

// One tagged season through the AvistaZ pipeline instead of Sonarr's own SeasonSearch — search
// scoped to the AvistaZ indexer, rank gated to this series by alias, plan, then either auto-grab
// (GRAB_MODE=auto at high confidence) or post the candidates for a click. Mirrors
// runDirectGrabEscalation's shape but scoped to one season instead of a whole request. Never
// throws — every failure path returns a status the sweep can log and summarize.
async function runSeasonDirectGrab({ series, season, indexer, allowance }) {
  if (allowance.exhausted) return { status: 'allowance' };
  // Sonarr titles can carry a trailing year ("Full House (2004)"), which would otherwise become
  // a required token in the title score.
  const { query, year } = splitTitleYear(series.title);
  const aliases = sonarrSeriesAliases(series);
  let results;
  try {
    results = await searchAvistaz({ query, mediaType: 'tv', indexerId: indexer.id });
  } catch (err) {
    audit('external_api_error', { provider: 'prowlarr', error: err.message, action: 'season_pack_avistaz_search', seriesId: series.id, season: season.season });
    return { status: 'error', error: err.message };
  }
  const ranked = rankAvistazResults(results, { title: query, year: series.year || year, mediaType: 'tv', season: season.season, aliases }, { limit: avistazRankLimit('tv') });
  if (!ranked.length) return { status: 'no_results' };
  const plan = buildSeriesPlan({ candidates: ranked, mediaType: 'tv', season: season.season, allowance, aliases });
  const top = ranked[0];
  const mediaId = series.tvdbId ? `tvdb:${series.tvdbId}` : null;
  const meta = { mediaId, mediaType: 'tv', title: series.title, origin: 'season-pack' };
  if (CONFIG.GRAB_MODE === 'auto' && top.confidence >= CONFIG.GRAB_AUTO_CONFIDENCE) {
    if (plan && plan.picks.length > 1) {
      const outcome = await executeSeriesGrab(plan.picks, meta);
      if (outcome.sent.length || outcome.dup.length) {
        return { status: 'grabbed', detail: `auto-grabbed **${plan.coverage}** (${top.confidence}% confidence)` };
      }
      // Every release failed (rTorrent down, bad torrents) — fall through to human approval.
    } else {
      const grab = await executeGrab(top, meta);
      if (grab.ok) return { status: 'grabbed', detail: `auto-grabbed **${top.releaseTitle}** (${top.confidence}% confidence)` };
      if (grab.dup) return { status: 'grabbed', detail: `already grabbing this season — ${grab.why}` };
      // Grab itself failed (rTorrent down, bad torrent) — fall through to human approval.
    }
  }
  const nonce = stashGrabOffer({ mediaId, mediaType: 'tv', title: series.title, origin: 'season-pack', candidates: ranked, season: season.season, aliases });
  notifyChannel('downloads', grabCandidatesMessage({
    heading: `📦 AvistaZ Season Pack — ${series.title} S${pad(season.season)}`,
    candidates: ranked.slice(0, 3), nonce, allowance, plan,
    footnote: 'Found while filling this season from the AvistaZ-tagged library sweep.',
  }));
  return { status: 'offered', detail: `posted ${ranked.length} candidate(s) for approval (best: ${top.confidence}% confidence)` };
}

// Premiumize→rTorrent reroute: a dead Premiumize transfer came from Sonarr/Radarr's own
// public-indexer download client — the bot never mediated that grab, so there's no grab_jobs
// row, magnet, or indexer GUID on file for it, only the transfer's release-name string. The one
// thing recoverable is the still-live Sonarr/Radarr queue entry for the same release (matched by
// exact normalized title), which carries real series/episode or movie identity. Re-search
// Prowlarr's public indexers for an equivalent release under that identity and grab it through
// the existing direct-grab pipeline (seedbox rTorrent) instead of leaving Sonarr/Radarr to retry
// the same dead public indexer forever. Never throws — every failure path returns a status the
// sweep can log; a caller that can't confidently identify the release just leaves it alone.
async function rerouteDeadPremiumizeTransfer(t) {
  if (!grabConfigured()) return { status: 'not_configured' };
  const queue = await fetchArrQueues().catch(() => []);
  const wanted = normalizeTitle(t.name);
  const item = queue.find(q => wanted && normalizeTitle(q.sourceTitle) === wanted);
  if (!item) return { status: 'no_match' };

  let query; let year; let mediaType; let mediaId; let title; let season; let aliases;
  if (item.source.kind === 'tv') {
    if (!item.seriesTvdbId) return { status: 'no_match' };
    const series = await getSeriesByTvdbId(item.seriesTvdbId).catch(() => null);
    if (!series) return { status: 'no_match' };
    mediaType = 'tv';
    ({ query } = splitTitleYear(series.title));
    year = series.year || null;
    title = series.title;
    mediaId = `tvdb:${series.tvdbId}`;
    season = item.seasonNumber;
    aliases = sonarrSeriesAliases(series);
  } else {
    if (!item.movieTmdbId) return { status: 'no_match' };
    const movie = await getMovieByTmdbId(item.movieTmdbId).catch(() => null);
    if (!movie) return { status: 'no_match' };
    mediaType = 'movie';
    ({ query } = splitTitleYear(movie.title));
    year = movie.year || null;
    title = movie.title;
    mediaId = `tmdb:${movie.tmdbId}`;
  }

  let results;
  try {
    // No indexerId: searches every indexer Prowlarr has configured, same as a manual "search
    // all indexers" — this is exactly the pool Sonarr/Radarr's own search already draws from.
    results = await searchAvistaz({ query, mediaType });
  } catch (err) {
    audit('external_api_error', { provider: 'prowlarr', error: err.message, action: 'premiumize_reroute_search', title });
    return { status: 'error', error: err.message };
  }
  // Never resubmit through AvistaZ itself here — a title that reached Premiumize in the first
  // place was never AvistaZ-tagged/eligible, so an AvistaZ hit in this pool is a coincidental
  // title collision, not a legitimate route, and would spend a metered private-tracker search
  // this feature has no business touching.
  const avistazName = CONFIG.AVISTAZ_INDEXER_NAME;
  const publicResults = (results || []).filter(r => !String(r.indexer || '').toLowerCase().includes(avistazName));
  const ranked = rankAvistazResults(publicResults, { title: query, year, mediaType, season, aliases }, { limit: 5 });
  if (!ranked.length) return { status: 'no_results' };
  const top = ranked[0];
  if (top.confidence < tunable('PREMIUMIZE_REROUTE_MIN_CONFIDENCE')) return { status: 'low_confidence', confidence: top.confidence };

  const grab = await executeGrab(top, { mediaId, mediaType, title, origin: 'premiumize_reroute' });
  if (grab.ok) {
    audit('premiumize_reroute_grabbed', { transferId: String(t.id), name: t.name, title, releaseTitle: top.releaseTitle, confidence: top.confidence, jobId: grab.job.id });
    return { status: 'grabbed', releaseTitle: top.releaseTitle, confidence: top.confidence, title };
  }
  if (grab.dup) return { status: 'dup', why: grab.why };
  return { status: 'failed', why: grab.why };
}

// Seasons an active AvistaZ grab job already covers for this series — the direct-grab
// counterpart of the Sonarr queue that queuedSeasons() reads, so the sweep doesn't re-search
// (and re-spend the metered allowance on) a season it already sent to the seedbox last cycle.
// Only whole-series and explicit season claims count; a lone in-flight episode doesn't cover the
// rest of the season, so it must not suppress a real search for the remaining gaps.
function activeGrabSeasonsFor(series, episodes) {
  const aliases = sonarrSeriesAliases(series);
  const seasons = new Set();
  for (const job of listActiveGrabJobs().filter(j => j.media_type === 'tv')) {
    const claim = releaseContentClaim(job.release_title);
    if (!claim || !seriesAliasMatch(claim.series, aliases).ok) continue;
    if (claim.whole) { for (const ep of episodes || []) seasons.add(Number(ep.seasonNumber)); continue; }
    for (const s of claim.seasons) seasons.add(s);
  }
  return [...seasons];
}

// Seasons a torrent ALREADY sitting in rTorrent already covers for this series — the direct-grab
// pipeline only tracks torrents it submitted itself (grab_jobs, keyed by an info-hash it
// computed), so a torrent added manually, added before the bot existed, or still waiting on the
// independent adoption sweep (RTORRENT_ADOPT_CHECK_MINUTES, default every 5 min, vs. the season-
// pack sweep's own much longer interval) is otherwise invisible to activeGrabSeasonsFor and to
// GRAB_CONTENT_DEDUPE (both grab_jobs-only) — so the season-pack sweep would search AvistaZ and
// spend a metered allowance slot re-grabbing a season that's already downloading or already sat
// there fully transferred. Matches by content claim (same machinery as activeGrabSeasonsFor),
// not by exact filename, so renamed/differently-cased releases are still recognized. `torrents`
// is a `listRtorrentTorrents()` snapshot passed in by the caller so one sweep only lists rTorrent
// once, not once per series.
function rtorrentSeasonsFor(series, episodes, torrents) {
  const aliases = sonarrSeriesAliases(series);
  const seasons = new Set();
  for (const t of torrents || []) {
    const claim = releaseContentClaim(t.name);
    if (!claim || !seriesAliasMatch(claim.series, aliases).ok) continue;
    if (claim.whole) { for (const ep of episodes || []) seasons.add(Number(ep.seasonNumber)); continue; }
    for (const s of claim.seasons) seasons.add(s);
  }
  return [...seasons];
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
        const operatorError = formatOperatorError(err);
        const embedTitle = boundOperatorLabel(`❌ Seedbox Transfer Failed — ${job.title}`, OPERATOR_EMBED_LIMITS.title);
        const releaseTitle = boundOperatorLabel(job.release_title);
        setGrabJobState(job.id, 'failed', err.message);
        log.error(`Seedbox transfer failed for job #${job.id}:`, err);
        audit('avistaz_transfer_failed', { jobId: job.id, title: job.title, error: String(err.message).slice(0, 500) });
        notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.DANGER)
          .setTitle(embedTitle)
          .setDescription(`**Release:** ${releaseTitle}\n**Cause:** ${operatorError.cause}\n**Attempts:** ${operatorError.attempts}\n**Diagnostic:**\n\`\`\`text\n${operatorError.diagnostic}\n\`\`\`\n**Next step:** The torrent is still on the seedbox. Retry re-runs the copy; already-transferred files are skipped.`)],
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
  // The job stays active (scanning → importing → verified) until the arr's scan is actually
  // confirmed to have taken the files — "the scan command was fired" is not "it imported".
  // Verification runs in the background (it can take up to 10 minutes) but OWNS the
  // terminal state transition and the success notification; runGrabTransfer must never mark
  // the job done itself, or a scan that silently rejects everything reports false success.
  setGrabJobState(job.id, 'scanning');
  verifyArrImport(job, arr, cmdRes.data?.id, importPath, finalPath, st.sizeBytes)
    .catch(err => log.warn(`Import verification failed for job #${job.id}: ${err.message}`));
}

// Shared success path once an import is actually confirmed (leftover-file check passed) —
// called from verifyArrImport on every route that ends in success (plain scan, forced
// ManualImport, or the guided mapping wizard).
async function finishGrabJobImported(job, sizeBytes) {
  if (job.id == null) return; // synthetic job from a manual /rtorrent import — no row, no notification
  setGrabJobState(job.id, 'verified');
  const minutes = job.completed_at ? Math.max(1, Math.round((Date.now() - job.completed_at) / 60000)) : null;
  const adopted = String(job.origin || '').startsWith('adopt');
  audit(adopted ? 'rtorrent_adopt_imported' : 'avistaz_grab_imported', { jobId: job.id, mediaId: job.media_id, title: job.title, release: job.release_title, sizeBytes, transferMinutes: minutes });
  if (adopted) {
    // Batch-friendly: a 39-episode adoption must not ping the channel 39 times. One rolling
    // message is edited in place per import (edits don't notify); no requester DM either —
    // the discord id on an adopted job is the adopting admin.
    await updateAdoptTransferProgress(job, sizeBytes || job.size_bytes);
    return;
  }
  notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.SUCCESS)
    .setTitle(`📦 AvistaZ Grab Imported — ${job.title}`)
    .setDescription(`**${job.release_title}** (${fmtSpace(sizeBytes || job.size_bytes)}) finished on the seedbox, copied home, and was confirmed imported by ${job.media_type === 'movie' ? 'Radarr' : 'Sonarr'}. It keeps seeding on the seedbox.`)] });
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

// Poll an arr command until it reaches a terminal status or the deadline passes. Transient
// request failures are swallowed and just retried — only a hard deadline gives up.
async function pollArrCommand(arr, commandId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let command = { status: 'unknown' };
  while (Date.now() < deadline && commandId) {
    await sleepMs(15000);
    try {
      const r = await axios.get(`${arr.url}/api/v3/command/${commandId}`, { headers: { 'X-Api-Key': arr.key }, timeout: 10000 });
      command = r.data || command;
      if (['completed', 'failed', 'aborted'].includes(command.status)) break;
    } catch (_e) { /* transient — keep polling until the deadline */ }
  }
  return command;
}

// Whether it's safe to auto-force a batch of manualimport preview rows through ManualImport
// without a human looking at them first: the flag has to be on, AND (for TV) the job must be
// pinned to a single resolved Sonarr series (see target_arr_id / match_type) with every file
// in the batch mapping to THAT exact series — never Sonarr's own per-file guess. A movie job
// has no equivalent ambiguity concern (Radarr matched it by tmdbId already), so it only needs
// the flag.
function canAutoForceImport(job, mediaType, files) {
  if (!CONFIG.SONARR_AUTO_MANUAL_IMPORT) return false;
  if (mediaType === 'movie') return true;
  if (!job.target_arr_id || !['tvdb', 'exact', 'alternate', 'manual'].includes(job.match_type)) return false;
  return files.every(f => f.series?.id === job.target_arr_id);
}

// Post-import verification: wait for the scan command, then check the video files actually
// left staging. Owns every terminal state the job can land in beyond 'scanning':
//   - scan never completes → job stays 'scanning'; the arr's command queue is likely wedged
//     (say so — a restart clears it, then `/rtorrent import` re-triggers this folder).
//   - scan completed, everything imported → 'verified' (the actual success path).
//   - scan completed but skipped cleanly-matched files, identity is certain → force them
//     through ManualImport (opt-in via SONARR_AUTO_MANUAL_IMPORT), then re-verify.
//   - files are genuinely rejected, or identity ISN'T certain enough to auto-force →
//     'needs_mapping' (TV, with the guided wizard) or 'import_rejected' (movies), with the
//     rejection reasons named instead of silence.
async function verifyArrImport(job, arr, commandId, importPath, finalPath, sizeBytes) {
  const status = (await pollArrCommand(arr, commandId, 10 * 60000)).status;
  if (!leftoverVideoFiles(finalPath).length) return finishGrabJobImported(job, sizeBytes); // consumed — the import really happened

  if (status !== 'completed') {
    audit('grab_import_unverified', { jobId: job.id, title: job.title, commandId, status });
    notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.WARN)
      .setTitle(`⏳ Import Not Confirmed — ${job.title}`.slice(0, 256))
      .setDescription(`${arr.label}'s scan is still \`${status}\` after 10 minutes and the files are still in staging — its command queue may be wedged (one stuck scan blocks everything behind it). Check ${arr.label} → System → Tasks; restarting ${arr.label} clears the queue, then \`/rtorrent import\` re-triggers this folder.`)] });
    return; // stays 'scanning' — not done, not failed, just unconfirmed
  }

  // Scan finished yet videos remain: ask the arr what it thinks of each file.
  const preview = await axios.get(`${arr.url}/api/v3/manualimport`, {
    params: { folder: importPath, filterExistingFiles: true }, headers: { 'X-Api-Key': arr.key }, timeout: 120000,
  }).then(r => r.data || []);
  const clean = preview.filter(f => !(f.rejections || []).length
    && (job.media_type === 'movie' ? f.movie : (f.series && (f.episodes || []).length)));
  if (clean.length && canAutoForceImport(job, job.media_type, clean)) {
    const files = clean.map(f => (job.media_type === 'movie'
      ? { path: f.path, movieId: f.movie.id, quality: f.quality, languages: f.languages, releaseGroup: f.releaseGroup || undefined, indexerFlags: f.indexerFlags || 0 }
      : { path: f.path, seriesId: f.series.id, episodeIds: f.episodes.map(e => e.id), quality: f.quality, languages: f.languages, releaseGroup: f.releaseGroup || undefined, indexerFlags: f.indexerFlags || 0 }));
    setGrabJobState(job.id, 'importing');
    const cmdRes = await axios.post(`${arr.url}/api/v3/command`, { name: 'ManualImport', files, importMode: 'move' },
      { headers: { 'X-Api-Key': arr.key }, timeout: 15000 });
    audit('grab_import_forced', { jobId: job.id, title: job.title, files: files.length });
    // Verify the forced import too — firing the command is not proof it worked.
    const forcedStatus = (await pollArrCommand(arr, cmdRes.data?.id, 5 * 60000)).status;
    if (!leftoverVideoFiles(finalPath).length) {
      notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.INFO)
        .setTitle(`🔧 Import Nudged — ${job.title}`.slice(0, 256))
        .setDescription(`${arr.label}'s scan completed but quietly skipped **${files.length}** cleanly-matched file(s); they've been forced through ManualImport (move) and confirmed imported.`)] });
      return finishGrabJobImported(job, sizeBytes);
    }
    audit('grab_import_force_failed', { jobId: job.id, title: job.title, forcedStatus });
    setGrabJobState(job.id, job.media_type === 'movie' ? 'import_rejected' : 'needs_mapping', `forced ManualImport (${forcedStatus}) still left files in staging`);
    notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.WARN)
      .setTitle(`⚠️ Forced Import Didn't Take — ${job.title}`.slice(0, 256))
      .setDescription(`ManualImport was forced (status \`${forcedStatus}\`) but the files are still in staging. Check ${arr.label}'s Manual Import screen — this needs a human look.`)] });
    return;
  }
  // Grouped per reason WITH the filenames: "3 files rejected" is actionable, a de-duplicated
  // reason string against a 22-episode pack is not.
  const rejectionGroups = summarizeImportRejections(preview);
  const reasons = rejectionGroups.map(g => g.reason).slice(0, 5);
  audit('grab_import_rejected', { jobId: job.id, title: job.title, reasons, rejectedFiles: rejectionGroups.reduce((n, g) => n + g.count, 0), cleanUnforced: clean.length && !reasons.length });
  setGrabJobState(job.id, job.media_type === 'movie' ? 'import_rejected' : 'needs_mapping', reasons.join('; ') || null);
  // TV declines get the guided-import wizard: pick series + season in Discord, the bot pushes
  // the mapping through ManualImport — covers TVDB filing the show under another title and
  // fansub names Sonarr can't parse, without touching the Sonarr UI.
  const components = [];
  let mapHint = `use ${arr.label}'s Manual Import screen for hand-mapping`;
  // The wizard only helps a matching problem. Offering it for "destination already exists" or an
  // unreadable file sends you round a loop that cannot possibly fix the cause.
  if (job.media_type !== 'movie' && (!rejectionGroups.length || looksLikeMappingProblem(rejectionGroups))) {
    const nonce = stashMapOffer({ title: job.title, folder: path.basename(finalPath), importPath, finalPath, jobId: job.id });
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mapimp_start:${nonce}`).setLabel('Map to a Series…').setStyle(ButtonStyle.Primary)));
    mapHint = '**Map to a Series…** below walks through picking the series + season right here and pushes the mapping into Sonarr';
  }
  const whyNotForced = clean.length && !CONFIG.SONARR_AUTO_MANUAL_IMPORT ? ` (${clean.length} file(s) matched cleanly but \`SONARR_AUTO_MANUAL_IMPORT\` is off, or the series match isn't certain enough to auto-force)`
    : clean.length ? ' (matched cleanly, but not to the series this job is pinned to)' : '';
  notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.WARN)
    .setTitle(`🚫 ${arr.label} Declined the Import — ${job.title}`.slice(0, 256))
    .setDescription([
      `The files copied home fine but ${arr.label} won't take them${whyNotForced}:`,
      '',
      ...(rejectionGroups.length ? renderRejectionLines(rejectionGroups) : ['• (no reason reported — the series may be missing or the names unparseable)']),
      '',
      `They're still in staging. Fix the cause and re-run \`/rtorrent import target:${job.media_type === 'movie' ? 'radarr' : 'sonarr'} folder:${String(path.basename(finalPath)).slice(0, 80)}\` — or ${mapHint}.`,
    ].join('\n').slice(0, 4000))], components });
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
  // A human just confirmed the exact series/season/episode mapping — this IS "identity
  // certain", so the job is pinned and marked verified directly rather than left to another
  // leftover-file poll (the wizard already proved the files were consumed by walking the
  // manualimport preview itself).
  if (state.jobId != null) {
    setGrabJobIdentity(state.jobId, { targetArrId: state.seriesId, tvdbId: null, matchType: 'manual' });
    setGrabJobState(state.jobId, 'verified');
  }
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
  let state;
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

// A hash match only blocks re-adoption when the existing job is still meaningfully tracking the
// torrent — actively in flight (mirrors listActiveGrabJobs' state list in src/db.js) or already
// confirmed imported ('verified'). A job that failed, was rejected on import, needs manual
// mapping, or sits in an unrecognized/legacy state (a stale record from before a refactor, or one
// that got stuck) never actually finished — treating it as blocking would permanently prevent
// adopting a torrent that's still sitting right there complete, which defeats the entire point of
// /rtorrent adopt as the manual recovery path for exactly that situation.
const ADOPT_BLOCKING_STATES = new Set(['sent', 'downloading', 'complete', 'transferring', 'scanning', 'importing', 'verified']);

// Create the grab job for an existing torrent. Never throws — callers branch on
// { ok, why, dup }. An explicit adoption overrides a standing ignore flag.
async function executeAdoption(torrent, target, meta, resolver = null) {
  const existingJob = torrent.hash ? getGrabJobByHash(torrent.hash) : null;
  const verdict = decideAdoption({ torrent, existingJob: existingJob && ADOPT_BLOCKING_STATES.has(existingJob.state) ? existingJob : null, target });
  if (!verdict.ok) return verdict;
  if (!grabImportTarget(verdict.mediaType)) {
    return { ok: false, why: `${target === 'sonarr' ? 'Sonarr' : 'Radarr'} isn't configured — the adopted torrent could never be imported` };
  }
  // Another active job already covers these episodes (a different release of the same content):
  // don't adopt the duplicate. Runs before the remote-path search so we skip the wasted rclone work.
  const contentDup = findActiveContentDuplicate({ releaseTitle: torrent.name, mediaType: verdict.mediaType, excludeHash: torrent.hash });
  if (contentDup) return { ok: false, dup: true, why: `same content as job #${contentDup.job.id} (${contentDup.job.state}) — already have ${contentDup.label}; not adopting this duplicate` };
  // Resolve the Sonarr series identity BEFORE the job (or the remote-path search) exists —
  // Sonarr must not be left to guess the series from the release filename at import time,
  // and an ambiguous match blocks adoption for one admin click rather than auto-picking.
  // meta.seriesOverride (set by that click) skips resolution entirely.
  let identity = {};
  if (verdict.mediaType === 'tv') {
    if (meta.seriesOverride) {
      identity = { targetArrId: meta.seriesOverride.id, tvdbId: meta.seriesOverride.tvdbId || null, matchType: 'manual' };
    } else {
      const guessTitle = seriesToken(torrent.name);
      const guessYear = parseReleaseName(torrent.name).year;
      const resolved = await resolveSonarrSeriesIdentity({ title: guessTitle, year: guessYear }).catch(() => ({ status: 'none', series: null, candidates: [] }));
      if (resolved.status === 'ambiguous') {
        return {
          ok: false, needsSeriesPick: true,
          why: `matches ${resolved.candidates.length} series in Sonarr's library — pick one so it doesn't get imported under the wrong show`,
          candidates: resolved.candidates.slice(0, 20).map(s => ({ id: s.id, title: s.title, year: s.year, tvdbId: s.tvdbId })),
        };
      }
      if (resolved.series) identity = { targetArrId: resolved.series.id, tvdbId: resolved.series.tvdbId, matchType: resolved.status };
    }
  }
  // If Sonarr already has a file for the exact episode(s) this release covers, adopting it would
  // pay for an rclone copy from the seedbox only to be rejected (or silently skipped) at import
  // time anyway — check up front and skip it instead. Scoped to single/ranged-episode releases
  // with a resolved series; a season pack, an unparseable name, or an unresolved series falls
  // through to the normal path rather than being silently blocked by a check that can't be sure.
  if (verdict.mediaType === 'tv' && identity.targetArrId) {
    const parsed = parseReleaseName(torrent.name);
    if (parsed.season != null && parsed.episode != null && !parsed.seasonPack) {
      const episodes = await getSeriesEpisodes(identity.targetArrId).catch(() => null);
      const wanted = (episodes || []).filter(ep => Number(ep.seasonNumber) === parsed.season
        && Number(ep.episodeNumber) >= parsed.episode && Number(ep.episodeNumber) <= (parsed.episodeEnd || parsed.episode));
      if (wanted.length && wanted.every(ep => ep.hasFile)) {
        const epLabel = `S${pad(parsed.season)}E${pad(parsed.episode)}${parsed.episodeEnd ? `-E${pad(parsed.episodeEnd)}` : ''}`;
        return { ok: false, dup: true, why: `Sonarr already has a file for ${epLabel} — not adopting a duplicate` };
      }
    }
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
    ...identity,
  });
  audit('rtorrent_adopted', { actorDiscordId: meta.actorDiscordId || null, jobId: job.id, infoHash: torrent.hash, name: torrent.name, target, state: verdict.state, remotePath, viaSearch: !!viaSearch, origin: meta.origin || 'adopt', matchType: identity.matchType || null, targetArrId: identity.targetArrId || null });
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
  const outcome = { adopted: 0, complete: 0, downloading: 0, dup: 0, failed: [], ambiguous: [] };
  for (const t of candidates) {
    const result = await executeAdoption(t, target, meta, resolver);
    if (result.ok) { outcome.adopted++; outcome[result.state]++; }
    else if (result.dup) outcome.dup++;
    // An ambiguous series match needs one admin click, not a bulk guess — surfaced
    // separately so it doesn't read as an ordinary failure, and re-adoptable one-by-one via
    // `/rtorrent adopt search:"..."` (which offers the series-pick buttons).
    else if (result.needsSeriesPick) outcome.ambiguous.push({ name: t.name, candidates: result.candidates });
    else outcome.failed.push({ name: t.name, why: result.why });
  }
  audit('rtorrent_adopt_bulk', { actorDiscordId: meta.actorDiscordId || null, target, requested: candidates.length, adopted: outcome.adopted, dup: outcome.dup, ambiguous: outcome.ambiguous.length, failed: outcome.failed.length });
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
    && !ADOPT_BLOCKING_STATES.has(getGrabJobByHash(t.hash)?.state) && !isAdoptIgnored(t.hash) && !isAdoptOffered(t.hash));
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
    } else if (result.dup) {
      // A different release of content already in the pipeline — skip quietly (not a failure).
      audit('rtorrent_adopt_dup_skipped', { infoHash: t.hash, name: t.name, why: result.why });
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
async function sweepTranscodes() {
  if (!tautulliConfigured()) return;
  const data = await tautulliApi('get_activity');
  const sessions = data?.sessions || [];
  const now = Date.now();
  pruneAlertCooldowns('transcode', now - 24 * 3600000);
  for (const s of sessions) {
    if (s.video_decision !== 'transcode') continue;
    const key = `${s.user_id || s.user}:${s.rating_key}`;
    const last = getAlertedAt('transcode', key);
    if (now - last < CONFIG.TRANSCODE_ALERT_COOLDOWN_MINUTES * 60000) continue;
    setAlertedAt('transcode', key, now);
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
async function sweepPremiumizeTransfers() {
  if (!premiumizeConfigured()) return;
  const transfers = await listTransfers();
  const now = Date.now();
  const currentIds = new Set(transfers.map(t => String(t.id)));
  for (const row of listAlertCooldowns('premiumize')) {
    if (!currentIds.has(row.alert_key) || now - row.last_alerted_at > 48 * 3600000) clearAlertCooldown('premiumize', row.alert_key);
  }
  // 'premiumize_retry' reuses the generic alert-cooldown table purely as a "have we already
  // given this one its one retry" flag — same lifecycle as the 'premiumize' scope above.
  for (const row of listAlertCooldowns('premiumize_retry')) {
    if (!currentIds.has(row.alert_key) || now - row.last_alerted_at > 48 * 3600000) clearAlertCooldown('premiumize_retry', row.alert_key);
  }
  // Ignore flags are per transfer id; drop them once the transfer leaves the list so a reused
  // id can't be silently ignored (same pattern as stuck_ignore:).
  for (const r of db.prepare("SELECT key FROM app_settings WHERE key LIKE 'pm_ignore:%'").all()) {
    if (!currentIds.has(r.key.slice('pm_ignore:'.length))) db.prepare('DELETE FROM app_settings WHERE key = ?').run(r.key);
  }

  const stuck = findStuckTransfers(transfers, pmTracker, { stuckAfterMs: CONFIG.PREMIUMIZE_STUCK_AFTER_MINUTES * 60000, now });
  const ignored = new Set(stuck.filter(t => getSetting(`pm_ignore:${t.id}`)).map(t => String(t.id)));
  const alertedAt = new Map(stuck.map(t => [String(t.id), getAlertedAt('premiumize', String(t.id))]));
  const retried = new Set(stuck.filter(t => getAlertedAt('premiumize_retry', String(t.id))).map(t => String(t.id)));
  const { deletes, retries, alerts } = planStuckTransferActions(stuck, {
    autoDelete: tunable('PREMIUMIZE_AUTO_CLEAR_DEAD'),
    maxProgress: tunable('PREMIUMIZE_AUTO_CLEAR_MAX_PROGRESS') / 100,
    retryBeforeClear: tunable('PREMIUMIZE_RETRY_BEFORE_CLEAR'),
    ignored, alertedAt, retried, cooldownMs: CONFIG.PREMIUMIZE_ALERT_COOLDOWN_HOURS * 3600000, now,
  });

  const cleared = [];
  const failed = [];
  const blocklistEnabled = tunable('RELEASE_GROUP_BLOCKLIST_ENABLED');
  const blocklistThreshold = tunable('RELEASE_GROUP_BLOCKLIST_THRESHOLD');
  const blocklistCandidates = [];
  const rerouteEnabled = tunable('PREMIUMIZE_REROUTE_ENABLED');
  const rerouteMaxPerSweep = tunable('PREMIUMIZE_REROUTE_MAX_PER_SWEEP');
  const rerouted = [];
  let rerouteAttempts = 0;
  for (const t of deletes) {
    const id = String(t.id);
    try {
      await deleteTransfer(id);
      pmTracker.delete(id);
      clearAlertCooldown('premiumize', id);
      clearAlertCooldown('premiumize_retry', id);
      cleared.push(t);
      audit('premiumize_transfer_auto_cleared', { transferId: id, name: t.name, status: t.status, progress: t.progress });
      // Proactive dead-release-group blocklist (#211): the same release-group tag showing up
      // across repeated dead auto-clears is knowable in advance, not just after the fact — track
      // it, and once it crosses the threshold, suggest a Sonarr Custom Format for an admin to
      // approve (never applied automatically).
      if (blocklistEnabled) {
        const group = extractReleaseGroup(t.name);
        if (group) {
          const count = recordDeadReleaseGroupSighting(group, { sampleName: t.name, now });
          const row = getReleaseGroupSighting(group);
          if (count >= blocklistThreshold && !row.suggested_at && !row.dismissed) blocklistCandidates.push({ group, count, sampleName: t.name });
        }
      }
      // Premiumize→rTorrent reroute: this transfer is unsalvageable on Premiumize (already given
      // its one retry, still dead) — try once to pick the same release back up through the
      // seedbox rTorrent client instead of leaving Sonarr/Radarr to keep retrying the same dead
      // public indexer. Bounded per sweep since each attempt is a real Prowlarr search.
      if (rerouteEnabled && rerouteAttempts < rerouteMaxPerSweep && !grabDailyAllowance().exhausted) {
        rerouteAttempts += 1;
        const outcome = await rerouteDeadPremiumizeTransfer(t).catch(err => ({ status: 'error', error: err.message }));
        if (outcome.status === 'grabbed') rerouted.push({ t, outcome });
      }
    } catch (err) {
      failed.push({ t, err });
      audit('external_api_error', { provider: 'premiumize', error: err.message, action: 'premiumize_auto_clear', transferId: id });
    }
  }
  // Premiumize's own retry gets one more shot at seeding before the transfer is given up on —
  // slow trackers (the theory behind "not seeding long enough") get a second chance instead of
  // being cleared the instant they're first seen dead. Left unmarked on failure so it's retried
  // again next sweep rather than jumping straight to delete on an API hiccup.
  const retriedOk = [];
  for (const t of retries) {
    const id = String(t.id);
    try {
      await retryTransfer(id);
      setAlertedAt('premiumize_retry', id, now);
      retriedOk.push(t);
      audit('premiumize_transfer_retry_auto', { transferId: id, name: t.name, status: t.status, progress: t.progress });
    } catch (err) {
      audit('external_api_error', { provider: 'premiumize', error: err.message, action: 'premiumize_auto_retry', transferId: id });
    }
  }
  for (const t of alerts) setAlertedAt('premiumize', String(t.id), now);

  // One batched embed instead of one alert per transfer — a bad night of public-indexer grabs
  // can produce dozens of dead transfers at once, and a wall of near-identical alerts is worse
  // than a summary with the bulk buttons this channel already has.
  if (!cleared.length && !retriedOk.length && !alerts.length && !failed.length) return;
  const lines = [];
  if (retriedOk.length) {
    lines.push(`**🔁 Given one more chance to seed (${retriedOk.length}):**`, ...retriedOk.slice(0, 10).map(t => `• ${String(t.name || 'unnamed').slice(0, 100)}`));
    if (retriedOk.length > 10) lines.push(`• _+${retriedOk.length - 10} more_`);
  }
  if (rerouted.length) {
    lines.push('', `**🔀 Rerouted to seedbox rTorrent (${rerouted.length}):**`, ...rerouted.slice(0, 10).map(({ outcome }) => `• ${String(outcome.title || '').slice(0, 60)} → ${String(outcome.releaseTitle || '').slice(0, 90)} (${outcome.confidence}% confidence)`));
  }
  if (cleared.length) {
    lines.push('', `**🧹 Auto-cleared (${cleared.length}):**`, ...cleared.slice(0, 10).map(t => `• ${String(t.name || 'unnamed').slice(0, 100)}`));
    if (cleared.length > 10) lines.push(`• _+${cleared.length - 10} more_`);
  }
  if (failed.length) {
    lines.push('', `**⚠️ Failed to clear (${failed.length}):**`, ...failed.slice(0, 5).map(({ t, err }) => `• ${String(t.name || 'unnamed').slice(0, 100)} — ${err.message}`));
  }
  if (alerts.length) {
    lines.push('', `**🧊 Still stuck (${alerts.length}):**`);
    for (const t of alerts.slice(0, 10)) {
      const pct = Math.round(Number(t.progress || 0) * 100);
      lines.push(`• ${String(t.name || 'unnamed').slice(0, 100)} — ${String(t.status || 'unknown')} ${pct}%${t.message ? ` (${String(t.message).slice(0, 120)})` : ''}`);
    }
    if (alerts.length > 10) lines.push(`• _+${alerts.length - 10} more_`);
  }
  const embed = brandedEmbed(alerts.length ? COLORS.WARN : COLORS.INFO)
    .setTitle(`🧊 Premiumize — ${alerts.length} stuck, ${retriedOk.length} retried, ${cleared.length} auto-cleared${rerouted.length ? `, ${rerouted.length} rerouted` : ''}`)
    .setDescription(lines.join('\n').slice(0, 4000));
  // Per-transfer Retry/Clear/Ignore buttons only make sense for exactly one alerted transfer —
  // Discord's 5-button row can't carry them for a batch, so the bulk buttons stand in instead.
  const components = [];
  if (alerts.length === 1) {
    const id = String(alerts[0].id);
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pm_retry:${id}`).setLabel('Retry').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`pm_clear:${id}`).setLabel('Clear Transfer').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`pm_ignore:${id}`).setLabel('Ignore').setStyle(ButtonStyle.Secondary),
    ));
  } else if (alerts.length > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pm_clearstuck').setLabel('Clear All 0% Stuck').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('pm_clearfinished').setLabel('Clear Finished').setStyle(ButtonStyle.Secondary),
    ));
  }
  notifyChannel('downloads', { embeds: [embed], components });
  audit('premiumize_transfer_stuck', { cleared: cleared.length, retried: retriedOk.length, failed: failed.length, alerted: alerts.length, rerouted: rerouted.length });

  // One suggestion embed per newly-thresholded release group (a sweep rarely produces more than
  // one or two) — suggest-only, same posture as the AvistaZ auto-tag feature: nothing changes in
  // Sonarr until an admin clicks Approve.
  const seenGroups = new Set();
  for (const { group, count, sampleName } of blocklistCandidates) {
    if (seenGroups.has(group)) continue;
    seenGroups.add(group);
    markReleaseGroupSuggested(group, now);
    audit('release_group_blocklist_suggested', { group, deadClearCount: count, sampleName });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`relgroup_approve:${group}`).setLabel('Blocklist in Sonarr').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`relgroup_dismiss:${group}`).setLabel('Not dead — dismiss').setStyle(ButtonStyle.Secondary),
    );
    notifyChannel('downloads', { embeds: [brandedEmbed(COLORS.WARN)
      .setTitle(`🚫 Known-Dead Release Group? — ${group.toUpperCase()}`)
      .setDescription(`\`${group}\` has shown up on **${count}** distinct auto-cleared dead Premiumize transfers, most recently:\n\`${String(sampleName || '').slice(0, 150)}\`\n\nApproving creates a Sonarr Custom Format matching this release group and scores it \`${CONFIG.RELEASE_GROUP_BLOCKLIST_SCORE}\` in every quality profile, so future Sonarr searches skip it before ever grabbing. This can be undone in Sonarr (Settings → Custom Formats) if the tracker recovers.`)],
      components: [row] });
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
    const result = await executeDeletion(row.media_id, row.title, { requestorId: row.requestor_discord_id, reason: 'grace_expired', arrSource: row.arr_source || null });
    if (result.outcome === 'error') continue; // transient *arr failure — retry next sweep
    if (result.outcome === 'not_found') { markPendingDeletion(row.media_id, 'cancelled'); continue; }
    if (['ambiguous', 'scope_required'].includes(result.outcome)) {
      markPendingDeletion(row.media_id, 'cancelled');
      notifyChannel('cleanup', { embeds: [brandedEmbed(COLORS.WARN)
        .setTitle('🛑 Auto-Delete Blocked')
        .setDescription(`**${row.title}** was not deleted because the stored target is ${result.outcome === 'ambiguous' ? 'ambiguous between library editions' : 'a TV series without an explicit episode/season/series scope'}. Create a new, scoped cleanup action after verifying the exact files.`)] });
      continue;
    }
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
    { url: CONFIG.RADARR_URL, key: CONFIG.RADARR_API_KEY, label: 'radarr', rule: rules.movie_1080p },
    { url: CONFIG.RADARR_4K_URL, key: CONFIG.RADARR_4K_API_KEY, label: 'radarr-4k', rule: rules.movie_4k },
  ].filter(s => s.url && s.rule > 0);
  for (const s of movieSources) {
    const movies = await radarrGetFrom(s.url, s.key, '/movie').catch(() => []);
    for (const m of movies) {
      if (!m.hasFile || !m.movieFile?.dateAdded) continue;
      const ageDays = (now - Date.parse(m.movieFile.dateAdded)) / 86400000;
      if (ageDays < s.rule) continue;
      candidates.push({ kind: 'movie', mediaId: `tmdb:${m.tmdbId}`, title: `${m.title}${m.year ? ` (${m.year})` : ''}`, ageDays, sizeBytes: m.movieFile.size || 0, arrSource: s.label });
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
      const result = await executeDeletion(c.mediaId, c.title, { reason: 'retention_rule', arrSource: c.arrSource });
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
  const disks = await fetchDiskSpace();
  const now = Date.now();
  recordDiskSamples(db, disks, now);
  pruneDiskSamples(db, now);
  const forecasts = forecastDisks(db, disks, now);
  const freeGbThreshold = tunable('DISK_SPACE_WARN_GB');
  const forecastDaysThreshold = tunable('DISK_FORECAST_WARN_DAYS');
  const low = forecasts.filter(d => freeGbThreshold > 0 && gb(d.freeSpace || 0) < freeGbThreshold);
  const projected = forecasts.filter(d => forecastDaysThreshold > 0 && d.forecast.status === 'projected' && d.forecast.daysRemaining <= forecastDaysThreshold);
  if (!low.length && !projected.length) { db.prepare('DELETE FROM app_settings WHERE key = ?').run('disk_alert_last'); return; }
  const last = Number(getSetting('disk_alert_last') || '0');
  if (now - last < 24 * 3600000) return;
  setSetting('disk_alert_last', String(now));
  const details = [];
  if (low.length) details.push(low.map(d => `**${d.root}** — ${fmtSpace(d.freeSpace)} free of ${fmtSpace(d.totalSpace)}`).join('\n'));
  if (projected.length) details.push(projected.map(d => `**${d.root}** — ${forecastLabel(d.forecast)}`).join('\n'));
  notifyChannel('system', { embeds: [brandedEmbed(COLORS.DANGER)
    .setTitle('Storage Capacity Warning')
    .setDescription(`${details.join('\n\n')}\n\nThresholds: ${freeGbThreshold} GB free or ${forecastDaysThreshold} projected days. Run \`/cleanup-suggestions\` for read-only options.`)] });
  audit('disk_space_alert', {
    disks: low.map(d => ({ path: d.path, freeGb: Math.round(gb(d.freeSpace)) })),
    projected: projected.map(d => ({ path: d.path, daysRemaining: Math.ceil(d.forecast.daysRemaining), confidence: d.forecast.confidence })),
  });
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
  if (CONFIG.LOG_RETENTION_DAYS > 0) {
    try {
      const last = Number(getSetting('log_retention_last_run') || '0');
      if (Date.now() - last >= 24 * 3600000) {
        const age = `-${CONFIG.LOG_RETENTION_DAYS} days`;
        const auditDeleted = db.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', ?)").run(age).changes;
        const accessDeleted = db.prepare("DELETE FROM download_access_log WHERE created_at < datetime('now', ?)").run(age).changes;
        setSetting('log_retention_last_run', String(Date.now()));
        if (auditDeleted || accessDeleted) log.info(`Pruned ${auditDeleted} audit and ${accessDeleted} download-access log row(s) older than ${CONFIG.LOG_RETENTION_DAYS} days`);
      }
    } catch (err) {
      log.warn(`Log retention sweep failed: ${err.message}`);
    }
  }
  try {
    const age = `-${CONFIG.PENDING_EMAIL_EXPIRY_DAYS} days`;
    const rows = db.prepare("SELECT key FROM app_settings WHERE key LIKE 'pending_email:%' AND updated_at < datetime('now', ?)").all(age);
    for (const r of rows) clearPendingEmail(r.key.slice('pending_email:'.length));
    if (rows.length) log.info(`Expired ${rows.length} stale pending-email onboarding flag(s) older than ${CONFIG.PENDING_EMAIL_EXPIRY_DAYS} days`);
  } catch (err) {
    log.warn(`Pending-email expiry sweep failed: ${err.message}`);
  }
  try {
    const pruned = pruneWebhookEvents(CONFIG.WEBHOOK_EVENT_RETENTION_DAYS);
    if (pruned) log.info(`Pruned ${pruned} webhook-dedupe record(s) older than ${CONFIG.WEBHOOK_EVENT_RETENTION_DAYS} days`);
  } catch (err) {
    log.warn(`Webhook event prune sweep failed: ${err.message}`);
  }
  try {
    // Safety net: subscribers are normally cleared the moment their title becomes available or
    // gets declined. This only catches rows that never reach either outcome (e.g. the request
    // stalls forever upstream).
    const pruned = pruneRequestSubscribers(CONFIG.REQUEST_SUBSCRIBER_RETENTION_DAYS);
    if (pruned) log.info(`Pruned ${pruned} stale request-subscriber row(s) older than ${CONFIG.REQUEST_SUBSCRIBER_RETENTION_DAYS} days`);
  } catch (err) {
    log.warn(`Request-subscriber prune sweep failed: ${err.message}`);
  }
  if (CONFIG.WHATS_NEW_ENABLED) {
    try {
      const pruned = db.prepare("DELETE FROM app_settings WHERE key LIKE 'whats_new_posted:%' AND updated_at < datetime('now', '-30 days')").run().changes;
      if (pruned) log.info(`Pruned ${pruned} old whats-new dedupe flag(s)`);
    } catch (err) {
      log.warn(`Whats-new flag prune sweep failed: ${err.message}`);
    }
  }
}

// better-sqlite3's db.backup() is online and WAL-safe, so this runs without pausing the bot.
// A silently failing backup is worse than no backup, so failures go to the system-alerts channel
// rather than just the log.
async function sweepBackup() {
  try {
    const destination = await runBackup(DB_PATH, CONFIG.BACKUP_DIR);
    const successfulAt = Date.now();
    setSetting('backup_last_success', String(successfulAt));
    clearAlertCooldown('backup', 'overdue');
    const deleted = rotateBackups(CONFIG.BACKUP_DIR, CONFIG.BACKUP_KEEP_COUNT);
    log.info(`DB backup created: ${destination}${deleted.length ? ` (rotated out ${deleted.length} old backup(s))` : ''}`);
    audit('db_backup_created', { destination, rotatedOut: deleted.length, successfulAt });
  } catch (err) {
    log.error(`DB backup failed: ${err.message}`);
    audit('db_backup_failed', { error: err.message });
    notifyChannel('system', { embeds: [brandedEmbed(COLORS.DANGER)
      .setTitle('🛑 Database Backup Failed')
      .setDescription(`\`\`\`${err.message}\`\`\``)] });
    const state = backupState(getSetting('backup_last_success'), CONFIG.BACKUP_INTERVAL_HOURS);
    if (state.overdue && !getAlertedAt('backup', 'overdue')) {
      setAlertedAt('backup', 'overdue');
      notifyChannel('system', { embeds: [brandedEmbed(COLORS.WARN)
        .setTitle('Database Backup Overdue')
        .setDescription(`The last successful backup was ${fmtDuration(state.ageMs)} ago, more than twice the configured ${CONFIG.BACKUP_INTERVAL_HOURS}h interval.`)] });
      audit('db_backup_overdue', { lastSuccessfulAt: state.lastSuccessfulAt, ageMs: state.ageMs });
    }
    throw err;
  }
}

// #81: posts the same server-wide view /stats server:true shows, on a rolling ~30-day cadence
// (last_run gate, same pattern as janitorSweep's retention checks) rather than a fixed calendar
// date — simpler than cron, and "roughly monthly" is all this needs to be.
async function sweepMonthlyRecap() {
  const last = Number(getSetting('monthly_recap_last_run') || '0');
  if (Date.now() - last < 30 * 86400000) return;
  const sinceIso = last ? new Date(last).toISOString() : startOfMonthIso();
  setSetting('monthly_recap_last_run', String(Date.now()));
  const embed = await buildServerStatsEmbed({ sinceIso, periodLabel: 'The Last Month' });
  notifyChannel('whats_new', { embeds: [embed] });
  audit('monthly_recap_posted', { sinceIso });
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
        .setDescription(`Freed ${fmtSpace(evicted.reduce((a, i) => a + (i.size_bytes || 0), 0))} to make room for **${job.title}**:\n${evicted.map(i => `• **${i.title}**`).join('\n').slice(0, 3500)}\n\nThe Main copies are untouched — anything evicted can be re-staged with \`/stage\`.`)] });
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
    const operatorError = formatOperatorError(result.error);
    const embedTitle = boundOperatorLabel(`❌ Stage Failed — ${job.title}`, OPERATOR_EMBED_LIMITS.title);
    finishStageJob(job.id, 'failed', result.error);
    audit('stage_job_failed', { jobId: job.id, mediaId: job.media_id, title: job.title, error: String(result.error).slice(0, 500) });
    notifyChannel('system', { embeds: [brandedEmbed(COLORS.DANGER)
      .setTitle(embedTitle)
      .setDescription(`**Cause:** ${operatorError.cause}\n**Attempts:** ${operatorError.attempts}\n**Diagnostic:**\n\`\`\`text\n${operatorError.diagnostic}\n\`\`\`\n**Next step:** Fix the remote or cache issue, then use Retry Stage to resume the copy.`)],
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
  // Play-triggered promotions are automatic (the viewer didn't ask), so they stay silent too.
  if (job.origin !== 'bulk' && job.origin !== 'play' && job.origin !== 'reconcile') {
    await dmUser(job.requested_by_discord_id, { embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle(`🔥 Ready on the Travel Server — ${src.title || job.title}`)
      .setDescription(`**${src.title || job.title}** (${fmtSpace(src.sizeBytes)}) is now warm in the local cache — it'll play instantly, no more mystery buffering.`)] });
  }
}

// §Phase2 stale-staging reconciliation sweep. The PH box had treated a staged_items row as proof a
// title is local without ever checking the file is present and complete. This verifies each row
// against what's actually on the cache drive (rclone listing) and repairs drift: a row whose file
// vanished — restart, manual cache wipe, or an interrupted copy — is dropped and re-queued; an
// in-flight or partially-copied title is left alone. Runs once on startup and on an interval so the
// disk-pressure guard's accounting and promotion's 'already_local' skip track reality, not the DB.
async function sweepStagedReconciliation() {
  if (!stagingConfigured()) return;
  const rows = listStagedItems();
  if (!rows.length) return;
  const presentBytes = await fetchStagedPresence(rows.map(r => r.dest_path));
  const activeMediaIds = new Set(listActiveStageJobs().map(j => j.media_id));
  const result = reconcileStagedItems({ rows, presentBytes, activeMediaIds });
  // A failed/blind cache listing returns unknown — never delete rows on that (it would restage the
  // whole cache on a transient rclone error). Skip and try again next sweep.
  if (result.unknown) { audit('stage_reconcile_skipped', { reason: 'cache listing unavailable', rows: rows.length }); return; }
  if (!result.restage.length) {
    audit('stage_reconcile_ok', { local: result.local.length, transferring: result.transferring.length });
    return;
  }
  for (const r of result.restage) {
    removeStagedItem(r.media_id);
    enqueueStageJob({ mediaId: r.media_id, mediaType: r.media_type, title: r.title, discordId: r.staged_by_discord_id || CONFIG.ADMIN_USER_ID, origin: 'reconcile' });
    audit('stage_reconcile_restage', { mediaId: r.media_id, title: r.title });
  }
  notifyChannel('cleanup', { embeds: [brandedEmbed(COLORS.WARN)
    .setTitle('🔁 PH Cache Reconciled')
    .setDescription(`${result.restage.length} staged title(s) were missing or incomplete on the cache drive (restart, manual cleanup, or an interrupted copy) and have been re-queued:\n${result.restage.map(r => `• **${r.title}**`).join('\n').slice(0, 3500)}\n\n${result.local.length} verified present · ${result.transferring.length} still transferring.`)] });
  pumpStageQueue().catch(err => log.warn(`Stage queue pump (post-reconcile) failed: ${err.message}`));
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
  new SlashCommandBuilder().setName('download').setDescription('Get a secure download link').addStringOption(o => o.setName('title').setDescription('Movie or show title').setRequired(true)).addIntegerOption(o => o.setName('season').setDescription('Season number').setMinValue(0).setMaxValue(99)).addIntegerOption(o => o.setName('episode').setDescription('Episode number').setMinValue(1).setMaxValue(999)).addBooleanOption(o => o.setName('one_time').setDescription('One-time download link')),
  new SlashCommandBuilder().setName('request').setDescription('Request a movie or show (searches Seerr)').addStringOption(o => o.setName('title').setDescription('Start typing to search — pick from the list').setRequired(true).setAutocomplete(true)).addBooleanOption(o => o.setName('is4k').setDescription('Request the 4K version')),
  new SlashCommandBuilder().setName('link').setDescription('Link a user to Plex email (invites + sets up Seerr)').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('email').setDescription('Plex email — start typing to search linked/Plex users').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('unlink').setDescription('Unlink a user').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('users').setDescription('List linked users').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('status').setDescription('Show status').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('automation').setDescription('Preview or run an automation sweep').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('sweep').setDescription('Automation sweep').setRequired(true).addChoices(
      { name: 'stuck downloads', value: 'stuck' },
      { name: 'AvistaZ escalation', value: 'escalation' },
      { name: 'season packs', value: 'season-pack' },
      { name: 'episode recovery', value: 'episode-recovery' },
    ))
    .addStringOption(o => o.setName('mode').setDescription('Preview makes no changes').setRequired(true).addChoices(
      { name: 'preview', value: 'preview' },
      { name: 'run', value: 'run' },
    )),
  new SlashCommandBuilder().setName('backup-rehearse').setDescription('Verify the newest backup without changing the live database').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('doctor').setDescription('Read-only setup and Main → Philippines transfer checks').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('seerr-test').setDescription('Self-test Seerr Discord linking with a throwaway user').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addBooleanOption(o => o.setName('keep').setDescription('Keep the test user in Seerr so you can inspect its Discord settings')),
  new SlashCommandBuilder().setName('sync').setDescription('Sync users safely').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addStringOption(o => o.setName('mode').setDescription('preview or apply').setRequired(true).addChoices({ name: 'preview', value: 'preview' }, { name: 'apply', value: 'apply' })),
  new SlashCommandBuilder().setName('sync-fix').setDescription('Resolve sync issues found in the preview').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addStringOption(o => o.setName('target').setDescription('Category to fix').setRequired(true).addChoices({ name: 'placeholders', value: 'placeholders' }, { name: 'duplicates', value: 'duplicates' }, { name: 'orphans', value: 'orphans' }, { name: 'mergeemails', value: 'mergeemails' }, { name: 'links', value: 'links' })),
  new SlashCommandBuilder().setName('cleanup').setDescription('Cleanup deleted Seerr users').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addStringOption(o => o.setName('mode').setDescription('preview or apply').setRequired(false).addChoices({ name: 'preview', value: 'preview' }, { name: 'apply', value: 'apply' })),
  new SlashCommandBuilder().setName('invite').setDescription('Invite a member: bot DMs them for their Plex email and auto-sets them up').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addUserOption(o => o.setName('user').setDescription('Member to invite').setRequired(true)).addStringOption(o => o.setName('email').setDescription('Skip the DM — set them up with this Plex email right away').setAutocomplete(true)).addStringOption(o => o.setName('server').setDescription('Home server (only applies with `email` set — otherwise they pick it in the DM)').addChoices({ name: 'Main (USA)', value: 'primary' }, { name: 'Philippines', value: 'ph' })),
  new SlashCommandBuilder().setName('invite-post').setDescription('Post a public "Request Plex Access" button in this channel').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('reinvite').setDescription('Re-send a Plex invite to a linked user').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addUserOption(o => o.setName('user').setDescription('Discord user currently in the server')).addStringOption(o => o.setName('email').setDescription('Any linked user — start typing to search the DB').setAutocomplete(true)),
  new SlashCommandBuilder().setName('requests').setDescription('Show the most recent Seerr requests').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addIntegerOption(o => o.setName('count').setDescription('How many to show (default 10)').setMinValue(1).setMaxValue(25)),
  new SlashCommandBuilder().setName('pending').setDescription('Review requests awaiting approval').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('whorequested').setDescription('Find who requested a tracked title').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addStringOption(o => o.setName('title').setDescription('Start typing — matches all tracked requests').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('audit').setDescription('Audit log queries').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('recent').setDescription('Recent entries').addIntegerOption(o => o.setName('count').setDescription('Count').setMinValue(1).setMaxValue(100)))
    .addSubcommand(s => s.setName('user').setDescription('Entries by user').addUserOption(o => o.setName('person').setDescription('User').setRequired(true)).addIntegerOption(o => o.setName('count').setDescription('Count').setMinValue(1).setMaxValue(100)))
    .addSubcommand(s => s.setName('action').setDescription('Entries by action').addStringOption(o => o.setName('action').setDescription('Action name').setRequired(true)).addIntegerOption(o => o.setName('count').setDescription('Count').setMinValue(1).setMaxValue(100))),
  new SlashCommandBuilder().setName('queue').setDescription('Show what is downloading right now'),
  new SlashCommandBuilder().setName('request-status').setDescription('Check why a requested movie or show is not ready yet').addStringOption(o => o.setName('title').setDescription('Start typing — matches your recent requests').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('notifications').setDescription('Choose which request progress DMs you receive').addBooleanOption(o => o.setName('request_updates').setDescription('Future release, stalled, failed, and exhausted request DMs').setRequired(true)),
  new SlashCommandBuilder().setName('request-cancel').setDescription('Withdraw one of your own pending or awaiting-download requests').addStringOption(o => o.setName('title').setDescription('Start typing — matches your cancelable requests').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('report').setDescription('Report a problem with something already on Plex (wrong subtitles, bad audio, etc.)')
    .addStringOption(o => o.setName('title').setDescription('Start typing — matches available media').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('type').setDescription('What kind of problem').setRequired(true)
      .addChoices({ name: 'Video', value: '1' }, { name: 'Audio', value: '2' }, { name: 'Subtitle', value: '3' }, { name: 'Other', value: '4' }))
    .addStringOption(o => o.setName('details').setDescription('Describe the problem').setRequired(true)),
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
  new SlashCommandBuilder().setName('season').setDescription('Season-pack sweep: force a search now, or see why one hasn\'t happened').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('search').setDescription('Force a season search right now (Sonarr, or AvistaZ direct if the series is tagged)')
      .addStringOption(o => o.setName('title').setDescription('Sonarr series — start typing to search').setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName('season').setDescription('Season number').setRequired(true).setMinValue(0).setMaxValue(99))
      .addBooleanOption(o => o.setName('force').setDescription('Skip the cooldown/backoff (default: respect it)')))
    .addSubcommand(s => s.setName('status').setDescription('Why the automatic sweep has or hasn\'t touched this series')
      .addStringOption(o => o.setName('title').setDescription('Sonarr series — start typing to search').setRequired(true).setAutocomplete(true))),
  new SlashCommandBuilder().setName('cleanup-suggestions').setDescription('Largest/oldest media that could be cleaned up').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('stage').setDescription('Copy a title into the travel-server cache so it plays instantly there').addStringOption(o => o.setName('title').setDescription('Start typing — matches what\'s in the library').setRequired(true).setAutocomplete(true)),
  // Cache-management trio is admin-gated by default; /stage stays member-visible (self-serve,
  // rate-limited). To let e.g. a PH role pin without code changes, grant these per-role in
  // Server Settings → Integrations — that's why the handlers deliberately don't re-check admin.
  new SlashCommandBuilder().setName('staged').setDescription('Show the travel-server cache: what\'s warm, pinned, and copying').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('pin').setDescription('Protect a cached title from automatic eviction').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addStringOption(o => o.setName('title').setDescription('Cached title — start typing').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('unpin').setDescription('Remove eviction protection from a cached title').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addStringOption(o => o.setName('title').setDescription('Pinned title — start typing').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('stage-bulk').setDescription('Seed the travel cache from a list of titles (one per line)').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('assign-server').setDescription('Set which Plex server a user belongs to (drives invites + auto-staging)').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(o => o.setName('server').setDescription('Home server').setRequired(true).addChoices({ name: 'Main', value: 'primary' }, { name: 'Philippines', value: 'ph' })),
  new SlashCommandBuilder().setName('me').setDescription('Show your linked profile'),
  new SlashCommandBuilder().setName('stats').setDescription('Your watch/request stats this month (admins can see the server-wide view)')
    .addBooleanOption(o => o.setName('server').setDescription('Admin only: server-wide stats instead of your own')),
  new SlashCommandBuilder().setName('myrequests').setDescription('Show your recent requests'),
  new SlashCommandBuilder().setName('downloads').setDescription('Show your active download links'),
  new SlashCommandBuilder().setName('keep').setDescription('Show your keep list'),
  new SlashCommandBuilder().setName('help').setDescription('How this media server works'),
  new SlashCommandBuilder().setName('tier').setDescription('Regional tiering: per-node edge-cache plans').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('preview').setDescription('Dry-run the planner — shows keep/drop per node, writes nothing')
      .addStringOption(o => o.setName('node').setDescription('Only this node'))
      .addBooleanOption(o => o.setName('details').setDescription('Per-title change list for a single node (folder, size, state)')))
    .addSubcommand(s => s.setName('apply').setDescription('Publish manifests — agents converge on their next run')
      .addStringOption(o => o.setName('node').setDescription('Only this node'))
      .addBooleanOption(o => o.setName('details').setDescription('Per-title change list for a single node'))
      .addStringOption(o => o.setName('confirm').setDescription('Confirmation code for a large rebalance (shown when apply is held)'))),
  new SlashCommandBuilder().setName('tier-node').setDescription('Manage the tiering node registry').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('add').setDescription('Add or update a node')
      .addStringOption(o => o.setName('name').setDescription('Node name, e.g. california').setRequired(true))
      .addIntegerOption(o => o.setName('usable_gb').setDescription('Pool usable capacity in GB').setMinValue(0))
      .addIntegerOption(o => o.setName('headroom_pct').setDescription('Free-space floor % (default 15; ~25 for old drives)').setMinValue(0).setMaxValue(95))
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
      .addIntegerOption(o => o.setName('warm_days').setDescription('Override: recently-watched protection window').setMinValue(0).setMaxValue(3650))
      .addIntegerOption(o => o.setName('fresh_days').setDescription('Override: newly-added grace window').setMinValue(0).setMaxValue(3650)))
    .addSubcommand(s => s.setName('list').setDescription('List all nodes'))
    .addSubcommand(s => s.setName('enable').setDescription('Enable a node').addStringOption(o => o.setName('name').setDescription('Node name').setRequired(true)))
    .addSubcommand(s => s.setName('disable').setDescription('Disable a node (skipped by the planner entirely)').addStringOption(o => o.setName('name').setDescription('Node name').setRequired(true)))
    .addSubcommand(s => s.setName('token').setDescription('(Re)generate the node\'s sync-agent bearer token — shown once').addStringOption(o => o.setName('name').setDescription('Node name').setRequired(true)))
    .addSubcommandGroup(g => g.setName('folder').setDescription('Manage a node\'s Syncthing folders (multi-folder nodes)')
      .addSubcommand(s => s.setName('add').setDescription('Add or update a Syncthing folder on a node')
        .addStringOption(o => o.setName('name').setDescription('Node name').setRequired(true))
        .addStringOption(o => o.setName('folder_id').setDescription('Syncthing folder id, e.g. aaaaa-bbbbb').setRequired(true))
        .addStringOption(o => o.setName('folder_root').setDescription('Folder root path on that node, e.g. /mnt/media/Media/Movies').setRequired(true)))
      .addSubcommand(s => s.setName('remove').setDescription('Remove a Syncthing folder from a node')
        .addStringOption(o => o.setName('name').setDescription('Node name').setRequired(true))
        .addStringOption(o => o.setName('folder_id').setDescription('Syncthing folder id').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('List a node\'s Syncthing folders')
        .addStringOption(o => o.setName('name').setDescription('Node name').setRequired(true)))),
  new SlashCommandBuilder().setName('tier-member').setDescription('Manage a restricted node\'s member set').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('add').setDescription('Add a member').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('node').setDescription('Restricted node name').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a member').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('node').setDescription('Restricted node name').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('List members').addStringOption(o => o.setName('node').setDescription('Restricted node name').setRequired(true))),
  new SlashCommandBuilder().setName('revoke-downloads').setDescription('Revoke download links').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('scope').setDescription('all or user').setRequired(true).addChoices({ name: 'all', value: 'all' }, { name: 'user', value: 'user' }))
    .addUserOption(o => o.setName('user').setDescription('User for user scope').setRequired(false)),
].map(v => v.toJSON());

async function registerSlashCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_BOT_TOKEN);
    await rest.put(Routes.applicationGuildCommands(CONFIG.DISCORD_CLIENT_ID, CONFIG.DISCORD_GUILD_ID), { body: slashCommands });
    log.ok(`Registered ${slashCommands.length} slash command(s)`);
  } catch (err) {
    log.error(`Slash command registration failed: ${err.message}. Retrying in 5 minutes.`);
    notifyChannel('system', `❌ Slash command registration failed: ${err.message}. The bot and automations are still running; registration retries in 5 minutes.`);
    setTimeout(registerSlashCommands, 5 * 60000).unref();
  }
}

async function sweepRequestStatuses() {
  const remoteRequests = await requestReconcileStage('Seerr request inventory', () => fetchRequestInventoryWithRetry(fetchSeerrRequests));
  const result = await requestReconcileStage('local request reconciliation', () => reconcileRequestStatuses(remoteRequests));
  for (const change of result.changed.filter(row => row.to === 'failed')) {
    const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(change.id);
    if (!request?.requested_by_discord_id || !requestProgressDmEnabled(request.requested_by_discord_id) || getSetting(`request_failure_notified:${change.id}`)) continue;
    await dmUser(request.requested_by_discord_id, { embeds: [brandedEmbed(COLORS.DANGER)
      .setTitle(`❌ Request Failed — ${request.title}`.slice(0, 256))
      .setDescription('This request **failed in Seerr**. It is no longer downloading.')
      .addFields(
        { name: 'Type', value: mediaTypeLabel(request.media_type, request.is_4k), inline: true },
        { name: 'What happens next', value: 'An admin can inspect Seerr and the arr queue before retrying it.', inline: false },
      )] });
    setSetting(`request_failure_notified:${change.id}`, String(Date.now()));
    audit('request_failure_notified', { targetDiscordId: request.requested_by_discord_id, requestId: request.overseerr_request_id, title: request.title });
  }
  if (result.changed.length || result.repaired.length) {
    log.info(`Reconciled request tracking: ${result.changed.length} status update(s), ${result.repaired.length} stale pending row(s) removed`);
  }
  const notifications = await requestReconcileStage('request progress notifications', () => sweepRequestProgressNotifications(remoteRequests));
  return { ...result, notifications };
}

async function sweepRequestProgressNotifications(remoteRequests) {
  const rows = db.prepare(`SELECT * FROM requests
    WHERE status = 'approved' AND overseerr_request_id IS NOT NULL AND requested_by_discord_id IS NOT NULL
    ORDER BY id`).all();
  if (!rows.length) return { eta: 0, stalled: 0 };
  const queue = await fetchArrQueues();
  const remoteById = new Map((remoteRequests || []).filter(row => row?.id != null).map(row => [String(row.id), row]));
  const counts = { eta: 0, stalled: 0 };
  for (const row of rows) {
    if (!isSnowflake(row.requested_by_discord_id) || !requestProgressDmEnabled(row.requested_by_discord_id)) continue;
    const tmdbId = resolveTmdbId(row);
    const remote = remoteById.get(String(row.overseerr_request_id));
    let tvdbId = row.media_id.startsWith('tvdb:') ? Number(row.media_id.split(':')[1]) : Number(remote?.media?.tvdbId) || null;
    if (row.media_type === 'tv' && !tvdbId && tmdbId) tvdbId = await fetchSeerrTvdbId(tmdbId).catch(() => null);
    if (findRequestQueueItem(row, queue, tvdbId)) continue;

    const eta = releaseEtaInfo(await fetchReleaseEta({ mediaType: row.media_type, tmdbId, tvdbId }));
    if (eta?.waiting) {
      const key = `request_eta_notified:${row.id}`;
      if (getSetting(key)) continue;
      await dmUser(row.requested_by_discord_id, { embeds: [brandedEmbed(COLORS.INFO)
        .setTitle(`🗓️ Not Out Yet — ${row.title}`.slice(0, 256))
        .setDescription('Your request is approved, but it is **not available to download yet**.')
        .addFields(
          { name: 'Type', value: mediaTypeLabel(row.media_type, row.is_4k), inline: true },
          { name: 'Expected', value: eta.line, inline: false },
          { name: 'What happens next', value: 'The bot keeps checking automatically and will grab it as soon as a release shows up. Nothing for you to do.', inline: false },
        )] });
      setSetting(key, String(Date.now()));
      audit('request_eta_notified', { targetDiscordId: row.requested_by_discord_id, requestId: row.overseerr_request_id, title: row.title });
      counts.eta++;
      continue;
    }

    const ageMs = Date.now() - sqliteUtcMs(row.created_at);
    if (ageMs < tunable('REQUEST_STALLED_HOURS') * 3600000) continue;
    const key = `request_stalled_notified:${row.id}`;
    if (getSetting(key)) continue;
    await dmUser(row.requested_by_discord_id, { embeds: [brandedEmbed(COLORS.WARN)
      .setTitle(`⏳ Still Looking — ${row.title}`.slice(0, 256))
      .setDescription(`Approved ${fmtDuration(ageMs)} ago, but I cannot confirm an active download or a future release date.`)
      .addFields(
        { name: 'Type', value: mediaTypeLabel(row.media_type, row.is_4k), inline: true },
        { name: 'Waiting', value: fmtDuration(ageMs), inline: true },
        { name: 'What happens next', value: 'Searches may still be running. An admin can check Seerr and the arr queue, or retry it.', inline: false },
      )] });
    setSetting(key, String(Date.now()));
    audit('request_stalled_notified', { targetDiscordId: row.requested_by_discord_id, requestId: row.overseerr_request_id, title: row.title });
    counts.stalled++;
  }
  return counts;
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
  // every Watchtower restart would ping the admin channel. Whichever way it goes, say so in the
  // log: "connected" on its own used to read as success even when the ping never left the process.
  if (!channelFor('deploy')) {
    log.info('Deploy ping skipped: DEPLOY_CHANNEL_ID is unset (set it to a channel ID to get a "Bot Online" post after each restart)');
  } else {
    const sent = await notifyChannel('deploy', { embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle('🚀 Bot Online')
      .setDescription(`Restarted and connected as **${client.user.tag}**${process.env.GIT_SHA ? ` — image \`${process.env.GIT_SHA}\`` : ''}.`)] });
    if (sent) log.ok(`Deploy ping posted to channel ${channelFor('deploy')}${process.env.GIT_SHA ? ` (image ${process.env.GIT_SHA})` : ' (no GIT_SHA baked in — this image was not built by CI)'}`);
  }
  rehydratePendingEmails();
  startExpressServer();
  registerSlashCommands();
  scheduleTunableSweep({ label: 'Pending-approval sweep', minutesKey: 'PENDING_APPROVAL_CHECK_MINUTES', fn: () => runGuardedSweep('pending-approvals', sweepPendingApprovals) });
  log.ok(`Pending-approval sweep every ${tunable('PENDING_APPROVAL_CHECK_MINUTES')} min (nudge ${tunable('PENDING_APPROVAL_NUDGE_HOURS')}h, requester update ${tunable('PENDING_APPROVAL_REQUESTER_HOURS')}h, expire ${tunable('PENDING_APPROVAL_EXPIRE_DAYS')}d)`);
  if (CONFIG.REQUEST_RECONCILE_MINUTES > 0) {
    // Seerr often starts alongside the bot. Give it one minute to bind its port, then let the
    // inventory reader retry transient connection failures before recording a failed run.
    setTimeout(() => runGuardedSweep('request-reconcile', sweepRequestStatuses)
      .catch(err => log.warn(`Request reconciliation failed: ${err.message}`)), 60000).unref();
    setInterval(() => runGuardedSweep('request-reconcile', sweepRequestStatuses).catch(err => log.warn(`Request reconciliation failed: ${err.message}`)), CONFIG.REQUEST_RECONCILE_MINUTES * 60000).unref();
    log.ok(`Seerr request reconciliation starts after 1 min and runs every ${CONFIG.REQUEST_RECONCILE_MINUTES} min`);
  }
  // The arr URLs are a static prerequisite (no arrs configured, nothing to watch); the cadence and
  // thresholds are runtime-tunable, so the timer is armed either way and decides per tick.
  if (arrSources().length) {
    scheduleTunableSweep({ label: 'Stuck-download sweep', minutesKey: 'STUCK_CHECK_MINUTES', fn: () => runGuardedSweep('stuck', sweepStuckDownloads) });
    log.ok(`Stuck-download watchdog every ${tunable('STUCK_CHECK_MINUTES')} min (threshold ${tunable('STUCK_AFTER_MINUTES')} min)`);
  }
  if (CONFIG.RADARR_URL || CONFIG.SONARR_URL) {
    // Non-fatal setup check: escalation fails with tag_missing until the AvistaZ tag exists.
    if (tunable('ESCALATION_ENABLED')) verifyAvistazTags(CONFIG.AVISTAZ_TAG).then(missing => {
      for (const w of missing) log.warn(`Config: ${w.replace(/`/g, '')}`);
      if (missing.length) {
        notifyChannel('system', { embeds: [brandedEmbed(COLORS.WARN)
          .setTitle('⚙️ AvistaZ Escalation Warnings')
          .setDescription(missing.map(w => `• ${w}`).join('\n').slice(0, 4000))] });
      }
    }).catch(err => log.warn(`AvistaZ tag check failed: ${err.message}`));
    scheduleTunableSweep({ label: 'Escalation sweep', minutesKey: 'ESCALATION_CHECK_MINUTES', enabledKey: 'ESCALATION_ENABLED', fn: () => runGuardedSweep('escalation', sweepEscalations) });
    log.ok(`AvistaZ escalation watchdog every ${tunable('ESCALATION_CHECK_MINUTES')} min (delay ${escalationDelayLabel()}, tag '${CONFIG.AVISTAZ_TAG}')`);
  }
  if (CONFIG.SONARR_URL) {
    // A first pass shortly after boot, then on the interval — Sonarr needs a moment to settle
    // after a restart, and the sweep is capped per run anyway. sweepSeasonPacks() re-checks the
    // SEASON_PACK_FIRST toggle itself, so a paused tick costs nothing.
    scheduleTunableSweep({ label: 'Season-pack sweep', minutesKey: 'SEASON_PACK_CHECK_MINUTES', enabledKey: 'SEASON_PACK_FIRST', fn: () => runGuardedSweep('season-pack', sweepSeasonPacks), firstRunDelayMs: 120000 });
    log.ok(`Season-pack-first search every ${tunable('SEASON_PACK_CHECK_MINUTES')} min (old = ended or ${tunable('SEASON_PACK_DORMANT_DAYS')}d dormant, max ${tunable('SEASON_PACK_MAX_PER_RUN')}/run)`);
  }
  if (grabConfigured()) {
    // A restart mid-transfer leaves 'transferring' rows behind; put them back in the queue
    // (rclone copy skips files that already made it across).
    const resumed = resetInterruptedGrabTransfers();
    if (resumed) log.info(`Re-queued ${resumed} AvistaZ transfer(s) interrupted by restart`);
    if (CONFIG.GRAB_CHECK_MINUTES > 0) {
      setInterval(() => runGuardedSweep('grab', sweepGrabJobs).catch(err => log.warn(`Grab sweep failed: ${err.message}`)), CONFIG.GRAB_CHECK_MINUTES * 60000).unref();
    }
    pumpGrabTransfers().catch(err => log.warn(`Grab transfer pump failed: ${err.message}`));
    log.ok(`AvistaZ direct grab enabled → seedbox rTorrent (sweep every ${CONFIG.GRAB_CHECK_MINUTES} min, mode ${CONFIG.GRAB_MODE}, daily limit ${CONFIG.AVISTAZ_DAILY_GRAB_LIMIT || 'unlimited'})`);
  }
  if (CONFIG.RTORRENT_ADOPT_ENABLED && adoptPipelineReady() && CONFIG.RTORRENT_ADOPT_CHECK_MINUTES > 0) {
    setInterval(() => runGuardedSweep('adoption', sweepAdoptCandidates).catch(err => log.warn(`Adoption sweep failed: ${err.message}`)), CONFIG.RTORRENT_ADOPT_CHECK_MINUTES * 60000).unref();
    log.ok(`rTorrent adoption discovery running every ${CONFIG.RTORRENT_ADOPT_CHECK_MINUTES} min (labels: ${CONFIG.RTORRENT_ADOPT_LABELS.join(', ') || 'none'}, auto: ${CONFIG.RTORRENT_ADOPT_AUTO ? 'on' : 'off'})`);
  }
  if (CONFIG.JANITOR_CHECK_MINUTES > 0) {
    setInterval(() => runGuardedSweep('janitor', janitorSweep).catch(err => log.warn(`Janitor sweep failed: ${err.message}`)), CONFIG.JANITOR_CHECK_MINUTES * 60000).unref();
    log.ok(`Janitor running every ${CONFIG.JANITOR_CHECK_MINUTES} min (grace deletes: ${CONFIG.ENABLE_DELETION ? 'on' : 'off'}, retention: ${CONFIG.RETENTION_ENFORCEMENT ? 'on' : 'off'}, dry-run: ${CONFIG.DELETION_DRY_RUN ? 'on' : 'off'})`);
  }
  if (CONFIG.BACKUP_INTERVAL_HOURS > 0) {
    setInterval(() => runGuardedSweep('backup', sweepBackup).catch(err => log.warn(`Backup sweep failed: ${err.message}`)), CONFIG.BACKUP_INTERVAL_HOURS * 3600000).unref();
    log.ok(`DB backup running every ${CONFIG.BACKUP_INTERVAL_HOURS}h → ${CONFIG.BACKUP_DIR} (keeping last ${CONFIG.BACKUP_KEEP_COUNT})`);
  }
  if (CONFIG.MONTHLY_RECAP_ENABLED) {
    // Checked hourly, like the other "last_run" gated sweeps in janitorSweep, but this one fires
    // rarely enough to run on its own interval rather than folding into that sweep.
    setInterval(() => runGuardedSweep('monthly-recap', sweepMonthlyRecap).catch(err => log.warn(`Monthly recap sweep failed: ${err.message}`)), 3600000).unref();
    log.ok('Monthly community recap enabled — posts to the whats_new channel roughly every 30 days');
  }
  if (tautulliConfigured() && CONFIG.PLAYBACK_CHECK_MINUTES > 0) {
    setInterval(() => runGuardedSweep('transcode', sweepTranscodes).catch(err => log.warn(`Transcode sweep failed: ${err.message}`)), CONFIG.PLAYBACK_CHECK_MINUTES * 60000).unref();
    log.ok(`Transcode watchdog running every ${CONFIG.PLAYBACK_CHECK_MINUTES} min`);
  }
  if (premiumizeConfigured() && CONFIG.PREMIUMIZE_CHECK_MINUTES > 0) {
    setInterval(() => runGuardedSweep('premiumize', sweepPremiumizeTransfers).catch(err => log.warn(`Premiumize sweep failed: ${err.message}`)), CONFIG.PREMIUMIZE_CHECK_MINUTES * 60000).unref();
    log.ok(`Premiumize transfer watchdog running every ${CONFIG.PREMIUMIZE_CHECK_MINUTES} min (stuck after ${CONFIG.PREMIUMIZE_STUCK_AFTER_MINUTES} min)`);
  }
  if (stagingConfigured()) {
    // A restart mid-copy leaves 'copying' rows behind; put them back in the queue and let the
    // worker pick them up (rclone skips files that already made it across).
    const resumed = resetInterruptedStageJobs();
    if (resumed) log.info(`Re-queued ${resumed} stage job(s) interrupted by restart`);
    if (CONFIG.STAGE_CHECK_MINUTES > 0) {
      setInterval(() => runGuardedSweep('stage-queue', pumpStageQueue).catch(err => log.warn(`Stage queue pump failed: ${err.message}`)), CONFIG.STAGE_CHECK_MINUTES * 60000).unref();
    }
    pumpStageQueue().catch(err => log.warn(`Stage queue pump failed: ${err.message}`));
    // §Phase2: reconcile the staged_items DB against the cache drive once at startup (the DB may have
    // drifted while the process was down) and then periodically.
    sweepStagedReconciliation().catch(err => log.warn(`Stage reconciliation failed: ${err.message}`));
    if (CONFIG.STAGE_RECONCILE_MINUTES > 0) {
      setInterval(() => runGuardedSweep('stage-reconcile', sweepStagedReconciliation).catch(err => log.warn(`Stage reconciliation failed: ${err.message}`)), CONFIG.STAGE_RECONCILE_MINUTES * 60000).unref();
    }
    log.ok(`Plex Home staging enabled → ${CONFIG.STAGE_RCLONE_REMOTE} (queue check every ${CONFIG.STAGE_CHECK_MINUTES} min, min free ${CONFIG.STAGE_MIN_FREE_GB} GB)`);
  }
  if (CONFIG.PH_TUNNEL_HEALTH_URL && CONFIG.PH_TUNNEL_CHECK_MINUTES > 0) {
    setInterval(() => runGuardedSweep('tunnel', sweepTunnelHealth).catch(err => log.warn(`Tunnel health sweep failed: ${err.message}`)), CONFIG.PH_TUNNEL_CHECK_MINUTES * 60000).unref();
    log.ok(`PH tunnel watchdog running every ${CONFIG.PH_TUNNEL_CHECK_MINUTES} min (alert after ${CONFIG.PH_TUNNEL_FAILS_BEFORE_ALERT} failures)`);
  }
});

client.on('guildMemberAdd', async member => {
  // Set the pending flag regardless of whether the DM lands, so that if this member has DMs
  // disabled but later opens them (or messages the bot unsolicited), messageCreate still
  // recognizes them as mid-onboarding instead of silently dropping their reply.
  setPendingEmail(member.id);
  try {
    await member.send({ embeds: [brandedEmbed(COLORS.PLEX)
      .setTitle('👋 Welcome to Durant Media Server!')
      .setDescription('Glad to have you here! To request access, just **reply to this message with the email on your Plex account**.\n\nOnce an admin approves you, you\'ll get a Plex invite and a DM confirming you\'re all set. 🍿'
        + (phServerConfigured() ? '\n\nOn the **Philippines server**? Tap the button below before you reply so I invite you to the right one — otherwise I\'ll default you to the main (USA) servers.' : ''))],
      components: phServerConfigured() ? [homeServerPickerRow()] : [] });
  } catch (err) {
    log.warn(`Could not DM ${member.user.tag}: ${err.message}`);
    notifyChannel('system', { embeds: [brandedEmbed(COLORS.WARN)
      .setTitle('⚠️ Welcome DM Failed')
      .setDescription(`Couldn't DM <@${member.id}> (${member.user.tag}) — they likely have server DMs turned off, so the usual onboarding message never landed.\n\nPoint them at the **Request Plex Access** button instead (\`/invite-post\` if one isn't posted yet).`)] });
  }
});

client.on('guildMemberRemove', async member => {
  clearPendingEmail(member.id);
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
    revokeMemberRole(member.id).catch(() => {});
    audit('user_unlinked', { targetDiscordId: member.id, email: user.email, removed: result.removed });
    notifyChannel('audit', `⚠️ User left Discord: <@${member.id}> (${user.email}). Plex removed: ${result.removed ? 'yes' : 'no'}`);
  } catch (err) {
    audit('external_api_error', { targetDiscordId: member.id, provider: 'plex', error: err.message });
    notifyChannel('audit', `⚠️ Failed to remove Plex access for ${user.email}: ${err.message}`);
  }
});

// The email modal opened by the public Request Access button. The server pick (if any) rides in
// the customId suffix since a modal can't carry a select menu/buttons of its own.
function requestAccessModal(server) {
  return new ModalBuilder()
    .setCustomId(`request_access_modal:${server}`)
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
}

// Two buttons offered wherever a requester can pick their home server before an admin approves
// them (DM onboarding, /invite's DM). Only shown when a PH box is actually configured.
function homeServerPickerRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('onboard_server:primary').setLabel('🇺🇸 Main (USA) Servers').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('onboard_server:ph').setLabel('🇵🇭 Philippines Server').setStyle(ButtonStyle.Secondary),
  );
}

// Post the Approve/Deny access-request embed to the admin channel. Shared by the DM email flow
// and the public Request Access modal. homeServer reflects what the requester already picked
// (or 'primary' by default) — Approve honors it as-is; Approve + Tailscale still lets an admin
// force PH regardless.
async function postAccessRequestToAdmins(user, email, homeServer = 'primary') {
  const adminChannel = await safeGetChannel(CONFIG.ADMIN_CHANNEL_ID);
  if (!adminChannel) {
    log.error(`Access request for ${user.id} could not be posted: ADMIN_CHANNEL_ID is unavailable.`);
    return false;
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`plex_approve:${user.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`plex_deny:${user.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
  );
  // Optional third button (env-gated): approves onto the PH/travel server and adds Tailscale
  // setup instructions to their DM. Admin picks this per-person — regular Approve is unchanged.
  if (CONFIG.TAILSCALE_ENABLED) {
    row.addComponents(new ButtonBuilder().setCustomId(`plex_approve_ts:${user.id}`).setLabel('Approve + Tailscale (PH)').setStyle(ButtonStyle.Primary));
  }
  const requestEmbed = brandedEmbed(COLORS.INFO)
    .setTitle('🔐 New Plex Access Request')
    .addFields({ name: 'User', value: `<@${user.id}>`, inline: true }, { name: 'Email', value: `\`${email}\``, inline: true });
  if (homeServer === 'ph') requestEmbed.addFields({ name: 'Requested server', value: '🇵🇭 Philippines', inline: true });
  const avatarUrl = user.displayAvatarURL?.();
  if (avatarUrl) requestEmbed.setThumbnail(avatarUrl);
  await adminChannel.send({ embeds: [requestEmbed], components: [row] });
  return true;
}

client.on('messageCreate', async message => {
  if (message.author.bot || message.guild) return;
  if (!hasPendingEmail(message.author.id)) return;
  const email = message.content.trim().toLowerCase();
  if (!isValidEmail(email)) return message.reply('That does not look like a valid email. Try again.');
  const homeServer = takePendingHomeServer(message.author.id);
  clearPendingEmail(message.author.id);
  if (homeServer === 'ph') setUserHomeServer(message.author.id, 'ph');

  // Admin-initiated invite (/invite): the admin already vouched for this person, so skip the
  // Approve button and run the full chain (absorb + Plex invite + Seerr) the moment they reply.
  if (getSetting(`admin_invited:${message.author.id}`)) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`admin_invited:${message.author.id}`);
    const { absorbed, plexStatus, seerrStatus, plexOk, seerrOk } = await applyFullChainLink(message.author.id, email, message.author.username);
    audit('user_linked', { targetDiscordId: message.author.id, email, source: 'admin_invite_auto', absorbedPlexRow: absorbed?.discord_id || null });
    const hadAccess = plexStatus.includes('already');
    await message.reply({ embeds: [brandedEmbed(plexOk ? COLORS.SUCCESS : COLORS.WARN)
      .setTitle(plexOk ? '🎉 You\'re In!' : '⚠️ Your Setup Needs Attention')
      .setDescription(plexOk
        ? (hadAccess ? `You're all set — \`${email}\` already has Plex access. Use \`/help\` here to see everything I can do. 🍿` : `📬 A Plex invite was sent to \`${email}\` — accept it and you're set. Use \`/help\` here to see everything I can do. 🍿`)
        : `The Plex invite to \`${email}\` failed. An admin has the failure details and can retry your setup.`)] });
    notifyChannel('audit', { embeds: [brandedEmbed(plexOk && seerrOk ? COLORS.SUCCESS : COLORS.WARN)
      .setTitle(plexOk && seerrOk ? '✅ Admin Invite Completed' : '⚠️ Admin Invite Needs Attention')
      .setDescription(`<@${message.author.id}> replied with \`${email}\`.`)
      .addFields(
        { name: 'Plex', value: plexStatus, inline: true },
        { name: 'Seerr', value: seerrStatus, inline: true },
      )] });
    return;
  }

  // Someone else's real (already-linked) Discord account already owns this email — don't create a
  // second `users` row for the same address, since every canonical-email lookup after that (role
  // sync, webhook DMs, escalation…) would arbitrarily pick one of the two and silently strand the
  // other. Flag it for an admin instead of guessing.
  const conflict = findConflictingRealUser(message.author.id, email);
  if (conflict) {
    audit('email_collision', { actorDiscordId: message.author.id, targetDiscordId: conflict.discord_id, email });
    await message.reply('⚠️ That email is already linked to another Discord account here. If that wasn\'t you, please double-check the address — otherwise flag an admin to help sort it out.');
    notifyChannel('admin', `⚠️ <@${message.author.id}> replied with \`${email}\`, which is already linked to <@${conflict.discord_id}>. Needs manual review before either account is approved.`);
    return;
  }

  // linkUserToEmail (not storeUserEmail) so an existing plex_ synthetic row with the same email is
  // absorbed instead of becoming a duplicate pair — e.g. an existing Plex friend joining Discord.
  linkUserToEmail(message.author.id, email);
  audit('user_linked', { targetDiscordId: message.author.id, email, homeServer });
  const posted = await postAccessRequestToAdmins(message.author, email, homeServer).catch(err => {
    log.error(`Access request for ${message.author.id} failed to post: ${err.message}`);
    return false;
  });
  await message.reply(posted
    ? '✅ Thanks! Your request has been sent to the admins for approval. You\'ll get a DM here as soon as you\'re approved.'
    : '❌ I saved your email, but I could not notify the admins. Please tell an admin to check `ADMIN_CHANNEL_ID`; the Request Plex Access button can retry the notice.');
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isAutocomplete()) return handleAutocomplete(interaction);
    if (interaction.isChatInputCommand()) await handleSlashCommand(interaction);
    if (interaction.isButton()) {
      if (buttonActionsInFlight.has(interaction.customId)) {
        return interaction.reply({ content: '⏳ This action is already being processed.', ephemeral: true });
      }
      buttonActionsInFlight.add(interaction.customId);
      try { await handleButton(interaction); } finally { buttonActionsInFlight.delete(interaction.customId); }
    }
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

  // /season search|status title: — Sonarr's own library, scored by token overlap (same approach
  // as the guided-import wizard's series picker), recently-added first on ties.
  if (interaction.commandName === 'season') {
    const focusedTitle = interaction.options.getFocused(true);
    if (focusedTitle.name !== 'title') return interaction.respond([]).catch(() => {});
    const q = String(focusedTitle.value || '').trim();
    try {
      const all = await listSonarrSeries();
      const tokens = normalizeTitle(q).split(' ').filter(Boolean);
      const scored = all.map(s => {
        const hay = ` ${normalizeTitle(`${s.title} ${(s.alternateTitles || []).map(t => t.title).join(' ')}`)} `;
        return { s, score: tokens.filter(t => hay.includes(` ${t} `)).length };
      }).sort((a, b) => b.score - a.score || String(b.s.added || '').localeCompare(String(a.s.added || '')));
      const pool = tokens.length ? (scored.filter(x => x.score > 0).length ? scored.filter(x => x.score > 0) : scored) : scored;
      const choices = pool.slice(0, 25).map(({ s }) => ({
        name: `${s.title}${s.year ? ` (${s.year})` : ''}`.slice(0, 100),
        value: String(s.id),
      }));
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

  if (interaction.commandName === 'whorequested') {
    const focusedTitle = interaction.options.getFocused(true);
    if (focusedTitle.name !== 'title') return interaction.respond([]).catch(() => {});
    const q = String(focusedTitle.value || '').toLowerCase().trim();
    const rows = db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 500').all();
    const seen = new Set();
    const choices = [];
    for (const r of rows) {
      if (q && !String(r.title || '').toLowerCase().includes(q)) continue;
      if (seen.has(r.id)) continue;
      const siblings = rows.filter(candidate => candidate.media_type === r.media_type
        && !!candidate.is_4k === !!r.is_4k
        && (candidate.media_id === r.media_id || (
        candidate.title === r.title
        && candidate.requested_by_discord_id === r.requested_by_discord_id
        && String(candidate.media_id).split(':')[0] !== String(r.media_id).split(':')[0]
        )));
      for (const sibling of siblings) seen.add(sibling.id);
      const current = siblings.find(candidate => candidate.status === 'available') || siblings.find(candidate => candidate.status === 'failed') || r;
      choices.push({ name: `${r.title}${r.is_4k ? ' (4K)' : ''} · ${current.status}`.slice(0, 100), value: `request:${r.id}` });
      if (choices.length >= 25) break;
    }
    return interaction.respond(choices).catch(() => {});
  }

  // /request-cancel title: — only the requester's own still-outstanding (pending/approved)
  // requests. Once available or declined there's nothing left to withdraw.
  if (interaction.commandName === 'request-cancel') {
    const focusedTitle = interaction.options.getFocused(true);
    if (focusedTitle.name !== 'title') return interaction.respond([]).catch(() => {});
    const q = String(focusedTitle.value || '').toLowerCase().trim();
    const rows = db.prepare("SELECT * FROM requests WHERE requested_by_discord_id = ? AND status IN ('pending', 'approved') ORDER BY id DESC LIMIT 500").all(interaction.user.id);
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

  // /report title: — only media that's actually available, since a playback/subtitle/audio
  // problem can't exist before then. Anyone can report on anything available (not scoped to
  // their own requests — the person who noticed the bad audio may not be who requested it).
  if (interaction.commandName === 'report') {
    const focusedTitle = interaction.options.getFocused(true);
    if (focusedTitle.name !== 'title') return interaction.respond([]).catch(() => {});
    const q = String(focusedTitle.value || '').toLowerCase().trim();
    const rows = db.prepare("SELECT * FROM requests WHERE status = 'available' ORDER BY id DESC LIMIT 500").all();
    const seen = new Set();
    const choices = [];
    for (const r of rows) {
      if (q && !String(r.title || '').toLowerCase().includes(q)) continue;
      if (seen.has(r.media_id)) continue;
      seen.add(r.media_id);
      choices.push({ name: r.title.slice(0, 100), value: String(r.media_id).slice(0, 100) });
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
  if (n === 'automation') return handleAutomationCommand(interaction);
  if (n === 'backup-rehearse') return handleBackupRehearseCommand(interaction);
  if (n === 'doctor') return handleDoctorCommand(interaction);
  if (n === 'seerr-test') return handleSeerrTestCommand(interaction);
  if (n === 'sync') return handleSyncCommand(interaction);
  if (n === 'sync-fix') return handleSyncFixCommand(interaction);
  if (n === 'cleanup') return handleCleanupCommand(interaction);
  if (n === 'invite') return handleInviteCommand(interaction);
  if (n === 'invite-post') return handleInvitePostCommand(interaction);
  if (n === 'reinvite') return handleReinviteCommand(interaction);
  if (n === 'requests') return handleRequestsCommand(interaction);
  if (n === 'pending') return handlePendingCommand(interaction);
  if (n === 'whorequested') return handleWhoRequestedCommand(interaction);
  if (n === 'audit') return handleAuditCommand(interaction);
  if (n === 'queue') return handleQueueCommand(interaction);
  if (n === 'request-status') return handleRequestStatusCommand(interaction);
  if (n === 'notifications') return handleNotificationsCommand(interaction);
  if (n === 'request-cancel') return handleRequestCancelCommand(interaction);
  if (n === 'report') return handleReportCommand(interaction);
  if (n === 'watching') return handleWatchingCommand(interaction);
  if (n === 'indexers') return handleIndexersCommand(interaction);
  if (n === 'debrid') return handleDebridCommand(interaction);
  if (n === 'avistaz') return handleAvistazCommand(interaction);
  if (n === 'rtorrent') return handleRtorrentCommand(interaction);
  if (n === 'season') return handleSeasonCommand(interaction);
  if (n === 'cleanup-suggestions') return handleCleanupSuggestionsCommand(interaction);
  if (n === 'stage') return handleStageCommand(interaction);
  if (n === 'staged') return handleStagedCommand(interaction);
  if (n === 'pin') return handlePinCommand(interaction, true);
  if (n === 'unpin') return handlePinCommand(interaction, false);
  if (n === 'stage-bulk') return handleStageBulkCommand(interaction);
  if (n === 'assign-server') return handleAssignServerCommand(interaction);
  if (n === 'me') return handleMeCommand(interaction);
  if (n === 'stats') return handleStatsCommand(interaction);
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
  if (!takePersistentRateLimit('download-command', interaction.user.id, CONFIG.DOWNLOAD_MAX_PER_HOUR, 3600000)) {
    return interaction.reply({ content: '❌ Rate limit reached. Try again later.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const title = interaction.options.getString('title');
  const season = interaction.options.getInteger('season');
  const episode = interaction.options.getInteger('episode');
  const oneTime = interaction.options.getBoolean('one_time') ?? CONFIG.DOWNLOAD_ONE_TIME_LINKS_DEFAULT;

  let filePath; let displayTitle;
  if (season != null || episode != null) {
    const series = (await searchSeries(title))[0];
    if (!series) return interaction.editReply('❌ Series not found.');
    const epFile = (await getEpisodeFiles(series.id)).find(f => f.seasonNumber === (season ?? 1) && f.episodeNumber === (episode ?? 1));
    if (!epFile) return interaction.editReply('❌ Episode not found.');
    filePath = epFile.path; displayTitle = `${series.title} S${pad(season ?? 1)}E${pad(episode ?? 1)}`;
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

// Keeps a Discord role in sync with actual Plex access — gated entirely on PLEX_MEMBER_ROLE_ID
// so it's a no-op for deployments that haven't set one up. discord_id values here are sometimes
// synthetic (plex_<id> rows for Plex friends never linked to Discord); isSnowflake filters those
// out before ever touching the Discord API.
async function grantMemberRole(discordId) {
  if (!CONFIG.PLEX_MEMBER_ROLE_ID || !isSnowflake(discordId)) return;
  try {
    const guild = client.guilds.cache.get(CONFIG.DISCORD_GUILD_ID);
    const member = await guild?.members.fetch(discordId).catch(() => null);
    if (member && !member.roles.cache.has(CONFIG.PLEX_MEMBER_ROLE_ID)) {
      await member.roles.add(CONFIG.PLEX_MEMBER_ROLE_ID);
    }
  } catch (err) {
    log.warn(`Couldn't grant member role to ${discordId}: ${err.message}`);
  }
}

async function revokeMemberRole(discordId) {
  if (!CONFIG.PLEX_MEMBER_ROLE_ID || !isSnowflake(discordId)) return;
  try {
    const guild = client.guilds.cache.get(CONFIG.DISCORD_GUILD_ID);
    const member = await guild?.members.fetch(discordId).catch(() => null);
    if (member && member.roles.cache.has(CONFIG.PLEX_MEMBER_ROLE_ID)) {
      await member.roles.remove(CONFIG.PLEX_MEMBER_ROLE_ID);
    }
  } catch (err) {
    log.warn(`Couldn't revoke member role from ${discordId}: ${err.message}`);
  }
}

// Full reconciliation pass: grants the role to everyone with real access and revokes it from
// anyone who has it but shouldn't, so drift (a role added/removed by hand, a missed edge case)
// self-heals instead of accumulating. Fetches the whole member list once, which is fine at the
// private-server scale this bot targets.
async function reconcilePlexMemberRoles() {
  if (!CONFIG.PLEX_MEMBER_ROLE_ID) return { granted: 0, revoked: 0 };
  const guild = client.guilds.cache.get(CONFIG.DISCORD_GUILD_ID);
  const members = await guild?.members.fetch().catch(() => null);
  if (!members) return { granted: 0, revoked: 0 };

  // "Should have the role" is derived from Plex's own current friends list, not the local
  // invited/overseerr_created flags — those only record that an invite was *sent* at some point,
  // not whether it was ever accepted, and they don't move if access is later revoked outside the
  // bot's own flows (directly in Plex, say). This is the same friends fetch /sync uses.
  //
  // A failed fetch must abort the whole reconciliation rather than fall back to an empty list —
  // an empty friends list looks identical to "everyone lost access," which would revoke the role
  // from every current holder on a transient Plex API outage.
  let friends;
  try {
    const token = await getPlexToken();
    friends = await fetchPlexFriends(token);
  } catch (err) {
    log.warn(`Role reconcile aborted — couldn't fetch the Plex friends list: ${err.message}`);
    return { granted: 0, revoked: 0 };
  }
  const shouldHave = new Set();
  for (const friend of friends) {
    const match = friend.email ? getUserByCanonicalEmail(friend.email) : null;
    if (match && isSnowflake(match.discord_id)) shouldHave.add(match.discord_id);
  }

  let granted = 0; let revoked = 0;
  for (const member of members.values()) {
    const has = member.roles.cache.has(CONFIG.PLEX_MEMBER_ROLE_ID);
    const should = shouldHave.has(member.id);
    try {
      if (should && !has) { await member.roles.add(CONFIG.PLEX_MEMBER_ROLE_ID); granted++; }
      else if (!should && has) { await member.roles.remove(CONFIG.PLEX_MEMBER_ROLE_ID); revoked++; }
    } catch (err) {
      log.warn(`Role reconcile failed for ${member.id}: ${err.message}`);
    }
  }
  return { granted, revoked };
}

// The full Plex → Discord → Seerr chain for linking one person, shared by /link and the
// /sync-fix links buttons. Absorbs a matching plex_ synthetic row, sends a Plex invite only if
// they don't already have access, and reconciles Seerr: link the existing user (wiring the Discord
// notification ID that Plex-imported users never got) or create a fresh one.
async function applyFullChainLink(discordId, email, username) {
  const { absorbed } = linkUserToEmail(discordId, email);
  const row = getUserByDiscordId(discordId);

  let plexStatus; let plexOk = false;
  if (row.invited) {
    plexOk = true;
    plexStatus = absorbed ? '✅ already had access (merged Plex row)' : '✅ already invited';
  } else {
    try {
      const result = await inviteUserToPlex(email, { homeServer: homeServerFor(discordId) });
      plexOk = result.successCount > 0;
      if (plexOk) markUserInvited(discordId);
      plexStatus = result.successCount > 0 ? `✅ invite sent (${result.successCount}/${result.total})` : '⚠️ invite failed on all servers';
    } catch (err) {
      audit('external_api_error', { provider: 'plex', error: err.message, targetDiscordId: discordId });
      plexStatus = '❌ invite failed';
    }
  }

  let seerrStatus; let seerrOk = false;
  try {
    const key = canonicalizeEmail(email);
    const existing = (await fetchOverseerrUsers()).find(ou => canonicalizeEmail(ou.email) === key);
    if (existing) {
      markOverseerrCreated(discordId, existing.id ?? null);
      const notified = existing.id != null ? await setOverseerrDiscordNotification(existing.id, discordId) : false;
      seerrStatus = `✅ linked existing user${notified ? ' + Discord notifications' : ''}`;
      seerrOk = true;
    } else {
      const id = await createOverseerrUser(email, discordId, username || email.split('@')[0]);
      markOverseerrCreated(discordId, id);
      seerrStatus = '✅ user created + Discord notifications';
      seerrOk = true;
    }
  } catch (err) {
    audit('external_api_error', { provider: 'overseerr', error: err.message, targetDiscordId: discordId });
    seerrStatus = '❌ failed — run /sync apply to retry';
  }

  if (plexStatus.startsWith('✅')) grantMemberRole(discordId).catch(() => {});
  return { absorbed, plexStatus, seerrStatus, plexOk, seerrOk };
}

async function handleLinkCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const target = interaction.options.getUser('user');
  const email = interaction.options.getString('email').toLowerCase().trim();
  if (!isValidEmail(email) || canonicalizeEmail(email).startsWith('__placeholder__:')) {
    return interaction.reply({ content: `❌ \`${email}\` isn't a valid email address.`, ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  const { absorbed, plexStatus, seerrStatus, plexOk, seerrOk } = await applyFullChainLink(target.id, email, target.username);
  audit('user_linked', { actorDiscordId: interaction.user.id, targetDiscordId: target.id, email, source: 'slash_link', absorbedPlexRow: absorbed?.discord_id || null });
  const embed = brandedEmbed(plexOk && seerrOk ? COLORS.SUCCESS : COLORS.WARN)
    .setTitle(plexOk && seerrOk ? '🔗 User Linked' : '⚠️ User Link Needs Attention')
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
  revokeMemberRole(target.id).catch(() => {});
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
    if (pendingDupe.requested_by_discord_id === interaction.user.id) {
      return interaction.editReply(`⏳ **${label}**${is4k ? ' (4K)' : ''} was already requested by you and is waiting for admin approval — no need to request it again.`);
    }
    const added = addRequestSubscriber(subscriberKeyFor(tmdbId, is4k), interaction.user.id);
    audit('request_subscribed', { actorDiscordId: interaction.user.id, title: label, mediaType, tmdbId, is4k, stage: 'gate' });
    return interaction.editReply(added
      ? `⏳ **${label}**${is4k ? ' (4K)' : ''} was already requested by someone else and is waiting for admin approval — already on the way. I'll DM you too when it lands.`
      : `⏳ **${label}**${is4k ? ' (4K)' : ''} is already waiting for admin approval — you're already tracked for it.`);
  }
  const existing = await checkExistingSeerrMedia(mediaType, tmdbId, is4k);
  if (existing) {
    audit('media_request_duplicate', { actorDiscordId: interaction.user.id, title: label, mediaType, tmdbId, is4k, reason: existing });
    if (existing.includes('available on Plex')) {
      return interaction.editReply(`ℹ️ **${label}**${is4k ? ' (4K)' : ''} is ${existing} — no need to request it again. 🍿`);
    }
    // Already in Seerr's pipeline (requested/downloading) under someone else — subscribe instead
    // of dead-ending; the MEDIA_AVAILABLE webhook fans the DM out to every subscriber.
    const added = addRequestSubscriber(subscriberKeyFor(tmdbId, is4k), interaction.user.id);
    audit('request_subscribed', { actorDiscordId: interaction.user.id, title: label, mediaType, tmdbId, is4k, stage: 'seerr' });
    return interaction.editReply(added
      ? `ℹ️ **${label}**${is4k ? ' (4K)' : ''} is ${existing} — already on the way. I'll DM you when it lands.`
      : `ℹ️ **${label}**${is4k ? ' (4K)' : ''} is ${existing} — you're already tracked for it.`);
  }

  let seerrUserId = null;
  try { seerrUserId = await resolveSeerrUserId(row); } catch (_e) {}
  if (seerrUserId == null) {
    return interaction.editReply('❌ No Seerr account is linked to you yet — ask an admin to run `/link` for you.');
  }

  const admin = isAdminInteraction(interaction);
  // #80: a member with enough approved requests behind them skips the gate too — the gate's
  // cost is admin attention, and that cost is worth paying for a new member, not someone who's
  // made N reasonable requests already. 4K stays gated unconditionally regardless of trust (the
  // AvistaZ pipeline has its own separate GRAB_MODE=approve gate later, so it doesn't need
  // special-casing here).
  const trustScore = admin ? 0 : getTrustScore(interaction.user.id);
  const autoApprove = !admin && CONFIG.AUTO_APPROVE_AFTER_N_APPROVED > 0 && !is4k && trustScore >= CONFIG.AUTO_APPROVE_AFTER_N_APPROVED;

  // Non-admins (and not auto-approved) go through the bot-side approval gate: Seerr sees nothing
  // until an admin clicks Approve (Seerr insta-approves anything the bot's admin API key
  // creates, so approval has to happen here).
  if (!admin && !autoApprove) {
    // Because every request is submitted with the admin API key, Seerr's own quota enforcement
    // never sees the real requester — check it here instead so the fairness rule stays visible
    // and self-enforcing rather than resting entirely on admin memory.
    const quotaBlock = await quotaBlockReason(seerrUserId, interaction.user.id, mediaType);
    if (quotaBlock) return interaction.editReply(quotaBlock);
    const payload = { discordId: interaction.user.id, email: row.email, seerrUserId, mediaType, tmdbId, is4k, label };
    const nonce = stashPendingRequest(payload);
    const posted = await postPendingRequestNotice(nonce, payload)
      .catch(err => { log.warn(`Approval notice failed: ${err.message}`); return false; });
    if (!posted) {
      takePendingRequest(nonce);
      return interaction.editReply('❌ Couldn\'t post the approval request to the admins — try again in a bit.');
    }
    if (posted === 'handled') return interaction.editReply('This request was already handled by an admin.');
    upsertRequest(null, `tmdb:${tmdbId}`, mediaType, is4k, label, interaction.user.id, 'pending');
    audit('media_request_gated', { actorDiscordId: interaction.user.id, title: label, mediaType, tmdbId, is4k, nonce });
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO)
      .setTitle(`${mediaTypeEmoji(mediaType, is4k)} Request Submitted`)
      .setDescription(`**${label}**${is4k ? ' (4K)' : ''}${mediaType === 'tv' ? ' — all seasons' : ''}\nWaiting for admin approval — you'll get a DM either way.`)] });
  }

  // Quota still applies to an auto-approved request — trust skips the *admin*, not the fairness
  // rule. (Admins bypass both; this block only reaches here for admin or auto-approve.)
  if (autoApprove) {
    const quotaBlock = await quotaBlockReason(seerrUserId, interaction.user.id, mediaType);
    if (quotaBlock) return interaction.editReply(quotaBlock);
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
    // Self-requests (admin or auto-approved) skip the gate, so there's no "+ AvistaZ Fallback"
    // button to click — pre-authorize the fallback automatically instead, which also puts the
    // arr tag on right away like a gate pre-auth does.
    const azPreAuth = canEscalate({ mediaType, is4k });
    if (azPreAuth) {
      recordEscalationWatch({ mediaType, tmdbId, tvdbId: data?.media?.tvdbId ?? null, title: label, discordId: interaction.user.id, preAuthorized: true });
      tagPreAuthorizedMedia({ mediaType, tmdbId, tvdbId: data?.media?.tvdbId ?? null, title: label })
        .catch(err => log.warn(`Approval-time AvistaZ tagging failed for ${label}: ${err.message}`));
    }
    if (autoApprove) {
      const newScore = bumpTrustScore(interaction.user.id, 1);
      audit('media_request_auto_approved', { actorDiscordId: interaction.user.id, title: label, mediaType, tmdbId, is4k, seerrUserId, requestId: data?.id ?? null, trustScore: newScore });
      // Visible, not blocking: admins see it happened and can one-click undo, but nothing waits
      // on them.
      const undoRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`trust_undo:${data?.id ?? ''}:${interaction.user.id}`).setLabel('Undo').setStyle(ButtonStyle.Danger),
      );
      notifyChannel('requests', {
        embeds: [brandedEmbed(COLORS.INFO)
          .setTitle(`${mediaTypeEmoji(mediaType, is4k)} Auto-Approved`)
          .setDescription(`**${label}** — <@${interaction.user.id}> has ${newScore} approved requests and skipped the gate.`)],
        components: data?.id != null ? [undoRow] : [],
      });
    } else {
      audit('media_requested', { actorDiscordId: interaction.user.id, title: label, mediaType, tmdbId, is4k, seerrUserId, requestId: data?.id ?? null, azPreAuth });
    }
    await interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS)
      .setTitle(`${mediaTypeEmoji(mediaType, is4k)} Request Sent`)
      .setDescription(`**${label}**${is4k ? ' (4K)' : ''}${mediaType === 'tv' ? ' — all seasons' : ''}\nRequested as \`${row.email}\` — ${autoApprove ? 'auto-approved (you\'re a trusted requester) and grabbing it now! 🚀' : 'approved and grabbing it now! 🚀'}\nYou'll get a DM when it's on Plex.${azPreAuth ? `\n🔐 AvistaZ fallback pre-authorized — tagging it \`${CONFIG.AVISTAZ_TAG}\` now. If nothing public is grabbed within ${escalationDelayLabel()} it ${preAuthOutcomeLabel(mediaType)}.` : ''}`)] });
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

async function handleAutomationCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const name = interaction.options.getString('sweep');
  const mode = interaction.options.getString('mode');
  await interaction.deferReply({ ephemeral: true });
  if (mode === 'preview') {
    const items = await previewAutomation(name);
    const lines = items.length
      ? items.map(item => `- ${item.title}: ${item.stage} — ${item.reason}`)
      : ['No items would be actioned.'];
    return interaction.editReply([`**${name} preview**`, ...lines].join('\n').slice(0, 2000));
  }
  const sweeps = {
    stuck: sweepStuckDownloads,
    escalation: sweepEscalations,
    'season-pack': () => sweepSeasonPacks({ rearmAlerts: true }),
    'episode-recovery': runEpisodeRecoverySweep,
  };
  const outcome = await runGuardedSweep(name, sweeps[name]);
  if (!outcome.ok || outcome.result?.busy) return interaction.editReply(`${name} is already running.`);
  const result = outcome.result || {};
  const count = result.searched ?? result.acted ?? result.alerted ?? 0;
  return interaction.editReply(`${name} sweep finished with ${count} action(s).`);
}

async function handleBackupRehearseCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  await interaction.deferReply({ ephemeral: true });
  try {
    const result = rehearseLatestBackup(DB_PATH, CONFIG.BACKUP_DIR);
    audit('db_backup_rehearsed', result);
    const comparison = result.rowCountsMatch
      ? `The live database and restored backup both contain ${result.liveUsers} user row(s).`
      : `The live database contains ${result.liveUsers} user row(s); the restored backup contains ${result.backupUsers}.`;
    await interaction.editReply({ embeds: [brandedEmbed(result.rowCountsMatch ? COLORS.SUCCESS : COLORS.WARN)
      .setTitle('Backup Rehearsal Completed')
      .setDescription(`Verified ${path.basename(result.backup)} in a temporary database. ${comparison}\n\nThe live database was opened read-only and was not modified.`)] });
  } catch (err) {
    audit('db_backup_rehearsal_failed', { error: err.message });
    await interaction.editReply({ embeds: [brandedEmbed(COLORS.DANGER)
      .setTitle('Backup Rehearsal Failed')
      .setDescription(`\`\`\`${err.message}\`\`\``)] });
  }
}

async function handleStatusCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  await interaction.deferReply({ ephemeral: true });
  const health = await gatherHealth();
  const pendingRequests = db.prepare("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'").get().c;
  const activeLinks = db.prepare('SELECT COUNT(*) AS c FROM download_tokens WHERE revoked = 0 AND expires_at > ?').get(Date.now()).c;
  const warnings = configWarnings();

  const automationConfig = [
    ['pending-approvals', tunable('PENDING_APPROVAL_CHECK_MINUTES')],
    ['request-reconcile', CONFIG.REQUEST_RECONCILE_MINUTES],
    ['stuck', tunable('STUCK_CHECK_MINUTES')],
    ['escalation', tunable('ESCALATION_ENABLED') ? tunable('ESCALATION_CHECK_MINUTES') : 0],
    ['season-pack', tunable('SEASON_PACK_FIRST') ? tunable('SEASON_PACK_CHECK_MINUTES') : 0],
    ['grab', grabConfigured() ? CONFIG.GRAB_CHECK_MINUTES : 0],
    ['adoption', CONFIG.RTORRENT_ADOPT_ENABLED ? CONFIG.RTORRENT_ADOPT_CHECK_MINUTES : 0],
    ['janitor', CONFIG.JANITOR_CHECK_MINUTES],
    ['backup', CONFIG.BACKUP_INTERVAL_HOURS > 0 ? CONFIG.BACKUP_INTERVAL_HOURS * 60 : 0],
    ['monthly-recap', CONFIG.MONTHLY_RECAP_ENABLED ? 60 : 0],
    ['transcode', tautulliConfigured() ? CONFIG.PLAYBACK_CHECK_MINUTES : 0],
    ['premiumize', premiumizeConfigured() ? CONFIG.PREMIUMIZE_CHECK_MINUTES : 0],
    ['stage-queue', stagingConfigured() ? CONFIG.STAGE_CHECK_MINUTES : 0],
    ['stage-reconcile', stagingConfigured() ? CONFIG.STAGE_RECONCILE_MINUTES : 0],
    ['tunnel', CONFIG.PH_TUNNEL_HEALTH_URL ? CONFIG.PH_TUNNEL_CHECK_MINUTES : 0],
  ];
  let automationDegraded = false;
  const automationLines = automationConfig.map(([name, minutes]) => {
    if (minutes <= 0) return `⏭️ ${name}: disabled`;
    let run = automationRuns.get(name);
    if (!run) {
      const stored = getSetting(`automation_run:${name}`);
      if (stored) {
        try { run = JSON.parse(stored); } catch (err) { run = { status: 'failed', finishedAt: null, error: `invalid stored run state: ${err.message}` }; }
      }
    }
    if (!run) return `❔ ${name}: every ${minutes}m · not run since boot`;
    if (run.status === 'running') {
      const runningOverdue = run.startedAt && Date.now() - run.startedAt > Math.max(minutes * 2, minutes + 5) * 60000;
      if (runningOverdue) automationDegraded = true;
      return `${runningOverdue ? '⚠️' : '⏳'} ${name}: ${runningOverdue ? 'running unusually long' : 'running'} since ${discordTimestamp(run.startedAt)}`;
    }
    const detail = run.status === 'failed' ? ` · ${String(run.error).slice(0, 100)}` : '';
    const overdue = run.finishedAt && Date.now() - run.finishedAt > Math.max(minutes * 2, minutes + 5) * 60000;
    if (run.status === 'failed' || overdue) automationDegraded = true;
    return `${run.status === 'ok' && !overdue ? '✅' : run.status === 'failed' ? '❌' : '⚠️'} ${name}: ${overdue ? 'overdue · last ' : `${run.status} `}${run.finishedAt ? discordTimestamp(run.finishedAt, 'R') : 'unknown'}${detail}`;
  });

  const deploymentChecks = [];
  try {
    fs.accessSync(path.dirname(DB_PATH), fs.constants.W_OK);
    deploymentChecks.push(`✅ Data directory writable: \`${path.dirname(DB_PATH)}\``);
  } catch (err) {
    deploymentChecks.push(`❌ Data directory is not writable: \`${path.dirname(DB_PATH)}\` (${err.code || err.message})`);
  }
  deploymentChecks.push(fs.existsSync(CONFIG.RAID_PATH)
    ? `✅ Media mount exists: \`${CONFIG.RAID_PATH}\``
    : `❌ Media mount missing: \`${CONFIG.RAID_PATH}\` — check the Compose volume and \`MEDIA_HOST_PATH\`.`);
  if (CONFIG.BACKUP_INTERVAL_HOURS > 0) {
    deploymentChecks.push(fs.existsSync(CONFIG.BACKUP_DIR)
      ? `✅ Backup directory exists: \`${CONFIG.BACKUP_DIR}\``
      : `⚠️ Backup directory has not been created yet: \`${CONFIG.BACKUP_DIR}\``);
  }

  const integrationLines = HEALTH_KEYS.filter(k => health[k] !== undefined).map(k => {
    const age = k === 'backup' && health.backupLastSuccessfulAt ? ` · last success ${discordTimestamp(health.backupLastSuccessfulAt)}` : '';
    const status = k === 'backup' && health[k] === 'disabled' ? 'skipped' : health[k];
    const error = health.errors?.[k] ? ` · ${String(health.errors[k]).slice(0, 120)}` : '';
    return `${statusEmoji(status)} ${healthLabel(k)}: ${health[k]}${age}${error}`;
  });

  // Categorize DB rows: real Discord-linked, plex_-only synthetic, and @plex.local placeholders
  // (collapsed to a count once acknowledged). Also tally fixable issues so admins know to run /sync-fix.
  const allUsers = db.prepare('SELECT discord_id, email, invited FROM users').all().filter(u => u.discord_id !== CONFIG.DISCORD_CLIENT_ID);
  const canonCounts = new Map();
  const dbCanon = new Set();
  let discordLinked = 0; let discordInvited = 0; let plexOnly = 0; let placeholderCount = 0; let placeholderAcked = 0;
  for (const u of allUsers) {
    const key = canonicalizeEmail(u.email);
    if (key.startsWith('__placeholder__:')) {
      placeholderCount++;
      if (getSetting(`placeholder_ack:${u.discord_id}`)) placeholderAcked++;
      continue;
    }
    dbCanon.add(key);
    canonCounts.set(key, (canonCounts.get(key) || 0) + 1);
    if (u.discord_id.startsWith('plex_')) plexOnly++;
    else {
      discordLinked++;
      if (u.invited) discordInvited++;
    }
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
    `**Discord-linked:** ${discordLinked} (${discordInvited} invited)`,
    `**Plex-only:** ${plexOnly}`,
    `**Placeholder:** ${placeholderCount}${placeholderCount ? ` (${placeholderAcked} acknowledged)` : ''}`,
  ].join('\n');

  const diskReport = await fetchDiskSpaceReport().catch(error => ({ disks: [], errors: { unknown: error.message }, sourceCount: arrSources().length, reportedCount: 0 }));
  const disks = forecastDisks(db, diskReport.disks, Date.now());
  const storageLines = disks.map(d => {
    const lowFlag = tunable('DISK_SPACE_WARN_GB') > 0 && gb(d.freeSpace || 0) < tunable('DISK_SPACE_WARN_GB') ? ' ⚠️' : '';
    const pctUsed = d.totalSpace ? Math.round(((d.totalSpace - d.freeSpace) / d.totalSpace) * 100) : 0;
    return `\`${d.root}\` — ${fmtSpace(d.freeSpace)} free of ${fmtSpace(d.totalSpace)} (${pctUsed}% used)${lowFlag} · ${forecastLabel(d.forecast)}`;
  });

  let emptyStorage = 'No *arr instances configured';
  const diskErrors = Object.entries(diskReport.errors || {});
  if (diskErrors.length) {
    const diskFailureLine = `⚠️ Disk-space query failed: ${diskErrors.map(([name, error]) => `${name}: ${error}`).join(' · ')}`.slice(0, 1024);
    emptyStorage = diskFailureLine;
    if (storageLines.length) storageLines.push(diskFailureLine);
  } else if (diskReport.reportedCount > 0 && !diskReport.disks.length) {
    emptyStorage = `No reported disks matched \`DISK_SPACE_PATHS\` (the *arrs returned ${diskReport.reportedCount})`;
  } else if (diskReport.sourceCount > 0) {
    emptyStorage = 'The configured *arr instances reported no eligible disks';
  }

  // Configuration warnings remain prominent below, but informational/risk warnings do not make
  // a reachable system unhealthy. Actual integration, deployment, and automation failures do.
  const overall = statusOverall({ health, automationDegraded, diskErrors, deploymentChecks });
  const embed = brandedEmbed(overall === 'ok' ? COLORS.SUCCESS : COLORS.WARN)
    .setTitle('📊 Durant Media Server Status')
    .setDescription(`Overall: **${overall.toUpperCase()}**`)
    .addFields(
      { name: 'Integrations', value: integrationLines.join('\n').slice(0, 1024) || 'none', inline: false },
      { name: 'Users', value: usersSummary, inline: true },
      { name: 'Pending requests', value: `${pendingRequests}`, inline: true },
      { name: 'Active download links', value: `${activeLinks}`, inline: true },
      { name: 'Storage', value: (storageLines.join('\n') || emptyStorage).slice(0, 1024), inline: false },
      { name: 'DB ↔ Overseerr', value: reconcileLine, inline: false },
      { name: 'Fixable sync issues', value: fixableLine, inline: false },
      { name: 'Configuration and Compose', value: [...deploymentChecks, ...warnings.map(w => `⚠️ ${w}`)].join('\n').slice(0, 1024) || '✅ No configuration warnings', inline: false },
      { name: 'Automations', value: automationLines.join('\n').slice(0, 1024), inline: false },
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
  audit('status_checked', { actorDiscordId: interaction.user.id, overall, configWarnings: warnings.length });
  await interaction.editReply({ embeds: [embed] });
}

async function handleDoctorCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  await interaction.deferReply({ ephemeral: true });
  const checks = await runEdgeDiagnostics({ live: true });
  const active = listActiveStageJobs();
  const copying = active.filter(j => j.status === 'copying');
  checks.push({
    name: 'Transfer queue',
    status: copying.length > 1 ? 'fail' : 'ok',
    detail: `${copying.length} copying, ${active.filter(j => j.status === 'queued').length} queued`,
  });
  const nodes = listTierNodes();
  const now = Date.now();
  for (const node of nodes) {
    const tierState = getTierPlan(node.name);
    const heartbeatAge = tierState?.lastHeartbeatAt ? now - Number(tierState.lastHeartbeatAt) : null;
    checks.push({
      name: `Tier agent: ${node.name}`,
      status: heartbeatAge != null && heartbeatAge < 15 * 60000 && !(tierState?.lastErrors || []).length ? 'ok' : 'warn',
      detail: heartbeatAge == null ? 'no heartbeat reported' : `last heartbeat ${fmtDuration(heartbeatAge)} ago${tierState?.lastErrors?.length ? ` · ${tierState.lastErrors[0]}` : ''}`,
    });
    const telemetry = tierState?.lastTelemetry;
    const hardware = assessNodeTelemetry(telemetry, { warnC: CONFIG.NODE_TEMP_WARN_C, criticalC: CONFIG.NODE_TEMP_CRITICAL_C });
    checks.push({
      name: `Hardware: ${node.name}`,
      status: hardware.level === 'critical' ? 'fail' : hardware.level === 'warn' || hardware.level === 'unknown' ? 'warn' : 'ok',
      detail: telemetrySummary(telemetry, fmtSpace),
    });
  }
  const icon = s => s === 'ok' ? '✅' : s === 'warn' ? '⚠️' : '❌';
  const failures = checks.filter(c => c.status === 'fail').length;
  const warnings = checks.filter(c => c.status === 'warn').length;
  audit('edge_diagnostics_run', { actorDiscordId: interaction.user.id, failures, warnings });
  const embed = brandedEmbed(failures ? COLORS.DANGER : warnings ? COLORS.WARN : COLORS.SUCCESS)
    .setTitle('🩺 Main → Edge Transfer Doctor')
    .setDescription(checks.map(c => `${icon(c.status)} **${c.name}** — ${String(c.detail).slice(0, 350)}`).join('\n').slice(0, 4000))
    .setFooter({ text: 'Durant Media Server · Read-only: no files were copied, changed, or deleted.' });
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
  const plexFriends = await fetchPlexFriends(token).catch(() => []);
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
  const friends = await fetchPlexFriends(token).catch(() => []);
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
  const roles = await reconcilePlexMemberRoles().catch(err => { log.warn(`Role reconcile failed: ${err.message}`); return { granted: 0, revoked: 0 }; });
  audit('sync_changes_applied', { actorDiscordId: interaction.user.id, added, updated, repaired, beforeCount, afterCount, rolesGranted: roles.granted, rolesRevoked: roles.revoked });
  const roleLine = CONFIG.PLEX_MEMBER_ROLE_ID ? `\nMember role granted: ${roles.granted}\nMember role revoked: ${roles.revoked}` : '';
  await interaction.editReply(`${formatSyncPreview(preview, 'Apply completed.')}\n\nAdded to DB: ${added}\nOverseerr users created: ${updated}\nLinks repaired: ${repaired}${roleLine}`);
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
  const serverOpt = interaction.options.getString('server');
  if (target.bot) return interaction.editReply('❌ Can\'t invite a bot.');
  const existing = getUserByDiscordId(target.id);
  const existingNote = existing ? `\nNote: they were already linked to \`${existing.email}\` — this updates it.` : '';

  if (emailOpt) {
    const email = emailOpt.toLowerCase().trim();
    if (!isValidEmail(email) || canonicalizeEmail(email).startsWith('__placeholder__:')) {
      return interaction.editReply(`❌ \`${email}\` isn't a valid email address.`);
    }
    if (serverOpt === 'ph') setUserHomeServer(target.id, 'ph');
    const { absorbed, plexStatus, seerrStatus, plexOk, seerrOk } = await applyFullChainLink(target.id, email, target.username);
    audit('user_linked', { actorDiscordId: interaction.user.id, targetDiscordId: target.id, email, source: 'slash_invite', absorbedPlexRow: absorbed?.discord_id || null });
    const hadAccess = plexStatus.includes('already');
    await dmUser(target.id, { embeds: [brandedEmbed(plexOk ? COLORS.SUCCESS : COLORS.WARN)
      .setTitle(plexOk ? '🎉 You\'re In!' : '⚠️ Your Setup Needs Attention')
      .setDescription(plexOk
        ? (hadAccess ? `An admin set you up on the media server — \`${email}\` already has Plex access. Use \`/help\` here to see everything I can do. 🍿` : `An admin set you up on the media server. 📬 A Plex invite was sent to \`${email}\` — accept it and you're set. Use \`/help\` here to see everything I can do. 🍿`)
        : `The Plex invite to \`${email}\` failed. An admin has the failure details and can retry your setup.`)] });
    return interaction.editReply({ embeds: [brandedEmbed(plexOk && seerrOk ? COLORS.SUCCESS : COLORS.WARN)
      .setTitle(plexOk && seerrOk ? '🔗 User Invited' : '⚠️ User Invite Needs Attention')
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
      .setDescription(`An admin has invited you! To get set up, just **reply to this message with the email on your Plex account** — I'll handle the rest automatically. 🍿`
        + (phServerConfigured() ? '\n\nOn the **Philippines server**? Tap the button below before you reply.' : ''))],
      components: phServerConfigured() ? [homeServerPickerRow()] : [] });
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
  if (action === 'adopt_series_pick') return handleAdoptSeriesPick(interaction, nonce);
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

// The series picked from adoption's "Which Series?" select menu: adopt with the identity
// pinned explicitly, bypassing the resolver entirely (a human decision beats any heuristic).
async function handleAdoptSeriesPick(interaction, nonce) {
  if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
  const offer = takeGrabOffer(nonce);
  if (!offer) return interaction.update({ content: 'ℹ️ Already handled (or expired).', embeds: [], components: [] });
  const seriesId = Number(interaction.values?.[0]);
  const picked = (offer.candidates || []).find(c => c.id === seriesId);
  if (!picked) return interaction.update({ content: 'ℹ️ That option no longer exists.', embeds: [], components: [] });
  await interaction.deferUpdate();
  const result = await executeAdoption(offer.torrent, offer.target, {
    discordId: offer.discordId || interaction.user.id, origin: offer.origin || 'adopt', actorDiscordId: interaction.user.id,
    seriesOverride: { id: picked.id, tvdbId: picked.tvdbId },
  });
  if (!result.ok) {
    return interaction.editReply({ embeds: [brandedEmbed(result.dup ? COLORS.INFO : COLORS.DANGER)
      .setTitle(`${result.dup ? 'ℹ️ Already Tracked' : '❌ Adoption Failed'} — ${String(offer.torrent.name).slice(0, 180)}`.slice(0, 256))
      .setDescription(result.why)], components: [] });
  }
  return interaction.editReply({ embeds: [brandedEmbed(COLORS.SUCCESS)
    .setTitle(`🧲 Adopted as ${picked.title} — ${String(offer.torrent.name).slice(0, 150)}`.slice(0, 256))
    .setDescription(`Job #${result.job.id} pinned to Sonarr series **${picked.title}** by <@${interaction.user.id}>, created as **${result.state}**. ${result.state === 'complete' ? 'Transferring home now.' : 'Watched to 100% before transferring.'}`)], components: [] });
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
  if (!interaction.customId.startsWith('request_access_modal')) return;
  const homeServer = interaction.customId.split(':')[1] === 'ph' ? 'ph' : 'primary';
  await interaction.deferReply({ ephemeral: true });
  const email = String(interaction.fields.getTextInputValue('plex_email') || '').toLowerCase().trim();
  if (!isValidEmail(email)) {
    return interaction.editReply({ content: '❌ That doesn\'t look like a valid email address — click the button and try again.' });
  }
  clearPendingEmail(interaction.user.id); // a DM ask may be outstanding; the modal supersedes it
  const conflict = findConflictingRealUser(interaction.user.id, email);
  if (conflict) {
    audit('email_collision', { actorDiscordId: interaction.user.id, targetDiscordId: conflict.discord_id, email, source: 'request_access_button' });
    await interaction.editReply({ content: '⚠️ That email is already linked to another Discord account here. If that wasn\'t you, double-check the address — otherwise flag an admin to help sort it out.' });
    notifyChannel('admin', `⚠️ <@${interaction.user.id}> requested access with \`${email}\`, which is already linked to <@${conflict.discord_id}>. Needs manual review before either account is approved.`);
    return;
  }
  linkUserToEmail(interaction.user.id, email);
  if (homeServer === 'ph') setUserHomeServer(interaction.user.id, 'ph');
  audit('user_linked', { targetDiscordId: interaction.user.id, email, homeServer, source: 'request_access_button' });
  const posted = await postAccessRequestToAdmins(interaction.user, email, homeServer).catch(() => false);
  await interaction.editReply({ content: posted
    ? `✅ Thanks! Your request for \`${email}\`${homeServer === 'ph' ? ' (Philippines server)' : ''} was sent to the admins. You'll get a DM as soon as you're approved.`
    : '❌ I saved your email, but I could not notify the admins. Ask an admin to check `ADMIN_CHANNEL_ID`; clicking Request Plex Access again will retry the notice.' });
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
  if (discordId && result.successCount > 0) markUserInvited(discordId);
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

async function handlePendingCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const pending = listPendingRequests();
  if (!pending.length) return interaction.reply({ content: '✅ No requests are waiting for approval.', ephemeral: true });
  const shown = pending.slice(0, 5);
  const components = shown.map(item => {
    const buttons = [new ButtonBuilder().setCustomId(`request_approve:${item.nonce}`).setLabel('Approve').setStyle(ButtonStyle.Success)];
    if (canEscalate(item)) buttons.push(new ButtonBuilder().setCustomId(`request_approve_az:${item.nonce}`).setLabel('Approve + AvistaZ').setStyle(ButtonStyle.Primary));
    buttons.push(new ButtonBuilder().setCustomId(`request_deny:${item.nonce}`).setLabel('Deny').setStyle(ButtonStyle.Danger));
    return new ActionRowBuilder().addComponents(...buttons);
  });
  const lines = shown.map((item, index) => `${index + 1}. **${item.label}** — <@${item.discordId}> · ${discordTimestamp(item.createdAt, 'R')}`);
  if (pending.length > shown.length) lines.push(`…and ${pending.length - shown.length} more; resolve these and run \`/pending\` again.`);
  return interaction.reply({ embeds: [brandedEmbed(COLORS.INFO).setTitle(`⏳ Pending Approvals (${pending.length})`).setDescription(lines.join('\n'))], components, ephemeral: true });
}

async function handleWhoRequestedCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  await interaction.deferReply({ ephemeral: true });
  const raw = String(interaction.options.getString('title') || '').trim();
  const selected = /^request:\d+$/.test(raw)
    ? db.prepare('SELECT * FROM requests WHERE id = ?').get(Number(raw.slice('request:'.length)))
    : db.prepare('SELECT * FROM requests WHERE title LIKE ? ORDER BY id DESC LIMIT 1').get(`%${raw}%`);
  if (!selected) return interaction.editReply(`No tracked request matches **${raw}**. Pick a suggestion from the list.`);

  const rows = db.prepare(`SELECT * FROM requests
    WHERE media_type = ? AND is_4k = ? AND (media_id = ? OR (title = ? AND requested_by_discord_id IS ?))
    ORDER BY id DESC`).all(selected.media_type, selected.is_4k ? 1 : 0, selected.media_id, selected.title, selected.requested_by_discord_id);
  const current = rows.find(row => row.status === 'available')
    || rows.find(row => row.status === 'failed')
    || rows.find(row => row.status === 'approved')
    || rows[0];
  const requestId = rows.find(row => row.overseerr_request_id)?.overseerr_request_id;
  const requesterRows = new Map();
  for (const row of rows) {
    if (!row.requested_by_discord_id) continue;
    const known = requesterRows.get(row.requested_by_discord_id);
    if (!known || sqliteUtcMs(row.created_at) < sqliteUtcMs(known.created_at)) requesterRows.set(row.requested_by_discord_id, row);
  }
  const requesterLines = [...requesterRows.values()].map(row => {
    const who = isSnowflake(row.requested_by_discord_id) ? `<@${row.requested_by_discord_id}>` : `\`${row.requested_by_discord_id}\``;
    const requestedAt = sqliteUtcMs(row.created_at);
    return `${who}${requestedAt ? ` — ${discordTimestamp(requestedAt, 'f')} (${discordTimestamp(requestedAt)})` : ''}`;
  });

  const tmdbRow = rows.find(row => String(row.media_id).startsWith('tmdb:'));
  const tmdbId = tmdbRow ? Number(tmdbRow.media_id.slice('tmdb:'.length)) : resolveTmdbId(current);
  const subscriberIds = tmdbId != null ? listRequestSubscribers(subscriberKeyFor(tmdbId, !!current.is_4k)) : [];
  const requesterIds = new Set(requesterRows.keys());
  const subscribers = subscriberIds.filter(id => !requesterIds.has(id));

  let pipeline = 'Queued';
  if (current.status === 'available') pipeline = 'Available';
  else if (current.status === 'failed') pipeline = 'Stalled';
  else if (['declined', 'cancelled'].includes(current.status)) pipeline = 'Stopped';
  else if (current.status === 'pending') pipeline = 'Queued — awaiting approval';
  else if (current.status === 'approved') {
    const queue = await fetchArrQueues().catch(() => null);
    if (queue) {
      const match = findRequestQueueItem(current, queue);
      if (match && queueItemLooksUnhealthy(match)) pipeline = `Stalled — ${String(match.messages?.[0] || match.trackedStatus || match.status).slice(0, 180)}`;
      else if (match) pipeline = `Downloading — ${match.source.label}, ${queuePercent(match)}%`;
    }
  }

  const embed = brandedEmbed(COLORS.INFO)
    .setTitle(`${mediaTypeEmoji(current.media_type, current.is_4k)} ${current.title}${current.is_4k ? ' (4K)' : ''}`.slice(0, 256))
    .addFields(
      { name: 'Requested by', value: requesterLines.join('\n').slice(0, 1024) || 'Unknown', inline: false },
      { name: 'Current status', value: requestStatusBadge(current.status), inline: true },
      { name: 'Pipeline', value: pipeline, inline: true },
      { name: 'Seerr request', value: requestId ? `#${requestId}` : 'Not assigned yet', inline: true },
      { name: 'Also waiting', value: subscribers.length ? subscribers.map(id => isSnowflake(id) ? `<@${id}>` : `\`${id}\``).join(', ').slice(0, 1024) : 'Nobody else', inline: false },
    );
  audit('request_ownership_viewed', { actorDiscordId: interaction.user.id, requestId: requestId || null, mediaId: current.media_id, title: current.title, subscribers: subscribers.length });
  return interaction.editReply({ embeds: [embed] });
}

async function handleAuditCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  const sub = interaction.options.getSubcommand();
  let rows;
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

  const lines = [`**1 · Submitted**  ✅${isSnowflake(row.requested_by_discord_id) ? ` by <@${row.requested_by_discord_id}>` : ''}`];
  if (row.status === 'available') {
    lines.push('**2 · Approved**  ✅');
    lines.push('**3 · Downloaded to Main**  ✅');
    const requester = isSnowflake(row.requested_by_discord_id) ? getUserByDiscordId(row.requested_by_discord_id) : null;
    if (requester?.home_server === 'ph' && stagingConfigured()) {
      const staged = getStagedItem(row.media_id);
      const stageJob = listActiveStageJobs().find(j => j.media_id === row.media_id);
      if (staged) lines.push('**4 · Philippines edge delivery**  ✅ Warm and ready to play 🍿');
      else if (stageJob?.status === 'copying') lines.push(`**4 · Philippines edge delivery**  📥 Copying now${stageJob.started_at ? ` since ${discordTimestamp(stageJob.started_at)}` : ''}`);
      else if (stageJob) lines.push('**4 · Philippines edge delivery**  ⏳ Queued for transfer');
      else lines.push('**4 · Philippines edge delivery**  ⏸️ Available on Main but not cached yet — use `/stage` to copy it to your edge server.');
    } else {
      lines.push('**4 · Ready on Plex**  ✅ Go watch it! 🍿');
    }
  } else if (row.status === 'declined') {
    lines.push('**2 · Approval**  ❌ Declined by an admin.');
  } else if (row.status === 'pending') {
    lines.push('**2 · Approval**  ⏳ Waiting for an admin. You\'ll get a DM when it changes.');
    lines.push('**3 · Download**  ⏸️ Starts after approval');
  } else {
    lines.push('**2 · Approved**  ✅');
    const items = await fetchArrQueues().catch(() => []);
    const match = findRequestQueueItem(row, items);
    if (match) {
      const pct = queuePercent(match);
      lines.push(`**3 · Download**  ⬇️ ${match.source.label}: ${progressBar(pct)} ${pct}%${match.timeleft ? ` · ETA \`${match.timeleft}\`` : ''}`);
      if (queueItemLooksUnhealthy(match)) {
        lines.push(`⚠️ **Operator detail:** ${String(match.messages[0] || match.trackedStatus || match.status).slice(0, 200)}`);
        lines.push('You do not need to do anything; an admin gets a one-click retry option.');
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
        lines.push(`**3 · Download**  ⏳ It isn't out yet; it will be grabbed automatically after release.\n${eta.line}`);
      } else {
        lines.push('**3 · Download**  🔎 Looking for a suitable release. Searches retry automatically; an admin can force another search.');
        if (eta) lines.push(eta.line);
      }
    }
  }
  await interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO)
    .setTitle(`📊 ${row.title}${row.is_4k ? ' (4K)' : ''}`)
    .setDescription(lines.join('\n'))] });
}

// /request-cancel — let a user withdraw their own request. Two cases: still held behind the
// bot's own approval gate (nothing exists in Seerr yet — just drop the stash), or already
// submitted to Seerr (DELETE the request there, which Seerr permits while it's still
// pending/processing and refuses once the media is available).
async function handleRequestCancelCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const mediaId = String(interaction.options.getString('title') || '').trim();
  const row = /^(tmdb|tvdb):\d+$/.test(mediaId)
    ? db.prepare("SELECT * FROM requests WHERE media_id = ? AND requested_by_discord_id = ? AND status IN ('pending', 'approved') ORDER BY id DESC LIMIT 1").get(mediaId, interaction.user.id)
    : db.prepare("SELECT * FROM requests WHERE title LIKE ? AND requested_by_discord_id = ? AND status IN ('pending', 'approved') ORDER BY id DESC LIMIT 1").get(`%${mediaId}%`, interaction.user.id);
  if (!row) {
    return interaction.editReply('❌ Nothing cancelable matches that — pick a suggestion from the list. Requests that are already available or declined can\'t be withdrawn.');
  }

  // #75: cancelling shouldn't cancel it for other people who also asked for it — hand the
  // request off to the next subscriber instead of dropping it, when there is one. Subscribers
  // are keyed by the real tmdbId, which is NOT the same as row.media_id once a TV request is
  // approved (that becomes tvdb:<id>) — resolveTmdbId() finds the tmdb:-keyed sibling row for
  // that case instead of misreading the tvdb id as a tmdbId.
  const tmdbId = resolveTmdbId(row);
  const subscriberKey = tmdbId != null ? subscriberKeyFor(tmdbId, !!row.is_4k) : null;
  const [heirId] = subscriberKey ? listRequestSubscribers(subscriberKey) : [];
  const heirUser = heirId ? getUserByDiscordId(heirId) : null;

  if (row.status === 'pending') {
    const nonce = findPendingRequestNonce(interaction.user.id, row.media_type, tmdbId, !!row.is_4k);
    const pending = nonce ? takePendingRequest(nonce) : null;
    if (pending && heirUser) {
      let heirSeerrUserId = null;
      try { heirSeerrUserId = await resolveSeerrUserId(heirUser); } catch (_e) {}
      if (heirSeerrUserId != null) {
        restashPendingRequest(nonce, { ...pending, discordId: heirId, email: heirUser.email, seerrUserId: heirSeerrUserId });
        db.prepare('UPDATE requests SET requested_by_discord_id = ? WHERE id = ?').run(heirId, row.id);
        db.prepare('DELETE FROM request_subscribers WHERE media_id = ? AND discord_id = ?').run(subscriberKey, heirId);
        audit('request_handed_off', { actorDiscordId: interaction.user.id, targetDiscordId: heirId, title: row.title, mediaId: row.media_id, stage: 'gate' });
        notifyChannel('requests', `↩️ <@${interaction.user.id}> withdrew their request for **${row.title}**${row.is_4k ? ' (4K)' : ''} — handed off to <@${heirId}>, who also wanted it. Still awaiting approval.`);
        return interaction.editReply(`↩️ Withdrew your request for **${row.title}**${row.is_4k ? ' (4K)' : ''} — handed off to another member who wanted it too, so it's still pending approval.`);
      }
    }
    // No one to hand off to (or the heir couldn't be resolved in Seerr) — drop it for real.
    db.prepare("UPDATE requests SET status = 'cancelled' WHERE id = ?").run(row.id);
    audit('request_cancelled_by_user', { actorDiscordId: interaction.user.id, title: row.title, mediaId: row.media_id, stage: 'gate' });
    notifyChannel('requests', `↩️ <@${interaction.user.id}> withdrew their own request for **${row.title}**${row.is_4k ? ' (4K)' : ''} before it was reviewed.`);
    return interaction.editReply(`↩️ Withdrew your request for **${row.title}**${row.is_4k ? ' (4K)' : ''} — it never reached an admin.`);
  }

  // 'approved' — already submitted to Seerr. If someone else is subscribed, just reassign local
  // ownership to them (the Seerr request itself stays exactly as it is — nothing to resubmit).
  if (heirId) {
    db.prepare('UPDATE requests SET requested_by_discord_id = ? WHERE id = ?').run(heirId, row.id);
    db.prepare('DELETE FROM request_subscribers WHERE media_id = ? AND discord_id = ?').run(subscriberKey, heirId);
    audit('request_handed_off', { actorDiscordId: interaction.user.id, targetDiscordId: heirId, title: row.title, mediaId: row.media_id, stage: 'seerr' });
    notifyChannel('requests', `↩️ <@${interaction.user.id}> stepped back from **${row.title}**${row.is_4k ? ' (4K)' : ''} — handed off to <@${heirId}>, who also wanted it. Still on its way.`);
    return interaction.editReply(`↩️ Stepped back from **${row.title}**${row.is_4k ? ' (4K)' : ''} — handed off to another member who wanted it too.`);
  }

  // Let Seerr be the source of truth on whether it can still be pulled back (it refuses once
  // the media is available/partially available).
  if (!row.overseerr_request_id) {
    return interaction.editReply('❌ Can\'t cancel this one — it\'s already downloading or on Plex.');
  }
  try {
    await deleteOverseerrRequest(row.overseerr_request_id);
  } catch (err) {
    audit('external_api_error', { actorDiscordId: interaction.user.id, provider: 'overseerr', action: 'cancel_request', requestId: row.overseerr_request_id, error: err.message });
    return interaction.editReply(`❌ Couldn't cancel **${row.title}** — it's likely already downloading. (${err.response?.status === 403 ? 'Seerr refused the delete' : err.message})`);
  }
  db.prepare("UPDATE requests SET status = 'cancelled' WHERE id = ?").run(row.id);
  audit('request_cancelled_by_user', { actorDiscordId: interaction.user.id, title: row.title, mediaId: row.media_id, stage: 'seerr', overseerrRequestId: row.overseerr_request_id });
  notifyChannel('requests', `↩️ <@${interaction.user.id}> cancelled their own request for **${row.title}**${row.is_4k ? ' (4K)' : ''}.`);
  return interaction.editReply(`↩️ Cancelled **${row.title}**${row.is_4k ? ' (4K)' : ''}.`);
}

const ISSUE_TYPE_LABELS = { 1: 'Video', 2: 'Audio', 3: 'Subtitle', 4: 'Other' };

// /report — files a problem with existing media straight into Seerr's own Issues feature
// (POST /api/v1/issue), so it lands where the admin already manages media instead of as
// unstructured Discord chatter they have to notice and remember.
async function handleReportCommand(interaction) {
  const linked = getUserByDiscordId(interaction.user.id);
  if (!linked) return interaction.reply({ content: '❌ You need to be linked first — ask an admin to run `/link` for you.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });

  const mediaId = String(interaction.options.getString('title') || '').trim();
  const issueType = Number(interaction.options.getString('type'));
  const details = String(interaction.options.getString('details') || '').trim().slice(0, 1000);

  const row = /^(tmdb|tvdb):\d+$/.test(mediaId)
    ? db.prepare("SELECT * FROM requests WHERE media_id = ? AND status = 'available' ORDER BY id DESC LIMIT 1").get(mediaId)
    : db.prepare("SELECT * FROM requests WHERE title LIKE ? AND status = 'available' ORDER BY id DESC LIMIT 1").get(`%${mediaId}%`);
  if (!row) return interaction.editReply('❌ Nothing available matches that — pick a suggestion from the list.');

  let seerrUserId = null;
  try { seerrUserId = await resolveSeerrUserId(linked); } catch (_e) {}
  if (seerrUserId == null) return interaction.editReply('❌ No Seerr account is linked to you yet — ask an admin to run `/link` for you.');

  // Prefer resolving via the known Seerr request id — it needs no tmdb/tvdb reasoning and works
  // for TV, where the locally-tracked media_id is often tvdb:<id> (Seerr's tvdbId), not a tmdbId.
  // fetchSeerrTvdbId() converts the other direction (tmdb → tvdb) and would silently misresolve
  // if fed a tvdb id here, so it's only used as a last resort for movies (always tmdb:-keyed).
  let seerrMediaId = row.overseerr_request_id != null ? await fetchSeerrMediaIdByRequest(row.overseerr_request_id) : null;
  if (seerrMediaId == null && row.media_id.startsWith('tmdb:')) {
    seerrMediaId = await fetchSeerrMediaId(row.media_type, Number(row.media_id.split(':')[1]));
  }
  if (seerrMediaId == null) {
    return interaction.editReply(`❌ Couldn't find **${row.title}** in Seerr to attach the report to. Let an admin know directly.`);
  }

  try {
    await createSeerrIssue(seerrMediaId, issueType, details, seerrUserId);
  } catch (err) {
    audit('external_api_error', { actorDiscordId: interaction.user.id, provider: 'overseerr', action: 'create_issue', error: err.message, mediaId: row.media_id });
    return interaction.editReply(`❌ Couldn't file the report: ${err.response?.data?.message || err.message}`);
  }
  audit('issue_reported', { actorDiscordId: interaction.user.id, title: row.title, mediaId: row.media_id, issueType: ISSUE_TYPE_LABELS[issueType] });
  notifyChannel('requests', { embeds: [brandedEmbed(COLORS.WARN)
    .setTitle(`🛠️ Issue Reported — ${row.title}`)
    .setDescription(details)
    .addFields(
      { name: 'Reported by', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Type', value: ISSUE_TYPE_LABELS[issueType], inline: true },
    )] });
  return interaction.editReply(`✅ Reported a **${ISSUE_TYPE_LABELS[issueType].toLowerCase()}** issue with **${row.title}** — an admin will take a look.`);
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
    // Best-effort: only gate on aliases when the typed title resolves unambiguously to a real
    // Sonarr series. An admin free-typing a title Sonarr doesn't know yet (not added, or a
    // movie) keeps today's alias-less scoring rather than being blocked.
    let aliases;
    if (mediaType === 'tv') {
      const resolved = await resolveSonarrSeriesIdentity({ title: split.query, year }).catch(() => null);
      if (resolved?.series) aliases = sonarrSeriesAliases(resolved.series);
    }
    const results = await searchAvistaz({ query: split.query, mediaType, indexerId: indexer.id });
    // includeRejected only to explain an empty result set below — the offer itself (what's
    // stashed, planned, and clickable) is built from `accepted` alone, so a button's index
    // always lines up with the same position in offer.candidates.
    const withRejected = rankAvistazResults(results, { title: split.query, year, mediaType, season, aliases }, { limit: avistazRankLimit(mediaType), includeRejected: true });
    if (!withRejected.length) return interaction.editReply(`🔍 No AvistaZ results for **${split.query}**${season != null ? ` S${pad(season)}` : ''}. Try alternate spellings or the show's original title.`);
    const accepted = withRejected.filter(c => !c.rejected);
    if (!accepted.length) return interaction.editReply(`🔍 AvistaZ returned ${withRejected.length} result(s) for **${split.query}**, but none matched this series by name — they looked like a different, similarly-titled show.`);
    const candidates = accepted.slice(0, 3);
    const allowance = grabDailyAllowance();
    // An explicit `season:` scopes the whole-series plan to that season; without one it plans
    // across every season the search turned up.
    const plan = buildSeriesPlan({ candidates: accepted, mediaType, season, allowance, aliases });
    const nonce = stashGrabOffer({ mediaType, title: rawTitle, discordId: interaction.user.id, origin: 'manual', candidates: accepted, season, aliases });
    audit('avistaz_search', { actorDiscordId: interaction.user.id, query: split.query, mediaType, season, results: results.length, shown: candidates.length, planned: plan?.picks.length || 0 });
    return interaction.editReply(grabCandidatesMessage({
      heading: `🔎 Found ${accepted.length} AvistaZ match${accepted.length === 1 ? '' : 'es'} — ${split.query}`,
      candidates, nonce, allowance, plan,
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
    try {
      const version = await getRtorrentVersion();
      const torrents = await listRtorrentTorrents();
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
      // A hash match only counts as "tracked" when the existing job is still in flight or
      // already confirmed imported — see ADOPT_BLOCKING_STATES. A failed/rejected/stale job
      // never actually finished, so its torrent stays adoptable.
      const isTracked = t => { const j = getGrabJobByHash(t.hash); return j && ADOPT_BLOCKING_STATES.has(j.state) ? j : null; };
      const fresh = matches.filter(t => !isTracked(t));
      if (!fresh.length) {
        const j = isTracked(matches[0]);
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

// /season search|status — an on-demand escape hatch for the automatic season-pack sweep
// (index.js's runSeasonPackSweep and src/season-pack.js's seasonSearchTargets). `search` mirrors
// the dashboard's "Search Now" action (same route decision: AvistaZ-tagged + direct-grab enabled
// goes through runSeasonDirectGrab, everything else through Sonarr's own SeasonSearch) so an admin
// never has to leave Discord for what used to require the dashboard or Sonarr's own web UI.
// `status` never searches anything — it just explains the seasonSearchTargets gate for one series,
// since the sweep itself stays silent about series it decides not to touch (untagged when
// SEASON_PACK_SONARR_UNTAGGED is off, too young, on cooldown, etc.).
async function handleSeasonCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;
  if (!CONFIG.SONARR_URL) return interaction.reply({ content: '❌ Sonarr isn\'t configured.', ephemeral: true });
  const sub = interaction.options.getSubcommand();
  const seriesId = Number(interaction.options.getString('title'));
  await interaction.deferReply({ ephemeral: true });
  const all = await listSonarrSeries().catch(() => []);
  const series = all.find(s => Number(s.id) === seriesId);
  if (!series) return interaction.editReply('❌ Couldn\'t find that series in Sonarr any more — start typing again and pick a fresh suggestion.');

  const tagSource = { url: CONFIG.SONARR_URL, key: CONFIG.SONARR_API_KEY, label: 'sonarr' };
  const tagId = await getArrTagId(tagSource, CONFIG.AVISTAZ_TAG).catch(() => null);
  const tagged = tagId != null && (series.tags || []).includes(tagId);
  const allowUntagged = tunable('SEASON_PACK_SONARR_UNTAGGED');
  const directEnabled = tunable('SEASON_PACK_AVISTAZ_DIRECT') && grabConfigured();

  if (sub === 'status') {
    const episodes = await getSeriesEpisodes(series.id).catch(() => null);
    if (!episodes) return interaction.editReply(`❌ Couldn't read episodes for **${series.title}** from Sonarr.`);
    const requestedTvdbIds = tunable('SEASON_PACK_REQUESTED') ? listRequestedTvdbIds() : new Set();
    const requested = requestedTvdbIds.has(Number(series.tvdbId));
    const cfg = seasonPackConfig();
    const targets = seasonSearchTargets({
      series, episodes, requested,
      searchedAt: getSeasonSearchTimes(series.id),
      stallCounts: getSeasonSearchStalls(series.id),
    }, Date.now(), cfg);
    const lines = [];
    lines.push(`**Sweep eligible:** ${targets.eligible ? `✅ yes (${targets.reason})` : `❌ no — ${targets.reason}`}`);
    lines.push(`**AvistaZ tag:** ${tagged ? `✅ tagged \`${CONFIG.AVISTAZ_TAG}\`` : `❌ not tagged${allowUntagged ? '' : ' — the automatic sweep skips untagged series unless `SEASON_PACK_SONARR_UNTAGGED=true`'}`}`);
    lines.push(`**Would route through:** ${tagged && directEnabled ? 'AvistaZ direct grab' : 'Sonarr\'s own SeasonSearch (its configured indexers)'}`);
    if (!tagged && !allowUntagged) {
      lines.push('', '⚠️ This series is **not swept automatically** — untagged, and `SEASON_PACK_SONARR_UNTAGGED` is off. Use `/season search` here to force a one-off check, or tag it (or flip that setting) for it to be picked up on its own.');
    }
    if (targets.seasons.length) {
      lines.push('', '**Ready to search now:**');
      for (const s of targets.seasons) lines.push(`• S${pad(s.season)} — ${s.missing}/${s.aired} aired episode(s) missing`);
    }
    if (targets.held?.length) {
      lines.push('', '**On cooldown:**');
      for (const s of targets.held) lines.push(`• S${pad(s.season)} — ${s.missing}/${s.aired} missing, next eligible ${new Date(s.nextEligible).toISOString().slice(0, 16).replace('T', ' ')} UTC (\`/season search force:true\` skips this)`);
    }
    if (!targets.seasons.length && !targets.held?.length) lines.push('', 'No season currently qualifies for a pack search (nothing missing enough, or everything already in queue).');
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO).setTitle(`🔍 Season-Pack Status — ${series.title}`.slice(0, 256)).setDescription(lines.join('\n').slice(0, 4000))] });
  }

  // sub === 'search'
  const seasonNumber = interaction.options.getInteger('season');
  const force = interaction.options.getBoolean('force') || false;
  const episodes = await getSeriesEpisodes(series.id).catch(() => null);
  if (!episodes) return interaction.editReply(`❌ Couldn't read episodes for **${series.title}** from Sonarr.`);
  const missing = episodes.filter(ep => Number(ep.seasonNumber) === seasonNumber && ep.monitored && !ep.hasFile
    && Date.parse(ep.airDateUtc || ep.airDate || '') <= Date.now());
  if (!missing.length) return interaction.editReply(`ℹ️ **${series.title}** S${pad(seasonNumber)} has no aired missing episodes — nothing to search for.`);
  const fallback = getSeasonEpisodeFallback(series.id, seasonNumber);
  if (fallback) return interaction.editReply(`❌ A bounded episode fallback already owns **${series.title}** S${pad(seasonNumber)} (${fallback.state}) — let it finish first.`);
  if (!force) {
    const { cooling, nextEligible } = seasonSearchCooldown(getSeasonSearchTimes(series.id)[seasonNumber]);
    if (cooling) return interaction.editReply(`⏳ **${series.title}** S${pad(seasonNumber)} is on cooldown until ${new Date(nextEligible).toISOString()}. Add \`force:true\` to search anyway.`);
  }

  if (tagged && directEnabled) {
    const indexer = await findAvistazIndexer().catch(() => null);
    if (!indexer) return interaction.editReply(`❌ **${series.title}** is tagged for AvistaZ, but no matching Prowlarr indexer was found — check \`AVISTAZ_INDEXER_NAME\`.`);
    const allowance = grabDailyAllowance();
    const result = await runSeasonDirectGrab({ series, season: { season: seasonNumber, missing: missing.length }, indexer, allowance });
    clearSeasonAlertState(series.id, seasonNumber);
    recordSeasonSearch({ seriesId: series.id, seasonNumber, seriesTitle: series.title, missing: missing.length });
    audit('season_search_command', { actorDiscordId: interaction.user.id, seriesId: series.id, title: series.title, season: seasonNumber, route: 'avistaz', status: result.status, force });
    const statusText = result.status === 'grabbed' ? result.detail
      : result.status === 'offered' ? result.detail
        : result.status === 'no_results' ? 'AvistaZ search completed but found no results.'
          : result.status === 'allowance' ? 'the daily AvistaZ grab allowance is exhausted for today.'
            : `AvistaZ search failed: ${result.error || 'unknown error'}`;
    return interaction.editReply(`📦 **${series.title}** S${pad(seasonNumber)} — ${statusText}`);
  }

  const command = await triggerSeasonSearch(series.id, seasonNumber);
  clearSeasonAlertState(series.id, seasonNumber);
  const stallCount = recordSeasonSearch({ seriesId: series.id, seasonNumber, seriesTitle: series.title, missing: missing.length });
  monitorSeasonSearch({ seriesId: series.id, seriesTitle: series.title, seriesYear: series.year, seriesAliases: sonarrSeriesAliases(series), seasonNumber, missingAtSearch: missing.length, commandId: command?.id, stallCount });
  audit('season_search_command', { actorDiscordId: interaction.user.id, seriesId: series.id, title: series.title, season: seasonNumber, route: 'sonarr', commandId: command?.id || null, force });
  return interaction.editReply(`📡 Sonarr accepted the S${pad(seasonNumber)} season search for **${series.title}**.${force ? ' (cooldown overridden)' : ''} Its own interactive-search report will follow in the downloads channel if it needs one.`);
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
          candidates.push({ mediaId: `tmdb:${m.tmdbId}`, title: `${m.title}${s.label === 'radarr-4k' ? ' (4K)' : ''}`, path: m.path, sizeBytes: m.sizeOnDisk, ageDays: (now - addedMs) / 86400000 });
        }
      } else {
        const series = await axios.get(`${s.url}/api/v3/series`, { headers: { 'X-Api-Key': s.key }, timeout: 20000 }).then(r => r.data || []);
        for (const t of series) {
          const size = t.statistics?.sizeOnDisk || 0;
          if (!size) continue;
          const addedMs = Date.parse(t.added || '') || now;
          candidates.push({ mediaId: `tvdb:${t.tvdbId}`, title: t.title, path: t.path, sizeBytes: size, ageDays: (now - addedMs) / 86400000 });
        }
      }
    } catch (err) {
      audit('external_api_error', { provider: s.label, error: err.message, action: 'cleanup_suggestions' });
    }
  }
  const allEligible = candidates
    .filter(c => !isInKeepList(c.mediaId) && !CONFIG.NEVER_DELETE_MEDIA_IDS.includes(c.mediaId))
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
  const eligible = allEligible.slice(0, 12);
  if (!eligible.length) return interaction.editReply('Nothing sizable to suggest — everything is either small, keep-listed, or never-delete.');
  const total = fmtSpace(eligible.reduce((a, c) => a + c.sizeBytes, 0));
  const forecasts = forecastDisks(db, await fetchDiskSpace().catch(() => []), now)
    .filter(d => d.forecast.status === 'projected')
    .sort((a, b) => a.forecast.daysRemaining - b.forecast.daysRemaining);
  let timeEstimate = 'Capacity estimate unavailable until enough disk history has been collected.';
  for (const disk of forecasts) {
    const suggestions = allEligible.filter(candidate => pathIsOnRoot(candidate.path, disk.path)).slice(0, 5);
    if (!suggestions.length) continue;
    const freed = suggestions.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
    const days = freed / disk.forecast.consumptionBytesPerDay;
    timeEstimate = `On ${disk.root}, freeing its top ${suggestions.length} suggestion(s) (${fmtSpace(freed)}) would buy approximately ${Math.max(1, Math.round(days))} days at the current estimated rate.`;
    break;
  }
  await interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO)
    .setTitle(`🧹 Cleanup Suggestions (top ${eligible.length} ≈ ${total})`)
    .setDescription(`${eligible.map(c => `• **${c.title}** — ${fmtSpace(c.sizeBytes)} — ${Math.round(c.ageDays)}d old`).join('\n')}\n\n${timeEstimate}`.slice(0, 4000))
    .setFooter({ text: 'Durant Media Server · Suggestions only — nothing is deleted. Keep list & never-delete already excluded.' })] });
}

async function handleMeCommand(interaction) {
  const row = getUserByDiscordId(interaction.user.id);
  if (!row) {
    return interaction.reply({ embeds: [brandedEmbed(COLORS.WARN)
      .setTitle('👤 Not Linked Yet')
      .setDescription('You aren\'t linked to a Plex account yet.\nDM me your Plex email to request access!')], ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  const requestCount = db.prepare('SELECT COUNT(*) AS c FROM requests WHERE requested_by_discord_id = ?').get(interaction.user.id).c;
  let quota = null;
  if (row.overseerr_user_id != null) {
    try { quota = await fetchUserQuota(row.overseerr_user_id); } catch (_e) {}
  }
  const quotaLines = [quotaLine(quota, 'movie'), quotaLine(quota, 'tv')].filter(Boolean);
  const homeServer = row.home_server === 'ph' ? 'Philippines' : 'Main';
  const accessReady = !!(row.invited && row.overseerr_created);
  const checklist = [
    `1. ${row.invited ? '✅' : '⏳'} Plex invitation ${row.invited ? 'sent — accept it from your Plex email if you have not already' : 'has not been sent yet'}`,
    `2. ${row.overseerr_created ? '✅' : '⏳'} Request access ${row.overseerr_created ? 'connected' : 'still being set up'}`,
    `3. ${accessReady ? '✅' : '⏳'} Home server: **${homeServer}**`,
  ].join('\n');
  const nextStep = !row.invited
    ? 'An admin still needs to send your Plex invitation.'
    : !row.overseerr_created
      ? 'Your Plex invitation is sent; an admin still needs to finish request access.'
      : row.home_server === 'ph'
        ? 'You are ready. Use `/request` for new media and `/stage` to warm something already in the library on your edge server.'
        : 'You are ready. Use `/request` for new media and `/request-status` to track it.';
  const embed = brandedEmbed(accessReady ? COLORS.SUCCESS : COLORS.PLEX)
    .setTitle(accessReady ? '✅ Your Access Is Ready' : '👤 Your Access Checklist')
    .setThumbnail(interaction.user.displayAvatarURL?.() || null)
    .addFields(
      { name: 'Plex email', value: `\`${row.email}\``, inline: false },
      { name: 'Setup', value: checklist, inline: false },
      { name: 'Next step', value: nextStep, inline: false },
      { name: 'Total requests', value: `${requestCount}`, inline: true },
      ...(quotaLines.length ? [{ name: 'Quota', value: quotaLines.join('\n'), inline: false }] : []),
      ...(CONFIG.AUTO_APPROVE_AFTER_N_APPROVED > 0 ? [{ name: 'Standing', value: describeTrustStanding(interaction.user.id), inline: false }] : []),
    );
  await interaction.editReply({ embeds: [embed] });
}

// #80: "12 approved requests" if not yet trusted, "auto-approved — 12 approved requests" once
// past the threshold — gives members a reason to make good requests, and tells them why their
// next /request might skip the gate.
function describeTrustStanding(discordId) {
  const score = getTrustScore(discordId);
  const threshold = CONFIG.AUTO_APPROVE_AFTER_N_APPROVED;
  if (score >= threshold) return `🚀 Auto-approved — ${score} approved request${score === 1 ? '' : 's'} (4K still needs admin approval)`;
  return `${score} of ${threshold} approved requests until auto-approval`;
}
async function handleMyRequestsCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const rows = db.prepare('SELECT * FROM requests WHERE requested_by_discord_id = ? ORDER BY id DESC LIMIT 15').all(interaction.user.id);
  const cancelable = rows.some(r => r.status === 'pending' || r.status === 'approved');
  const embed = brandedEmbed(COLORS.INFO)
    .setTitle('🎬 Your Recent Requests')
    .setDescription(rows.length
      ? rows.map(r => `${requestStatusBadge(r.status)} — **${r.title}** (${mediaTypeLabel(r.media_type, r.is_4k)})`).join('\n')
      : 'No requests yet. Request something in Overseerr and it\'ll show up here!');
  const user = getUserByDiscordId(interaction.user.id);
  if (user?.overseerr_user_id != null) {
    let quota = null;
    try { quota = await fetchUserQuota(user.overseerr_user_id); } catch (_e) {}
    const quotaLines = [quotaLine(quota, 'movie'), quotaLine(quota, 'tv')].filter(Boolean);
    if (quotaLines.length) embed.addFields({ name: 'Quota', value: quotaLines.join('\n'), inline: false });
  }
  if (cancelable) embed.setFooter({ text: 'Changed your mind about one? Use /request-cancel.' });
  await interaction.editReply({ embeds: [embed] });
}

function startOfMonthIso() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

// Personal-only by default: a "top watcher" leaderboard is fun in a family server and
// uncomfortable in a wider one, so this never surfaces anyone else's numbers.
async function buildPersonalStatsEmbed(discordId) {
  const since = startOfMonthIso();
  const requestCount = db.prepare("SELECT COUNT(*) AS c FROM requests WHERE requested_by_discord_id = ? AND created_at >= ? AND status != 'cancelled'").get(discordId, since).c;
  const embed = brandedEmbed(COLORS.INFO).setTitle('📊 Your Stats This Month')
    .addFields({ name: 'Requests', value: `${requestCount}`, inline: true });

  const user = getUserByDiscordId(discordId);
  if (tautulliConfigured() && user?.plex_username) {
    try {
      const data = await tautulliApi('get_history', { user: user.plex_username, after: since.slice(0, 10), length: 2000 });
      const rows = (data?.data || []).filter(r => r.media_type !== 'track');
      const titles = new Set(rows.map(r => ['episode', 'season', 'show'].includes(r.media_type) ? r.grandparent_title : r.title));
      embed.addFields(
        { name: 'Plays', value: `${rows.length}`, inline: true },
        { name: 'Distinct titles', value: `${titles.size}`, inline: true },
      );
    } catch (err) {
      log.warn(`Personal stats Tautulli lookup failed: ${err.message}`);
    }
  }
  return embed;
}

// Server-wide view, reused by /stats server:true and the scheduled monthly recap. Kept
// anonymous by default (no per-member breakdown) other than top requesters, which is closer to
// a leaderboard than a privacy concern in a private server the same way personal watch time is.
async function buildServerStatsEmbed({ sinceIso, periodLabel }) {
  const since = sinceIso || startOfMonthIso();
  // Counts primary-recipient availability DMs only (not the #75 subscriber fan-out copies, which
  // are tagged {subscriber:true}), so a popular title with several subscribers isn't overcounted.
  const titlesAdded = db.prepare(
    "SELECT COUNT(*) AS c FROM audit_log WHERE action = 'media_available_notification_sent' AND created_at >= ? AND (metadata_json IS NULL OR metadata_json NOT LIKE '%\"subscriber\":true%')",
  ).get(since).c;
  const topRequesters = db.prepare(
    "SELECT requested_by_discord_id AS id, COUNT(*) AS c FROM requests WHERE created_at >= ? AND status != 'cancelled' AND requested_by_discord_id IS NOT NULL GROUP BY requested_by_discord_id ORDER BY c DESC LIMIT 5",
  ).all(since);

  const embed = brandedEmbed(COLORS.SUCCESS).setTitle(`📊 Server Stats — ${periodLabel || 'This Month'}`)
    .addFields({ name: 'Titles added', value: `${titlesAdded}`, inline: true });

  if (topRequesters.length) {
    embed.addFields({ name: 'Top requesters', value: topRequesters.map(r => `<@${r.id}> — ${r.c}`).join('\n'), inline: false });
  }

  if (tautulliConfigured()) {
    try {
      const days = Math.max(1, Math.ceil((Date.now() - Date.parse(since)) / 86400000));
      const history = await fetchHistory(undefined, { afterDays: days, length: 5000 });
      const mostWatched = [...history].sort((a, b) => b.plays - a.plays).slice(0, 5);
      if (mostWatched.length) {
        embed.addFields({ name: 'Most watched', value: mostWatched.map(h => `${h.title} — ${h.plays} play${h.plays === 1 ? '' : 's'}`).join('\n'), inline: false });
      }
    } catch (err) {
      log.warn(`Server stats Tautulli lookup failed: ${err.message}`);
    }
  }
  return embed;
}

async function handleStatsCommand(interaction) {
  const wantsServer = interaction.options.getBoolean('server');
  if (wantsServer && !isAdminInteraction(interaction)) {
    return interaction.reply({ content: '❌ Server-wide stats are admin only — try `/stats` for your own.', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: !wantsServer });
  const embed = wantsServer ? await buildServerStatsEmbed({}) : await buildPersonalStatsEmbed(interaction.user.id);
  await interaction.editReply({ embeds: [embed] });
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
  let entry;
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
  const serverLabel = server === 'ph' ? 'Philippines' : 'Main';
  const row = getUserByDiscordId(target.id);
  if (!row) return interaction.reply({ content: `⚠️ ${target.tag} isn't in the DB — \`/link\` them first.`, ephemeral: true });
  if ((row.home_server || 'primary') === server) return interaction.reply({ content: `ℹ️ ${target.tag} is already assigned to **${serverLabel}**.`, ephemeral: true });
  setUserHomeServer(target.id, server);
  audit('user_home_server_changed', { actorDiscordId: interaction.user.id, targetDiscordId: target.id, from: row.home_server || 'primary', to: server });
  const notes = [
    `✅ ${target.tag} is now assigned to **${serverLabel}**${server === 'ph' ? ' — their finished-request titles will auto-stage to the travel cache' : ''}.`,
  ];
  if (row.invited) {
    notes.push(`⚠️ They were already invited under the old assignment. Send a fresh invite to the ${server === 'ph' ? 'Philippines server' : 'Main servers'} with \`/reinvite\`, and remove their share on the old server from plex.tv if they shouldn't keep it (watch state doesn't sync between servers).`);
  }
  return interaction.reply({ content: notes.join('\n'), ephemeral: true });
}

async function handleNotificationsCommand(interaction) {
  const enabled = interaction.options.getBoolean('request_updates', true);
  const key = `request_progress_dm:${interaction.user.id}`;
  if (enabled) deleteSetting(key);
  else setSetting(key, '0');
  audit('notification_preference_changed', { actorDiscordId: interaction.user.id, requestUpdates: enabled });
  return interaction.reply({
    content: enabled
      ? 'Request progress DMs are enabled.'
      : 'Request progress DMs are muted. Approval and availability messages are unchanged.',
    ephemeral: true,
  });
}

async function handleHelpCommand(interaction) {
  const userCommands = [
    '`/request` — Search and request a movie or show; an admin approves it in Discord',
    '`/request-status` — Check why a request isn\'t ready yet',
    '`/notifications` — Enable or mute request progress DMs',
    '`/request-cancel` — Withdraw one of your own pending or awaiting-download requests',
    '`/report` — Report a problem with something already on Plex (wrong subtitles, bad audio, etc.)',
    '`/stats` — Your watch/request stats this month',
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
      '`/stage` — Copy a title to the travel server so it plays instantly there');
  }
  const embed = brandedEmbed(COLORS.PLEX)
    .setTitle('🎬 Durant Media Server — Help')
    .setDescription('DM the bot your Plex account email → an admin approves → you get Plex + Seerr (request) access.')
    .addFields({ name: 'Commands', value: userCommands.join('\n'), inline: false });
  if (isAdminInteraction(interaction)) {
    const peopleCommands = [
      '`/invite` — DM a member for their Plex email and auto-set them up',
      '`/invite-post` — Post a public Request Access button in this channel',
      '`/link` — Link a Discord user to a Plex email (invites + sets up Seerr)',
      '`/unlink` — Remove a user from the DB',
      '`/users` — List linked users',
      '`/sync` — Preview or apply user sync',
      '`/sync-fix` — Resolve duplicates / placeholders / orphans / suggested links',
      '`/reinvite` — Re-send a Plex invite to a linked user',
    ];
    const operationsCommands = [
      '`/status` — Show system health and stats',
      '`/backup-rehearse` — Verify the newest backup without changing the live database',
      '`/doctor` — Run read-only Main → Philippines transfer and configuration checks',
      '`/requests` — Show the most recent Seerr requests',
      '`/pending` — Review requests still awaiting approval',
      '`/whorequested` — Find who requested a title and who else is waiting',
      '`/cleanup` — Remove deleted Seerr users',
      '`/audit` — Query the audit log',
      '`/revoke-downloads` — Revoke active download links',
      '`/seerr-test` — Self-test Seerr Discord linking with a throwaway user',
      '`/watching` — Current Plex playback (via Tautulli)',
      '`/indexers` — Prowlarr indexer + Byparr health',
      '`/debrid` — Premiumize account + transfer status',
      '`/cleanup-suggestions` — Largest/oldest media that could be cleaned up',
    ];
    const infrastructureCommands = [
      '`/tier` — Regional tiering: preview/apply per-node edge-cache plans',
      '`/tier-node` — Manage the tiering node registry (capacity, access mode, demand source, `folder add|remove|list`)',
      '`/tier-member` — Manage a restricted node\'s member set',
    ];
    if (grabConfigured()) {
      infrastructureCommands.push('`/avistaz` — Search AvistaZ directly and send a release to the seedbox');
    }
    if (rtorrentConfigured()) {
      infrastructureCommands.push('`/rtorrent` — Inspect seedbox torrents and adopt existing ones into the pipeline');
    }
    if (stagingConfigured()) {
      infrastructureCommands.push(
        '`/staged` — See what\'s warm in the travel cache (and what\'s copying)',
        '`/pin` / `/unpin` — Protect a cached title from automatic eviction',
        '`/stage-bulk` — Seed the travel cache from a list of titles',
        '`/assign-server` — Set a user\'s home server (primary / ph)');
    }
    embed.addFields(
      { name: 'Admin · People & access', value: peopleCommands.join('\n'), inline: false },
      { name: 'Admin · Requests & operations', value: operationsCommands.join('\n'), inline: false },
      { name: 'Admin · Advanced infrastructure', value: infrastructureCommands.join('\n'), inline: false },
    );
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
  // Attach each node's one-to-many Syncthing folders (R2.1). listTierNodeFolders falls back to a
  // single synthesized folder from the legacy folder_root column, so single-folder nodes are
  // unchanged. The planner resolves every title to the right folder per node.
  const nodes = listTierNodes().map(n => ({ ...n, folders: listTierNodeFolders(n.name) }));
  const enabled = nodes.filter(n => n.enabled);
  if (!enabled.length) return { manifests: {}, warnings: ['No enabled tier nodes — add one with `/tier-node add`.'], nodes };
  const { items: inventory, failedSources } = await fetchTierInventory({
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
  const planRecords = {};   // full lifecycle records (published/converged/report meta) for display
  const hysteresis = {};    // { name: { keepMediaIds } } — §1.1 keyed off the last CONVERGED state only
  for (const n of enabled) {
    // Every non-full edge node needs its reported file inventory so the planner can score by
    // local atime. For `atime` nodes it's the whole signal; for `plex` nodes it's the per-title
    // fallback the scorer uses whenever the node's PMS has no view record for a title (§R2.2).
    // Passing it only to `atime` nodes silently starved plex-mode of its documented fallback, so
    // every unwatched-in-90d title scored 0 and eviction collapsed to size-only ordering.
    if (!n.full) atimeReports[n.name] = listTierNodeFiles(n.name);
    if (n.access === 'restricted') {
      memberRequests[n.name] = listRequestsByRequesters(listTierNodeMembers(n.name), CONFIG.TIER_REQUEST_GRACE_DAYS);
    }
    const rec = getTierPlan(n.name);
    if (rec) {
      planRecords[n.name] = rec;
      // §1.1 hysteresis must key off a state the node ACTUALLY reached, not one it was merely told
      // to reach — so only a converged keep set carries over. A published-but-unconverged plan
      // leaves prevKeep null (planner re-derives from floor + admits), which is correct: the node
      // never confirmed it got there.
      if (rec.converged?.keepMediaIds?.length) hysteresis[n.name] = { keepMediaIds: rec.converged.keepMediaIds };
    }
  }
  const result = planTier({
    nodes,
    inventory,
    historiesByNode,
    atimeReports,
    memberRequests,
    keepListIds: tierKeepListIds(),
    neverDeleteIds: CONFIG.NEVER_DELETE_MEDIA_IDS,
    prevPlans: hysteresis,
    config: {
      coreTopK: CONFIG.TIER_CORE_TOP_K,
      halfLifeDays: CONFIG.TIER_HALF_LIFE_DAYS,
      warmDays: CONFIG.TIER_WARM_DAYS,
      freshDays: CONFIG.TIER_FRESH_DAYS,
      requestGraceDays: CONFIG.TIER_REQUEST_GRACE_DAYS,
      churnMinAbsolute: CONFIG.TIER_CHURN_MIN_ABSOLUTE,
      churnMinRelative: CONFIG.TIER_CHURN_MIN_RELATIVE,
      churnPenaltyPerTb: CONFIG.TIER_CHURN_PENALTY_PER_TB,
    },
  });
  // A source that failed contributes zero titles, and a title missing from the inventory is in
  // neither keep nor drop — so its folder's .stignore renders EMPTY and Syncthing re-pulls
  // everything the previous plan held back (hundreds of GB, over the edge node's uplink). The
  // apply-impact caps can't see it either: those titles aren't in the keep set, so newDownloadBytes
  // stays 0 and no confirm is demanded. So a partial inventory makes the whole plan unpublishable —
  // not a warning to read past. `/tier preview` still renders it, clearly marked.
  const inventoryIncomplete = failedSources.map(f => `\`${f.label}\` — ${f.error}`);
  const warnings = [...(result.warnings || [])];
  if (inventoryIncomplete.length) {
    warnings.unshift(`🛑 Inventory incomplete — ${failedSources.map(f => f.label).join(', ')} could not be read. Publishing now would blank the \`.stignore\` for every title they serve and trigger a full re-sync, so \`/tier apply\` is blocked until they answer.`);
  }
  return { ...result, warnings, nodes, planRecords, failedSources };
}

// Global apply-guardrail caps (§1.5) in bytes; a 0/negative CONFIG value disables that cap (null).
function tierApplyCaps() {
  const gb = n => (n > 0 ? n * 1024 ** 3 : null);
  return {
    maxRealRemovalBytes: gb(CONFIG.TIER_APPLY_MAX_REMOVAL_GB),
    maxRemovedTitles: CONFIG.TIER_APPLY_MAX_REMOVED_TITLES > 0 ? CONFIG.TIER_APPLY_MAX_REMOVED_TITLES : null,
    maxNewDownloadBytes: gb(CONFIG.TIER_APPLY_MAX_DOWNLOAD_GB),
  };
}

// §1.1/1.2/1.3 render one node's field. `rec` is the plan lifecycle record (published/converged/
// report meta), `impact` the §1.5 guardrail assessment, `actions` the §1.3 physical-action preview
// (all from the node's last physical inventory, not the previous plan — manual deletions show up).
function tierManifestField(node, m, rec, impact = null, actions = null) {
  const free = Math.max(0, (node.usable_bytes || 0) - m.stats.keepBytes);
  const lines = [
    `Keep: **${m.stats.keepCount}** titles · ${fmtSpace(m.stats.keepBytes)}`,
    `Drop: **${m.stats.dropCount}** titles · ${fmtSpace(m.stats.dropBytes)}`,
    `Budget ${fmtSpace(m.stats.budgetBytes)} → ${fmtSpace(free)} free of ${fmtSpace(node.usable_bytes || 0)}`,
  ];
  if (m.full) lines.push('🔒 Full master — never pruned');
  // §1.3 physical-action preview: what the agent will actually do next, from {plan} × {what's on
  // disk}. Only the action buckets are shown (fully-synced kept titles are the quiet default).
  if (actions) {
    const t = actions.totals;
    const bits = [];
    if (t.downloadLocally.count) bits.push(`⬇️ download ${t.downloadLocally.count} · ${fmtSpace(t.downloadLocally.bytes)}`);
    if (t.removeLocal.count) bits.push(`🗑️ remove ${t.removeLocal.count} · ${fmtSpace(t.removeLocal.bytes)}`);
    if (t.keptDownloading.count) bits.push(`⏳ still syncing ${t.keptDownloading.count} · ${fmtSpace(t.keptDownloading.bytes)}`);
    if (t.alreadyAbsent.count) bits.push(`∅ already gone ${t.alreadyAbsent.count}`);
    lines.push(bits.length ? bits.join(' · ') : '✓ fully in sync — no disk actions');
    if (!actions.hasReport) lines.push('_(no agent report yet — assumes nothing local)_');
  }
  // §1.5 large-rebalance confirmation, computed on the same physical impact numbers.
  if (impact?.requiresConfirm) lines.push(`⚠️ Large rebalance — apply needs \`confirm:${impact.confirmCode}\``);
  // §1.1 published vs converged: never claim a plan is on disk before the agent confirms it.
  const pub = rec?.published;
  const conv = rec?.converged;
  if (!pub) lines.push('No plan published yet');
  else if (conv && conv.planHash === pub.planHash) {
    lines.push(pub.planHash === m.planHash
      ? `✅ Converged ${fmtAgo(conv.convergedAt)} — matches this plan`
      : `Converged plan \`${conv.planHash}\` ${fmtAgo(conv.convergedAt)}; this preview differs`);
  } else {
    lines.push(`📤 Published \`${pub.planHash}\` ${fmtAgo(pub.publishedAt)} — agent has not confirmed convergence yet`);
    if (conv) lines.push(`   last converged: \`${conv.planHash}\` ${fmtAgo(conv.convergedAt)}`);
  }
  // Liveness: lastHeartbeatAt is bumped on every agent check-in (report OR no-op heartbeat), so it's
  // the "is the agent alive?" signal; lastAgentReportAt is only bumped by full convergence reports.
  const beat = rec?.lastHeartbeatAt;
  const lastRep = rec?.lastAgentReportAt;
  if (beat) lines.push(`Agent checked in ${fmtAgo(beat)}${lastRep && lastRep < beat ? ` · last full report ${fmtAgo(lastRep)}` : ''}${rec.lastErrors?.length ? ` · ⚠️ ${rec.lastErrors.length} error(s)` : ''}`);
  else if (lastRep) lines.push(`Agent last reported ${fmtAgo(lastRep)}${rec.lastErrors?.length ? ` · ⚠️ ${rec.lastErrors.length} error(s)` : ''}`);
  // §1.3 effective settings the plan ran with (the node-update path stored warm/fresh but never showed them).
  const warmDays = node.warm_days ?? (node.sticky ? CONFIG.TIER_WARM_DAYS * 2 : CONFIG.TIER_WARM_DAYS);
  const freshDays = node.fresh_days ?? CONFIG.TIER_FRESH_DAYS;
  lines.push(`Settings: demand ${node.demand_source || 'tautulli'} · warm ${warmDays}d · fresh ${freshDays}d${node.sticky ? ' · sticky' : ''} · headroom ${node.headroom_pct ?? 15}%`);
  if (m.forceKept.length) lines.push(`⚠️ ${m.forceKept.length} force-kept (no full-node copy)`);
  // Per-folder drop breakdown under the node total (R2.1) — only when the node spans >1 folder.
  const multi = (m.folders || []).filter(f => f.folder_id || (m.folders || []).length > 1);
  if (multi.length > 1) {
    for (const f of m.folders) {
      const bytes = (f.drop || []).reduce((a, e) => a + (e.sizeBytes || 0), 0);
      lines.push(`  └ \`${f.folder_id || 'default'}\`: keep ${f.keep?.length || 0} · drop ${f.drop?.length || 0} (${fmtSpace(bytes)})`);
    }
  }
  return { name: `${m.full ? '🏠' : '📦'} ${m.node} (${m.access}, ${m.demandSource})`, value: lines.join('\n').slice(0, 1024), inline: false };
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

  const routingErrors = (plans.routingErrors || []).filter(issue => names.includes(issue.node));
  if (sub === 'apply' && routingErrors.length) {
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.DANGER)
      .setTitle('🛑 Apply Blocked — Folder Routing Mismatch')
      .setDescription([
        'The planner could not map some Arr inventory paths to the selected node’s Syncthing folders. Publishing would assign those titles to the first folder, so nothing was written.',
        '',
        ...routingErrors.map(issue => `• \`${issue.node}\`: ${issue.count} unmatched title(s)${issue.examples.length ? ` — examples: ${issue.examples.map(v => `\`${v}\``).join(', ')}` : ''}`),
        '',
        'Configure the enabled full master with its Syncthing folder IDs and source-side roots, and make sure each edge has the same IDs. Local paths and folder order may differ. Then re-run `/tier preview`.',
      ].join('\n').slice(0, 4000))] });
  }

  // §1.5 apply-impact per node (real removals / new downloads vs the node's last physical
  // inventory) — computed for both preview and apply so the same numbers and confirm code show in
  // the dry run. Full masters never prune and aren't edge caches, so they skip the guardrail.
  const caps = tierApplyCaps();
  const impacts = {};
  const actions = {};   // §1.3 physical-action preview per node (from last physical inventory)
  const filesByNode = {};
  for (const name of names) {
    const node = plans.nodes.find(n => n.name === name);
    if (node?.full) continue;
    const files = listTierNodeFiles(name);
    filesByNode[name] = files;
    const imp = assessApplyImpact({ manifest: plans.manifests[name], files, caps });
    imp.confirmCode = tierApplyConfirmCode(name, plans.manifests[name].planHash);
    impacts[name] = imp;
    actions[name] = computeTierActionPreview({ manifest: plans.manifests[name], files });
  }

  const blocked = [];
  if (sub === 'apply' && plans.failedSources?.length) {
    // Hard stop, not a cap that a confirm code can override: every plan in this run was built on a
    // partial library, so publishing any of them blanks the .stignore for the missing arr's titles
    // and starts a full re-sync onto the node. There is no correct confirmation for that — the only
    // fix is to get the arr answering and re-plan.
    audit('tier_apply_blocked_incomplete_inventory', {
      actorDiscordId: interaction.user.id, nodes: names, failedSources: plans.failedSources.map(f => f.label),
    });
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.DANGER)
      .setTitle('🛑 Apply Blocked — Incomplete Inventory')
      .setDescription([
        `Could not read ${plans.failedSources.length} media source(s), so the planner only saw part of the library:`,
        ...plans.failedSources.map(f => `• \`${f.label}\` — ${String(f.error).slice(0, 200)}`),
        '',
        'Titles from a source that did not answer end up in neither keep nor drop, which renders an **empty `.stignore`** for their folders — the node would then re-download everything the last plan was holding back.',
        '',
        `Fix the source and re-run \`/tier apply\`. \`/tier preview\` still works and will show the same warning. Nothing was published${names.length > 1 ? ' for any node' : ''}.`,
      ].join('\n').slice(0, 4000))] });
  }
  if (sub === 'apply') {
    // A confirm code is echoed for exactly one plan; nodes over a cap without the matching code are
    // held back (the rest still apply). The code binds to the plan hash, so a stale code silently
    // stops matching once the plan moves.
    const confirm = interaction.options.getString('confirm')?.trim().toUpperCase() || null;
    for (const name of names) {
      const m = plans.manifests[name];
      const imp = impacts[name];
      if (imp?.requiresConfirm && confirm !== imp.confirmCode) {
        blocked.push(name);
        audit('tier_apply_blocked', { actorDiscordId: interaction.user.id, node: name, planHash: m.planHash, realRemovalBytes: imp.realRemovalBytes, removedTitles: imp.removedTitles, newDownloadBytes: imp.newDownloadBytes });
        continue;
      }
      const stignore = renderSyncthingStignore(m);
      // Render each folder's own .stignore into the served manifest so the agent writes one per
      // folder root; the aggregate `stignore` stays for single-folder agents.
      const folders = (m.folders || []).map(f => ({ ...f, stignore: renderFolderStignore(f, m) }));
      setSetting(`tier_manifest:${name}`, JSON.stringify({ ...m, folders, stignore, rcloneFilesFrom: m.transport === 'rclone' ? renderRclone(m) : undefined }));
      // §1.1 publish only — the plan is NOT marked converged here. The agent's report endpoint
      // advances converged once it confirms the node actually reached this exact plan.
      plans.planRecords[name] = setTierPublishedPlan(name, { planHash: m.planHash, keepMediaIds: m.keep.map(e => e.mediaId) });
      audit('tier_plan_published', { actorDiscordId: interaction.user.id, node: name, planHash: m.planHash, keepCount: m.stats.keepCount, dropCount: m.stats.dropCount, dropBytes: m.stats.dropBytes, confirmed: !!imp?.requiresConfirm });
    }
  }

  const appliedCount = sub === 'apply' ? names.length - blocked.length : 0;
  const embed = brandedEmbed(sub === 'apply' ? (blocked.length ? COLORS.WARN : COLORS.SUCCESS) : COLORS.INFO)
    .setTitle(sub === 'apply'
      ? (appliedCount ? '🗺️ Tier Plans Published' : '🛑 Tier Apply Held — Confirmation Required')
      : '🗺️ Tier Preview (dry run — nothing written)')
    .setDescription(sub === 'apply'
      ? (appliedCount
        ? 'Manifests are live at `/agent/manifest/:node` — each node\'s sync agent converges on its next run (ignore-first, then prune).'
        : 'No manifest written — every targeted node exceeds an apply guardrail. Re-run with the confirm code shown below.')
      : 'What `/tier apply` would publish. Drops only ever remove edge copies — every title stays on a full master.');
  for (const name of names.slice(0, 12)) {
    embed.addFields(tierManifestField(plans.nodes.find(n => n.name === name), plans.manifests[name], plans.planRecords?.[name], impacts[name] || null, actions[name] || null));
  }
  if (blocked.length) {
    embed.addFields({
      name: '🛑 Held for confirmation',
      value: blocked.map(name => `\`${name}\` → re-run \`/tier apply node:${name} confirm:${impacts[name].confirmCode}\``).join('\n').slice(0, 1024),
      inline: false,
    });
  }
  if (plans.warnings?.length) embed.addFields({ name: '⚠️ Warnings', value: plans.warnings.slice(0, 8).map(w => `• ${w}`).join('\n').slice(0, 1024), inline: false });
  // §1.3 details:true — a per-title change list for a single node (folder, size, score, state,
  // reason). Only makes sense scoped to one node; ask for `node:` when several are in scope.
  if (interaction.options.getBoolean('details')) {
    if (names.length !== 1) {
      embed.addFields({ name: '🔎 Details', value: 'Add `node:<name>` to see the per-title change list for one node.', inline: false });
    } else {
      const name = names[0];
      const detail = renderTierDetailBlock(plans.manifests[name], actions[name]);
      if (detail) embed.addFields({ name: `🔎 ${name} — per-title changes`, value: detail.slice(0, 1024), inline: false });
    }
  }
  return interaction.editReply({ embeds: [embed] });
}

// §1.3 per-title change list for `/tier preview node:<n> details:true`. Groups the plan's titles by
// physical action (download / remove / still-syncing / already-gone) and lists each with its folder,
// size, demand score, and current on-disk state. Fully-synced kept titles are summarized, not listed
// (they're the quiet majority). Capped to fit a Discord field; overflow is counted.
function renderTierDetailBlock(manifest, actions) {
  if (!actions) return null;
  const scoreOf = e => (typeof e.value === 'number' ? e.value : null);
  const line = (e, tag) => {
    const bits = [`${tag} **${(e.title || e.mediaId || '').slice(0, 48)}**`, fmtSpace(e.sizeBytes || 0)];
    if (e.folderId) bits.push(`\`${e.folderId}\``);
    const s = scoreOf(e);
    if (s != null) bits.push(`score ${s.toFixed(3)}`);
    return bits.join(' · ');
  };
  const sections = [
    ['⬇️ download', actions.downloadLocally],
    ['🗑️ remove', actions.removeLocal],
    ['⏳ syncing', actions.keptDownloading],
    ['∅ already gone', actions.alreadyAbsent],
  ];
  const out = [];
  let shown = 0;
  const LIMIT = 18;
  for (const [tag, list] of sections) {
    for (const e of list) {
      if (shown >= LIMIT) { out.push(`…and ${sections.reduce((a, [, l]) => a + l.length, 0) - shown} more`); break; }
      out.push(line(e, tag));
      shown++;
    }
    if (shown >= LIMIT) break;
  }
  const synced = actions.totals.keptSynced;
  if (synced.count) out.push(`✓ ${synced.count} kept title(s) already fully synced (${fmtSpace(synced.bytes)})`);
  return out.length ? out.join('\n') : null;
}

async function handleTierNodeCommand(interaction) {
  if (!(await requireAdmin(interaction))) return;

  // R2.1 multi-folder: `/tier-node folder add|remove|list`.
  if (interaction.options.getSubcommandGroup(false) === 'folder') return handleTierNodeFolderCommand(interaction);

  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const nodes = listTierNodes();
    if (!nodes.length) return interaction.reply({ content: 'No tier nodes yet — `/tier-node add name:<node>` creates one.', ephemeral: true });
    const lines = nodes.map(n => {
      const members = n.access === 'restricted' ? ` · ${listTierNodeMembers(n.name).length} member(s)` : '';
      const plan = getTierPlan(n.name);
      const folders = listTierNodeFolders(n.name);
      const folderNote = folders.length > 1 ? ` · ${folders.length} folders` : '';
      // §1.1 show the CONVERGED hash when the node has confirmed one; otherwise mark it as published-
      // but-pending so "on disk" and "handed to the agent" are never conflated in the list.
      const planNote = plan?.converged
        ? ` · plan \`${plan.converged.planHash}\`${plan.published && plan.published.planHash !== plan.converged.planHash ? ` (published \`${plan.published.planHash}\` pending)` : ''}`
        : plan?.published ? ` · published \`${plan.published.planHash}\` (pending)` : ' · no plan applied';
      // Agent liveness (heartbeat, bumped on every check-in incl. no-op runs) so a healthy idle
      // node reads differently from a stopped/unreachable one.
      const beatAt = plan?.lastHeartbeatAt || plan?.lastAgentReportAt || null;
      const beatNote = beatAt ? ` · agent ${fmtAgo(beatAt)}${plan?.lastErrors?.length ? ' ⚠️' : ''}` : ' · agent never reported';
      const hardwareNote = plan?.lastTelemetry ? ` · ${telemetrySummary(plan.lastTelemetry, fmtSpace)}` : ' · hardware telemetry unavailable';
      return `${n.enabled ? '🟢' : '⚫'} **${n.name}** — ${fmtSpace(n.usable_bytes || 0)}, headroom ${n.headroom_pct}%${n.full ? ', **full master**' : ''}${n.sticky ? ', sticky' : ''} · ${n.access}/${n.demand_source}/${n.transport}${folderNote}${members}${planNote}${beatNote}${hardwareNote}`;
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
    const folders = listTierNodeFolders(name).filter(folder => folder.folderRoot)
      .map(folder => ({ id: folder.folderId || 'CHANGEME_FOLDER_ID', path: folder.folderRoot }));
    if (!folders.length) {
      return interaction.reply({ content: `❌ \`${name}\` has no Syncthing folders. Add each one with \`/tier-node folder add\` before rotating its token.`, ephemeral: true });
    }
    const raw = setTierAgentToken(name);
    audit('tier_agent_token_rotated', { actorDiscordId: interaction.user.id, node: name });
    const botUrl = CONFIG.TUNNEL_DOMAIN ? `https://${CONFIG.TUNNEL_DOMAIN}` : `http://127.0.0.1:${CONFIG.PORT}`;
    // Shown once, so hand over the finished command rather than a token and a documentation hunt.
    const install = tierInstallCommand({ botUrl, node: name, token: raw, folders, syncthingApiKey: 'CHANGEME' });
    const placeholders = folders.some(folder => folder.id === 'CHANGEME_FOLDER_ID') ? ' and folder-ID placeholders' : '';
    return interaction.reply({ content: `🔑 Agent token for \`${name}\` — **shown once**, and it replaces any previous token.\n\nRun this **on that node** after replacing the API-key${placeholders}:\n\`\`\`sh\n${install}\n\`\`\`\nAll ${folders.length} registered folder(s) are included. It installs the agent to \`/opt/tier-agent\`, writes the token to root-only \`/etc/tier-agent.env\`, enables a 15-minute systemd timer, and runs once so you see immediately whether it worked. Add \`TIER_MOUNT_ROOT\`/\`TIER_MOUNT_MARKER\` to the \`env\` list if the media lives on an external drive.`, ephemeral: true });
  }

  // sub === 'add' (also edits an existing node — only supplied options change)
  const usableGb = interaction.options.getInteger('usable_gb');
  const headroomPct = interaction.options.getInteger('headroom_pct');
  const warmDays = interaction.options.getInteger('warm_days');
  const freshDays = interaction.options.getInteger('fresh_days');
  if (usableGb != null && usableGb < 0) return interaction.reply({ content: '❌ `usable_gb` cannot be negative.', ephemeral: true });
  if (headroomPct != null && (headroomPct < 0 || headroomPct > 95)) return interaction.reply({ content: '❌ `headroom_pct` must be between 0 and 95.', ephemeral: true });
  if ([warmDays, freshDays].some(value => value != null && (value < 0 || value > 3650))) return interaction.reply({ content: '❌ `warm_days` and `fresh_days` must be between 0 and 3650.', ephemeral: true });
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
      (() => {
        const folders = listTierNodeFolders(name);
        if (folders.length > 1 || folders.some(f => f.folderId)) return `Folders (${folders.length}): ${folders.map(f => `\`${f.folderId || 'default'}\`→\`${f.folderRoot}\``).join(', ')}`;
        return node.folder_root ? `Folder root \`${node.folder_root}\` — add more with \`/tier-node folder add\` for a multi-folder node.` : '⚠️ No `folder_root`/folders set — the agent needs at least one (`folder_root:` or `/tier-node folder add`).';
      })(),
      node.demand_source === 'tautulli' && !node.tautulli_url ? '⚠️ No Tautulli configured — this node contributes no demand signal (floor + pins only).' : null,
      node.demand_source === 'plex' && !node.plex_url ? '⚠️ `demand_source` is plex but no `plex_url`/`plex_token` set — this node contributes no demand signal until they are.' : null,
      node.demand_source === 'atime' && node.atime_mask ? `atime mask \`${node.atime_mask}\` UTC — reads in that window are treated as Plex maintenance, not watches.` : null,
      node.demand_source === 'atime' && !node.atime_mask ? '💡 Tip: if Plex scheduled tasks read files nightly on this node, set `atime_mask` to that window (UTC) or they will count as watches.' : null,
      created ? `Next: \`/tier-node token name:${name}\` for the agent, then \`/tier preview\`.` : null,
    ].filter(Boolean).join('\n'));
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

// R2.1: `/tier-node folder add|remove|list` — a node's library can span several Receive-Only
// Syncthing folders while staying one budget pool. Legacy single-folder nodes keep working via
// the tier_nodes.folder_root column (surfaced here as the `default` folder).
async function handleTierNodeFolderCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  const name = interaction.options.getString('name', true).toLowerCase();
  if (!getTierNode(name)) return interaction.reply({ content: `❌ Unknown node \`${name}\` — add it first with \`/tier-node add\`.`, ephemeral: true });

  if (sub === 'list') {
    const folders = listTierNodeFolders(name);
    if (!folders.length) return interaction.reply({ content: `\`${name}\` has no folders yet — add one with \`/tier-node folder add\`, or set \`folder_root\` on the node.`, ephemeral: true });
    const lines = folders.map(f => `• \`${f.folderId || '(default / SYNCTHING_FOLDER_ID)'}\` → \`${f.folderRoot}\``);
    return interaction.reply({ embeds: [brandedEmbed(COLORS.INFO).setTitle(`📁 Folders — ${name}`).setDescription(lines.join('\n').slice(0, 4000))], ephemeral: true });
  }

  const folderId = interaction.options.getString('folder_id', true).trim();
  if (sub === 'add') {
    const folderRoot = interaction.options.getString('folder_root', true).trim();
    addTierNodeFolder(name, folderId, folderRoot);
    audit('tier_node_folder_added', { actorDiscordId: interaction.user.id, node: name, folderId });
    const folders = listTierNodeFolders(name);
    return interaction.reply({ content: `✅ Folder \`${folderId}\` → \`${folderRoot}\` set on \`${name}\` (${folders.length} folder(s) total). Re-run \`/tier preview ${name}\` to see the per-folder split.`, ephemeral: true });
  }
  // remove
  const removed = removeTierNodeFolder(name, folderId);
  audit('tier_node_folder_removed', { actorDiscordId: interaction.user.id, node: name, folderId });
  return interaction.reply({ content: removed ? `✅ Folder \`${folderId}\` removed from \`${name}\`.` : `\`${folderId}\` wasn't a folder of \`${name}\`.`, ephemeral: true });
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

  // Server pick from a DM onboarding message (welcome DM or /invite's DM) — stash it for
  // messageCreate to pick up once they reply with their email.
  if (action === 'onboard_server') {
    const server = parts[0] === 'ph' ? 'ph' : 'primary';
    setPendingHomeServer(interaction.user.id, server);
    return interaction.reply({ content: server === 'ph'
      ? '✅ Got it — Philippines server. Now reply to my first message with the email on your Plex account.'
      : '✅ Got it — main (USA) servers. Now reply to my first message with the email on your Plex account.' });
  }

  // Public self-service button from /invite-post — open to everyone, pops an email modal.
  if (action === 'request_access') {
    const existing = getUserByDiscordId(interaction.user.id);
    if (existing && !canonicalizeEmail(existing.email).startsWith('__placeholder__:')) {
      if (existing.invited && existing.overseerr_created) {
        return interaction.reply({ content: `✅ You're already set up with \`${existing.email}\`. Use \`/me\` to check your access, or ask an admin if the email needs changing.`, ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const posted = await postAccessRequestToAdmins(interaction.user, existing.email, existing.home_server || 'primary').catch(() => false);
      return interaction.editReply(posted
        ? `✅ Your pending request for \`${existing.email}\` was posted to the admins again.`
        : '❌ I still could not reach the admin channel. Ask an admin to check `ADMIN_CHANNEL_ID` and the bot\'s channel permissions.');
    }
    // A PH box exists to choose from — ask which server before popping the email modal. Discord
    // modals can't hold a select menu/buttons, so the pick has to happen as its own step first.
    if (phServerConfigured()) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('request_access_server:primary').setLabel('🇺🇸 Main (USA) Servers').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('request_access_server:ph').setLabel('🇵🇭 Philippines Server').setStyle(ButtonStyle.Secondary),
      );
      return interaction.reply({ content: 'Which server are you requesting access to?', components: [row], ephemeral: true });
    }
    return interaction.showModal(requestAccessModal('primary'));
  }

  if (action === 'request_access_server') {
    const server = parts[0] === 'ph' ? 'ph' : 'primary';
    return interaction.showModal(requestAccessModal(server));
  }

  if (['plex_approve', 'plex_approve_ts', 'plex_deny', 'overseerr_approve', 'overseerr_deny', 'request_approve', 'request_approve_az', 'request_deny', 'trust_undo', 'pm_retry', 'pm_clear', 'pm_ignore', 'pm_clearstuck', 'pm_clearfinished', 'grab_dl', 'grab_all', 'grab_cancel', 'grab_retry', 'season_grab', 'adopt_do', 'adopt_bulk', 'adopt_cancel'].includes(action) && !isAdminInteraction(interaction)) {
    return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
  }

  if (action === 'season_grab') return handleSeasonPackGrab(interaction, parts[0], parts[1]);

  // One-click undo for an auto-approved request (#80) — pulls it back the same way
  // /request-cancel does, and resets the requester's trust the same as a manual denial would.
  if (action === 'trust_undo') {
    const [requestId, targetDiscordId] = parts;
    await interaction.deferUpdate();
    if (requestId) {
      try { await deleteOverseerrRequest(requestId); }
      catch (err) {
        audit('external_api_error', { actorDiscordId: interaction.user.id, provider: 'overseerr', action: 'trust_undo', requestId, error: err.message });
        return interaction.followUp({ content: `❌ Couldn't undo — Seerr refused the delete (likely already downloading): ${err.response?.data?.message || err.message}`, ephemeral: true });
      }
    }
    db.prepare("UPDATE requests SET status = 'cancelled' WHERE overseerr_request_id = ?").run(requestId || null);
    resetTrustScore(targetDiscordId);
    audit('media_request_auto_approve_undone', { actorDiscordId: interaction.user.id, targetDiscordId, requestId });
    await dmUser(targetDiscordId, { embeds: [brandedEmbed(COLORS.WARN)
      .setTitle('Request Undone')
      .setDescription('An admin undid one of your auto-approved requests. Your trusted-requester standing was reset — future requests go through the normal approval gate again.')] });
    return interaction.editReply({ embeds: [brandedEmbed(COLORS.WARN)
      .setTitle('↩️ Auto-Approval Undone')
      .setDescription(`Undone by <@${interaction.user.id}>. <@${targetDiscordId}>'s trust was reset.`)], components: [] });
  }

  if (action === 'plex_approve' || action === 'plex_approve_ts' || action === 'plex_deny') {
    const targetDiscordId = parts[0];
    if (plexGateInFlight.has(targetDiscordId)) {
      return interaction.reply({ content: '⏳ Already being processed by another click — hang tight.', ephemeral: true });
    }
    plexGateInFlight.add(targetDiscordId);
    try {
      if (action === 'plex_approve' || action === 'plex_approve_ts') {
        await interaction.deferUpdate();
        const user = getUserByDiscordId(targetDiscordId);
        if (!user) return interaction.editReply({ content: 'User not found.', components: [] });
        const wantsTailscale = action === 'plex_approve_ts';
        if (wantsTailscale && (user.home_server || 'primary') !== 'ph') {
          setUserHomeServer(targetDiscordId, 'ph');
          audit('user_home_server_changed', { actorDiscordId: interaction.user.id, targetDiscordId, from: user.home_server || 'primary', to: 'ph' });
        }
        const discordUser = await client.users.fetch(targetDiscordId).catch(() => null);
        const { plexStatus, seerrStatus, plexOk, seerrOk } = await applyFullChainLink(targetDiscordId, user.email, discordUser?.username);
        const complete = plexOk && seerrOk;
        // Cover both paths onto PH: the admin explicitly clicking "Approve + Tailscale" and a
        // requester who already self-selected Philippines before plain Approve — either way they
        // need the Tailscale instructions, since the PH box is CGNAT'd and unreachable otherwise.
        const isPh = wantsTailscale || (getUserByDiscordId(targetDiscordId)?.home_server || 'primary') === 'ph';
        audit('admin_command_executed', { actorDiscordId: interaction.user.id, targetDiscordId, command: wantsTailscale ? 'plex_approve_ts' : 'plex_approve', plexOk, seerrOk });
        const tailscaleNote = isPh && CONFIG.TAILSCALE_ENABLED
          ? `\n\n🌐 **You're on the Philippines/travel server**, which sits behind CGNAT with no IPv6 — normal Plex remote access can't reach it. To watch, you'll need **Tailscale**:\n1. Install it: ${CONFIG.TAILSCALE_SETUP_URL}\n2. An admin will send you a tailnet invite separately — accept it once it arrives.\n3. In Plex, add the server manually using ${CONFIG.TAILSCALE_SERVER_ADDRESS ? `\`${CONFIG.TAILSCALE_SERVER_ADDRESS}\`` : 'the tailnet address an admin sends you'}.`
          : '';
        await dmUser(targetDiscordId, { embeds: [brandedEmbed(plexOk ? COLORS.SUCCESS : COLORS.WARN)
          .setTitle(plexOk ? '🎉 You\'re In!' : '⚠️ Your Setup Needs Attention')
          .setDescription((plexOk
            ? `Your access request was approved. Check \`${user.email}\` for the Plex invite, then use \`/help\` here to see what the bot can do.`
            : `The Plex invite to \`${user.email}\` failed. An admin has the failure details and can retry your approval.`) + tailscaleNote)] });
        await interaction.editReply({ embeds: [brandedEmbed(complete ? COLORS.SUCCESS : COLORS.WARN)
          .setTitle(complete ? '✅ Access Approved' : '⚠️ Access Setup Incomplete')
          .addFields(
            { name: 'User', value: `<@${targetDiscordId}>`, inline: true },
            { name: 'Plex', value: plexStatus, inline: true },
            { name: 'Seerr', value: seerrStatus, inline: true },
            ...(isPh ? [{ name: 'Server', value: '🇵🇭 Philippines', inline: true }] : []),
          )], components: complete ? [] : interaction.message.components });
        return;
      }
      // plex_deny
      removeUser(targetDiscordId);
      audit('admin_command_executed', { actorDiscordId: interaction.user.id, targetDiscordId, command: 'plex_deny' });
      await dmUser(targetDiscordId, { embeds: [brandedEmbed(COLORS.DANGER)
        .setTitle('Access Request Declined')
        .setDescription('Sorry — your Plex access request was declined. Reach out to an admin if you think this was a mistake.')] });
      await interaction.update({ embeds: [brandedEmbed(COLORS.DANGER)
        .setTitle('🚫 Access Declined')
        .setDescription(`Declined <@${targetDiscordId}>`)], components: [] });
      return;
    } finally {
      plexGateInFlight.delete(targetDiscordId);
    }
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
    const actor = { kind: 'discord', id: interaction.user.id, label: interaction.user.tag || interaction.user.username || interaction.user.id };
    const result = await denyGatedRequest({ nonce: parts[0], actor });
    if (!result.ok) return interaction.update({ content: 'ℹ️ Already handled (or expired).', components: [] });
    const pending = result.pending;
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
    revokeMemberRole(discordId).catch(() => {});
    audit('user_unlinked', { actorDiscordId: interaction.user.id, targetDiscordId: discordId, email: user.email, removed, source: 'revoke_plex_button' });
    return interaction.editReply({ content: `🗑️ Revoked Plex for <@${discordId}> (${user.email}) and removed from DB. Removed: ${removed ? 'yes' : 'no'}.`, components: [] });
  }

  if (['relgroup_approve', 'relgroup_dismiss'].includes(action)) {
    if (!isAdminInteraction(interaction)) return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    const group = parts[0];
    const row = getReleaseGroupSighting(group);
    if (!row) return interaction.reply({ content: '❌ No record of this release group anymore.', ephemeral: true });

    if (action === 'relgroup_dismiss') {
      dismissReleaseGroupSuggestion(group);
      audit('release_group_blocklist_dismissed', { actorDiscordId: interaction.user.id, group, deadClearCount: row.dead_clear_count });
      return interaction.reply({ content: `✅ Dismissed — won't suggest blocklisting \`${group}\` again unless it's reset.`, ephemeral: true });
    }

    if (!CONFIG.SONARR_URL) return interaction.reply({ content: '❌ SONARR_URL is not configured.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const existingFormats = await listSonarrCustomFormats();
      const cfName = `Dead release group — ${group}`;
      let cf = existingFormats.find(f => f.name === cfName);
      if (!cf) cf = await createSonarrCustomFormat(cfName, `\\b${group}\\b`);
      await scoreSonarrCustomFormatInAllProfiles(cf.id, CONFIG.RELEASE_GROUP_BLOCKLIST_SCORE);
      markReleaseGroupBlocklisted(group, cf.id);
      audit('release_group_blocklisted', { actorDiscordId: interaction.user.id, group, customFormatId: cf.id, score: CONFIG.RELEASE_GROUP_BLOCKLIST_SCORE, deadClearCount: row.dead_clear_count });
      return interaction.editReply({ content: `🚫 Blocklisted \`${group}\` — created/updated Sonarr Custom Format \`${cfName}\` (id ${cf.id}) and scored it ${CONFIG.RELEASE_GROUP_BLOCKLIST_SCORE} in every quality profile.` });
    } catch (err) {
      audit('external_api_error', { actorDiscordId: interaction.user.id, provider: 'sonarr', action: 'release_group_blocklist', group, error: err.message });
      return interaction.editReply({ content: `❌ Failed to blocklist \`${group}\`: ${err.message}` });
    }
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
        .setDescription(`${result.detail}\nAdded by <@${interaction.user.id}>. Public indexers get ${escalationDelayLabel()} first; the AvistaZ fallback ${row.pre_authorized ? `is pre-authorized and ${preAuthOutcomeLabel(row.media_type)}` : 'will ask before firing'} if nothing lands.`)], components: [] });
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
  // "Grab Everything": send every non-overlapping release in the stashed plan, so a series whose
  // best AvistaZ match is one season (or one episode) doesn't need N prompts that never come.
  if (action === 'grab_all') {
    const offer = takeGrabOffer(parts[0]);
    if (!offer) return interaction.update({ content: 'ℹ️ Already handled (or expired).', components: [] });
    const candidates = offer.candidates || [];
    // Re-plan against live state rather than trusting the stashed indexes: the offer survives
    // restarts, and anything grabbed since it was posted must not be grabbed twice.
    const allowance = grabDailyAllowance();
    if (allowance.exhausted) {
      restashGrabOffer(parts[0], offer);
      return interaction.reply({ content: `❌ Daily AvistaZ allowance is used up (${CONFIG.AVISTAZ_DAILY_GRAB_LIMIT}/day) — the buttons will work again tomorrow (UTC).`, ephemeral: true });
    }
    const plan = buildSeriesPlan({ candidates, mediaType: offer.mediaType, season: offer.season ?? null, allowance, aliases: offer.aliases });
    if (!plan) {
      // A null plan is not always "nothing left": buildSeriesPlan also returns null when
      // GRAB_TV_COMPLETE is off or the day's budget is spent. Only the first case means the
      // offer is finished — in the others the numbered Download buttons are still useful, so
      // the offer goes back rather than being consumed by a click that grabbed nothing.
      if (!CONFIG.GRAB_TV_COMPLETE || seriesGrabBudget(allowance) < 1) {
        restashGrabOffer(parts[0], offer);
        return interaction.reply({
          content: CONFIG.GRAB_TV_COMPLETE
            ? `❌ No room in today's AvistaZ budget for a bulk grab (${allowance.remaining} left). The numbered Download buttons still work.`
            : '❌ Whole-series grabs are disabled (`GRAB_TV_COMPLETE=false`). The numbered Download buttons still work.',
          ephemeral: true,
        });
      }
      return interaction.update({ embeds: [brandedEmbed(COLORS.INFO)
        .setTitle(`ℹ️ Nothing Left to Grab — ${offer.title}`)
        .setDescription('Every release from this search is already downloading or imported.')], components: [] });
    }
    await interaction.deferUpdate();
    await interaction.editReply({ embeds: [brandedEmbed(COLORS.INFO)
      .setTitle(`⏳ Grabbing ${plan.picks.length} Releases — ${offer.title}`)
      .setDescription(`Started by <@${interaction.user.id}>, covering **${plan.coverage}**. Sending them to the seedbox one at a time — a summary follows here.`)], components: [] });
    const outcome = await executeSeriesGrab(plan.picks, {
      mediaId: offer.mediaId || null, mediaType: offer.mediaType, title: offer.title,
      discordId: offer.discordId, origin: `${offer.origin || 'manual'}-all`, actorDiscordId: interaction.user.id,
    });
    const after = grabDailyAllowance();
    const body = `${seriesGrabSummary(outcome, { planned: plan.picks.length, trimmed: plan.trimmed })}\nI'll watch each one, copy it home when it finishes, and hand it to ${offer.mediaType === 'movie' ? 'Radarr' : 'Sonarr'} for import.${after.limited ? `\nDownloads remaining today: **${after.remaining}**` : ''}`;
    const summary = { embeds: [brandedEmbed(outcome.sent.length ? (outcome.failed.length ? COLORS.WARN : COLORS.SUCCESS) : COLORS.DANGER)
      .setTitle(`🔐 Whole-Series Grab — ${offer.title}`.slice(0, 256))
      .setDescription(body.slice(0, 4000))], components: [] };
    // A long plan can outlive the 15-minute interaction token; fall back to a fresh post.
    return interaction.editReply(summary).catch(() => notifyChannel('downloads', summary));
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
      if (result.needsSeriesPick) {
        const nonce = stashGrabOffer({ kind: 'adopt-series-pick', torrent, target, discordId: offer.discordId, origin: offer.origin, candidates: result.candidates });
        const options = result.candidates.map(c => ({
          label: `${c.title}${c.year ? ` (${c.year})` : ''}`.slice(0, 100),
          value: String(c.id),
          description: c.tvdbId ? `TVDB ${c.tvdbId}` : undefined,
        }));
        return interaction.editReply({ embeds: [brandedEmbed(COLORS.WARN)
          .setTitle(`🧭 Which Series? — ${String(torrent.name).slice(0, 180)}`.slice(0, 256))
          .setDescription(`${result.why}. Pick the right one below — nothing is adopted until you do.`)],
        components: [
          new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`adopt_series_pick:${nonce}`).setPlaceholder('Pick the series…').addOptions(...options)),
          new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`adopt_cancel:${nonce}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)),
        ] });
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
    if (outcome.ambiguous.length) {
      lines.push('', `**${outcome.ambiguous.length} matched multiple Sonarr series — needs a pick:**`);
      for (const a of outcome.ambiguous.slice(0, 8)) lines.push(`• ${String(a.name).slice(0, 100)} (${a.candidates.length} matches)`);
      if (outcome.ambiguous.length > 8) lines.push(`…and ${outcome.ambiguous.length - 8} more.`);
      lines.push('Adopt these one at a time with `/rtorrent adopt search:"..."` so the picker can show you the matches.');
    }
    if (outcome.failed.length) {
      lines.push('', `**${outcome.failed.length} failed:**`);
      for (const f of outcome.failed.slice(0, 8)) lines.push(`• ${String(f.name).slice(0, 80)} — ${String(f.why).slice(0, 220)}`);
      if (outcome.failed.length > 8) lines.push(`…and ${outcome.failed.length - 8} more (see the audit log).`);
      lines.push('Re-running the same `/rtorrent adopt` only offers what\'s still untracked.');
    }
    const summary = { embeds: [brandedEmbed((outcome.failed.length || outcome.ambiguous.length) ? COLORS.WARN : COLORS.SUCCESS)
      .setTitle(`🧲 Bulk Adoption ${(outcome.failed.length || outcome.ambiguous.length) ? 'Finished With Follow-ups' : 'Complete'}`)
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
    return interaction.editReply({ content: `📤 Evicted **${staged.title}** — freed ${fmtSpace(staged.size_bytes)} on the travel server. The Main copies are untouched; \`/stage\` brings it back anytime.`, components: [] });
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

    const pending = db.prepare('SELECT * FROM pending_deletions WHERE media_id = ?').get(mediaId);
    const result = await executeDeletion(mediaId, title, { actorDiscordId: interaction.user.id, requestorId, reason: 'user_button', arrSource: pending?.arr_source || null });
    if (result.outcome === 'error') return interaction.editReply({ content: `❌ Delete failed for **${title}**: ${result.error}`, components: [] });
    if (result.outcome === 'not_found') { markPendingDeletion(mediaId, 'cancelled'); return interaction.editReply({ content: `⚠️ Could not find **${title}** in Radarr/Sonarr — nothing to delete.`, components: [] }); }
    if (result.outcome === 'ambiguous') { markPendingDeletion(mediaId, 'cancelled'); return interaction.editReply({ content: `🛑 **${title}** exists in more than one Radarr library and this older action did not preserve the edition. Nothing was deleted; wait for a new edition-specific prompt.`, components: [] }); }
    if (result.outcome === 'scope_required') { markPendingDeletion(mediaId, 'cancelled'); return interaction.editReply({ content: `🛑 TV cleanup needs an exact episode, season, or whole-series scope. This playback action only identified the show, so nothing was deleted.`, components: [] }); }
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

function dashboardActor(req) {
  return { actor: 'dashboard', actorIp: req.ip || req.socket.remoteAddress || 'unknown' };
}

function dashboardGateActor(req) {
  const session = readCookie(req, 'dm_session');
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const id = session ? `session:${sha256(session).slice(0, 12)}` : `header:${ip}`;
  return { kind: 'dashboard', id, label: `Dashboard operator ${id}` };
}

function dashboardGateResponse(result, operation) {
  if (result.error === 'already_handled') return { ok: false, error: 'This request was already handled or expired.', retryable: false };
  if (!result.ok) {
    const request = result.requestId == null ? '' : `Seerr accepted request #${result.requestId}, but `;
    return { ok: false, error: `${request}${result.error || 'the request failed'}`, retryable: !!result.restashed };
  }
  if (operation === 'deny') return { ok: true, message: `${result.pending.label} was denied.` };
  const quota = result.quotaWarning ? ` Quota warning: ${result.quotaWarning}` : '';
  if (result.collision) return { ok: true, message: `${result.pending.label} was already requested; the requester is subscribed.${quota}` };
  return { ok: true, message: `Seerr request #${result.requestId} was created for ${result.pending.label}.${quota}` };
}

function dashboardActionError(err) {
  const data = err?.response?.data;
  if (typeof data === 'string') return data;
  if (data?.message) return data.message;
  if (data != null) return JSON.stringify(data);
  return err?.message || String(err);
}

let httpServer = null;

// Requests the requester still cannot watch in full. Two distinct kinds, deliberately in one list:
// a request that never became available at all, and a series Seerr calls "available" that is in
// fact missing aired episodes — the second is invisible everywhere else in the bot, because one
// imported episode flips a whole show to ✅.
//
// Sonarr work is bounded: the series list is one call, and episodes are only fetched for series
// whose own statistics already show a shortfall, capped per render. A dashboard page load must not
// turn into a hundred API calls.
const INCOMPLETE_SERIES_FETCH_CAP = 12;

async function gatherIncompleteRequests({ queue = [], grabJobs = [], escalations = [], now = Date.now() } = {}) {
  const openRequests = db.prepare(`
    SELECT * FROM requests
     WHERE status NOT IN ('available', 'declined', 'cancelled')
     ORDER BY id DESC LIMIT 40`).all();
  // episode_recovery is created by the worker's ensureSchema, which only runs when that worker
  // starts — so the table may legitimately not exist yet.
  const hasRecoveryTable = !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'episode_recovery'").get();
  const recoveryRows = hasRecoveryTable
    ? db.prepare('SELECT * FROM episode_recovery WHERE resolved_at IS NULL AND ignored_at IS NULL LIMIT 200').all()
    : [];
  const ctx = { queue: queue || [], grabJobs, escalations, recoveryRows };
  const rows = [];
  const seenTvdb = new Set();
  const priority = mediaPriorityMap();

  if (CONFIG.SONARR_URL) {
    const requestedTvdbIds = listRequestedTvdbIds();
    const series = await listSonarrSeries();
    const candidates = (series || [])
      .filter(entry => requestedTvdbIds.has(Number(entry.tvdbId)))
      .filter(entry => {
        const stats = entry.statistics || {};
        return Number(stats.episodeFileCount || 0) < Number(stats.episodeCount || 0);
      })
      .slice(0, INCOMPLETE_SERIES_FETCH_CAP);
    const episodeLists = await Promise.all(candidates.map(entry => getSeriesEpisodes(entry.id).catch(() => [])));
    candidates.forEach((entry, index) => {
      const episodes = episodeLists[index];
      const summary = summarizeSeriesGaps({ series: entry, episodes, now });
      if (!summary.airedMissing) return;
      seenTvdb.add(Number(entry.tvdbId));
      const activity = describeActivity(ctx, { tvdbId: entry.tvdbId, title: entry.title });
      const key = priorityKey({ tvdbId: entry.tvdbId });
      const rank = priority.get(key);
      const searchedAt = getSeasonSearchTimes(entry.id);
      const searchActions = summary.seasons.map(season => {
        const missingEpisodes = episodes.filter(ep => Number(ep.seasonNumber) === season.season && !ep.hasFile && ep.monitored
          && Date.parse(ep.airDateUtc || ep.airDate || '') <= now);
        if (missingEpisodes.length === 1) {
          return { label: `Search S${pad(season.season)}E${pad(missingEpisodes[0].episodeNumber)} now`, url: '/admin/action/search', body: { kind: 'episode', seriesId: entry.id, episodeId: missingEpisodes[0].id } };
        }
        const { cooling, nextEligible } = seasonSearchCooldown(searchedAt[season.season], now);
        // A cooling season isn't unclickable — an admin who's just watched a season stall for
        // days may reasonably want to try again right now rather than wait out the backoff, so
        // the button stays enabled and passes force:true instead of disabling.
        return {
          label: cooling ? `Search S${pad(season.season)} now (override cooldown)` : `Search S${pad(season.season)} now`,
          url: '/admin/action/search',
          body: { kind: 'season', seriesId: entry.id, seasonNumber: season.season, force: cooling },
          title: cooling ? `Normally eligible ${new Date(nextEligible).toISOString()} — this bypasses that cooldown/backoff.` : '',
        };
      });
      rows.push({
        state: activity.state,
        title: `📺 ${summary.title}`,
        sub: `${describeGaps(summary)} — ${activity.note}${rank != null ? ` — pinned #${rank}` : ''}`,
        right: `${summary.airedMissing} missing`,
        pct: summary.pct,
        missing: summary.airedMissing,
        actions: [...searchActions, { label: rank != null ? 'Unpin' : 'Pin', url: '/admin/action/priority', body: { operation: rank != null ? 'unpin' : 'pin', key, mediaType: 'tv', title: summary.title } }],
      });
    });
  }

  for (const request of openRequests) {
    const tvdbId = /^tvdb:(\d+)$/.exec(request.media_id || '')?.[1];
    // A series already covered by the Sonarr pass above would otherwise appear twice.
    if (tvdbId && seenTvdb.has(Number(tvdbId))) continue;
    const tmdbId = /^tmdb:(\d+)$/.exec(request.media_id || '')?.[1];
    const activity = describeActivity(ctx, { tvdbId: tvdbId ? Number(tvdbId) : null, tmdbId: tmdbId ? Number(tmdbId) : null, title: request.title });
    const age = fmtAgo(sqliteUtcMs(request.created_at));
    rows.push({
      state: request.status === 'failed' ? 'down' : activity.state,
      title: `${mediaTypeEmoji(request.media_type, request.is_4k)} ${request.title}`,
      sub: `${requestStatusBadge(request.status)} · requested ${age} · ${activity.note}`,
      right: request.requested_by_discord_id ? `by ${request.requested_by_discord_id}` : '',
      missing: 0,
      actions: request.media_id ? [{ label: priority.has(request.media_id) ? 'Unpin' : 'Pin', url: '/admin/action/priority', body: { operation: priority.has(request.media_id) ? 'unpin' : 'pin', key: request.media_id, mediaType: request.media_type, title: request.title } }] : [],
    });
  }
  return rankIncomplete(rows);
}

function seasonAlertDashboardItems(rows = []) {
  return rows.map(item => ({
    state: 'skip',
    title: `${item.seriesTitle || `Sonarr series ${item.seriesId}`} S${pad(item.seasonNumber)}`,
    sub: `alerts stood down after ${item.attemptCount} identical no-grab results · ${item.missingCount ?? '?'} aired missing · ${item.releaseCount == null ? 'release count unavailable' : `${item.releaseCount} interactive release(s)`}`,
    right: item.lastAttemptedAt ? `last tried ${fmtAgo(item.lastAttemptedAt)}` : '',
    actions: [{ label: 'Re-arm alerts', url: '/admin/action/search', body: { kind: 'rearm-alert', seriesId: item.seriesId, seasonNumber: item.seasonNumber } }],
  }));
}

function startExpressServer() {
  // Shared plumbing (x-powered-by, trust proxy, the global JSON body parser) lives in the
  // src/app.js factory so it can be exercised with real HTTP requests on an ephemeral port
  // without booting Discord — see scripts/tests/app-factory.test.js. Route registration below is
  // unchanged; only the app's own setup moved.
  const app = createApp({ trustProxy: !!CONFIG.TRUST_PROXY, skipJsonPaths: ['/agent/', '/webhook/tautulli'] });
  const upload = multer({ limits: { fileSize: 5 * 1024 * 1024, files: 5 } });
  // Agent reports can carry a full atime inventory (thousands of file rows), so /agent/ gets a
  // larger JSON limit than the webhook/dashboard routes. Parsing is applied per-route (after
  // tierAgentAuth) below instead of here, so an unauthenticated caller can't force a 25 MB parse.
  const agentJsonParser = bodyParser.json({ limit: '25mb' });
  const tautulliJsonParser = bodyParser.json({ limit: '1mb' });
  const webhookBodyConcurrencyLimiter = createBodyConcurrencyLimiter({
    limit: CONFIG.WEBHOOK_BODY_MAX_CONCURRENT,
    scope: 'webhook body',
  });
  const agentBodyConcurrencyLimiter = createBodyConcurrencyLimiter({
    limit: CONFIG.AGENT_REPORT_MAX_CONCURRENT,
    scope: 'agent report body',
  });

  registerHealthAndDownloadRoutes(app, {
    config: CONFIG,
    db,
    gatherHealth,
    httpRateLimitKey,
    cleanExpiredTokens,
    getDownloadRecordByRawToken,
    sha256,
    resolveSafeMediaPath,
    notifyChannel,
    mimeFor,
    audit,
  });

  const webhookHandlers = createWebhookHandlers({
    config: CONFIG,
    audit,
    webhookEventKey,
    recordWebhookEvent,
    forgetWebhookEvent,
    webhookUserKey,
    resolvePlexWebhookEmail,
    handleOverseerrWebhook,
    handlePlexWebhook,
    handleTautulliWebhook,
    log,
  });
  app.post('/webhook/overseerr', requireWebhookSecret(() => CONFIG.WEBHOOK_SECRET), webhookBodyConcurrencyLimiter, upload.any(), webhookHandlers.overseerr);

  app.post('/webhook/plex', requireWebhookSecret(() => CONFIG.WEBHOOK_SECRET, { allowQuery: true }), webhookBodyConcurrencyLimiter, upload.any(), webhookHandlers.plex);

  // Tautulli sends JSON, so exclude this path from createApp's global parser and attach the parser
  // only after its secret and concurrency admission checks. Invalid internet traffic is rejected
  // without spending JSON parsing work or occupying an authenticated body-processing slot.
  app.post('/webhook/tautulli',
    requireWebhookSecret(() => CONFIG.TAUTULLI_WEBHOOK_SECRET, { header: 'x-tautulli-secret' }),
    webhookBodyConcurrencyLimiter,
    tautulliJsonParser,
    webhookHandlers.tautulli);

  // ---- Regional tiering: per-node sync-agent API ----
  const tierAgentAuth = createTierAgentAuth({ getTierAgentTokenHash, sha256, safeEqual, audit });

  // One-liner install for a node's sync agent. Both routes sit behind the node's own bearer token:
  // no new public surface, and a token that can already read the manifest can hardly be harmed by
  // also reading the agent source. The token itself is never embedded here — the bot only stores
  // its hash — so the installer takes it from the environment of the shell running the pipe.
  app.get('/agent/install/:node', tierAgentAuth, (req, res) => {
    const node = String(req.params.node).toLowerCase();
    const template = fs.readFileSync(path.join(__dirname, 'agent', 'install.sh.tmpl'), 'utf8');
    const botUrl = CONFIG.TUNNEL_DOMAIN ? `https://${CONFIG.TUNNEL_DOMAIN}` : `http://127.0.0.1:${CONFIG.PORT}`;
    audit('tier_agent_installer_fetched', { node, ip: req.ip || req.socket.remoteAddress || 'unknown' });
    res.type('text/plain').send(template.split('__NODE__').join(node).split('__BOT_URL__').join(botUrl));
  });

  app.get('/agent/source/:node', tierAgentAuth, (_req, res) => {
    res.type('text/plain').send(fs.readFileSync(path.join(__dirname, 'agent', 'agent.js'), 'utf8'));
  });

  app.get('/agent/manifest/:node', tierAgentAuth, (req, res) => {
    const raw = getSetting(`tier_manifest:${String(req.params.node).toLowerCase()}`);
    if (!raw) return res.status(404).json({ error: 'No manifest published for this node — run /tier apply.' });
    res.type('json').send(raw);
  });

  const tierAgentReportLimiter = createTierAgentReportLimiter({ limit: CONFIG.AGENT_REPORT_MAX_PER_MINUTE });
  app.post('/agent/report/:node', tierAgentAuth, tierAgentReportLimiter, agentBodyConcurrencyLimiter, agentJsonParser, (req, res) => {
    const node = String(req.params.node).toLowerCase();
    const body = req.body || {};
    const previousTelemetryLevel = getTierPlan(node)?.lastTelemetryLevel || 'unknown';
    const telemetry = sanitizeNodeTelemetry(body.telemetry);
    const telemetryHealth = assessNodeTelemetry(telemetry, { warnC: CONFIG.NODE_TEMP_WARN_C, criticalC: CONFIG.NODE_TEMP_CRITICAL_C });
    const notifyTelemetryTransition = () => {
      if (!telemetry || telemetryHealth.level === previousTelemetryLevel) return;
      if (!['warn', 'critical'].includes(telemetryHealth.level) && !['warn', 'critical'].includes(previousTelemetryLevel)) return;
      const recovered = telemetryHealth.level === 'ok';
      notifyChannel('system', { embeds: [brandedEmbed(recovered ? COLORS.SUCCESS : telemetryHealth.level === 'critical' ? COLORS.DANGER : COLORS.WARN)
        .setTitle(`${recovered ? '✅' : telemetryHealth.level === 'critical' ? '🔥' : '⚠️'} Edge node hardware — ${node}`)
        .setDescription(`${telemetryHealth.reason}\n${telemetrySummary(telemetry, fmtSpace)}${recovered ? `\nRecovered from ${previousTelemetryLevel}.` : ''}`)] });
      audit('tier_agent_telemetry_transition', { node, from: previousTelemetryLevel, to: telemetryHealth.level, temperatureC: telemetry.temperatureC });
    };
    // Heartbeat fast-path: the agent posts { heartbeat:true } on a clean no-op run (plan + inventory
    // unchanged). It's proof of life with nothing to store or converge — bump the timestamp and
    // clear any stale errors (a clean no-op only happens AFTER a healthy convergence, so lingering
    // errors would be misleading). Full reports go through recordTierAgentReport below, which also
    // bumps the heartbeat; the drive-missing branch bumps it too but with its mount errors.
    if (body.heartbeat && !body.driveMissing) {
      recordTierAgentHeartbeat(node, { errors: [], telemetry, telemetryLevel: telemetryHealth.level });
      notifyTelemetryTransition();
      audit('tier_agent_heartbeat', { node, planHash: body.planHash || null });
      return res.json({ ok: true, heartbeat: true });
    }
    const errors = Array.isArray(body.errors) ? body.errors.slice(0, 10).map(e => String(e).slice(0, 300)) : [];
    // Per-file prune skips are reported separately from errors: the file stays ignored either way,
    // so the node still reached its plan. Counting them as errors used to hold the node at
    // "published but not converged" forever — the agent advances its own plan hash after a skip and
    // never retries, so nothing could ever clear it, and the lost converged state also cost the
    // node its hysteresis keep-set on every subsequent plan. Surfaced, never convergence-blocking.
    const skipped = Array.isArray(body.skipped) ? body.skipped.slice(0, 10).map(e => String(e).slice(0, 300)) : [];
    // Mount guard: when the node's external media drive is absent the agent refuses to run and
    // reports driveMissing WITHOUT an inventory — so the empty-directory walk can never wipe the
    // node's known contents (which would trigger a full re-seed onto the wrong disk). Handle it
    // before the inventory block, alert only on the state transition, and never post a "converged"
    // success for a run that did nothing.
    const mountKey = `tier_mount_state:${node}`;
    if (body.driveMissing) {
      const prev = getSetting(mountKey);
      setSetting(mountKey, 'missing');
      const mountErrors = (Array.isArray(body.mountErrors) ? body.mountErrors : []).slice(0, 8).map(e => String(e).slice(0, 300));
      // Proof of life (the agent ran and reached us) but a DEGRADED run — persist the mount errors
      // as the plan's error state so the status surfaces read warn/⚠️, not a healthy "checked in
      // recently / ok". Without this the heartbeat bump alone would mask a repeatedly drive-missing
      // node as healthy. Cleared on recovery, when the agent's next full report reports no errors.
      recordTierAgentHeartbeat(node, { errors: mountErrors.length ? mountErrors : ['media drive missing'], telemetry, telemetryLevel: telemetryHealth.level });
      notifyTelemetryTransition();
      audit('tier_agent_drive_missing', { node, mountErrors: mountErrors.join('; ').slice(0, 500) || undefined });
      if (prev !== 'missing') {
        notifyChannel('system', { embeds: [brandedEmbed(COLORS.DANGER)
          .setTitle(`🟠 ${node} media drive missing`)
          .setDescription([
            'The external media drive is not mounted where the tier agent expects it.',
            '**Syncthing convergence has been suspended** — the agent will not write, prune, or re-inventory until the drive is back.',
            mountErrors.length ? `\n${mountErrors.slice(0, 6).map(e => `• ${e}`).join('\n')}` : null,
          ].filter(Boolean).join('\n').slice(0, 4000))] });
      }
      return res.json({ ok: true, acknowledged: 'drive-missing' });
    }
    if (getSetting(mountKey) === 'missing') {
      setSetting(mountKey, 'ok');
      audit('tier_agent_drive_recovered', { node });
      notifyChannel('system', { embeds: [brandedEmbed(COLORS.SUCCESS)
        .setTitle(`🟢 ${node} media drive back online`)
        .setDescription('The external media drive is mounted again and the tier agent has resumed converging Syncthing.')] });
    }
    // The atime demand signal (§3.2a): full local inventory snapshots replace the stored set.
    // An EMPTY array is still a snapshot (the node may have pruned its last media file) —
    // only an absent field means "no inventory in this report". When the node has an
    // atime_mask, suspect (maintenance-window) atimes are laundered against the previously
    // stored rows BEFORE the replace, so the DB always holds the last plausible human read.
    let inventoryStored = false;
    if (Array.isArray(body.inventory)) {
      try {
        let files = body.inventory.slice(0, 200000);
        const mask = parseAtimeMask(getTierNode(node)?.atime_mask);
        if (mask) files = maskSuspectAtimes(files, listTierNodeFiles(node), mask);
        replaceTierNodeFiles(node, files);
        inventoryStored = true;
      } catch (err) {
        errors.push(`inventory store failed: ${err.message}`);
      }
    }
    // §1.1 The agent has reported — record it (any run, converged or not) so status surfaces can
    // tell "healthy idle" from "stopped / net down". Then advance `converged` ONLY when the agent
    // says it converged, reported no errors, AND the hash matches what we actually published — a
    // report for a stale/mismatched plan, or one carrying errors, must never mark convergence.
    recordTierAgentReport(node, { inventoryStored, errors, telemetry, telemetryLevel: telemetryHealth.level });
    notifyTelemetryTransition();
    const publishedHash = getTierPlan(node)?.published?.planHash || null;
    const converged = body.converged === true && errors.length === 0 && !!body.planHash && body.planHash === publishedHash;
    if (converged) markTierPlanConverged(node, { planHash: body.planHash });
    audit('tier_agent_report', { node, planHash: body.planHash || null, publishedHash, converged, bytesFreed: body.bytesFreed || 0, droppedCount: (body.dropped || []).length, inventoryCount: Array.isArray(body.inventory) ? body.inventory.length : 0, errors: errors.join('; ').slice(0, 500) || undefined, skipped: skipped.join('; ').slice(0, 500) || undefined });
    if ((body.bytesFreed || 0) > 0 || errors.length || skipped.length) {
      // Report the honest state: "converged" only when the checks above passed; otherwise say the
      // agent has published-but-pending or hit errors, so a mismatched/failed run can't masquerade
      // as a clean convergence.
      const statusLine = errors.length
        ? `⚠️ Plan \`${body.planHash || '?'}\` reported with errors — not marked converged.`
        : converged
          ? `✅ Plan \`${body.planHash}\` converged.`
          : `📤 Plan \`${body.planHash || '?'}\` reported${publishedHash && body.planHash !== publishedHash ? ` but does not match published \`${publishedHash}\`` : ''} — convergence not confirmed.`;
      notifyChannel('cleanup', { embeds: [brandedEmbed(errors.length ? COLORS.WARN : (converged ? COLORS.SUCCESS : COLORS.INFO))
        .setTitle(`📦 Tier Agent Report — ${node}`)
        .setDescription([
          statusLine,
          (body.bytesFreed || 0) > 0 ? `Freed **${fmtSpace(body.bytesFreed)}** across ${(body.dropped || []).length} title(s). Master copies untouched.` : null,
          errors.length ? `⚠️ Errors:\n${errors.map(e => `• ${e}`).join('\n')}` : null,
          // Informational: these files stayed on disk but are ignored, so the node is still on plan.
          skipped.length ? `ℹ️ Not pruned (still ignored, node is on plan):\n${skipped.map(e => `• ${e}`).join('\n')}` : null,
        ].filter(Boolean).join('\n').slice(0, 4000))] });
    }
    res.json({ ok: true, converged });
  });

  if (CONFIG.DASHBOARD_ENABLED) {
    const adminForm = express.urlencoded({ extended: false, limit: '16kb' });
    const webauthnBrowserPath = path.join(path.dirname(require.resolve('@simplewebauthn/browser')), '..', 'dist', 'bundle', 'index.es5.umd.min.js');
    const passkeyClientPath = path.join(__dirname, 'src', 'passkey-client.js');

    app.get('/admin/passkey-client.js', rateLimit({
      windowMs: 60000,
      limit: 120,
      keyGenerator: httpRateLimitKey,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }), (_req, res) => res.sendFile(passkeyClientPath, { headers: { 'Cache-Control': 'no-cache' } }));
    app.get('/admin/webauthn-browser.js', (_req, res) => res.sendFile(webauthnBrowserPath, { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } }));

    app.get('/admin/login', (req, res) => {
      if (verifySession(readCookie(req, 'dm_session'))) return res.redirect('/admin');
      res.type('html').send(renderLogin(!!req.query.error, null, { passkeyEnabled: listPasskeys().length > 0 }));
    });

    app.get('/admin/passkey/authentication-options', rateLimit({
      windowMs: 15 * 60000,
      limit: 10,
      keyGenerator: httpRateLimitKey,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) => res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' }),
    }), async (req, res) => {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      if (!listPasskeys().length) return res.status(404).json({ error: 'No passkeys are enrolled.' });
      const binding = crypto.randomBytes(32).toString('base64url');
      const secure = req.secure || (req.headers['x-forwarded-proto'] || '').includes('https');
      try {
        const options = await passkeyService.authenticationOptions(binding);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Set-Cookie', `dm_webauthn=${binding}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=300${secure ? '; Secure' : ''}`);
        return res.json(options);
      } catch (_err) {
        audit('dashboard_passkey_login_failed', { ip, reason: 'options_failed' });
        return res.status(400).json({ error: 'Could not start passkey sign-in.' });
      }
    });

    app.post('/admin/passkey/authenticate', async (req, res) => {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      try {
        await passkeyService.finishAuthentication(readCookie(req, 'dm_webauthn'), req.body);
        setDashboardSessionCookie(req, res);
        res.append('Set-Cookie', 'dm_webauthn=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0');
        audit('dashboard_login_success', { ip, method: 'passkey' });
        return res.json({ verified: true });
      } catch (_err) {
        audit('dashboard_passkey_login_failed', { ip, reason: 'verification_failed' });
        return res.status(401).json({ verified: false, error: 'Passkey sign-in failed.' });
      }
    });

    app.post('/admin/login', adminForm, rateLimit({
      windowMs: 15 * 60000,
      limit: 5,
      keyGenerator: httpRateLimitKey,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) => res.status(429).type('html').send(renderLogin(
        false,
        'Too many attempts. Try again in a few minutes.',
        { passkeyEnabled: listPasskeys().length > 0 },
      )),
    }), (req, res) => {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const pwd = req.body?.password || '';
      const passOk = CONFIG.DASHBOARD_ADMIN_PASSWORD && safeEqual(pwd, CONFIG.DASHBOARD_ADMIN_PASSWORD);
      const tokenOk = CONFIG.DASHBOARD_ADMIN_TOKEN && safeEqual(pwd, CONFIG.DASHBOARD_ADMIN_TOKEN);
      if (!passOk && !tokenOk) {
        audit('dashboard_login_failed', { ip });
        return res.redirect('/admin/login?error=1');
      }
      setDashboardSessionCookie(req, res);
      audit('dashboard_login_success', { ip, method: 'password' });
      res.redirect('/admin');
    });

    app.post('/admin/logout', (req, res) => {
      res.setHeader('Set-Cookie', 'dm_session=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0');
      res.redirect('/admin/login');
    });

    app.get('/admin', dashboardAuth, async (_req, res) => {
      const now = Date.now();
      const pendingApprovals = listPendingRequests();
      const passkeys = listPasskeys();
      // Live activity: every external read is failure-tolerant so one dead integration never
      // takes the dashboard down — null means "couldn't reach it", rendered as such.
      const [health, sessions, queue, disks, edgeChecks, members, pendingQuota] = await Promise.all([
        gatherHealth(),
        tautulliConfigured() ? tautulliApi('get_activity').then(d => d?.sessions || []).catch(() => null) : Promise.resolve(null),
        arrSources().length ? fetchArrQueues().catch(() => null) : Promise.resolve(null),
        arrSources().length ? fetchDiskSpace().catch(() => null) : Promise.resolve(null),
        runEdgeDiagnostics({ live: false }).catch(() => []),
        pendingApprovals.length ? getGuildMembers().catch(() => []) : Promise.resolve([]),
        Promise.all(pendingApprovals.map(pending => quotaBlockReason(pending.seerrUserId, pending.discordId, pending.mediaType, { tmdbId: pending.tmdbId, is4k: pending.is4k }, true)
          .then(warning => ({ warning, error: null }))
          .catch(err => ({ warning: null, error: dashboardActionError(err) })))),
      ]);
      const grabJobs = listActiveGrabJobs();
      const stageJobs = listActiveStageJobs();
      const escalations = db.prepare("SELECT * FROM escalations WHERE state IN ('watching','alerted','error') ORDER BY approved_at").all();
      // Depends on the queue above, so it runs after rather than inside that Promise.all. Null on
      // failure (Sonarr unreachable) so the card says so instead of claiming everything is fine.
      const incomplete = await gatherIncompleteRequests({ queue: queue || [], grabJobs, escalations, now }).catch(() => null);
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
      const pendingRequestCount = db.prepare("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'").get().c;
      const recentRequests = db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 50').all();
      const linkedUsers = db.prepare('SELECT discord_id, email, invited, requested_at, home_server FROM users ORDER BY requested_at DESC LIMIT 100').all();
      const recentDownloads = db.prepare('SELECT * FROM download_access_log ORDER BY id DESC LIMIT 25').all();
      const auditRows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 50').all();
      const linkedTotal = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
      const activeLinks = db.prepare('SELECT COUNT(*) AS c FROM download_tokens WHERE revoked = 0 AND expires_at > ?').get(now).c;

      const memberNames = new Map(members.map(member => [member.user.id, member.displayName || member.user.globalName || member.user.username || member.user.tag]));
      const approvalItems = pendingApprovals.map((pending, index) => {
        const quota = pendingQuota[index];
        const azAvailable = canEscalate(pending);
        const createdAt = typeof pending.createdAt === 'number' ? pending.createdAt : sqliteUtcMs(pending.createdAt);
        return {
          state: quota.error || quota.warning ? 'warn' : 'ok',
          title: pending.label,
          sub: `${memberNames.get(pending.discordId) || pending.discordId} · ${mediaTypeLabel(pending.mediaType, pending.is4k)} · quota: ${quota.error ? `unavailable (${quota.error})` : (quota.warning || 'within limit')} · AvistaZ pre-auth ${azAvailable ? 'available' : 'unavailable'}`,
          right: createdAt ? `waiting ${fmtDuration(Math.max(0, now - createdAt))}` : 'waiting age unknown',
          actions: [
            { label: 'Approve', url: '/admin/action/gate', body: { operation: 'approve', nonce: pending.nonce }, inline: true },
            { label: 'Approve + AvistaZ fallback', url: '/admin/action/gate', body: { operation: 'approve_az', nonce: pending.nonce }, inline: true, disabled: !azAvailable, title: azAvailable ? '' : 'AvistaZ pre-auth is unavailable for this request.' },
            { label: 'Deny', url: '/admin/action/gate', body: { operation: 'deny', nonce: pending.nonce }, inline: true, danger: true },
          ],
        };
      });

      const stats = [
        renderStat('Streaming', sessions === null ? '—' : sessions.length),
        renderStat('Downloading', queue === null ? '—' : queue.length),
        renderStat('Active jobs', grabJobs.length + stageJobs.length),
        renderStat('Watching', escalations.length),
        renderStat('Incomplete', incomplete === null ? '—' : incomplete.length),
        renderStat('Tier nodes', `${tierNodes.filter(n => n.enabled).length}/${tierNodes.length}`),
        renderStat('Pending requests', pendingRequestCount),
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
      const allowance = grabDailyAllowance();
      const watchItems = [
        ...escalations.map(e => ({
          state: 'warn',
          title: e.title,
          sub: `escalation watch · ${e.state}${e.pre_authorized ? ' · pre-authorized' : ''}`,
          right: `approved ${fmtAgo(e.approved_at)}`,
          actions: [{
            label: allowance.limited ? `Escalate now (${allowance.remaining} left)` : 'Escalate now',
            url: '/admin/action/escalate',
            body: { id: e.id },
            confirm: allowance.limited
              ? `Escalate ${e.title} now? This can spend one of ${allowance.remaining} remaining AvistaZ downloads today.`
              : `Escalate ${e.title} to AvistaZ now?`,
            danger: true,
            disabled: allowance.exhausted,
          }],
        })),
        ...pendingDeletions.map(p => ({
          state: 'skip',
          title: p.title || p.media_id,
          sub: 'pending deletion (finished-watching prompt)',
          right: `deletes ${fmtAgo(p.delete_after)}`,
        })),
      ];
      const priorityItems = listMediaPriority().map((item, index, all) => ({
        state: 'ok',
        title: item.title,
        sub: `${mediaTypeLabel(item.media_type, false)} · ${item.key}`,
        right: `rank ${item.rank}`,
        actions: [
          { label: 'Up', url: '/admin/action/priority', body: { operation: 'move', key: item.key, direction: -1 }, disabled: index === 0 },
          { label: 'Down', url: '/admin/action/priority', body: { operation: 'move', key: item.key, direction: 1 }, disabled: index === all.length - 1 },
          { label: 'Unpin', url: '/admin/action/priority', body: { operation: 'unpin', key: item.key } },
        ],
      }));
      const seasonAlertItems = seasonAlertDashboardItems(listSeasonAlertStates({ stoodDownOnly: true }));
      const sweepItems = [
        ['stuck', 'Stuck-download sweep'],
        ['escalation', 'Escalation sweep'],
        ['season-pack', 'Season-pack sweep'],
        ['episode-recovery', 'Episode-recovery sweep'],
      ].map(([name, title]) => ({ state: 'skip', title, actions: [{ label: 'Run now', url: '/admin/action/sweep', body: { name } }] }));

      const tierItems = tierNodes.map(n => {
        const plan = getTierPlan(n.name);
        const rep = lastReportByNode[n.name];
        const status = tierNodeStatus(plan, rep, now);
        return {
          state: !n.enabled ? 'skip' : status.state,
          title: `${n.name}${n.full ? ' · full master' : ''}${n.sticky ? ' · sticky' : ''}`,
          sub: `${n.access} · ${n.demand_source}${n.demand_source === 'atime' && n.atime_mask ? ` (mask ${n.atime_mask})` : ''} · ${n.transport} · ${fmtSpace(n.usable_bytes || 0)} @ ${n.headroom_pct}% headroom · ${status.details}`,
          right: status.status,
          actions: status.setup ? [{ label: 'Set up this node', setupNode: n.name }] : [],
        };
      });

      const diskItems = forecastDisks(db, disks || [], now).map(d => {
        const used = (d.totalSpace || 0) - (d.freeSpace || 0);
        const pct = d.totalSpace ? Math.round((used / d.totalSpace) * 100) : 0;
        return {
          state: (tunable('DISK_SPACE_WARN_GB') > 0 && (d.freeSpace || 0) < tunable('DISK_SPACE_WARN_GB') * 1024 ** 3)
            || (tunable('DISK_FORECAST_WARN_DAYS') > 0 && d.forecast.status === 'projected' && d.forecast.daysRemaining <= tunable('DISK_FORECAST_WARN_DAYS')) ? 'warn' : 'ok',
          title: d.root,
          sub: `${fmtSpace(d.freeSpace || 0)} free of ${fmtSpace(d.totalSpace || 0)} · ${forecastLabel(d.forecast)}`,
          right: `${pct}% used`,
          pct,
        };
      });

      const plexUserRows = pendingPlex.map(u => ({ email: u.email, discord: u.discord_id, requested: fmtAgo(u.requested_at) }));
      const requestRows = recentRequests.map(r => ({ title: r.title, status: r.status, type: mediaTypeLabel(r.media_type, r.is_4k), seerr: r.overseerr_request_id || 'provisional', requester: r.requested_by_discord_id || '—', when: fmtAgo(sqliteUtcMs(r.created_at)) }));
      const linkedRows = linkedUsers.map(u => ({ email: u.email, discord: u.discord_id, group: u.home_server === 'ph' ? 'Philippines' : 'Main', invited: u.invited ? '✅' : '⏳', since: fmtAgo(u.requested_at) }));
      const downloadRows = recentDownloads.map(d => ({ when: fmtAgo(sqliteUtcMs(d.created_at)), file: (d.file_path || '').split('/').pop() || '—', status: d.status, sent: d.bytes_sent ? fmtSpace(d.bytes_sent) : '', ip: d.ip || '' }));
      const auditTableRows = auditRows.map(a => ({ when: fmtAgo(sqliteUtcMs(a.created_at)), action: a.action, details: String(a.metadata_json || '').slice(0, 160) }));

      const unavailable = which => `<p class="muted">${escapeHtml(which)} unreachable or not configured.</p>`;
      const nav = [['overview', 'Overview'], ['operations', 'Operations'], ['automation', 'Automation'], ['edge', 'Edge'], ['people', 'People'], ['logs', 'Logs']];
      const settingsGroups = runtimeSettings.describeRuntimeSettings({ config: CONFIG, store: settingsStore });
      const overriddenCount = settingsGroups.reduce((n, g) => n + g.settings.filter(x => x.overridden).length, 0);

      const body = `
        <div class="overall ${health.overall === 'ok' ? 'ok' : 'warn'}">
          <span>Overall: <strong>${escapeHtml(String(health.overall).toUpperCase())}</strong></span>
          <span class="updated">updated ${new Date(now).toISOString().slice(11, 19)} UTC · auto-refreshes</span>
        </div>
        <div class="stats">${stats}</div>

        <section class="panel" data-panel="overview">
          ${renderPasskeyManagement(passkeys, PASSKEY_RP.rpID)}
          <div class="card">
            <h2>Integrations</h2>
            <div class="badges">${renderHealthBadges(health)}</div>
            ${Object.keys(health.errors || {}).length ? renderItemList(Object.entries(health.errors).map(([name, error]) => ({ state: 'down', title: name, sub: error })), '') : ''}
          </div>
          <div class="card">
            <h2>▶️ Now Streaming</h2>
            ${sessions === null ? unavailable('Tautulli') : renderItemList(nowPlayingItems, 'Nobody is streaming right now.')}
          </div>
          <div class="card">
            <h2>⬇️ Downloading</h2>
            ${queue === null ? unavailable('Radarr/Sonarr') : renderItemList(queueItems, 'Nothing in the download queues.')}
          </div>
          <div class="card">
            <h2>💾 Disk Space</h2>
            ${disks === null ? unavailable('*arr diskspace') : renderItemList(diskItems, 'No disks reported.')}
          </div>
        </section>

        <section class="panel" data-panel="operations">
          <div class="card">
            <h2>Pending Approval<span class="sub">Requests waiting for an administrator. Quota changes are warnings and do not block approval.</span></h2>
            ${renderItemList(approvalItems, 'No requests are waiting for approval.')}
          </div>
          <div class="card">
            <h2>🧩 Not Watchable Yet<span class="sub">Requests still missing content — including series Seerr already calls "available" but that are missing aired episodes. Worst first.</span></h2>
            ${incomplete === null ? unavailable('Sonarr') : renderItemList(incomplete, 'Every request is complete — nothing missing.')}
          </div>
          <div class="card">
            <h2>⚙️ Active Jobs</h2>
            ${renderItemList(jobItems, 'No seedbox grabs or staging copies running.')}
          </div>
          <div class="card">
            <h2>👀 Watching / Scheduled</h2>
            ${renderItemList(watchItems, 'No escalation watches or pending deletions.')}
          </div>
          <div class="card">
            <h2>Pinned Media<span class="sub">Pinned titles run first in capped Sonarr sweeps. Reorder them here.</span></h2>
            ${renderItemList(priorityItems, 'No titles are pinned.')}
          </div>
          <div class="card">
            <h2>Recent Media Requests</h2>
            ${renderTable(requestRows)}
          </div>
          <div class="card">
            <h2>Manual Actions</h2>
            ${renderItemList(sweepItems, '')}
            <div class="actions">
              <a class="btn" href="/admin/health">Health JSON</a>
              <a class="btn" href="/admin/doctor">Edge Doctor JSON</a>
              <a class="btn" href="/admin/action/sync-preview">Sync Preview</a>
              <a class="btn" href="/admin/action/cleanup-preview">Cleanup Preview</a>
              <button class="btn danger" type="button" onclick="revokeAll()">Revoke All Download Links</button>
            </div>
          </div>
        </section>

        <section class="panel" data-panel="automation">
          <p class="panel-intro">These take effect on the next sweep — no redeploy. Compose stays the default:
            <strong>Reset to compose</strong> drops the override and the stack file's value applies again.
            ${overriddenCount ? `<strong>${overriddenCount}</strong> setting${overriddenCount === 1 ? ' is' : 's are'} currently overridden here.` : 'Nothing is overridden right now.'}</p>
          <div class="card">
            <h2>Season-search alert stand-downs<span class="sub">Searches still run. Only repeated identical no-release messages are muted.</span></h2>
            ${renderItemList(seasonAlertItems, 'No season-search alerts are stood down.')}
          </div>
          ${settingsGroups.map(renderSettingsGroup).join('')}
        </section>

        <section class="panel" data-panel="edge">
          <div class="card">
            <h2>📦 Tier Nodes</h2>
            ${renderItemList(tierItems, 'No tier nodes registered yet.')}
          </div>
          ${renderTierNodeSetup(tierNodes.map(node => ({ ...node, folders: listTierNodeFolders(node.name) })))}
          <div class="card">
            <h2>🩺 Edge Readiness</h2>
            ${renderItemList(edgeChecks.map(c => ({ state: c.status === 'fail' ? 'down' : c.status, title: c.name, sub: c.detail })), 'No edge checks available.')}
          </div>
        </section>

        <section class="panel" data-panel="people">
          <div class="card">
            <h2>Pending Plex Users</h2>
            ${renderTable(plexUserRows)}
          </div>
          <div class="card">
            <h2>Linked Users</h2>
            ${renderTable(linkedRows)}
          </div>
        </section>

        <section class="panel" data-panel="logs">
          <div class="card">
            <h2>Recent Downloads</h2>
            ${renderTable(downloadRows)}
          </div>
          <div class="card">
            <h2>Recent Audit Log</h2>
            ${renderTable(auditTableRows)}
          </div>
        </section>

        <script src="/admin/passkey-client.js"></script>
        <script src="/admin/webauthn-browser.js"></script>
        <script>
          async function revokeAll() {
            if (!confirm('Revoke ALL active download links? This cannot be undone.')) return;
            const r = await fetch('/admin/action/revoke-all', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
            alert(r.ok ? 'All active download links revoked.' : 'Failed: ' + r.status);
            if (r.ok) location.reload();
          }
          document.querySelectorAll('[data-post]').forEach(function (btn) {
            btn.addEventListener('click', async function () {
              var prompt = btn.dataset.confirm;
              if (prompt && !confirm(prompt)) return;
              var body = JSON.parse(btn.dataset.body || '{}');
              if (prompt) body.confirmed = true;
              var item = btn.closest('.item-main');
              var buttons = btn.dataset.inline && item ? [].slice.call(item.querySelectorAll('[data-post]')) : [btn];
              var buttonStates = buttons.map(function (button) { return { button: button, disabled: button.disabled }; });
              var note = btn.dataset.inline && item ? item.querySelector('.action-result') : null;
              buttons.forEach(function (button) { button.disabled = true; });
              if (note) { note.textContent = 'Workingâ€¦'; note.className = 'action-result'; }
              try {
                var r = await fetch(btn.dataset.post, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                var result = await r.json().catch(function () { return {}; });
                var ok = r.ok && result.ok !== false;
                var message = ok ? (result.message || 'Action completed.') : (result.error || 'Request failed: ' + r.status);
                if (note) {
                  note.textContent = message;
                  note.className = 'action-result ' + (ok ? 'ok' : 'bad');
                  if (!ok && result.retryable) buttonStates.forEach(function (state) { state.button.disabled = state.disabled; });
                } else {
                  alert(message);
                  if (ok) location.reload();
                }
              } catch (err) {
                var message = String(err && err.message || err);
                if (note) { note.textContent = message; note.className = 'action-result bad'; }
                else alert(message);
                buttonStates.forEach(function (state) { state.button.disabled = state.disabled; });
              }
            });
          });
          (function () {
            var enroll = document.getElementById('passkey-enroll');
            var note = document.getElementById('passkey-note');
            var passkeyReady = !enroll || (!!window.PasskeyClient && window.PasskeyClient.preparePasskeyAction(enroll, note, window));
            if (enroll && !window.PasskeyClient) {
              enroll.disabled = true;
              note.textContent = 'Passkey support could not be checked. Open this HTTPS dashboard in Safari, Chrome, Edge, or another WebAuthn-capable browser.';
              note.className = 'save-note bad';
            }
            var post = async function (url, body) {
              var response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
              var result = await response.json().catch(function () { return {}; });
              if (!response.ok) throw new Error(result.error || 'Passkey request failed.');
              return result;
            };
            if (enroll && passkeyReady) enroll.addEventListener('click', async function () {
              var label = document.getElementById('passkey-label').value.trim();
              if (!label) { note.textContent = 'Enter a device label.'; note.className = 'save-note bad'; return; }
              enroll.disabled = true;
              try {
                var optionsJSON = await post('/admin/passkey/registration-options', { label: label });
                var response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: optionsJSON });
                await post('/admin/passkey/register', response);
                location.hash = 'overview';
                location.reload();
              } catch (error) {
                note.textContent = window.PasskeyClient ? window.PasskeyClient.passkeyErrorMessage(error, window) : (error.message || String(error));
                note.className = 'save-note bad';
                enroll.disabled = false;
              }
            });
            document.querySelectorAll('[data-passkey-rename]').forEach(function (button) {
              button.addEventListener('click', async function () {
                var row = button.closest('[data-passkey]');
                try { await post('/admin/passkey/rename', { credentialId: row.dataset.passkey, label: row.querySelector('input').value }); location.reload(); }
                catch (error) { note.textContent = error.message || String(error); note.className = 'save-note bad'; }
              });
            });
            document.querySelectorAll('[data-passkey-revoke]').forEach(function (button) {
              button.addEventListener('click', async function () {
                if (!confirm('Revoke this passkey? That device will no longer be able to sign in.')) return;
                var row = button.closest('[data-passkey]');
                try { await post('/admin/passkey/revoke', { credentialId: row.dataset.passkey }); location.reload(); }
                catch (error) { note.textContent = error.message || String(error); note.className = 'save-note bad'; }
              });
            });
          })();
          document.querySelectorAll('[data-setup-node]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var form = document.getElementById('tier-install-form');
              if (!form) return;
              form.elements.node.value = btn.dataset.setupNode;
              form.elements.node.dispatchEvent(new Event('change'));
              document.getElementById('tier-node-setup').scrollIntoView({ behavior: 'smooth' });
              var firstFolder = form.querySelector('[name="folderId"]');
              if (firstFolder) firstFolder.focus();
            });
          });
          (function () {
            var registerForm = document.getElementById('tier-register-form');
            var installForm = document.getElementById('tier-install-form');
            var folderList = document.getElementById('tier-folder-list');
            var folderRow = function (folder) {
              var row = document.createElement('div');
              row.className = 'tier-folder-row';
              row.innerHTML = '<label>Syncthing folder ID<input name="folderId" placeholder="e.g. movies"></label>'
                + '<label>Local folder path<input name="folderRoot" placeholder="/mnt/media/Media/Movies"></label>'
                + '<button class="btn tier-folder-remove" type="button">Remove</button>';
              row.querySelector('[name="folderId"]').value = folder && (folder.folderId || folder.id) || '';
              row.querySelector('[name="folderRoot"]').value = folder && (folder.folderRoot || folder.path) || '';
              return row;
            };
            var ensureFourFolderRows = function () {
              if (!folderList) return;
              while (folderList.children.length < 4) folderList.appendChild(folderRow());
            };
            if (folderList) {
              folderList.addEventListener('click', function (event) {
                var button = event.target.closest('.tier-folder-remove');
                if (!button) return;
                button.closest('.tier-folder-row').remove();
                ensureFourFolderRows();
                window.__dirtySettings = true;
              });
              document.getElementById('tier-folder-add').addEventListener('click', function () {
                folderList.appendChild(folderRow());
                window.__dirtySettings = true;
              });
            }
            if (installForm) installForm.elements.node.addEventListener('change', function () {
              var option = this.options[this.selectedIndex];
              var folders = [];
              try { folders = JSON.parse(option.dataset.folders || '[]'); } catch (_e) {}
              folderList.replaceChildren();
              folders.forEach(function (folder) { folderList.appendChild(folderRow(folder)); });
              ensureFourFolderRows();
            });
            [registerForm, installForm].filter(Boolean).forEach(function (form) {
              form.addEventListener('input', function () { window.__dirtySettings = true; });
            });
            if (registerForm) registerForm.addEventListener('submit', async function (event) {
              event.preventDefault();
              var values = Object.fromEntries(new FormData(registerForm));
              values.full = registerForm.elements.full.checked;
              var note = document.getElementById('tier-register-note');
              var r = await fetch('/admin/action/tier-node', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
              var result = await r.json().catch(function () { return {}; });
              if (!r.ok || result.ok === false) { note.textContent = result.error || 'Registration failed.'; note.className = 'save-note bad'; return; }
              window.__dirtySettings = false;
              location.hash = 'edge';
              location.reload();
            });
            if (installForm) installForm.addEventListener('submit', async function (event) {
              event.preventDefault();
              var values = Object.fromEntries(new FormData(installForm));
              values.folders = [].slice.call(folderList.querySelectorAll('.tier-folder-row')).map(function (row) {
                return { id: row.querySelector('[name="folderId"]').value.trim(), path: row.querySelector('[name="folderRoot"]').value.trim() };
              }).filter(function (folder) { return folder.id || folder.path; });
              delete values.folderId;
              delete values.folderRoot;
              var note = document.getElementById('tier-install-note');
              if (!values.folders.length || values.folders.some(function (folder) { return !folder.id || !folder.path; })) {
                note.textContent = 'Add at least one complete folder ID/path pair; remove or finish partial rows.';
                note.className = 'save-note bad';
                return;
              }
              if (!!values.mountRoot !== !!values.mountMarker) {
                note.textContent = 'Mount root and mount marker must be supplied together.';
                note.className = 'save-note bad';
                return;
              }
              if (!confirm('Save this complete folder list and rotate the node token? The existing agent will stop working until this new command is installed.')) return;
              values.confirmed = true;
              var r = await fetch('/admin/action/tier-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
              var result = await r.json().catch(function () { return {}; });
              if (!r.ok || result.ok === false) { note.textContent = result.error || 'Command generation failed.'; note.className = 'save-note bad'; return; }
              document.getElementById('tier-install-command').textContent = result.command;
              document.getElementById('tier-install-result').hidden = false;
              installForm.elements.node.options[installForm.elements.node.selectedIndex].dataset.folders = JSON.stringify(values.folders);
              note.textContent = 'Token rotated. Copy this command now.';
              note.className = 'save-note ok';
            });
            var copy = document.getElementById('tier-copy-command');
            if (copy) copy.addEventListener('click', async function () {
              await navigator.clipboard.writeText(document.getElementById('tier-install-command').textContent);
              copy.textContent = 'Copied';
            });
          })();
          (function () {
            var note = function (group, text, cls) {
              var el = document.querySelector('[data-note="' + group + '"]');
              if (el) { el.textContent = text; el.className = 'save-note' + (cls ? ' ' + cls : ''); }
            };
            var inputsFor = function (group) {
              return [].slice.call(document.querySelectorAll('[data-group="' + group + '"] [data-key]'));
            };
            // Any edit blocks the auto-refresh until it is saved, so a pending change can't be
            // silently thrown away by the 60s reload.
            document.addEventListener('input', function (e) { if (e.target.dataset && e.target.dataset.key) window.__dirtySettings = true; });
            document.addEventListener('change', function (e) { if (e.target.dataset && e.target.dataset.key) window.__dirtySettings = true; });
            var post = async function (url, payload, group, okText) {
              note(group, 'Saving…');
              try {
                var r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                var body = await r.json().catch(function () { return {}; });
                if (!r.ok || body.ok === false) { note(group, (body.errors || ['Failed: ' + r.status]).join('; '), 'bad'); return; }
                window.__dirtySettings = false;
                note(group, okText, 'ok');
                setTimeout(function () { location.reload(); }, 700);
              } catch (err) { note(group, String(err && err.message || err), 'bad'); }
            };
            document.querySelectorAll('[data-preview]').forEach(function (btn) {
              btn.addEventListener('click', async function () {
                var group = btn.dataset.preview;
                var values = {};
                inputsFor(group).forEach(function (el) {
                  values[el.dataset.key] = el.dataset.type === 'bool' ? (el.checked ? '1' : '0') : el.value;
                });
                note(group, 'Calculating preview...');
                try {
                  var sweep = group.replace(/_/g, '-');
                  var r = await fetch('/admin/action/sweep-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: sweep, values: values }) });
                  var body = await r.json().catch(function () { return {}; });
                  if (!r.ok || body.ok === false) { note(group, body.error || 'Preview failed.', 'bad'); return; }
                  var result = document.querySelector('[data-preview-result="' + group + '"]');
                  result.replaceChildren();
                  var heading = document.createElement('p');
                  heading.textContent = body.items.length ? body.items.length + ' item(s) evaluated:' : 'No items would be actioned.';
                  result.appendChild(heading);
                  if (body.items.length) {
                    var list = document.createElement('ul');
                    body.items.forEach(function (item) {
                      var row = document.createElement('li');
                      row.textContent = item.title + ': ' + item.stage + ' — ' + item.reason;
                      list.appendChild(row);
                    });
                    result.appendChild(list);
                  }
                  note(group, 'Preview uses the unsaved values above.', 'ok');
                } catch (err) { note(group, String(err && err.message || err), 'bad'); }
              });
            });
            document.querySelectorAll('[data-save]').forEach(function (btn) {
              btn.addEventListener('click', function () {
                var group = btn.dataset.save;
                var values = {};
                inputsFor(group).forEach(function (el) {
                  values[el.dataset.key] = el.dataset.type === 'bool' ? (el.checked ? '1' : '0') : el.value;
                });
                post('/admin/settings', { values: values }, group, 'Saved.');
              });
            });
            document.querySelectorAll('[data-reset]').forEach(function (btn) {
              btn.addEventListener('click', function () {
                var group = btn.dataset.reset;
                if (!confirm('Drop the overrides for this group and use the compose values again?')) return;
                post('/admin/settings/reset', { keys: inputsFor(group).map(function (el) { return el.dataset.key; }) }, group, 'Reset to compose.');
              });
            });
          })();
        </script>`;
      res.type('html').send(renderPage('Dashboard', body, { showLogout: true, showSearch: true, nav, autoRefresh: true, tabs: true }));
    });

    app.get('/admin/search', dashboardAuth, async (req, res) => {
      const normalized = normalizeSearchQuery(req.query.q);
      if (!normalized.query) {
        return res.type('html').send(renderPage('Search', '<div class="card"><h2>Search</h2><p class="muted">Enter at least 2 characters.</p></div>', { showLogout: true, showSearch: true }));
      }
      if (normalized.error) {
        return res.status(400).type('html').send(renderPage('Search', `<div class="card"><h2>Search</h2><div class="error">${escapeHtml(normalized.error)}</div></div>`, { showLogout: true, showSearch: true, searchQuery: normalized.query }));
      }
      const [members, queues, series, missingEpisodes, movies] = await Promise.all([
        getGuildMembers().catch(() => []),
        arrSources().length ? fetchArrQueues().catch(() => []) : Promise.resolve([]),
        CONFIG.SONARR_URL ? listSonarrSeries().catch(() => []) : Promise.resolve([]),
        CONFIG.SONARR_URL ? listSonarrMissingEpisodes().catch(() => []) : Promise.resolve([]),
        (CONFIG.RADARR_URL || CONFIG.RADARR_4K_URL) ? listRadarrMovies().catch(() => []) : Promise.resolve([]),
      ]);
      const now = Date.now();
      const results = searchDashboard({
        query: normalized.query,
        requests: db.prepare('SELECT * FROM requests ORDER BY id DESC').all(),
        users: db.prepare('SELECT * FROM users ORDER BY requested_at DESC').all(),
        auditRows: db.prepare('SELECT created_at, action, metadata_json FROM audit_log ORDER BY id DESC').all(),
        downloadTokens: db.prepare('SELECT discord_id, revoked, expires_at FROM download_tokens').all(),
        members: members.filter(member => !member.user?.bot).map(member => ({ discordId: member.user.id, name: member.displayName || member.user.globalName || member.user.username || member.user.tag })),
        queues, series, missingEpisodes, movies, now,
      });
      const requestRows = results.requests.map(row => ({ title: row.title, status: row.status, type: row.type, requester: row.requestedBy, when: fmtAgo(sqliteUtcMs(row.requestedAt)), progress: row.progress }));
      const userRows = results.users.map(row => ({ discord: row.discord, name: row.name, email: row.email, linked: row.linked, server: row.homeServer, invited: row.invited, requests: row.requests, links: row.activeLinks }));
      const libraryRows = results.library.map(row => ({ title: row.title, type: row.type, status: row.status, complete: row.completeness, gaps: row.gaps, source: row.source }));
      const auditRows = results.audit.map(row => ({ when: fmtAgo(sqliteUtcMs(row.when)), action: row.action, matched: row.match }));
      const body = `<div class="actions"><a class="btn" href="/admin">Back to dashboard</a></div>
        <div class="card"><h2>Requests <span class="sub">${requestRows.length} result${requestRows.length === 1 ? '' : 's'}</span></h2>${renderTable(requestRows)}</div>
        <div class="card"><h2>Users <span class="sub">${userRows.length} result${userRows.length === 1 ? '' : 's'}</span></h2>${renderTable(userRows)}</div>
        <div class="card"><h2>Library <span class="sub">${libraryRows.length} result${libraryRows.length === 1 ? '' : 's'}</span></h2>${renderTable(libraryRows)}</div>
        <div class="card"><h2>Audit <span class="sub">${auditRows.length} result${auditRows.length === 1 ? '' : 's'} · metadata is searchable but hidden</span></h2>${renderTable(auditRows)}</div>`;
      res.type('html').send(renderPage(`Search: ${normalized.query}`, body, { showLogout: true, showSearch: true, searchQuery: normalized.query }));
    });

    app.get('/admin/health', dashboardAuth, async (_req, res) => res.json(await gatherHealth()));
    app.get('/admin/doctor', dashboardAuth, async (_req, res) => res.json({ checks: await runEdgeDiagnostics({ live: true }), tierNodes: listTierNodes().map(n => ({ name: n.name, enabled: !!n.enabled, full: !!n.full, usableBytes: n.usable_bytes })) }));
    app.get('/admin/action/sync-preview', dashboardAuth, async (_req, res) => res.json(await buildSyncPreview()));
    app.get('/admin/action/cleanup-preview', dashboardAuth, async (_req, res) => {
      const users = await fetchOverseerrUsers().catch(() => []);
      const toDelete = users.filter(u => u.userType !== 1 && ['displayName', 'email', 'username'].some(k => (u[k] || '').toLowerCase().startsWith('deleted_user')));
      res.json({ wouldRemove: toDelete.length, users: toDelete.map(u => ({ id: u.id, email: u.email, username: u.username })) });
    });
    app.post('/admin/action/gate', dashboardAuth, async (req, res) => {
      const operation = req.body?.operation;
      const nonce = String(req.body?.nonce || '');
      if (!['approve', 'approve_az', 'deny'].includes(operation) || !/^[0-9a-f]{8}$/.test(nonce)) {
        return res.status(400).json({ ok: false, error: 'Invalid pending-request action.', retryable: false });
      }
      try {
        const actor = dashboardGateActor(req);
        const result = operation === 'deny'
          ? await denyGatedRequest({ nonce, actor })
          : await approveGatedRequest({ nonce, actor, azPreAuth: operation === 'approve_az' });
        const response = dashboardGateResponse(result, operation);
        const status = response.ok ? 200 : (result.restashed ? 502 : 409);
        return res.status(status).json(response);
      } catch (err) {
        return res.status(500).json({ ok: false, error: dashboardActionError(err), retryable: false });
      }
    });
    app.post('/admin/passkey/registration-options', dashboardAuth, async (req, res) => {
      try {
        const options = await passkeyService.registrationOptions(readCookie(req, 'dm_session'), req.body?.label);
        res.setHeader('Cache-Control', 'no-store');
        return res.json(options);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    });
    app.post('/admin/passkey/register', dashboardAuth, async (req, res) => {
      try {
        const passkey = await passkeyService.finishRegistration(readCookie(req, 'dm_session'), req.body);
        audit('dashboard_passkey_enrolled', dashboardActor(req));
        return res.json({ ok: true, label: passkey.label });
      } catch (_err) {
        audit('dashboard_passkey_enrollment_failed', { ...dashboardActor(req), reason: 'verification_failed' });
        return res.status(400).json({ error: 'Passkey enrollment failed.' });
      }
    });
    app.post('/admin/passkey/rename', dashboardAuth, (req, res) => {
      const credentialId = String(req.body?.credentialId || '');
      const label = String(req.body?.label || '').trim();
      if (!credentialId || !label || label.length > 64) return res.status(400).json({ error: 'Credential and a label of 1 to 64 characters are required.' });
      if (!renamePasskey(credentialId, label)) return res.status(404).json({ error: 'Passkey not found.' });
      audit('dashboard_passkey_renamed', dashboardActor(req));
      return res.json({ ok: true });
    });
    app.post('/admin/passkey/revoke', dashboardAuth, (req, res) => {
      const credentialId = String(req.body?.credentialId || '');
      if (listPasskeys().length === 1 && !CONFIG.DASHBOARD_ADMIN_PASSWORD && !CONFIG.DASHBOARD_ADMIN_TOKEN) {
        return res.status(409).json({ error: 'Configure the password fallback before revoking the last passkey.' });
      }
      if (!revokePasskey(credentialId)) return res.status(404).json({ error: 'Passkey not found.' });
      audit('dashboard_passkey_revoked', dashboardActor(req));
      return res.json({ ok: true });
    });
    app.post('/admin/action/tier-node', dashboardAuth, (req, res) => {
      const name = String(req.body?.name || '').trim().toLowerCase();
      const usableGb = Number(req.body?.usableGb);
      const access = req.body?.access;
      const demandSource = req.body?.demandSource;
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || !Number.isInteger(usableGb) || usableGb < 1
        || !['open', 'restricted'].includes(access) || !['tautulli', 'plex', 'atime'].includes(demandSource)) {
        audit('dashboard_tier_node_upserted', { ...dashboardActor(req), ok: false, node: name || null, reason: 'invalid_request' });
        return res.status(400).json({ ok: false, error: 'Enter a valid node name, capacity, access, and demand source.' });
      }
      const { created, node } = upsertTierNode({ name, usable_bytes: usableGb * 1024 ** 3, access, demand_source: demandSource, full: req.body?.full === true });
      audit('dashboard_tier_node_upserted', { ...dashboardActor(req), ok: true, node: name, created });
      return res.json({ ok: true, node: { name: node.name }, message: created ? 'Node registered.' : 'Node updated.' });
    });
    app.post('/admin/action/tier-token', dashboardAuth, (req, res) => {
      const node = String(req.body?.node || '').trim().toLowerCase();
      const legacyFolderRoot = String(req.body?.folderRoot || '').trim();
      const legacyFolderId = String(req.body?.syncthingFolderId || '').trim();
      if (req.body?.confirmed !== true) return res.status(400).json({ ok: false, error: 'Token rotation confirmation is required.' });
      if (!getTierNode(node)) return res.status(404).json({ ok: false, error: 'Node not found.' });
      let setup;
      try {
        setup = prepareTierNodeInstall({
          ...req.body,
          folders: req.body?.folders || [{ id: legacyFolderId, path: legacyFolderRoot }],
        });
      }
      catch (err) { return res.status(400).json({ ok: false, error: err.message }); }
      const { folders, syncthingApiKey, mountRoot, mountMarker } = setup;
      upsertTierNode({ name: node, folder_root: folders[0].path });
      replaceTierNodeFolders(node, folders);
      const token = setTierAgentToken(node);
      const botUrl = CONFIG.TUNNEL_DOMAIN ? `https://${CONFIG.TUNNEL_DOMAIN}` : `http://127.0.0.1:${CONFIG.PORT}`;
      const command = tierInstallCommand({ botUrl, node, token, folders, syncthingApiKey, mountRoot, mountMarker });
      audit('dashboard_tier_agent_token_rotated', { ...dashboardActor(req), node, folderCount: folders.length });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, command });
    });
    app.post('/admin/action/search', dashboardAuth, async (req, res) => {
      const kind = req.body?.kind;
      const seriesId = Number(req.body?.seriesId);
      const seasonNumber = Number(req.body?.seasonNumber);
      const episodeId = Number(req.body?.episodeId);
      if (kind === 'rearm-alert') {
        if (!Number.isInteger(seriesId) || seriesId < 1 || !Number.isInteger(seasonNumber) || seasonNumber < 0) {
          audit('dashboard_season_alert_rearmed', { ...dashboardActor(req), ok: false, reason: 'invalid_request' });
          return res.status(400).json({ ok: false, error: 'Valid series and season numbers are required.' });
        }
        const changed = clearSeasonAlertState(seriesId, seasonNumber);
        audit('dashboard_season_alert_rearmed', { ...dashboardActor(req), ok: true, seriesId, seasonNumber, changed });
        return res.json({ ok: true, message: changed ? 'Season-search alerts re-armed.' : 'Season-search alerts were already armed.' });
      }
      if (!['season', 'episode'].includes(kind) || !Number.isInteger(seriesId)) {
        audit('dashboard_search', { ...dashboardActor(req), ok: false, reason: 'invalid_request' });
        return res.status(400).json({ ok: false, error: 'Invalid search request.' });
      }
      try {
        const series = (await listSonarrSeries()).find(row => Number(row.id) === seriesId);
        if (!series) throw new Error(`Sonarr series ${seriesId} was not found`);
        const episodes = await getSeriesEpisodes(seriesId);
        if (kind === 'season') {
          const missing = episodes.filter(ep => Number(ep.seasonNumber) === seasonNumber && ep.monitored && !ep.hasFile
            && Date.parse(ep.airDateUtc || ep.airDate || '') <= Date.now());
          if (!Number.isInteger(seasonNumber) || !missing.length) throw new Error(`Sonarr season ${seasonNumber} has no aired missing episodes`);
          const fallback = getSeasonEpisodeFallback(seriesId, seasonNumber);
          if (fallback) {
            const error = `A bounded episode fallback already owns this season (${fallback.state})`;
            audit('dashboard_search', { ...dashboardActor(req), ok: false, reason: 'episode_fallback_active', seriesId, seasonNumber, fallbackState: fallback.state });
            return res.status(409).json({ ok: false, error });
          }
          // An admin explicitly clicking "Search Now" is a deliberate one-off override, not the
          // automated sweep — force:true skips the cooldown (including any stall backoff) rather
          // than making them wait out a multi-day backoff they just decided isn't warranted.
          // Without force, the plain cooldown still applies so an accidental double-click isn't
          // silently overridden.
          const force = !!req.body?.force;
          const { cooling, nextEligible } = force ? { cooling: false } : seasonSearchCooldown(getSeasonSearchTimes(seriesId)[seasonNumber]);
          if (cooling) {
            const error = `Season search is cooling down until ${new Date(nextEligible).toISOString()}`;
            audit('dashboard_search', { ...dashboardActor(req), ok: false, reason: 'cooldown', seriesId, seasonNumber, nextEligible });
            return res.status(409).json({ ok: false, error, nextEligible, canOverride: true });
          }
          // Mirror the automated season-pack sweep's avistaz-vs-sonarr decision. This button used
          // to always call Sonarr's plain SeasonSearch, silently ignoring the AvistaZ tag — an
          // override on a tagged show now actually searches AvistaZ instead of quietly falling
          // back to the public-indexer route it exists to avoid.
          const tagSource = { url: CONFIG.SONARR_URL, key: CONFIG.SONARR_API_KEY, label: 'sonarr' };
          const tagId = await getArrTagId(tagSource, CONFIG.AVISTAZ_TAG).catch(() => null);
          const tagged = tagId != null && (series.tags || []).includes(tagId);
          const directEnabled = tunable('SEASON_PACK_AVISTAZ_DIRECT') && grabConfigured();
          const indexer = tagged && directEnabled ? await findAvistazIndexer().catch(() => null) : null;
          if (tagged && directEnabled && !indexer) {
            audit('dashboard_search', { ...dashboardActor(req), ok: false, reason: 'indexer_missing', seriesId, seasonNumber, title: series.title });
            return res.status(409).json({ ok: false, error: `${series.title} is tagged for AvistaZ, but the AvistaZ indexer could not be found in Prowlarr — check AVISTAZ_INDEXER_NAME and the indexer's name there.` });
          }
          if (tagged && directEnabled && indexer) {
            const allowance = grabDailyAllowance();
            const result = await runSeasonDirectGrab({ series, season: { season: seasonNumber, missing: missing.length }, indexer, allowance });
            clearSeasonAlertState(seriesId, seasonNumber);
            recordSeasonSearch({ seriesId, seasonNumber, seriesTitle: series.title, missing: missing.length });
            audit('dashboard_search', { ...dashboardActor(req), ok: result.status !== 'error', kind, seriesId, seasonNumber, title: series.title, route: 'avistaz', status: result.status, override: force });
            const statusText = result.status === 'grabbed' ? result.detail
              : result.status === 'offered' ? result.detail
                : result.status === 'no_results' ? 'AvistaZ search completed but found no results.'
                  : result.status === 'allowance' ? 'the daily AvistaZ grab allowance is exhausted for today.'
                    : `AvistaZ search failed: ${result.error || 'unknown error'}`;
            return res.json({ ok: result.status !== 'error', message: `${series.title} S${pad(seasonNumber)} — ${statusText}` });
          }
          const command = await triggerSeasonSearch(seriesId, seasonNumber);
          clearSeasonAlertState(seriesId, seasonNumber);
          const stallCount = recordSeasonSearch({ seriesId, seasonNumber, seriesTitle: series.title, missing: missing.length });
          monitorSeasonSearch({ seriesId, seriesTitle: series.title, seriesYear: series.year, seriesAliases: sonarrSeriesAliases(series), seasonNumber, missingAtSearch: missing.length, commandId: command?.id, stallCount });
          audit('dashboard_search', { ...dashboardActor(req), ok: true, kind, seriesId, seasonNumber, title: series.title, route: 'sonarr', commandId: command?.id || null, override: force });
          return res.json({ ok: true, message: `Sonarr accepted the S${pad(seasonNumber)} season search for ${series.title}.${force ? ' (cooldown overridden)' : ''}` });
        }
        const episode = episodes.find(ep => Number(ep.id) === episodeId && ep.monitored && !ep.hasFile
          && Date.parse(ep.airDateUtc || ep.airDate || '') <= Date.now());
        if (!Number.isInteger(episodeId) || !episode) throw new Error(`Sonarr episode ${episodeId} is not an aired missing episode in this series`);
        await triggerEpisodeSearch([episodeId]);
        audit('dashboard_search', { ...dashboardActor(req), ok: true, kind, seriesId, episodeId, title: series.title, seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber });
        return res.json({ ok: true, message: `Sonarr accepted the S${pad(episode.seasonNumber)}E${pad(episode.episodeNumber)} search for ${series.title}.` });
      } catch (err) {
        const error = dashboardActionError(err);
        audit('dashboard_search', { ...dashboardActor(req), ok: false, kind, seriesId, seasonNumber: Number.isInteger(seasonNumber) ? seasonNumber : null, episodeId: Number.isInteger(episodeId) ? episodeId : null, error });
        return res.status(err?.response ? 502 : 400).json({ ok: false, error });
      }
    });

    app.post('/admin/action/priority', dashboardAuth, (req, res) => {
      const operation = req.body?.operation;
      const key = String(req.body?.key || '');
      if (!['pin', 'unpin', 'move'].includes(operation) || !/^(tvdb|tmdb):\d+$/.test(key)) {
        audit('dashboard_priority', { ...dashboardActor(req), ok: false, operation, key, reason: 'invalid_request' });
        return res.status(400).json({ ok: false, error: 'Invalid priority request.' });
      }
      const rows = listMediaPriority();
      if (operation === 'pin') {
        const mediaType = req.body?.mediaType;
        const title = String(req.body?.title || '').trim();
        if (!['tv', 'movie'].includes(mediaType) || !title) {
          audit('dashboard_priority', { ...dashboardActor(req), ok: false, operation, key, reason: 'missing_media' });
          return res.status(400).json({ ok: false, error: 'Media type and title are required.' });
        }
        setMediaPriority({ key, mediaType, title, rank: nextRank(rows), pinnedBy: 'dashboard' });
      } else if (operation === 'unpin') {
        clearMediaPriority(key);
      } else {
        const index = rows.findIndex(row => row.key === key);
        const direction = Number(req.body?.direction);
        if (index < 0 || ![-1, 1].includes(direction)) {
          audit('dashboard_priority', { ...dashboardActor(req), ok: false, operation, key, reason: 'invalid_move' });
          return res.status(400).json({ ok: false, error: 'Pinned title or direction is invalid.' });
        }
        const target = Math.max(0, Math.min(rows.length - 1, index + direction));
        const [moved] = rows.splice(index, 1);
        rows.splice(target, 0, moved);
        const update = db.prepare('UPDATE media_priority SET rank = ? WHERE key = ?');
        db.transaction(() => rows.forEach((row, rank) => update.run(rank + 1, row.key)))();
      }
      audit('dashboard_priority', { ...dashboardActor(req), ok: true, operation, key });
      return res.json({ ok: true, message: operation === 'pin' ? 'Title pinned.' : operation === 'unpin' ? 'Title unpinned.' : 'Pinned order updated.' });
    });

    // A preview is authenticated but expensive: it reads the whole Sonarr series list and then
    // walks episodes series by series. Held-down Enter on the Preview button, or a stuck bit of
    // dashboard JS, would hammer Sonarr harder than the sweep it is previewing ever does.
    app.post('/admin/action/sweep-preview', rateLimit({
      windowMs: 60000,
      limit: 20,
      keyGenerator: httpRateLimitKey,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) => res.status(429).json({ ok: false, error: 'Too many previews. Wait a moment and try again.' }),
    }), dashboardAuth, async (req, res) => {
      try {
        const items = await previewAutomation(req.body?.name, req.body?.values || {});
        return res.json({ ok: true, items });
      } catch (err) {
        return res.status(400).json({ ok: false, error: dashboardActionError(err) });
      }
    });

    app.post('/admin/action/sweep', dashboardAuth, async (req, res) => {
      const name = req.body?.name;
      const sweeps = {
        stuck: sweepStuckDownloads,
        escalation: sweepEscalations,
        'season-pack': () => sweepSeasonPacks({ rearmAlerts: true }),
        'episode-recovery': runEpisodeRecoverySweep,
      };
      if (!sweeps[name]) {
        audit('dashboard_sweep', { ...dashboardActor(req), ok: false, name, reason: 'invalid_sweep' });
        return res.status(400).json({ ok: false, error: 'Unknown sweep.' });
      }
      try {
        const outcome = await runGuardedSweep(name, sweeps[name]);
        if (!outcome.ok || outcome.result?.busy) {
          audit('dashboard_sweep', { ...dashboardActor(req), ok: false, name, reason: 'already_running' });
          return res.status(409).json({ ok: false, error: `${name} sweep is already running.` });
        }
        const result = outcome.result || {};
        const count = result.searched ?? result.acted ?? result.alerted ?? 0;
        audit('dashboard_sweep', { ...dashboardActor(req), ok: true, name, count, result });
        return res.json({ ok: true, message: `${name} sweep finished with ${count} action(s).`, result });
      } catch (err) {
        const error = dashboardActionError(err);
        audit('dashboard_sweep', { ...dashboardActor(req), ok: false, name, error });
        return res.status(502).json({ ok: false, error });
      }
    });

    app.post('/admin/action/escalate', dashboardAuth, async (req, res) => {
      const id = Number(req.body?.id);
      const row = getEscalationById(id);
      if (req.body?.confirmed !== true) {
        audit('dashboard_escalation', { ...dashboardActor(req), ok: false, id, reason: 'confirmation_required' });
        return res.status(400).json({ ok: false, error: 'Confirmation is required.' });
      }
      if (!row || !['watching', 'alerted', 'error'].includes(row.state)) {
        audit('dashboard_escalation', { ...dashboardActor(req), ok: false, id, reason: 'already_handled' });
        return res.status(409).json({ ok: false, error: 'This escalation was already handled.' });
      }
      const directGrab = usesDirectGrabEscalation(row) && grabConfigured();
      const before = grabDailyAllowance();
      if (directGrab && before.exhausted) {
        audit('dashboard_escalation', { ...dashboardActor(req), ok: false, id, reason: 'allowance_exhausted', remaining: before.remaining });
        return res.status(409).json({ ok: false, error: 'The daily AvistaZ allowance is exhausted.', remaining: before.remaining });
      }
      try {
        const result = await runEscalation(row);
        const after = grabDailyAllowance();
        audit('dashboard_escalation', { ...dashboardActor(req), ok: result.ok, id, mediaId: row.media_id, title: row.title, remainingBefore: before.remaining, remainingAfter: after.remaining, reason: result.reason || result.why || null });
        if (!result.ok) return res.status(result.deferred ? 409 : 502).json({ ok: false, error: result.why || result.reason, remaining: after.remaining });
        return res.json({ ok: true, message: result.detail, remaining: after.remaining });
      } catch (err) {
        const error = dashboardActionError(err);
        audit('dashboard_escalation', { ...dashboardActor(req), ok: false, id, mediaId: row.media_id, title: row.title, error });
        return res.status(502).json({ ok: false, error });
      }
    });
    // Runtime overrides for the automation sweeps. Every write is validated against the setting's
    // declared bounds (src/runtime-settings.js) and audited — an override that quietly changes what
    // the bot does needs the same paper trail as any other admin action.
    app.post('/admin/settings', dashboardAuth, (req, res) => {
      const values = (req.body && req.body.values) || {};
      const errors = [];
      const applied = [];
      for (const [key, raw] of Object.entries(values)) {
        const result = runtimeSettings.setOverride(key, raw, { store: settingsStore });
        if (result.ok) applied.push({ key, value: result.value });
        else errors.push(result.error);
      }
      if (applied.length) audit('runtime_settings_changed', { applied });
      res.status(errors.length ? 400 : 200).json({ ok: !errors.length, applied, errors });
    });

    app.post('/admin/settings/reset', dashboardAuth, (req, res) => {
      const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
      const cleared = keys.filter(key => runtimeSettings.clearOverride(key, { store: settingsStore }).ok);
      if (cleared.length) audit('runtime_settings_reset', { cleared });
      res.json({ ok: true, cleared });
    });

    app.post('/admin/action/revoke-all', dashboardAuth, (_req, res) => { revokeAllDownloadLinks(); res.json({ ok: true }); });
    app.post('/admin/action/revoke-user/:discordId', dashboardAuth, (req, res) => { revokeAllDownloadLinks(req.params.discordId); res.json({ ok: true, discordId: req.params.discordId }); });
  }

  app.get('/', (_req, res) => res.send('Durant Media Server Bot is running.'));

  // Terminal error handler: logs server-side and returns a generic body. Never falls through to
  // Express's default handler, which includes the stack trace in the response whenever
  // NODE_ENV !== 'production' — these routes are internet-reachable via TUNNEL_DOMAIN.
  app.use((err, req, res, next) => {
    if (err && err.name === 'MulterError') {
      log.warn(`Multer error on ${req.path}: ${err.message}`);
      return res.sendStatus(200);
    }
    log.error(`Unhandled error on ${req.method} ${req.path}: ${err && err.stack ? err.stack : err}`);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Internal Server Error' });
  });

  httpServer = app.listen(CONFIG.PORT, () => log.ok(`Express server listening on port ${CONFIG.PORT}`));
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
    // Mirrors the guildMemberAdd welcome-DM failure alert: every other dmUser caller (approval,
    // denial, escalation, etc.) used to fail silently to stdout-only log.warn, so the requester
    // could be approved/denied and never find out unless an admin happened to notice.
    const title = payload?.embeds?.[0]?.data?.title;
    notifyChannel('system', { embeds: [brandedEmbed(COLORS.WARN)
      .setTitle('⚠️ DM Failed')
      .setDescription(`Couldn't DM <@${discordId}>${title ? ` — "${title}"` : ''} — they likely have server DMs turned off. Follow up another way if this was important.`)] });
    return false;
  }
}

async function handleOverseerrWebhook(body) {
  const { notification_type, subject, media, request } = body;
  if (!notification_type || !media) return;
  const titleMatch = subject?.match(/^.+? - (.+)$/);
  const title = titleMatch ? titleMatch[1] : (subject || 'Unknown Title');
  const raw4k = media.is4k;
  const is4k = raw4k === true || raw4k === 1 || ['1', 'true', 'yes', '4k'].includes(String(raw4k || '').toLowerCase());
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
  if (notification_type === 'MEDIA_DECLINED' && media.tmdbId != null) clearRequestSubscribers(subscriberKeyFor(media.tmdbId, is4k));

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
    // Close the loop for PH users: the import just finished on Main, so kick the cache
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

  // Fan the same "it's ready" DM out to everyone who asked for this while it was already in
  // flight (#75) — always keyed tmdb:<id> regardless of media type, since that's the identifier
  // subscribers were recorded under. Runs even without a primary requesterDiscordId.
  if (notification_type === 'MEDIA_AVAILABLE' && media.tmdbId != null) {
    const subscriberKey = subscriberKeyFor(media.tmdbId, is4k);
    const subscribers = listRequestSubscribers(subscriberKey).filter(id => id !== requesterDiscordId);
    if (subscribers.length) {
      const embed = brandedEmbed(COLORS.SUCCESS)
        .setTitle('🍿 Now Available on Plex')
        .setDescription(`**${title}** is ready to watch — enjoy!\n\nWant something else? Use \`/download\` or request more anytime.`);
      if (poster) embed.setImage(poster);
      for (const discordId of subscribers) {
        const sent = await dmUser(discordId, { embeds: [embed] });
        if (sent) audit('media_available_notification_sent', { targetDiscordId: discordId, title, subscriber: true });
      }
    }
    clearRequestSubscribers(subscriberKey);
  }

  // "What's new" — the bot receives every MEDIA_AVAILABLE event already; post it somewhere the
  // whole community sees it instead of only DMing the requester(s). Keyed by mediaId (stable
  // across seasons) rather than title text, so a show that lands in a few separate season drops
  // within WHATS_NEW_GROUP_WINDOW_HOURS collapses into one post instead of one per season.
  if (CONFIG.WHATS_NEW_ENABLED && notification_type === 'MEDIA_AVAILABLE') {
    const lastPostKey = `whats_new_posted:${mediaId}`;
    const last = Number(getSetting(lastPostKey) || '0');
    if (Date.now() - last >= CONFIG.WHATS_NEW_GROUP_WINDOW_HOURS * 3600000) {
      setSetting(lastPostKey, String(Date.now()));
      const embed = brandedEmbed(COLORS.SUCCESS)
        .setTitle(`${mediaTypeEmoji(media.media_type, is4k)} New on Plex`)
        .setDescription(`**${title}** just landed${is4k ? ' in 4K' : ''} — go watch it! 🍿`);
      if (poster) embed.setImage(poster);
      notifyChannel('whats_new', { embeds: [embed] });
      audit('whats_new_posted', { mediaId, title, is4k });
    }
  }
}

async function handlePlexWebhook(payload) {
  const { event, Account, Metadata, Server } = payload;
  // Scrobble = finished (eviction/delete flows). play/resume = playback START, used only to
  // promote a not-yet-cached title on the PH box (§2.2). Anything else is ignored.
  const isPlayStart = event === 'media.play' || event === 'media.resume';
  if ((event !== 'media.scrobble' && !isPlayStart) || !Account || !Metadata) return;
  // Every event is gated on which server it came from BEFORE anything destructive can happen:
  // a PH viewer finishing a movie must never reach the delete flow against the master.
  const origin = classifyServerIdentity({ serverName: Server?.title, machineId: Server?.uuid });
  if (origin === 'unknown') {
    audit('webhook_server_unmatched', { source: 'plex', serverName: Server?.title || null, machineId: Server?.uuid || null, event });
    return;
  }
  if (origin === 'ca-edge') {
    // California is in the Main viewing group, but it is a constrained cache/fallback node.
    // Its storage is managed by the tier agent; playback must never arm full-Main deletion or
    // accidentally enter the Philippines staging queue.
    audit('edge_playback_observed', { edge: 'california', source: 'plex', serverName: Server?.title || null, machineId: Server?.uuid || null, event });
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
  // Play-start only promotes, and only on the PH box (primary plays are already local). The Plex
  // webhook carries no email, so attribution falls back to the Plex account id for rate limiting.
  if (isPlayStart) {
    if (origin === 'ph') await handlePhPlayStart({ mediaId, title, mediaType: mediaType === 'episode' ? 'tv' : 'movie', watcherKey: Account?.id != null ? `plex:${Account.id}` : undefined });
    return;
  }
  if (origin === 'ph') {
    return handlePhWatchedEvent({ event: 'watched', mediaId, title, mediaType: mediaType === 'episode' ? 'tv' : 'movie' });
  }
  // A Plex episode webhook identifies the series by TVDB id, not the exact Sonarr episode file.
  // Never turn one finished episode into a whole-series delete prompt.
  if (mediaType === 'episode') {
    audit('cleanup_prompt_skipped_tv_scope', { source: 'plex', mediaId, title, reason: 'episode_not_resolved' });
    return;
  }
  if (mediaType === 'movie' && !is4k) return;
  if (isInKeepList(mediaId) || CONFIG.NEVER_DELETE_MEDIA_IDS.includes(mediaId)) return;

  const reqRow = db.prepare('SELECT * FROM requests WHERE media_id = ? AND is_4k = 1 ORDER BY created_at DESC LIMIT 1').get(mediaId);
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
  const autoLine = CONFIG.ENABLE_DELETION ? `\n\n⏳ The **4K Radarr copy only** auto-deletes in ${CONFIG.DELETION_GRACE_HOURS} hour(s) unless you choose **Keep**.` : '';
  await adminChannel.send({ content: `<@${reqRow.requested_by_discord_id}>`, embeds: [brandedEmbed(COLORS.WARN).setTitle('🎥 Finished Watching · 4K Edition').setDescription(`Looks like you finished **${title}**. Should we keep the **4K Radarr copy** or free up space? The standard copy is never part of this action.${autoLine}`)], components: [row] });
  recordPendingDeletion(mediaId, 'movie', title, reqRow.requested_by_discord_id, { is4k: true, arrSource: 'radarr-4k' });
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
  if (origin === 'ca-edge') {
    audit('edge_playback_observed', { edge: 'california', source: 'tautulli', serverName: server_name || null, machineId: machine_id || null, event });
    return;
  }
  const mediaId = media_type === 'movie' ? `tmdb:${tmdb_id}` : `tvdb:${tvdb_id}`;
  if (!tmdb_id && media_type === 'movie') return;
  if (!tvdb_id && media_type === 'episode') return;
  const mappedType = media_type === 'episode' ? 'tv' : 'movie';
  const eventTitle = media_type === 'episode' ? (grandparent_title || title) : title;
  // Tautulli "Playback Start" (event 'play') on the PH box → promote a not-yet-cached title so
  // the next play is local (§2.2). The payload carries user_email, so promotion is attributed to
  // the linked watcher for the daily cap. Only PH; primary plays need no promotion.
  if (event === 'play') {
    if (origin === 'ph') await handlePhPlayStart({ mediaId, title: eventTitle, mediaType: mappedType, watcherEmail: user_email });
    return;
  }
  if (origin === 'ph') {
    return handlePhWatchedEvent({ event, mediaId, title: eventTitle, mediaType: mappedType, watcherEmail: user_email });
  }
  if (event !== 'watched' || !user_email) return;
  if (media_type === 'episode') {
    audit('cleanup_prompt_skipped_tv_scope', { source: 'tautulli', mediaId, title: eventTitle, reason: 'episode_not_resolved' });
    return;
  }
  const resolutionFlag = String(is_4k || '').toLowerCase();
  const is4k = resolutionFlag.includes('4k') || ['1', 'true', 'yes'].includes(resolutionFlag);
  if (media_type === 'movie' && !is4k) return;
  const reqRow = db.prepare('SELECT * FROM requests WHERE media_id = ? AND is_4k = 1 ORDER BY created_at DESC LIMIT 1').get(mediaId);
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
  const tautulliAutoLine = CONFIG.ENABLE_DELETION ? `\n\n⏳ The **4K Radarr copy only** auto-deletes in ${CONFIG.DELETION_GRACE_HOURS} hour(s) unless you choose **Keep**.` : '';
  await adminChannel.send({ content: `<@${reqRow.requested_by_discord_id}>`, embeds: [brandedEmbed(COLORS.WARN).setTitle('🎥 Finished Watching · 4K Edition').setDescription(`Looks like you finished **${showTitle}**. Keep the **4K Radarr copy**, or free up space? The standard copy is never part of this action.${tautulliAutoLine}`)], components: [row] });
  recordPendingDeletion(mediaId, 'movie', showTitle, reqRow.requested_by_discord_id, { is4k: true, arrSource: 'radarr-4k' });
}

// A play-START on the PH box (Plex media.play/resume, Tautulli 'play'). Two jobs:
//   1) ALWAYS bump the LRU clock for an already-cached title — playing it is recent use, and a
//      play that's abandoned or resumed below the watch threshold may never emit a 'watched'
//      event. This must run regardless of EDGE_PROMOTE_ON_PLAY: it's the parity behaviour the old
//      handlePhWatchedEvent gave 'play' events, and dropping it would let a just-played title look
//      cold and get evicted.
//   2) If promotion is enabled AND the title isn't cached, stage it so the next play is local
//      (§2.2 PH pilot). EDGE_PROMOTE_AUDIT_ONLY decides + logs without copying. The pure decision
//      lives in staging.planPlayPromotion; this supplies the impure facts.
async function handlePhPlayStart({ mediaId, title, mediaType, watcherEmail, watcherKey }) {
  if (!stagingConfigured()) return;
  const staged = getStagedItem(mediaId);
  if (staged) touchStagedItem(mediaId);
  if (!CONFIG.EDGE_PROMOTE_ON_PLAY) return;
  // Attribute to the linked Discord user when we can resolve the watcher's email, else a stable
  // per-watcher fallback (Plex account id) so one PH viewer can't blow past the cap under 'anon'.
  const watcher = watcherEmail ? getUserByCanonicalEmail(watcherEmail) : null;
  const attributedId = [watcher?.discord_id, watcherEmail && `email:${watcherEmail}`, watcherKey, 'edge-anon'].find(Boolean);
  const DAY_MS = 86400000;
  // Peek the daily cap WITHOUT consuming — a skipped/audited event must not burn the budget; we
  // only consume a token when we actually enqueue a copy. §Phase2: the counter is now durable in
  // SQLite (edge_promote_log), so a restart no longer re-arms everyone's budget mid-day.
  const capOk = countRecentPromotions(attributedId, DAY_MS) < CONFIG.EDGE_PROMOTE_MAX_PER_USER_PER_DAY;
  const plan = planPlayPromotion({
    enabled: CONFIG.EDGE_PROMOTE_ON_PLAY,
    alreadyStaged: !!staged,
    lastPromoteAt: Number(getSetting(`promote_last:${mediaId}`) || '0'),
    now: Date.now(),
    cooldownMs: CONFIG.EDGE_PROMOTE_COOLDOWN_HOURS * 3600000,
    rateLimitOk: capOk,
    auditOnly: CONFIG.EDGE_PROMOTE_AUDIT_ONLY,
  });
  if (plan.action === 'skip') {
    if (plan.reason === 'rate_limited') audit('edge_promote_rate_limited', { mediaId, title, attributedId });
    return;
  }
  if (plan.action === 'audit') {
    audit('edge_promote_would_stage', { mediaId, title, mediaType, attributedId });
    return;
  }
  // enqueue: consume a daily token (durable), set the per-title cooldown, queue the copy. The stage
  // worker dedupes an already-active job, and origin:'play' stays silent (no completion DM).
  recordPromotion(attributedId, mediaId, DAY_MS);
  setSetting(`promote_last:${mediaId}`, String(Date.now()));
  const stageDiscordId = isSnowflake(attributedId) ? attributedId : CONFIG.ADMIN_USER_ID;
  const { duplicate } = enqueueStageJob({ mediaId, mediaType, title, discordId: stageDiscordId, origin: 'play' });
  audit('edge_promote_enqueued', { mediaId, title, mediaType, attributedId, duplicate });
}

// A playback event from the PH box. Any event bumps the LRU clock for a cached title; a
// finished watch re-uses the familiar 90% prompt UX, but pointed at the CACHE: "Yes" frees
// local cache space and the Main copies are untouched either way.
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
    .setDescription(`Looks like you finished **${staged.title || title}**. Free up ${fmtSpace(staged.size_bytes)} of cache space?\n\nEither way the Main copies are untouched — \`/stage\` brings it back anytime.`)], components: [row] });
  audit('evict_prompt_sent', { mediaId, title: staged.title || title, targetDiscordId: targetId });
}

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  log.error(`Unhandled rejection: ${message}`);
  try { audit('unhandled_rejection', { error: reason instanceof Error ? reason.message : String(reason) }); } catch (_e) {}
});

// Node's default behavior for an uncaught exception (no handler at all) is to print it and
// exit — installing this handler suppresses that, so it must still terminate the process itself.
// "It is not safe to resume normal operation after 'uncaughtException'" per Node's own docs: the
// error could have fired mid-mutation of shared state (a Map, an in-progress DB write), and
// letting the bot keep running risks compounding that into something worse than a restart.
// Exits nonzero so a process manager/Docker treats this as a crash, not a clean stop.
process.on('uncaughtException', (err) => {
  log.error(`Uncaught exception: ${err.stack || err.message}`);
  try { audit('uncaught_exception', { error: err.message }); } catch (_e) {}
  shutdown('uncaughtException', 1).catch(() => process.exit(1));
});

let shuttingDown = false;

async function shutdown(sig, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${sig}, shutting down`);

  // Hard fallback: a stuck in-flight download stream must never block shutdown forever.
  const hardTimeout = setTimeout(() => {
    log.warn('Shutdown drain timed out, forcing exit');
    process.exit(exitCode);
  }, CONFIG.SHUTDOWN_DRAIN_SECONDS * 1000).unref();

  // Stop accepting new HTTP connections first (webhooks, dashboard, in-flight /download/:token
  // streams) and give existing ones up to SHUTDOWN_DRAIN_SECONDS to finish before moving on.
  if (httpServer) {
    await new Promise(resolve => httpServer.close(err => {
      if (err) log.warn(`HTTP server close error: ${err.message}`);
      resolve();
    }));
  }

  try { await client.destroy(); } catch (err) { log.warn(`Discord client destroy error: ${err.message}`); }
  try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch (err) { log.warn(`DB close error: ${err.message}`); }

  clearTimeout(hardTimeout);
  process.exit(exitCode);
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
