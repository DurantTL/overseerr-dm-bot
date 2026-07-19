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

    CREATE TABLE IF NOT EXISTS grab_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id TEXT,
      media_type TEXT NOT NULL,
      title TEXT NOT NULL,
      release_title TEXT NOT NULL,
      info_hash TEXT,
      size_bytes INTEGER DEFAULT 0,
      label TEXT,
      requested_by_discord_id TEXT,
      origin TEXT DEFAULT 'manual',
      state TEXT DEFAULT 'sent',
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sent_at INTEGER,
      completed_at INTEGER,
      imported_at INTEGER
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

    CREATE TABLE IF NOT EXISTS tier_nodes (
      name TEXT PRIMARY KEY,
      usable_bytes INTEGER NOT NULL DEFAULT 0,
      headroom_pct INTEGER NOT NULL DEFAULT 15,
      full INTEGER DEFAULT 0,
      access TEXT DEFAULT 'open',
      demand_source TEXT DEFAULT 'tautulli',
      transport TEXT DEFAULT 'syncthing',
      folder_root TEXT,
      tautulli_url TEXT,
      tautulli_api_key TEXT,
      enabled INTEGER DEFAULT 1,
      sticky INTEGER DEFAULT 0,
      warm_days INTEGER,
      fresh_days INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tier_node_members (
      node TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (node, discord_id)
    );

    -- One-to-many Syncthing folders per node (R2.1): a node's library can span several
    -- Receive-Only folders but stays one budget pool / one eviction plan. Legacy single-folder
    -- nodes keep their tier_nodes.folder_root and are migrated into a single row below.
    CREATE TABLE IF NOT EXISTS tier_node_folders (
      node TEXT NOT NULL,
      syncthing_folder_id TEXT NOT NULL DEFAULT '',
      folder_root TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (node, syncthing_folder_id)
    );

    CREATE TABLE IF NOT EXISTS tier_agent_tokens (
      node TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tier_node_files (
      node TEXT NOT NULL,
      folder_id TEXT NOT NULL DEFAULT '',
      rel_path TEXT NOT NULL,
      size_bytes INTEGER DEFAULT 0,
      atime INTEGER,
      reported_at INTEGER,
      PRIMARY KEY (node, folder_id, rel_path)
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
    CREATE INDEX IF NOT EXISTS idx_grab_jobs_state ON grab_jobs(state);
    CREATE INDEX IF NOT EXISTS idx_grab_jobs_hash ON grab_jobs(info_hash);
  `);

  ensureColumn('users', 'overseerr_user_id', 'INTEGER');
  ensureColumn('users', 'plex_username', 'TEXT');
  // Which Plex server a person belongs to: 'primary' (California master) or 'ph' (remote cache
  // box). Watch state never syncs between servers, so invites and auto-staging key off this.
  ensureColumn('users', 'home_server', "TEXT DEFAULT 'primary'");
  ensureColumn('keep_list', 'expires_at', 'INTEGER');
  // Where the torrent's data lives under GRAB_RCLONE_REMOTE when it isn't just the torrent
  // name (adopted torrents can sit in per-label subfolders). NULL = use the rTorrent name.
  ensureColumn('grab_jobs', 'remote_path', 'TEXT');
  // One-shot flag: the "request never landed in the arr" alert was posted for this watch row.
  ensureColumn('escalations', 'arr_missing_alerted', 'INTEGER DEFAULT 0');
  // Tiering: demand_source 'plex' reads watch history straight from the node's PMS (no
  // Tautulli); atime_mask ('HH:MM-HH:MM' UTC) launders Plex-maintenance reads out of the
  // atime LRU signal at report ingest.
  ensureColumn('tier_nodes', 'plex_url', 'TEXT');
  ensureColumn('tier_nodes', 'plex_token', 'TEXT');
  ensureColumn('tier_nodes', 'atime_mask', 'TEXT');

  // R2.1 multi-folder: older installs have tier_node_files keyed on (node, rel_path) with no
  // folder_id. Rebuild it under the new (node, folder_id, rel_path) key so the same relPath can
  // legitimately exist in two folders (e.g. a title held in both the Movies and 4k folders).
  const tnfCols = db.prepare('PRAGMA table_info(tier_node_files)').all().map(c => c.name);
  if (!tnfCols.includes('folder_id')) {
    db.exec(`
      ALTER TABLE tier_node_files RENAME TO tier_node_files_legacy;
      CREATE TABLE tier_node_files (
        node TEXT NOT NULL,
        folder_id TEXT NOT NULL DEFAULT '',
        rel_path TEXT NOT NULL,
        size_bytes INTEGER DEFAULT 0,
        atime INTEGER,
        reported_at INTEGER,
        PRIMARY KEY (node, folder_id, rel_path)
      );
      INSERT INTO tier_node_files (node, folder_id, rel_path, size_bytes, atime, reported_at)
        SELECT node, '', rel_path, size_bytes, atime, reported_at FROM tier_node_files_legacy;
      DROP TABLE tier_node_files_legacy;
    `);
  }
  // Backfill tier_node_folders: any node with a legacy folder_root and no folder rows yet gets
  // one row (empty syncthing_folder_id — the agent's SYNCTHING_FOLDER_ID env still selects the
  // single folder), so existing single-folder nodes migrate transparently.
  db.prepare(`INSERT OR IGNORE INTO tier_node_folders (node, syncthing_folder_id, folder_root)
    SELECT name, '', folder_root FROM tier_nodes
    WHERE folder_root IS NOT NULL AND folder_root != ''
      AND name NOT IN (SELECT node FROM tier_node_folders)`).run();

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

  // .env-seeded fallback for the tiering node registry: only fills an EMPTY table, so runtime
  // edits via /tier-node always win over the seed on later restarts.
  if (CONFIG.TIER_NODES_SEED) {
    try {
      const count = db.prepare('SELECT COUNT(*) AS n FROM tier_nodes').get().n;
      if (count === 0) {
        for (const n of JSON.parse(CONFIG.TIER_NODES_SEED)) {
          if (!n || !n.name) continue;
          upsertTierNode(n);
          // Optional multi-folder seed: [{"name":"california","folders":[{"id":"eeeee-fffff","path":"/mnt/media/Media/Movies"}, ...]}]
          for (const f of Array.isArray(n.folders) ? n.folders : []) {
            if (f && (f.path || f.folder_root)) addTierNodeFolder(n.name, f.id || f.folder_id || '', f.path || f.folder_root);
          }
        }
      }
    } catch (err) {
      audit('tier_seed_failed', { error: err.message });
    }
  }
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

function markEscalationArrMissingAlerted(id) {
  db.prepare('UPDATE escalations SET arr_missing_alerted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
}

// Restart the escalation clock — used after a direct arr add so public indexers get the full
// delay before the AvistaZ fallback, instead of escalating on the very next sweep.
function touchEscalationApprovedAt(id) {
  db.prepare('UPDATE escalations SET approved_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(Date.now(), id);
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

// ---- AvistaZ direct-grab jobs ----
// One row per torrent the bot pushed to the seedbox rTorrent. States:
// sent → downloading → complete (seedbox finished, transfer pending) → transferring →
// done (imported by the arr), or failed. Durable so a restart mid-download/mid-transfer
// picks the pipeline back up.

// state defaults to 'sent' (a torrent the bot just pushed); adoption records jobs directly
// at 'downloading' or 'complete' since the torrent already exists in rTorrent.
function recordGrabJob({ mediaId, mediaType, title, releaseTitle, infoHash, sizeBytes, label, discordId, origin, state = 'sent', remotePath }) {
  const now = Date.now();
  const info = db.prepare(`INSERT INTO grab_jobs (media_id, media_type, title, release_title, info_hash, size_bytes, label, requested_by_discord_id, origin, state, remote_path, sent_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(mediaId || null, mediaType, title, releaseTitle, infoHash || null, sizeBytes || 0, label || null, discordId || null, origin || 'manual', state, remotePath || null, now, state === 'complete' ? now : null);
  return db.prepare('SELECT * FROM grab_jobs WHERE id = ?').get(info.lastInsertRowid);
}

const getGrabJob = id => db.prepare('SELECT * FROM grab_jobs WHERE id = ?').get(id);

// Duplicate guard: a hash that was ever sent and didn't outright fail (still moving, or
// already imported) must not be grabbed again — "already downloaded" is a scoring criterion.
const getGrabJobByHash = infoHash => db.prepare("SELECT * FROM grab_jobs WHERE info_hash = ? AND state != 'failed' ORDER BY id DESC LIMIT 1").get(infoHash);

// Pre-download duplicate check by exact release title, for when Prowlarr didn't report an
// info-hash. Failed jobs don't block a retry of the same release.
const getGrabJobByRelease = releaseTitle => db.prepare("SELECT * FROM grab_jobs WHERE release_title = ? AND state != 'failed' ORDER BY id DESC LIMIT 1").get(releaseTitle);

const listActiveGrabJobs = () => db.prepare("SELECT * FROM grab_jobs WHERE state IN ('sent','downloading','complete','transferring') ORDER BY id").all();

const nextTransferableGrabJob = () => db.prepare("SELECT * FROM grab_jobs WHERE state = 'complete' ORDER BY id LIMIT 1").get();

function setGrabJobState(id, state, error = null) {
  const stampCol = state === 'complete' ? 'completed_at' : state === 'done' ? 'imported_at' : null;
  const stamp = stampCol ? `, ${stampCol} = ?` : '';
  const args = stampCol ? [state, error ? String(error).slice(0, 500) : null, Date.now(), id] : [state, error ? String(error).slice(0, 500) : null, id];
  db.prepare(`UPDATE grab_jobs SET state = ?, error = ?${stamp} WHERE id = ?`).run(...args);
}

// The allowance counts every grab attempted today (failed ones included — the tracker may
// have counted the download the moment the .torrent was fetched). created_at is UTC.
// Adopted jobs never fetched anything from a tracker, so they don't consume a slot.
const countGrabJobsToday = () => db.prepare("SELECT COUNT(*) AS n FROM grab_jobs WHERE created_at >= datetime('now', 'start of day') AND origin NOT LIKE 'adopt%'").get().n;

// Retry a failed transfer/import (the torrent is still seeding on the seedbox, so the
// copy can simply run again). Only failed jobs are retryable.
const requeueGrabTransfer = id => db.prepare("UPDATE grab_jobs SET state = 'complete', error = NULL WHERE id = ? AND state = 'failed'").run(id).changes > 0;

// A restart mid-transfer leaves 'transferring' rows behind; rclone copy resumes cheaply.
const resetInterruptedGrabTransfers = () => db.prepare("UPDATE grab_jobs SET state = 'complete' WHERE state = 'transferring'").run().changes;

// AvistaZ search results parked behind Download buttons. Same app_settings stash pattern
// as the request approval gate: consumed on click, so stale/double clicks are harmless
// and the buttons survive restarts.
function stashGrabOffer(payload) {
  const nonce = crypto.randomBytes(4).toString('hex');
  setSetting(`grab_offer:${nonce}`, JSON.stringify({ ...payload, createdAt: Date.now() }));
  return nonce;
}

function takeGrabOffer(nonce) {
  if (!/^[0-9a-f]{8}$/.test(String(nonce || ''))) return null;
  const raw = getSetting(`grab_offer:${nonce}`);
  if (!raw) return null;
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(`grab_offer:${nonce}`);
  try { return JSON.parse(raw); } catch (_e) { return null; }
}

// Put a consumed offer back (grab failed against rTorrent) so the buttons can be retried.
function restashGrabOffer(nonce, payload) {
  setSetting(`grab_offer:${nonce}`, JSON.stringify(payload));
}

// ---- rTorrent adoption bookkeeping ----
// Adopted jobs are ordinary grab_jobs rows (origin 'adopt'/'adopt-auto') that start at
// 'downloading' or 'complete' instead of 'sent'. The ignore list keeps the discovery sweep
// quiet about torrents the admin never wants adopted; the offered markers make the sweep
// post each candidate once (durably, so restarts don't re-post).
const listAdoptedGrabJobs = (limit = 15) => db.prepare("SELECT * FROM grab_jobs WHERE origin LIKE 'adopt%' ORDER BY id DESC LIMIT ?").all(limit);

const setAdoptIgnored = (infoHash, name) => setSetting(`adopt_ignore:${infoHash}`, name || '1');
const clearAdoptIgnored = infoHash => db.prepare('DELETE FROM app_settings WHERE key = ?').run(`adopt_ignore:${infoHash}`);
const isAdoptIgnored = infoHash => !!getSetting(`adopt_ignore:${infoHash}`);
const listAdoptIgnored = () => db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'adopt_ignore:%'").all()
  .map(r => ({ infoHash: r.key.slice('adopt_ignore:'.length), name: r.value === '1' ? null : r.value }));

const markAdoptOffered = infoHash => setSetting(`adopt_offered:${infoHash}`, '1');
const isAdoptOffered = infoHash => !!getSetting(`adopt_offered:${infoHash}`);
const clearAdoptOffered = infoHash => db.prepare('DELETE FROM app_settings WHERE key = ?').run(`adopt_offered:${infoHash}`);
const listAdoptOfferedHashes = () => db.prepare("SELECT key FROM app_settings WHERE key LIKE 'adopt_offered:%'").all()
  .map(r => r.key.slice('adopt_offered:'.length));

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

// ---- Regional tiering ("edge cache") ----
// tier_nodes is the DB-backed node registry (§ /tier-node); tier_node_members the closed access
// set of restricted nodes; tier_agent_tokens the per-node bearer secrets for the sync agent's
// manifest/report routes; tier_node_files the agent-reported local inventory that atime nodes
// use as their demand signal. Last published plans live in app_settings (tier_plan:/tier_manifest:).

const TIER_NODE_FIELDS = ['usable_bytes', 'headroom_pct', 'full', 'access', 'demand_source', 'transport', 'folder_root', 'tautulli_url', 'tautulli_api_key', 'plex_url', 'plex_token', 'atime_mask', 'enabled', 'sticky', 'warm_days', 'fresh_days'];

// Insert-or-partial-update: only the fields present in `fields` change, so /tier-node edit can
// tweak one column without callers round-tripping the whole row.
function upsertTierNode(fields) {
  const name = String(fields.name).toLowerCase();
  const existing = db.prepare('SELECT name FROM tier_nodes WHERE name = ?').get(name);
  // New rows start from column defaults; the shared update below then applies every supplied
  // field, so create and edit take the same path.
  if (!existing) db.prepare('INSERT INTO tier_nodes (name) VALUES (?)').run(name);
  const sets = [];
  const args = [];
  for (const col of TIER_NODE_FIELDS) {
    if (fields[col] === undefined) continue;
    sets.push(`${col} = ?`);
    args.push(typeof fields[col] === 'boolean' ? (fields[col] ? 1 : 0) : fields[col]);
  }
  if (sets.length) {
    db.prepare(`UPDATE tier_nodes SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE name = ?`).run(...args, name);
  }
  return { created: !existing, node: getTierNode(name) };
}

const getTierNode = name => db.prepare('SELECT * FROM tier_nodes WHERE name = ?').get(String(name).toLowerCase());

const listTierNodes = () => db.prepare('SELECT * FROM tier_nodes ORDER BY name').all();

const setTierNodeEnabled = (name, enabled) => db.prepare('UPDATE tier_nodes SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?').run(enabled ? 1 : 0, String(name).toLowerCase()).changes > 0;

const addTierNodeMember = (node, discordId) => db.prepare('INSERT OR IGNORE INTO tier_node_members (node, discord_id) VALUES (?, ?)').run(String(node).toLowerCase(), discordId).changes > 0;

const removeTierNodeMember = (node, discordId) => db.prepare('DELETE FROM tier_node_members WHERE node = ? AND discord_id = ?').run(String(node).toLowerCase(), discordId).changes > 0;

const listTierNodeMembers = node => db.prepare('SELECT discord_id FROM tier_node_members WHERE node = ? ORDER BY discord_id').all(String(node).toLowerCase()).map(r => r.discord_id);

// ---- Multi-folder (R2.1) ----
// A node's Syncthing folders. Returns the explicit rows, or — for a legacy node that only ever
// had tier_nodes.folder_root — a single synthesized folder so the planner's single-folder path
// is unchanged. Shape matches what src/tier.js nodeFolders() consumes ({ folderId, folderRoot }).
function listTierNodeFolders(node) {
  const key = String(node).toLowerCase();
  const rows = db.prepare('SELECT syncthing_folder_id AS folderId, folder_root AS folderRoot FROM tier_node_folders WHERE node = ? ORDER BY folder_root').all(key);
  if (rows.length) return rows;
  const legacy = db.prepare('SELECT folder_root FROM tier_nodes WHERE name = ?').get(key);
  return legacy?.folder_root ? [{ folderId: '', folderRoot: legacy.folder_root }] : [];
}

const addTierNodeFolder = (node, folderId, folderRoot) => db.prepare(`INSERT INTO tier_node_folders (node, syncthing_folder_id, folder_root) VALUES (?, ?, ?)
  ON CONFLICT(node, syncthing_folder_id) DO UPDATE SET folder_root = excluded.folder_root`)
  .run(String(node).toLowerCase(), String(folderId || ''), String(folderRoot || '').replace(/\/+$/, '')).changes > 0;

const removeTierNodeFolder = (node, folderId) => db.prepare('DELETE FROM tier_node_folders WHERE node = ? AND syncthing_folder_id = ?').run(String(node).toLowerCase(), String(folderId || '')).changes > 0;

// (Re)generate the sync agent's bearer token for a node. Only the hash is stored — the raw
// token is shown once, same policy as download links.
function setTierAgentToken(node) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO tier_agent_tokens (node, token_hash) VALUES (?, ?)
    ON CONFLICT(node) DO UPDATE SET token_hash = excluded.token_hash, created_at = CURRENT_TIMESTAMP`)
    .run(String(node).toLowerCase(), sha256(rawToken));
  return rawToken;
}

const getTierAgentTokenHash = node => db.prepare('SELECT token_hash FROM tier_agent_tokens WHERE node = ?').get(String(node).toLowerCase())?.token_hash || null;

// Full-replace of a node's agent-reported inventory ({folderId, relPath, sizeBytes, atime}). The
// agent only re-sends when its local snapshot changed, so this stays cheap in the steady state.
// folderId defaults to '' so single-folder agents (which report no folderId) still work.
const replaceTierNodeFiles = db.transaction((node, files) => {
  const key = String(node).toLowerCase();
  db.prepare('DELETE FROM tier_node_files WHERE node = ?').run(key);
  const ins = db.prepare('INSERT OR REPLACE INTO tier_node_files (node, folder_id, rel_path, size_bytes, atime, reported_at) VALUES (?, ?, ?, ?, ?, ?)');
  const now = Date.now();
  for (const f of files) {
    if (!f || !f.relPath) continue;
    ins.run(key, String(f.folderId ?? f.folder_id ?? ''), String(f.relPath), Number(f.sizeBytes) || 0, Number.isFinite(Number(f.atime)) ? Number(f.atime) : null, now);
  }
});

const listTierNodeFiles = node => db.prepare('SELECT folder_id AS folderId, rel_path AS relPath, size_bytes AS sizeBytes, atime FROM tier_node_files WHERE node = ?').all(String(node).toLowerCase());

// Member cold-start signal: recent requests made by any of the given users (restricted-node
// pinning, §tier). Empty member set → empty result, never a broken IN () clause.
function listRequestsByRequesters(discordIds, sinceDays) {
  if (!discordIds.length) return [];
  const placeholders = discordIds.map(() => '?').join(',');
  return db.prepare(`SELECT media_id, media_type, title, requested_by_discord_id, created_at FROM requests
    WHERE requested_by_discord_id IN (${placeholders}) AND created_at >= datetime('now', ?)`)
    .all(...discordIds, `-${Math.max(1, Math.round(sinceDays))} days`)
    .map(r => ({ mediaId: r.media_id, mediaType: r.media_type, title: r.title, discordId: r.requested_by_discord_id, requestedAt: Date.parse(`${r.created_at}Z`) || Date.now() }));
}

const getTierPlan = node => { const raw = getSetting(`tier_plan:${String(node).toLowerCase()}`); if (!raw) return null; try { return JSON.parse(raw); } catch (_e) { return null; } };

const setTierPlan = (node, plan) => setSetting(`tier_plan:${String(node).toLowerCase()}`, JSON.stringify(plan));

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

module.exports = { db, ensureColumn, runMigrations, audit, upsertTierNode, getTierNode, listTierNodes, setTierNodeEnabled, addTierNodeMember, removeTierNodeMember, listTierNodeMembers, listTierNodeFolders, addTierNodeFolder, removeTierNodeFolder, setTierAgentToken, getTierAgentTokenHash, replaceTierNodeFiles, listTierNodeFiles, listRequestsByRequesters, getTierPlan, setTierPlan, storeUserEmail, linkUserToEmail, getUserByDiscordId, getUserByCanonicalEmail, markUserInvited, markOverseerrCreated, removeUser, upsertRequest, addToKeepList, isInKeepList, recordPendingDeletion, markPendingDeletion, postponePendingDeletion, recordEscalationWatch, getWatchingEscalations, getEscalationById, setEscalationState, setEscalationTvdbId, markEscalationArrMissingAlerted, touchEscalationApprovedAt, resolveEscalationForMediaKey, recordGrabJob, getGrabJob, getGrabJobByHash, getGrabJobByRelease, listActiveGrabJobs, nextTransferableGrabJob, setGrabJobState, countGrabJobsToday, requeueGrabTransfer, resetInterruptedGrabTransfers, stashGrabOffer, takeGrabOffer, restashGrabOffer, listAdoptedGrabJobs, setAdoptIgnored, clearAdoptIgnored, isAdoptIgnored, listAdoptIgnored, markAdoptOffered, isAdoptOffered, clearAdoptOffered, listAdoptOfferedHashes, setUserHomeServer, enqueueStageJob, getStageJob, nextQueuedStageJob, listActiveStageJobs, markStageJobCopying, finishStageJob, requeueStageJob, resetInterruptedStageJobs, recordStagedItem, getStagedItem, listStagedItems, removeStagedItem, touchStagedItem, setStagedItemPinned, createDownloadToken, getDownloadRecordByRawToken, revokeAllDownloadLinks, cleanExpiredTokens, getSetting, setSetting, stashPendingRequest, takePendingRequest, restashPendingRequest };
