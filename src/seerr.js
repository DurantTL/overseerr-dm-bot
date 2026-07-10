// Seerr/Overseerr API: users, notification settings, search, requests, self-test.
const axios = require('axios');
const crypto = require('crypto');
const { CONFIG } = require('./config');
const { audit, markOverseerrCreated } = require('./db');
const { canonicalizeEmail } = require('./util');

// Push a Discord ID into a Seerr user's notification settings. Previously this only happened for
// users the bot created, so Plex-imported Seerr users that got "repaired" into the DB never
// received Seerr-side Discord pings. Non-fatal: failures are audited, not thrown.
//
// Seerr 3.3 replaced the per-user `discordId` (string) with `discordIds` (string array) and reads
// ONLY the new key — posting just the old shape "succeeds" but stores an empty list. Send both
// shapes so the same call works on Overseerr / Jellyseerr 2.x (reads discordId, ignores the
// unknown array) and Seerr 3.3+ (reads discordIds, ignores the legacy key). Existing discordIds
// are merged in rather than clobbered, since 3.3 lets admins add extra IDs by hand.
//
// The POST treats the body as a FULL settings update — omitted fields (PGP key, Telegram,
// Pushover, ...) are overwritten with undefined. Round-trip the current settings from the GET as
// the POST base so only the Discord fields change; if the GET fails we abort rather than risk
// wiping the user's other notification settings.
async function setOverseerrDiscordNotification(overseerrUserId, discordId) {
  const headers = { 'X-Api-Key': CONFIG.OVERSEERR_API_KEY };
  try {
    const res = await axios.get(`${CONFIG.OVERSEERR_URL}/api/v1/user/${overseerrUserId}/settings/notifications`, { headers });
    const current = (res.data && typeof res.data === 'object') ? res.data : {};
    const existing = Array.isArray(current.discordIds) ? current.discordIds : [];
    const discordIds = [...new Set([...existing, discordId].map(v => String(v || '').trim()).filter(Boolean))];
    await axios.post(`${CONFIG.OVERSEERR_URL}/api/v1/user/${overseerrUserId}/settings/notifications`, { ...current, discordId, discordIds }, { headers });
    return true;
  } catch (err) {
    audit('external_api_error', { provider: 'overseerr', error: err.message, action: 'set_discord_notification', targetDiscordId: discordId, overseerrUserId });
    return false;
  }
}

async function createOverseerrUser(email, discordId, username) {
  const createRes = await axios.post(`${CONFIG.OVERSEERR_URL}/api/v1/user`, {
    email, username, password: crypto.randomUUID(), permissions: 32, userType: 2,
  }, { headers: { 'X-Api-Key': CONFIG.OVERSEERR_API_KEY } });
  const id = createRes.data.id;
  await setOverseerrDiscordNotification(id, discordId);
  return id;
}

