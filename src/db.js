// SQLite storage: schema migrations plus every row helper (users, requests, keep list,
// download tokens, settings, audit log, pending-request stash).
const Database = require('better-sqlite3');
const crypto = require('crypto');
const { CONFIG } = require('./config');
const { sha256, canonicalizeEmail, isSnowflake } = require('./util');

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

    CREATE TABLE IF NOT EXISTS pending_deletions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id TEXT NOT NULL UNIQUE,
      media_type TEXT,
      title TEXT,
      requestor_discord_id TEXT,
      prompt_sent_at INTEGER,
      delete_after INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS media_retention_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_class TEXT UNIQUE,
      retention_days INTEGER NOT NULL,
      enabled INTEGER DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS escalations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id TEXT NOT NULL UNIQUE,
      media_type TEXT NOT NULL,
      tmdb_id INTEGER NOT NULL,
      tvdb_id INTEGER,
      title TEXT NOT NULL,
      requested_by_discord_id TEXT,
      pre_authorized INTEGER DEFAULT 0,
      state TEXT DEFAULT 'watching',
      approved_at INTEGER NOT NULL,
      alerted_at INTEGER,
      escalated_at INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stage_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id TEXT NOT NULL,
      media_type TEXT NOT NULL,
      title TEXT NOT NULL,
      requested_by_discord_id TEXT,
      origin TEXT DEFAULT 'command',
      status TEXT DEFAULT 'queued',
      size_bytes INTEGER DEFAULT 0,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at INTEGER,
      finished_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS staged_items (
      media_id TEXT PRIMARY KEY,
      media_type TEXT,
      title TEXT,
      dest_path TEXT NOT NULL,
      size_bytes INTEGER DEFAULT 0,
      pinned INTEGER DEFAULT 0,
      pinned_by_discord_id TEXT,
      staged_by_discord_id TEXT,
      staged_at INTEGER,
      last_streamed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_stage_jobs_status ON stage_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_requests_media ON requests(media_id);
    CREATE INDEX IF NOT EXISTS idx_requests_requester ON requests(requested_by_discord_id);
    CREATE INDEX IF NOT EXISTS idx_download_tokens_discord ON download_tokens(discord_id);
    CREATE INDEX IF NOT EXISTS idx_download_tokens_expires ON download_tokens(expires_at);
    CREATE INDEX IF NOT EXISTS idx_download_access_created ON download_access_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_action_created ON audit_log(action, created_at);
    CREATE INDEX IF NOT EXISTS idx_escalations_state ON escalations(state);
  `);

  ensureColumn('users', 'overseerr_user_id', 'INTEGER');
  ensureColumn('users', 'plex_username', 'TEXT');
  // Which Plex server a person belongs to: 'primary' (California master) or 'ph' (remote cache
  // box). Watch state never syncs between servers, so invites and auto-staging key off this.
  ensureColumn('users', 'home_server', "TEXT DEFAULT 'primary'");
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

  // Old code stored '' when a webhook had no request id; those rows collided on the UNIQUE
  // column and overwrote each other. NULL is allowed to repeat.
  db.prepare("UPDATE requests SET overseerr_request_id = NULL WHERE overseerr_request_id = ''").run();

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

// basic helpers
function storeUserEmail(discordId, email) {
  db.prepare(`INSERT INTO users (discord_id, email, requested_at)
    VALUES (?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET email=excluded.email, requested_at=excluded.requested_at, overseerr_created=0, overseerr_user_id=NULL`)
    .run(discordId, email.toLowerCase().trim(), new Date().toISOString());
}

// Link a Discord ID to an email, absorbing any synthetic plex_ row that holds the same canonical
// email. Without the absorb, /link (and the DM email flow) created a second row for the same human
// and left the stale plex_ row behind — an instant duplicate-email pair. Carried-over flags
// (invited / overseerr_created / overseerr_user_id / plex_username) survive the merge so we don't
// re-invite or re-create a Seerr user for someone who already has both.
function linkUserToEmail(discordId, email) {
  const key = canonicalizeEmail(email);
  const absorbed = key && !key.startsWith('__placeholder__:')
    ? db.prepare('SELECT * FROM users').all().find(u =>
        u.discord_id !== discordId
        && u.discord_id.startsWith('plex_')
        && canonicalizeEmail(u.email) === key)
    : null;
  storeUserEmail(discordId, email);
  if (absorbed) {
    db.prepare(`UPDATE users SET
        invited = MAX(invited, ?),
        invited_at = COALESCE(invited_at, ?),
        overseerr_created = MAX(overseerr_created, ?),
        overseerr_user_id = COALESCE(overseerr_user_id, ?),
        plex_username = COALESCE(plex_username, ?)
      WHERE discord_id = ?`)
      .run(absorbed.invited ? 1 : 0, absorbed.invited_at, absorbed.overseerr_created ? 1 : 0, absorbed.overseerr_user_id, absorbed.plex_username, discordId);
    removeUser(absorbed.discord_id);
    audit('plex_row_absorbed', { targetDiscordId: discordId, email, absorbedRow: absorbed.discord_id, absorbedEmail: absorbed.email });
  }
  return { absorbed };
}

const getUserByDiscordId = discordId => db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);

// Canonical-email lookup (gmail dots/plus-tags collapse). Prefers rows with a real Discord
// snowflake over synthetic plex_ rows so notifications reach the actual person.
function getUserByCanonicalEmail(email) {
  const key = canonicalizeEmail(email);
  if (!key || key.startsWith('__placeholder__:')) return null;
  const matches = db.prepare('SELECT * FROM users').all().filter(u => canonicalizeEmail(u.email) === key);
  return matches.find(u => isSnowflake(u.discord_id)) || matches[0] || null;
}

const markUserInvited = discordId => db.prepare('UPDATE users SET invited = 1, invited_at = ? WHERE discord_id = ?').run(new Date().toISOString(), discordId);

const markOverseerrCreated = (discordId, overseerrId) => db.prepare('UPDATE users SET overseerr_created = 1, overseerr_user_id = ? WHERE discord_id = ?').run(overseerrId, discordId);

const removeUser = discordId => db.prepare('DELETE FROM users WHERE discord_id = ?').run(discordId);

function upsertRequest(overseerrRequestId, mediaId, mediaType, is4k, title, discordId, status) {
  // Later webhook events (approved/available) often arrive without requestedBy fields.
  // INSERT OR REPLACE used to wipe the original requester (breaking keep/delete attribution),
  // and '' request ids from those events all collided on the UNIQUE column. COALESCE keeps
  // the first known requester; missing request ids fall back to updating the media row.
  const reqId = overseerrRequestId ? String(overseerrRequestId) : null;
  if (reqId) {
    db.prepare(`INSERT INTO requests (overseerr_request_id, media_id, media_type, is_4k, title, requested_by_discord_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(overseerr_request_id) DO UPDATE SET
        status = excluded.status,
        title = excluded.title,
        requested_by_discord_id = COALESCE(excluded.requested_by_discord_id, requests.requested_by_discord_id)`)
      .run(reqId, mediaId, mediaType, is4k ? 1 : 0, title, discordId || null, status);
    return;
  }
  const updated = db.prepare(`UPDATE requests SET status = ?,
      requested_by_discord_id = COALESCE(?, requested_by_discord_id)
    WHERE media_id = ?`).run(status, discordId || null, mediaId);
  if (!updated.changes) {
    db.prepare(`INSERT INTO requests (overseerr_request_id, media_id, media_type, is_4k, title, requested_by_discord_id, status)
      VALUES (NULL, ?, ?, ?, ?, ?, ?)`)
      .run(mediaId, mediaType, is4k ? 1 : 0, title, discordId || null, status);
  }
}

function addToKeepList(mediaId, mediaType, title, discordId, keepDays = CONFIG.KEEP_LIST_DEFAULT_DAYS) {
  const expiresAt = keepDays > 0 ? Date.now() + keepDays * 86400000 : null;
  db.prepare('INSERT OR REPLACE INTO keep_list (media_id, media_type, title, kept_by_discord_id, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(mediaId, mediaType, title, discordId || null, expiresAt);
}

function isInKeepList(mediaId) {
  return !!db.prepare('SELECT id FROM keep_list WHERE media_id = ? AND (expires_at IS NULL OR expires_at > ?)').get(mediaId, Date.now());
}

// The "Finished Watching" prompt promises auto-deletion after the grace period; these rows are
// what the janitor sweep actually enforces. Re-prompting the same media resets the clock.
function recordPendingDeletion(mediaId, mediaType, title, requestorDiscordId) {
  const now = Date.now();
  db.prepare(`INSERT INTO pending_deletions (media_id, media_type, title, requestor_discord_id, prompt_sent_at, delete_after, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
    ON CONFLICT(media_id) DO UPDATE SET
      title = excluded.title,
      requestor_discord_id = excluded.requestor_discord_id,
      prompt_sent_at = excluded.prompt_sent_at,
      delete_after = excluded.delete_after,
      status = 'pending',
      updated_at = CURRENT_TIMESTAMP`)
    .run(mediaId, mediaType, title, requestorDiscordId || null, now, now + CONFIG.DELETION_GRACE_HOURS * 3600000);
}

function markPendingDeletion(mediaId, status) {
  db.prepare('UPDATE pending_deletions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE media_id = ?').run(status, mediaId);
}

function postponePendingDeletion(mediaId, deleteAfterMs) {
  db.prepare("UPDATE pending_deletions SET delete_after = ?, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE media_id = ?").run(deleteAfterMs, mediaId);
}

// ---- AvistaZ escalation watch list ----
// One row per title the watchdog should keep an eye on after approval. Keyed by the canonical
// tmdb:<id> (webhooks may report TV as tvdb:<id>, hence the extra tvdb_id column for matching).
// Re-approving the same title resets the clock; pre-authorization is sticky so a plain re-approve
// can't silently downgrade an admin's earlier "go to AvistaZ if needed".
function recordEscalationWatch({ mediaType, tmdbId, tvdbId, title, discordId, preAuthorized }) {
  db.prepare(`INSERT INTO escalations (media_id, media_type, tmdb_id, tvdb_id, title, requested_by_discord_id, pre_authorized, state, approved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'watching', ?)
    ON CONFLICT(media_id) DO UPDATE SET
      tvdb_id = COALESCE(excluded.tvdb_id, escalations.tvdb_id),
      title = excluded.title,
      requested_by_discord_id = COALESCE(excluded.requested_by_discord_id, escalations.requested_by_discord_id),
      pre_authorized = MAX(excluded.pre_authorized, escalations.pre_authorized),
      state = 'watching',
      approved_at = excluded.approved_at,
      updated_at = CURRENT_TIMESTAMP`)
    .run(`tmdb:${tmdbId}`, mediaType, tmdbId, tvdbId ?? null, title, discordId || null, preAuthorized ? 1 : 0, Date.now());
}

const getWatchingEscalations = () => db.prepare("SELECT * FROM escalations WHERE state = 'watching'").all();

const getEscalationById = id => db.prepare('SELECT * FROM escalations WHERE id = ?').get(id);

function setEscalationState(id, state) {
  const stampCol = state === 'alerted' ? 'alerted_at' : state === 'escalated' ? 'escalated_at' : null;
  const stamp = stampCol ? `, ${stampCol} = ?` : '';
  const args = stampCol ? [state, Date.now(), id] : [state, id];
  db.prepare(`UPDATE escalations SET state = ?${stamp}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...args);
}

function setEscalationTvdbId(id, tvdbId) {
  db.prepare('UPDATE escalations SET tvdb_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(tvdbId, id);
}

// Called from the Seerr webhook when media becomes available (or the request is declined) so
// watch rows resolve promptly instead of waiting for the next sweep. mediaKey follows the
// webhook convention: 'tmdb:<id>' or 'tvdb:<id>'.
function resolveEscalationForMediaKey(mediaKey) {
  const m = /^(tmdb|tvdb):(\d+)$/.exec(String(mediaKey || ''));
  if (!m) return;
  const [, kind, idStr] = m;
  const id = Number(idStr);
  if (kind === 'tmdb') {
    db.prepare("UPDATE escalations SET state = 'resolved', updated_at = CURRENT_TIMESTAMP WHERE media_id = ? AND state IN ('watching','alerted')").run(`tmdb:${id}`);
  } else {
    db.prepare("UPDATE escalations SET state = 'resolved', updated_at = CURRENT_TIMESTAMP WHERE tvdb_id = ? AND state IN ('watching','alerted')").run(id);
  }
}

// ---- Plex Home staging queue + cache inventory ----
// stage_jobs is the durable copy queue: a transpacific rclone copy can run 20+ minutes and WILL
// be in flight when something restarts, so the queue lives in SQLite and interrupted jobs are
// re-queued at startup (rclone copy skips already-transferred files, so a re-run is cheap).
// staged_items is what's currently warm in the PH cache, with the LRU bookkeeping eviction uses.

const setUserHomeServer = (discordId, server) => db.prepare('UPDATE users SET home_server = ? WHERE discord_id = ?').run(server, discordId);

// One active (queued/copying) job per media id — double /stage or auto-stage racing a manual
// stage collapses onto the existing job instead of copying twice.
function enqueueStageJob({ mediaId, mediaType, title, discordId, origin = 'command' }) {
  const existing = db.prepare("SELECT * FROM stage_jobs WHERE media_id = ? AND status IN ('queued','copying') ORDER BY id LIMIT 1").get(mediaId);
  if (existing) return { duplicate: true, job: existing };
  const info = db.prepare('INSERT INTO stage_jobs (media_id, media_type, title, requested_by_discord_id, origin) VALUES (?, ?, ?, ?, ?)')
    .run(mediaId, mediaType, title, discordId || null, origin);
  return { duplicate: false, job: db.prepare('SELECT * FROM stage_jobs WHERE id = ?').get(info.lastInsertRowid) };
}

const getStageJob = id => db.prepare('SELECT * FROM stage_jobs WHERE id = ?').get(id);

const nextQueuedStageJob = () => db.prepare("SELECT * FROM stage_jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get();

const listActiveStageJobs = () => db.prepare("SELECT * FROM stage_jobs WHERE status IN ('queued','copying') ORDER BY id").all();

function markStageJobCopying(id, sizeBytes) {
  db.prepare("UPDATE stage_jobs SET status = 'copying', size_bytes = ?, started_at = ? WHERE id = ?").run(sizeBytes || 0, Date.now(), id);
}

function finishStageJob(id, status, error = null) {
  db.prepare('UPDATE stage_jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?').run(status, error ? String(error).slice(0, 500) : null, Date.now(), id);
}

// Requeue a failed job (the Retry button). Only failed jobs are retryable — anything else is
// either still moving or already done.
function requeueStageJob(id) {
  return db.prepare("UPDATE stage_jobs SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL WHERE id = ? AND status = 'failed'").run(id).changes > 0;
}

// A restart mid-copy leaves 'copying' rows behind; put them back in the queue.
function resetInterruptedStageJobs() {
  return db.prepare("UPDATE stage_jobs SET status = 'queued', started_at = NULL WHERE status = 'copying'").run().changes;
}

function recordStagedItem({ mediaId, mediaType, title, destPath, sizeBytes, discordId }) {
  db.prepare(`INSERT INTO staged_items (media_id, media_type, title, dest_path, size_bytes, staged_by_discord_id, staged_at, last_streamed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(media_id) DO UPDATE SET
      title = excluded.title,
      dest_path = excluded.dest_path,
      size_bytes = excluded.size_bytes,
      staged_at = excluded.staged_at`)
    .run(mediaId, mediaType, title, destPath, sizeBytes || 0, discordId || null, Date.now());
}

const getStagedItem = mediaId => db.prepare('SELECT * FROM staged_items WHERE media_id = ?').get(mediaId);

const listStagedItems = () => db.prepare('SELECT * FROM staged_items ORDER BY staged_at').all();

const removeStagedItem = mediaId => db.prepare('DELETE FROM staged_items WHERE media_id = ?').run(mediaId);

// LRU touch — every PH playback event for a cached title lands here so eviction order tracks
// what actually gets watched, not what got copied first.
const touchStagedItem = mediaId => db.prepare('UPDATE staged_items SET last_streamed_at = ? WHERE media_id = ?').run(Date.now(), mediaId);

function setStagedItemPinned(mediaId, pinned, discordId) {
  db.prepare('UPDATE staged_items SET pinned = ?, pinned_by_discord_id = ? WHERE media_id = ?').run(pinned ? 1 : 0, pinned ? (discordId || null) : null, mediaId);
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

// ---- Bot-side approval gate for /request ----
// Seerr auto-approves ANY request created with an admin API key: the status check in
// MediaRequest.request uses the AUTHENTICATED CALLER's permissions (not the request user's),
// and admins pass every permission check — so a pending state never exists Seerr-side and no
// approval webhook can fire. The gate flips the order: a non-admin /request is stashed in
// app_settings (so buttons survive restarts) and posted to the requests channel first; the
// Seerr request is only created when an admin clicks Approve. Deny never touches Seerr.
function stashPendingRequest(payload) {
  const nonce = crypto.randomBytes(4).toString('hex');
  setSetting(`pending_request:${nonce}`, JSON.stringify({ ...payload, createdAt: Date.now() }));
  return nonce;
}

// Read + consume a stashed request. Null means the nonce is unknown or already handled —
// consuming makes double-clicks and stale buttons harmless.
function takePendingRequest(nonce) {
  if (!/^[0-9a-f]{8}$/.test(String(nonce || ''))) return null;
  const raw = getSetting(`pending_request:${nonce}`);
  if (!raw) return null;
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(`pending_request:${nonce}`);
  try { return JSON.parse(raw); } catch (_e) { return null; }
}

// Put a consumed request back (approve failed against Seerr) so the button can be retried.
function restashPendingRequest(nonce, payload) {
  setSetting(`pending_request:${nonce}`, JSON.stringify(payload));
}

module.exports = { db, ensureColumn, runMigrations, audit, storeUserEmail, linkUserToEmail, getUserByDiscordId, getUserByCanonicalEmail, markUserInvited, markOverseerrCreated, removeUser, upsertRequest, addToKeepList, isInKeepList, recordPendingDeletion, markPendingDeletion, postponePendingDeletion, recordEscalationWatch, getWatchingEscalations, getEscalationById, setEscalationState, setEscalationTvdbId, resolveEscalationForMediaKey, setUserHomeServer, enqueueStageJob, getStageJob, nextQueuedStageJob, listActiveStageJobs, markStageJobCopying, finishStageJob, requeueStageJob, resetInterruptedStageJobs, recordStagedItem, getStagedItem, listStagedItems, removeStagedItem, touchStagedItem, setStagedItemPinned, createDownloadToken, getDownloadRecordByRawToken, revokeAllDownloadLinks, cleanExpiredTokens, getSetting, setSetting, stashPendingRequest, takePendingRequest, restashPendingRequest };