// Live end-to-end diagnostic for the Seerr integration, driven by /seerr-test. Creates a
// throwaway Seerr user (never stored in the bot's own DB), pushes a Discord ID through the same
// code path /link uses, reads it back to prove it stored, then deletes the user unless the admin
// asked to keep it for inspection in the Seerr UI. Each step is isolated so one failure still
// yields a full report.
async function runSeerrSelfTest(discordId, { keep = false } = {}) {
  const headers = { 'X-Api-Key': CONFIG.OVERSEERR_API_KEY };
  const steps = [];
  let testUserId = null;
  const finish = () => {
    audit('seerr_selftest', { targetDiscordId: discordId, keep, steps: steps.map(s => `${s.ok ? 'ok' : 'FAIL'}:${s.name}`) });
    return { steps, testUserId };
  };

  try {
    const res = await axios.get(`${CONFIG.OVERSEERR_URL}/api/v1/status`, { headers, timeout: 10000 });
    const version = String(res.data?.version || 'unknown');
    const major = Number.parseInt(version.split('.')[0], 10);
    steps.push({ name: 'Seerr reachable', ok: true, detail: `Version ${version}${major >= 3 ? ' — new multi-ID `discordIds` API' : ' — legacy single `discordId` API'}` });
  } catch (err) {
    steps.push({ name: 'Seerr reachable', ok: false, detail: `Can't reach ${CONFIG.OVERSEERR_URL}: ${err.message}` });
    return finish(); // nothing else can work
  }

  try {
    const res = await axios.get(`${CONFIG.OVERSEERR_URL}/api/v1/settings/notifications/discord`, { headers, timeout: 10000 });
    const enabled = !!res.data?.enabled;
    const hasWebhook = !!res.data?.options?.webhookUrl;
    steps.push(enabled
      ? { name: 'Discord agent enabled', ok: true, detail: hasWebhook ? 'Agent is on with a webhook URL' : 'Agent is on, but no webhook URL is set' }
      : { name: 'Discord agent enabled', ok: false, detail: 'Agent is OFF — Seerr hides the per-user Discord fields until you enable it under **Settings → Notifications → Discord** (set a channel webhook URL and tick Enable Agent)' });
  } catch (err) {
    steps.push({ name: 'Discord agent enabled', ok: false, detail: `Couldn't read agent settings: ${err.message}` });
  }

  const email = `selftest-${Date.now()}@seerr-test.local`;
  try {
    testUserId = await createOverseerrUser(email, discordId, 'bot-selftest');
    steps.push({ name: 'Create test user', ok: true, detail: `Created \`${email}\` (Seerr user #${testUserId}) and pushed your Discord ID via the same call /link uses` });
  } catch (err) {
    steps.push({ name: 'Create test user', ok: false, detail: `Create failed: ${err.message}` });
    return finish();
  }

  try {
    const res = await axios.get(`${CONFIG.OVERSEERR_URL}/api/v1/user/${testUserId}/settings/notifications`, { headers, timeout: 10000 });
    const ids = Array.isArray(res.data?.discordIds) ? res.data.discordIds.map(String) : null;
    if (ids) {
      const ok = ids.includes(String(discordId));
      steps.push({ name: 'Discord ID stored', ok, detail: ok
        ? `Read back \`discordIds = [${ids.join(', ')}]\` (Seerr 3.3+ field)`
        : `Seerr 3.3+ \`discordIds\` came back as [${ids.join(', ')}] — your ID is missing` });
    } else {
      const single = String(res.data?.discordId || '');
      const ok = single === String(discordId);
      steps.push({ name: 'Discord ID stored', ok, detail: ok
        ? `Read back \`discordId = ${single}\` (legacy field)`
        : `Legacy \`discordId\` came back as "${single}" — expected ${discordId}` });
    }
  } catch (err) {
    steps.push({ name: 'Discord ID stored', ok: false, detail: `Read-back failed: ${err.message}` });
  }

  if (keep) {
    steps.push({ name: 'Cleanup', ok: true, detail: `Kept \`${email}\` — open Seerr → **Users → bot-selftest → Settings → Notifications → Discord** to see the field, then delete the user when done` });
  } else {
    try {
      await axios.delete(`${CONFIG.OVERSEERR_URL}/api/v1/user/${testUserId}`, { headers, timeout: 10000 });
      steps.push({ name: 'Cleanup', ok: true, detail: 'Test user deleted' });
    } catch (err) {
      steps.push({ name: 'Cleanup', ok: false, detail: `Couldn't delete test user #${testUserId} (${err.message}) — remove it from Seerr → Users manually` });
    }
  }
  return finish();
}

// Movie/TV search against Seerr, used by /request (both autocomplete and the free-text fallback).
// The query is %-encoded into the URL by hand: axios's default params serializer turns spaces
// into '+', which Overseerr's API rejects (sct/overseerr#2010) — multi-word searches came back
// as errors/empty while single words worked.
async function searchSeerr(query, timeout = 8000) {
  const res = await axios.get(`${CONFIG.OVERSEERR_URL}/api/v1/search?query=${encodeURIComponent(query)}&page=1`, {
    headers: { 'X-Api-Key': CONFIG.OVERSEERR_API_KEY },
    timeout,
  });
  return (res.data?.results || []).filter(r => r.mediaType === 'movie' || r.mediaType === 'tv');
}

// Why `tmdbId` can't be requested again, as a human phrase — or null when it's requestable.
// Movies: any tracked status (pending/downloading/available) blocks a repeat request. TV: only
// blocked when no season is left to request — asking for a show where seasons 1-2 are grabbed
// but 3 just aired is legitimate, and `seasons: 'all'` picks up just the new ones. 4K and
// regular are tracked separately in Seerr, so the check honors is4k. Fails open (null) on any
// API error: a Seerr hiccup shouldn't stop people requesting.
async function checkExistingSeerrMedia(mediaType, tmdbId, is4k) {
  // Media status values shared by Overseerr/Jellyseerr/Seerr.
  const ST = { UNKNOWN: 1, PENDING: 2, PROCESSING: 3, PARTIALLY_AVAILABLE: 4, AVAILABLE: 5 };
  // 6+ (newer Jellyseerr's DELETED) is requestable again, so only 2-5 counts as covered.
  const covered = st => st >= ST.PENDING && st <= ST.AVAILABLE;
  let data;
  try {
    const res = await axios.get(`${CONFIG.OVERSEERR_URL}/api/v1/${mediaType}/${tmdbId}`, { headers: { 'X-Api-Key': CONFIG.OVERSEERR_API_KEY }, timeout: 8000 });
    data = res.data;
  } catch (_e) { return null; }
  const info = data?.mediaInfo;
  const overall = (is4k ? info?.status4k : info?.status) || ST.UNKNOWN;
  if (!info || !covered(overall)) return null;
  if (mediaType === 'movie') {
    if (overall >= ST.PARTIALLY_AVAILABLE) return 'already available on Plex';
    return overall === ST.PROCESSING ? 'already requested and downloading' : 'already requested and waiting for approval';
  }
  if (overall === ST.AVAILABLE) return 'already fully available on Plex';
  // Seasons with no aired episodes can't be requested in Seerr either, so they don't count.
  const requestable = (data.seasons || []).filter(s => s.seasonNumber > 0 && (s.episodeCount == null || s.episodeCount > 0));
  if (!requestable.length) return null;
  const seasonStatus = new Map((info.seasons || []).map(s => [s.seasonNumber, is4k ? s.status4k : s.status]));
  if (requestable.some(s => !covered(seasonStatus.get(s.seasonNumber) || ST.UNKNOWN))) return null;
  const allAvailable = requestable.every(s => seasonStatus.get(s.seasonNumber) === ST.AVAILABLE);
  return allAvailable ? 'already fully available on Plex' : 'already requested — every season is on Plex or already on its way';
}

// Place a Seerr request AS a specific Seerr user. The admin API key has MANAGE_USERS, which is
// what lets the body's userId override the requesting identity — this is how requests made from
// Discord get attributed to the real person instead of the server owner.
async function createSeerrRequestAs(seerrUserId, mediaType, tmdbId, is4k) {
  const body = { mediaType, mediaId: tmdbId, is4k: !!is4k, userId: seerrUserId };
  if (mediaType === 'tv') body.seasons = 'all';
  const res = await axios.post(`${CONFIG.OVERSEERR_URL}/api/v1/request`, body, { headers: { 'X-Api-Key': CONFIG.OVERSEERR_API_KEY }, timeout: 15000 });
  // A proxy or fork can hand axios the JSON body as a raw string — normalize before inspecting.
  let data = res.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_e) { /* keep raw */ } }
  const id = data?.id ?? data?.request?.id ?? null;
  // Overseerr answers "no seasons available to request" with HTTP 202 + a message and creates
  // NOTHING — axios counts 2xx as success, so an approved TV request could silently never reach
  // Seerr while the bot reports it as sent. Only that confident no-op shape (202, or a message
  // with no request id) becomes an error, normalized to the axios shape 4xx rejections produce.
  // A 2xx whose body just looks unfamiliar still counts as success — some Seerr variants shape
  // the created request differently, and rejecting those failed every real request.
  if (res.status === 202 || (id == null && typeof data?.message === 'string')) {
    const err = new Error(data?.message || `Seerr created no request (HTTP ${res.status})`);
    err.response = res;
    throw err;
  }
  if (id == null) audit('external_api_error', { provider: 'overseerr', action: 'create_request_odd_response', error: `HTTP ${res.status}, body: ${JSON.stringify(res.data).slice(0, 300)}` });
  return (data && typeof data === 'object') ? data : res.data;
}

// Seerr user id for a linked DB row, backfilling rows that predate overseerr_user_id tracking
// by matching the Seerr user list on canonical email.
async function resolveSeerrUserId(row) {
  if (row.overseerr_user_id != null) return row.overseerr_user_id;
  const key = canonicalizeEmail(row.email);
  const match = (await fetchOverseerrUsers()).find(u => u.email && canonicalizeEmail(u.email) === key);
  if (match?.id == null) return null;
  markOverseerrCreated(row.discord_id, match.id);
  return match.id;
}

async function approveOverseerrRequest(requestId) {
  return axios.post(`${CONFIG.OVERSEERR_URL}/api/v1/request/${requestId}/approve`, {}, { headers: { 'X-Api-Key': CONFIG.OVERSEERR_API_KEY } });
}

async function denyOverseerrRequest(requestId) {
  return axios.post(`${CONFIG.OVERSEERR_URL}/api/v1/request/${requestId}/decline`, {}, { headers: { 'X-Api-Key': CONFIG.OVERSEERR_API_KEY } });
}

async function fetchOverseerrUsers() {
  const res = await axios.get(`${CONFIG.OVERSEERR_URL}/api/v1/user?take=200`, { headers: { 'X-Api-Key': CONFIG.OVERSEERR_API_KEY } });
  return res.data.results || [];
}

module.exports = { setOverseerrDiscordNotification, createOverseerrUser, runSeerrSelfTest, searchSeerr, checkExistingSeerrMedia, createSeerrRequestAs, resolveSeerrUserId, approveOverseerrRequest, denyOverseerrRequest, fetchOverseerrUsers };
