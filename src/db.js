// SQLite storage: schema migrations plus every row helper (users, requests, keep list,
// download tokens, settings, audit log, pending-request stash).
const Database = require('better-sqlite3');
const crypto = require('crypto');
const { CONFIG } = require('./config');
const { sha256, canonicalizeEmail, isSnowflake } = require('./util');
const { upsertTrackedRequest, collapseStalePendingRequests, reconcileTrackedRequestStatuses } = require('./request-tracking');
const { nextSeasonNoGrabAlert } = require('./season-alert');

// Overridable so tests (which can't assume write access to /app/data) can point at a scratch
// file instead; production is unaffected since DB_PATH is never set in the container.
const DB_PATH = process.env.DB_PATH || '/app/data/plex_invites.db';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function ensureColumn(table, col, spec) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${spec}`);
}

// Bumped whenever a migration step is added below. Not yet used to skip already-applied work —
// runMigrationsInner() still re-evaluates every idempotent step on each startup — but recording
// it in the database header (via PRAGMA user_version, which participates in the same transaction
// as every other write below) is the ledger a later packet will build a skip-if-current-version
// fast path on top of, per issue #179.
const SCHEMA_VERSION = 1;

function schemaVersion() {
  return db.pragma('user_version', { simple: true });
}

// The whole migration pass — schema creation, column additions, the tier_node_files rebuild, and
// data repairs below — runs inside one transaction. SQLite rolls back every statement in it if
// any step throws (a crash, a disk-full ALTER TABLE, an unhandled error), so an interrupted
// migration always leaves either the old schema (rollback) or the fully-migrated new schema
// (commit) — never a table set with some steps applied and others missing.
const runMigrations = db.transaction(function runMigrationsInner() {
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
    CREATE TABLE IF NOT EXISTS media_priority (
      key TEXT PRIMARY KEY,
      media_type TEXT NOT NULL,
      title TEXT NOT NULL,
      rank INTEGER NOT NULL DEFAULT 0,
      pinned_by TEXT,
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

    CREATE TABLE IF NOT EXISTS rate_limit_hits (
      scope TEXT NOT NULL,
      identity TEXT NOT NULL,
      hit_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limit_bucket ON rate_limit_hits(scope, identity, expires_at);
    CREATE INDEX IF NOT EXISTS idx_rate_limit_expiry ON rate_limit_hits(expires_at);

    CREATE TABLE IF NOT EXISTS alert_cooldowns (
      scope TEXT NOT NULL,
      alert_key TEXT NOT NULL,
      last_alerted_at INTEGER NOT NULL,
      PRIMARY KEY (scope, alert_key)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS disk_space_samples (
      root TEXT NOT NULL,
      free_bytes INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      sampled_at INTEGER NOT NULL,
      PRIMARY KEY (root, sampled_at)
    );

    CREATE TABLE IF NOT EXISTS dashboard_passkeys (
      credential_id TEXT PRIMARY KEY,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT NOT NULL DEFAULT '[]',
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      event_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Always keyed tmdb:<id> regardless of media type (unlike requests.media_id, which is
    -- rekeyed to tvdb:<id> for TV once Seerr assigns one) — tmdbId is the one identifier every
    -- caller has up front, at request time and at webhook time alike.
    CREATE TABLE IF NOT EXISTS request_subscribers (
      media_id TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(media_id, discord_id)
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
      is_4k INTEGER DEFAULT 0,
      arr_source TEXT,
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

    -- One row per (series, season) the season-pack sweep has asked Sonarr to search. Durable
    -- because the cooldown has to survive restarts: an in-memory map would re-search every
    -- dormant season of the whole library on every boot.
    CREATE TABLE IF NOT EXISTS season_searches (
      series_id INTEGER NOT NULL,
      season_number INTEGER NOT NULL,
      series_title TEXT,
      missing_at_search INTEGER DEFAULT 0,
      last_searched_at INTEGER NOT NULL,
      PRIMARY KEY (series_id, season_number)
    );

    -- Positive interactive evidence and the high-water cursor for bounded episode fallback.
    -- The unique season key makes scheduler retries and restart reconciliation idempotent.
    CREATE TABLE IF NOT EXISTS season_episode_fallbacks (
      series_id INTEGER NOT NULL,
      season_number INTEGER NOT NULL,
      series_title TEXT,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','submitted','cooldown')),
      evidence_status TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL,
      evidence_observed_at INTEGER NOT NULL,
      anchor_episode_id INTEGER,
      anchor_episode_number INTEGER,
      last_command_id INTEGER,
      cursor_episode_number INTEGER,
      cursor_episode_id INTEGER,
      submitted_count INTEGER NOT NULL DEFAULT 0,
      deferred_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      next_eligible_at INTEGER,
      last_outcome TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (series_id, season_number)
    );
    CREATE INDEX IF NOT EXISTS idx_season_episode_fallback_due
      ON season_episode_fallbacks(state, next_eligible_at, last_attempt_at);

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

    -- §Phase2: durable per-watcher daily promotion counter. The old in-memory Map reset the daily
    -- count on every restart (the per-title cooldown was durable, this wasn't), so a restart re-armed
    -- everyone's budget and a flapping process could stage far past the cap. One row per promotion;
    -- the cap is a COUNT over a rolling window, matching the old takeRateLimit semantics.
    CREATE TABLE IF NOT EXISTS edge_promote_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attributed_id TEXT NOT NULL,
      media_id TEXT,
      promoted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_edge_promote_attr ON edge_promote_log(attributed_id, promoted_at);

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
    CREATE INDEX IF NOT EXISTS idx_disk_space_samples_time ON disk_space_samples(sampled_at);
    CREATE INDEX IF NOT EXISTS idx_audit_action_created ON audit_log(action, created_at);
    CREATE INDEX IF NOT EXISTS idx_escalations_state ON escalations(state);
    CREATE INDEX IF NOT EXISTS idx_grab_jobs_state ON grab_jobs(state);
    CREATE INDEX IF NOT EXISTS idx_grab_jobs_hash ON grab_jobs(info_hash);
  `);

  ensureColumn('users', 'overseerr_user_id', 'INTEGER');
  ensureColumn('users', 'plex_username', 'TEXT');
  // Which Plex group a person belongs to: 'primary' (Main servers) or 'ph' (Philippines cache
  // server). Watch state never syncs between servers, so invites and auto-staging key off this.
  ensureColumn('users', 'home_server', "TEXT DEFAULT 'primary'");
  ensureColumn('keep_list', 'expires_at', 'INTEGER');
  // A deletion decision must keep the exact library edition all the way from the webhook prompt
  // to the grace-period sweep. Without these fields a 4K watch could resolve against the first
  // (1080p) Radarr instance and delete the wrong copy.
  ensureColumn('pending_deletions', 'is_4k', 'INTEGER DEFAULT 0');
  ensureColumn('pending_deletions', 'arr_source', 'TEXT');
  // Where the torrent's data lives under GRAB_RCLONE_REMOTE when it isn't just the torrent
  // name (adopted torrents can sit in per-label subfolders). NULL = use the rTorrent name.
  ensureColumn('grab_jobs', 'remote_path', 'TEXT');
  // Sonarr seriesId / Radarr movieId the job is pinned to, resolved BEFORE the job starts
  // (adoption) or already known (a normal request grab). NULL means Sonarr/Radarr has to
  // guess from the release filename at import time — exactly the case forced ManualImport
  // must not auto-fire for.
  ensureColumn('grab_jobs', 'target_arr_id', 'INTEGER');
  ensureColumn('grab_jobs', 'tvdb_id', 'INTEGER');
  // How target_arr_id was resolved: 'tvdb' | 'exact' | 'alternate' | null (unresolved).
  // 'ambiguous' never reaches this column — an ambiguous resolution blocks the job entirely
  // until an admin picks one.
  ensureColumn('grab_jobs', 'match_type', 'TEXT');
  // When the import was actually confirmed to have landed (leftover-file check passed after
  // the arr's scan/ManualImport completed) — distinct from imported_at, which used to be
  // stamped the moment the scan command was *fired*, before anyone checked it worked.
  ensureColumn('grab_jobs', 'verified_at', 'INTEGER');
  // One-shot flag: the "request never landed in the arr" alert was posted for this watch row.
  ensureColumn('escalations', 'arr_missing_alerted', 'INTEGER DEFAULT 0');
  // Cached AvistaZ-plausibility verdict ('asian' | 'non_asian'), from the title's TMDB origin
  // via Seerr. Only a decided verdict is stored — NULL means "not assessed yet, ask Seerr
  // again next sweep", so a transient Seerr outage can't freeze a show out of auto-escalation.
  ensureColumn('escalations', 'avistaz_fit', 'TEXT');
  // Tiering: demand_source 'plex' reads watch history straight from the node's PMS (no
  // Tautulli); atime_mask ('HH:MM-HH:MM' UTC) launders Plex-maintenance reads out of the
  // atime LRU signal at report ingest.
  ensureColumn('tier_nodes', 'plex_url', 'TEXT');
  ensureColumn('tier_nodes', 'plex_token', 'TEXT');
  ensureColumn('tier_nodes', 'atime_mask', 'TEXT');
  // The generic alert-cooldown table also carries durable no-grab backoff state for season
  // searches. Other scopes keep using only last_alerted_at and are unaffected by these defaults.
  ensureColumn('alert_cooldowns', 'attempt_count', 'INTEGER DEFAULT 0');
  ensureColumn('alert_cooldowns', 'last_attempted_at', 'INTEGER');
  ensureColumn('alert_cooldowns', 'fingerprint', 'TEXT');
  ensureColumn('alert_cooldowns', 'stood_down', 'INTEGER DEFAULT 0');
  ensureColumn('alert_cooldowns', 'metadata_json', 'TEXT');

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

  // Older approval flows inserted a Seerr-backed row beside the provisional Discord pending
  // row. Repair only rows whose authoritative sibling has advanced beyond pending.
  const repairedRequests = collapseStalePendingRequests(db);
  if (repairedRequests.length) {
    audit('stale_pending_requests_repaired', {
      count: repairedRequests.length,
      rows: repairedRequests.slice(0, 50),
    });
  }

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
          // Optional multi-folder seed: [{"name":"california","folders":[{"id":"aaaaa-bbbbb","path":"/mnt/media/Media/Movies"}, ...]}]
          for (const f of Array.isArray(n.folders) ? n.folders : []) {
            if (f && (f.path || f.folder_root)) addTierNodeFolder(n.name, f.id || f.folder_id || '', f.path || f.folder_root);
          }
        }
      }
    } catch (err) {
      audit('tier_seed_failed', { error: err.message });
    }
  }

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
});

function audit(action, details = {}) {
  const meta = { ...details };
  if (meta.error && typeof meta.error === 'string') meta.error = meta.error.slice(0, 500);
  db.prepare('INSERT INTO audit_log (action, actor_discord_id, target_discord_id, metadata_json) VALUES (?, ?, ?, ?)')
    .run(action, details.actorDiscordId || null, details.targetDiscordId || null, JSON.stringify(meta));
}

// basic helpers
function storeUserEmail(discordId, email) {
  const normalized = email.toLowerCase().trim();
  const current = db.prepare('SELECT email FROM users WHERE discord_id = ?').get(discordId);
  const changed = current && canonicalizeEmail(current.email) !== canonicalizeEmail(normalized);
  db.prepare(`INSERT INTO users (discord_id, email, requested_at)
    VALUES (?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      email=excluded.email,
      requested_at=excluded.requested_at,
      invited=CASE WHEN ? THEN 0 ELSE users.invited END,
      invited_at=CASE WHEN ? THEN NULL ELSE users.invited_at END,
      overseerr_created=CASE WHEN ? THEN 0 ELSE users.overseerr_created END,
      overseerr_user_id=CASE WHEN ? THEN NULL ELSE users.overseerr_user_id END`)
    .run(discordId, normalized, new Date().toISOString(), changed ? 1 : 0, changed ? 1 : 0, changed ? 1 : 0, changed ? 1 : 0);
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

// A different real (non-synthetic, already-Discord-linked) user already holding this email.
// linkUserToEmail only absorbs plex_ rows, so without this check a second real Discord account
// replying with someone else's email creates a second `users` row for the same address — after
// that, getUserByCanonicalEmail (role sync, webhook DMs, escalation…) picks one of the two
// arbitrarily and the other account silently stops getting notified/synced. Callers should offer
// this only from unattended self-service flows (DM reply, Request Access modal); an admin running
// /link on purpose is trusted to know what they're doing.
function findConflictingRealUser(discordId, email) {
  const key = canonicalizeEmail(email);
  if (!key || key.startsWith('__placeholder__:')) return null;
  return db.prepare('SELECT * FROM users').all().find(u =>
    u.discord_id !== discordId
    && !u.discord_id.startsWith('plex_')
    && canonicalizeEmail(u.email) === key) || null;
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
  return upsertTrackedRequest(db, overseerrRequestId, mediaId, mediaType, is4k, title, discordId, status);
}

function reconcileRequestStatuses(remoteRequests) {
  const result = reconcileTrackedRequestStatuses(db, remoteRequests);
  if (result.changed.length || result.repaired.length) {
    audit('request_statuses_reconciled', {
      changed: result.changed.slice(0, 100),
      repaired: result.repaired.slice(0, 100),
    });
  }
  return result;
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
function recordPendingDeletion(mediaId, mediaType, title, requestorDiscordId, { is4k = false, arrSource = null } = {}) {
  const now = Date.now();
  db.prepare(`INSERT INTO pending_deletions (media_id, media_type, title, requestor_discord_id, prompt_sent_at, delete_after, status, is_4k, arr_source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(media_id) DO UPDATE SET
      title = excluded.title,
      requestor_discord_id = excluded.requestor_discord_id,
      prompt_sent_at = excluded.prompt_sent_at,
      delete_after = excluded.delete_after,
      media_type = excluded.media_type,
      is_4k = excluded.is_4k,
      arr_source = excluded.arr_source,
      status = 'pending',
      updated_at = CURRENT_TIMESTAMP`)
    .run(mediaId, mediaType, title, requestorDiscordId || null, now, now + CONFIG.DELETION_GRACE_HOURS * 3600000, is4k ? 1 : 0, arrSource);
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

function setEscalationAvistazFit(id, fit) {
  db.prepare('UPDATE escalations SET avistaz_fit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(fit, id);
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
// scanning (arr scan/import command running) → importing (forced ManualImport in flight) →
// verified (leftover-file check confirmed the import actually happened), or one of
// needs_mapping / import_rejected / failed. Durable so a restart mid-download/mid-transfer
// picks the pipeline back up. A job only leaves the "active" set (see listActiveGrabJobs)
// once it's verified or has definitively failed — "the scan command was fired" is not the
// same thing as "the arr actually took the files".

// state defaults to 'sent' (a torrent the bot just pushed); adoption records jobs directly
// at 'downloading' or 'complete' since the torrent already exists in rTorrent.
function recordGrabJob({ mediaId, mediaType, title, releaseTitle, infoHash, sizeBytes, label, discordId, origin, state = 'sent', remotePath, targetArrId, tvdbId, matchType }) {
  const now = Date.now();
  const info = db.prepare(`INSERT INTO grab_jobs (media_id, media_type, title, release_title, info_hash, size_bytes, label, requested_by_discord_id, origin, state, remote_path, target_arr_id, tvdb_id, match_type, sent_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(mediaId || null, mediaType, title, releaseTitle, infoHash || null, sizeBytes || 0, label || null, discordId || null, origin || 'manual', state, remotePath || null, targetArrId || null, tvdbId || null, matchType || null, now, state === 'complete' ? now : null);
  return db.prepare('SELECT * FROM grab_jobs WHERE id = ?').get(info.lastInsertRowid);
}

// Pin (or re-pin) the job to a resolved Sonarr/Radarr identity — set once at adoption/grab
// time, or by an admin resolving an ambiguous match after the fact.
function setGrabJobIdentity(id, { targetArrId, tvdbId, matchType }) {
  db.prepare('UPDATE grab_jobs SET target_arr_id = ?, tvdb_id = ?, match_type = ? WHERE id = ?')
    .run(targetArrId ?? null, tvdbId ?? null, matchType ?? null, id);
}

const getGrabJob = id => db.prepare('SELECT * FROM grab_jobs WHERE id = ?').get(id);

// Duplicate guard: a hash that was ever sent and didn't outright fail (still moving, or
// already imported) must not be grabbed again — "already downloaded" is a scoring criterion.
const getGrabJobByHash = infoHash => db.prepare("SELECT * FROM grab_jobs WHERE info_hash = ? AND state != 'failed' ORDER BY id DESC LIMIT 1").get(infoHash);

// Pre-download duplicate check by exact release title, for when Prowlarr didn't report an
// info-hash. Failed jobs don't block a retry of the same release.
const getGrabJobByRelease = releaseTitle => db.prepare("SELECT * FROM grab_jobs WHERE release_title = ? AND state != 'failed' ORDER BY id DESC LIMIT 1").get(releaseTitle);

// scanning/importing stay "active": the import hasn't been confirmed yet, so duplicate
// protection and the adopted-batch progress counter must still count these jobs.
const listActiveGrabJobs = () => db.prepare("SELECT * FROM grab_jobs WHERE state IN ('sent','downloading','complete','transferring','scanning','importing') ORDER BY id").all();

const nextTransferableGrabJob = () => db.prepare("SELECT * FROM grab_jobs WHERE state = 'complete' ORDER BY id LIMIT 1").get();

function setGrabJobState(id, state, error = null) {
  const stampCol = state === 'complete' ? 'completed_at' : state === 'verified' ? 'imported_at' : null;
  const extra = state === 'verified' ? ', verified_at = ?' : '';
  const stamp = stampCol ? `, ${stampCol} = ?` : '';
  const args = [state, error ? String(error).slice(0, 500) : null];
  if (stampCol) args.push(Date.now());
  if (extra) args.push(Date.now());
  args.push(id);
  db.prepare(`UPDATE grab_jobs SET state = ?, error = ?${stamp}${extra} WHERE id = ?`).run(...args);
}

// The allowance counts every grab attempted today (failed ones included — the tracker may
// have counted the download the moment the .torrent was fetched). created_at is UTC.
// Adopted jobs never fetched anything from a tracker, so they don't consume a slot.
const countGrabJobsToday = () => db.prepare("SELECT COUNT(*) AS n FROM grab_jobs WHERE created_at >= datetime('now', 'start of day') AND origin NOT LIKE 'adopt%'").get().n;

// Retry a failed transfer/import (the torrent is still seeding on the seedbox, so the
// copy can simply run again). Only failed jobs are retryable.
const requeueGrabTransfer = id => db.prepare("UPDATE grab_jobs SET state = 'complete', error = NULL WHERE id = ? AND state = 'failed'").run(id).changes > 0;

// A restart mid-transfer leaves 'transferring' rows behind; rclone copy resumes cheaply.
// 'scanning'/'importing' rows are stranded the same way — verification is an in-memory poll
// with no durable resume point, so a restart mid-poll would otherwise leave the job parked
// forever instead of ever reaching 'verified' or a real failure. Re-running the whole
// transfer (copy → scan → verify) from 'complete' is safe: the copy is resumable and
// re-firing the scan on files that already imported is a no-op for the arr.
const resetInterruptedGrabTransfers = () => db.prepare("UPDATE grab_jobs SET state = 'complete' WHERE state IN ('transferring','scanning','importing')").run().changes;

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

// ---- Season-pack searches ----
// Every TVDB id somebody actually asked for, from both places a TV request lands: the requests
// table (keyed tvdb:<id> once the id is known) and the escalations table (explicit column).
// Used to give requested shows the season-pack treatment even while they're still airing —
// somebody is waiting on those, so a pack that gets the whole season at once is worth more than
// on a show nobody asked about.
function listRequestedTvdbIds() {
  const rows = db.prepare(`
    SELECT DISTINCT CAST(SUBSTR(media_id, 6) AS INTEGER) AS tvdb_id FROM requests
      WHERE media_id LIKE 'tvdb:%'
    UNION
    SELECT DISTINCT tvdb_id FROM escalations WHERE tvdb_id IS NOT NULL`).all();
  return new Set(rows.map(r => Number(r.tvdb_id)).filter(Boolean));
}

// season → last-searched timestamp for one series, in the shape seasonSearchTargets wants.
function getSeasonSearchTimes(seriesId) {
  const rows = db.prepare('SELECT season_number, last_searched_at FROM season_searches WHERE series_id = ?').all(seriesId);
  return Object.fromEntries(rows.map(r => [r.season_number, r.last_searched_at]));
}

function recordSeasonSearch({ seriesId, seasonNumber, seriesTitle, missing }) {
  db.prepare(`INSERT INTO season_searches (series_id, season_number, series_title, missing_at_search, last_searched_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(series_id, season_number) DO UPDATE SET
      series_title = excluded.series_title,
      missing_at_search = excluded.missing_at_search,
      last_searched_at = excluded.last_searched_at`)
    .run(seriesId, seasonNumber, seriesTitle || null, missing || 0, Date.now());
}

const listRecentSeasonSearches = (sinceMs = 7 * 86400000) =>
  db.prepare('SELECT * FROM season_searches WHERE last_searched_at >= ? ORDER BY last_searched_at DESC').all(Date.now() - sinceMs);

function recordSeasonEpisodeFallbackEvidence({ seriesId, seasonNumber, seriesTitle, evidence, now = Date.now() }) {
  if (evidence?.status !== 'approved_episode' || !evidence.fingerprint) return null;
  db.prepare(`INSERT INTO season_episode_fallbacks
      (series_id, season_number, series_title, state, evidence_status, evidence_fingerprint,
       evidence_observed_at, anchor_episode_id, anchor_episode_number, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(series_id, season_number) DO UPDATE SET
      series_title = excluded.series_title,
      evidence_status = excluded.evidence_status,
      evidence_fingerprint = excluded.evidence_fingerprint,
      evidence_observed_at = excluded.evidence_observed_at,
      anchor_episode_id = excluded.anchor_episode_id,
      anchor_episode_number = excluded.anchor_episode_number,
      state = CASE WHEN season_episode_fallbacks.state = 'submitted' THEN 'submitted' ELSE 'pending' END,
      next_eligible_at = CASE WHEN season_episode_fallbacks.state = 'submitted' THEN season_episode_fallbacks.next_eligible_at ELSE NULL END,
      updated_at = excluded.updated_at`)
    .run(seriesId, seasonNumber, seriesTitle || null, evidence.status, evidence.fingerprint,
      Number(evidence.observedAt) || now, evidence.anchorEpisodeId || null,
      evidence.anchorEpisodeNumber || null, now, now);
  return getSeasonEpisodeFallback(seriesId, seasonNumber);
}

function getSeasonEpisodeFallback(seriesId, seasonNumber) {
  return db.prepare('SELECT * FROM season_episode_fallbacks WHERE series_id = ? AND season_number = ?').get(seriesId, seasonNumber);
}

function listSeasonEpisodeFallbacks() {
  return db.prepare(`SELECT * FROM season_episode_fallbacks
    ORDER BY COALESCE(next_eligible_at, 0), COALESCE(last_attempt_at, 0), series_id, season_number`).all();
}

function markSeasonEpisodeFallbackSubmitted({ seriesId, seasonNumber, commandId, cursorEpisodeNumber,
  cursorEpisodeId, submittedCount, deferredCount, nextEligibleAt, now = Date.now() }) {
  return db.prepare(`UPDATE season_episode_fallbacks SET
      state = 'submitted', last_command_id = ?, cursor_episode_number = ?, cursor_episode_id = ?,
      submitted_count = ?, deferred_count = ?, last_attempt_at = ?, next_eligible_at = ?,
      last_outcome = 'accepted', last_error = NULL, updated_at = ?
    WHERE series_id = ? AND season_number = ? AND state != 'submitted'`)
    .run(commandId || null, cursorEpisodeNumber || null, cursorEpisodeId || null,
      submittedCount || 0, deferredCount || 0, now, nextEligibleAt || null, now, seriesId, seasonNumber).changes > 0;
}

function attachSeasonEpisodeFallbackCommand(seriesId, seasonNumber, commandId, now = Date.now()) {
  return db.prepare(`UPDATE season_episode_fallbacks SET last_command_id = ?, updated_at = ?
    WHERE series_id = ? AND season_number = ? AND state = 'submitted' AND last_command_id IS NULL`)
    .run(commandId || null, now, seriesId, seasonNumber).changes > 0;
}

function finishSeasonEpisodeFallback({ seriesId, seasonNumber, outcome, error = null, nextEligibleAt = null,
  resetCursor = false, now = Date.now() }) {
  return db.prepare(`UPDATE season_episode_fallbacks SET
      state = 'cooldown', last_outcome = ?, last_error = ?, next_eligible_at = ?,
      last_command_id = NULL,
      cursor_episode_number = CASE WHEN ? THEN NULL ELSE cursor_episode_number END,
      cursor_episode_id = CASE WHEN ? THEN NULL ELSE cursor_episode_id END,
      updated_at = ?
    WHERE series_id = ? AND season_number = ?`)
    .run(outcome, error ? String(error).slice(0, 500) : null, nextEligibleAt,
      resetCursor ? 1 : 0, resetCursor ? 1 : 0, now, seriesId, seasonNumber).changes > 0;
}

function deferSubmittedSeasonEpisodeFallback(seriesId, seasonNumber, nextEligibleAt, now = Date.now()) {
  return db.prepare(`UPDATE season_episode_fallbacks SET next_eligible_at = ?, updated_at = ?
    WHERE series_id = ? AND season_number = ? AND state = 'submitted'`)
    .run(nextEligibleAt, now, seriesId, seasonNumber).changes > 0;
}

function clearSeasonEpisodeFallback(seriesId, seasonNumber) {
  return db.prepare('DELETE FROM season_episode_fallbacks WHERE series_id = ? AND season_number = ?')
    .run(seriesId, seasonNumber).changes > 0;
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

// §Phase2 durable play-promotion daily cap. countRecentPromotions is the peek the guard uses to
// decide rateLimitOk; recordPromotion is called only when a copy is actually enqueued (so a
// skipped/audited play never burns budget). Old rows are pruned opportunistically on write.
function countRecentPromotions(attributedId, windowMs) {
  return db.prepare('SELECT COUNT(*) AS n FROM edge_promote_log WHERE attributed_id = ? AND promoted_at >= ?')
    .get(String(attributedId), Date.now() - windowMs).n;
}

function recordPromotion(attributedId, mediaId, windowMs = 86400000) {
  db.prepare('INSERT INTO edge_promote_log (attributed_id, media_id, promoted_at) VALUES (?, ?, ?)')
    .run(String(attributedId), mediaId || null, Date.now());
  // Keep the table from growing without bound — anything older than the counting window is dead.
  db.prepare('DELETE FROM edge_promote_log WHERE promoted_at < ?').run(Date.now() - Math.max(windowMs, 86400000));
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

// Dashboard setup submits the complete folder list, so replace it atomically: leaving stale rows
// behind would make the planner publish folders the freshly-installed agent no longer knows.
const replaceTierNodeFolders = db.transaction((node, folders) => {
  const key = String(node).toLowerCase();
  db.prepare('DELETE FROM tier_node_folders WHERE node = ?').run(key);
  const insert = db.prepare('INSERT INTO tier_node_folders (node, syncthing_folder_id, folder_root) VALUES (?, ?, ?)');
  for (const folder of folders) insert.run(key, folder.id, folder.path);
  return folders.length;
});

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

// §1.1 A node's plan lifecycle record. The old code stored a single {planHash, keepMediaIds,
// appliedAt} and marked it "applied" the instant the manifest was published — before the agent
// (possibly offline, drive-missing, or hours from its next run) had done anything. That conflated
// two very different states, so hysteresis and the dashboard both assumed a disk state the node
// might never have reached. We now track three:
//   published — the manifest handed to the agent (hash + keepMediaIds + publishedAt). NOT proof of
//               disk; it's just "what we told the node to become".
//   converged — the agent confirmed it reached exactly this plan with no errors (convergedAt).
//               The ONLY state trusted for hysteresis (the planner keys prevKeep off a state the
//               node actually reached) and the only one the UI may call "converged".
//   report metadata — lastAgentReportAt / lastInventoryAt / lastHeartbeatAt / lastErrors so status
//               surfaces can tell "healthy idle" from "stopped / net down / timer broken".
//               lastHeartbeatAt is bumped on EVERY inbound agent contact (full report,
//               drive-missing, or a lightweight no-op heartbeat) — it is the liveness signal;
//               lastAgentReportAt tracks only full (convergence) reports.
function emptyTierPlan() {
  return { published: null, converged: null, lastAgentReportAt: null, lastInventoryAt: null, lastHeartbeatAt: null, lastErrors: [] };
}

// Read + normalize. Legacy records are migrated on read: an old "applied" plan was assumed-converged
// under the old immediate-apply semantics, so it seeds BOTH published and converged (preserving
// hysteresis across the upgrade rather than forcing a spurious first-run rebalance everywhere).
function normalizeTierPlan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.published !== undefined || raw.converged !== undefined) {
    return {
      published: raw.published || null,
      converged: raw.converged || null,
      lastAgentReportAt: raw.lastAgentReportAt ?? null,
      lastInventoryAt: raw.lastInventoryAt ?? null,
      lastHeartbeatAt: raw.lastHeartbeatAt ?? null,
      lastErrors: Array.isArray(raw.lastErrors) ? raw.lastErrors : [],
    };
  }
  if (!raw.planHash) return null;
  const legacy = { planHash: raw.planHash, keepMediaIds: raw.keepMediaIds || [] };
  return {
    published: { ...legacy, publishedAt: raw.appliedAt ?? null },
    converged: { ...legacy, convergedAt: raw.appliedAt ?? null },
    lastAgentReportAt: null,
    lastInventoryAt: null,
    lastHeartbeatAt: null,
    lastErrors: [],
  };
}

const getTierPlan = node => { const raw = getSetting(`tier_plan:${String(node).toLowerCase()}`); if (!raw) return null; try { return normalizeTierPlan(JSON.parse(raw)); } catch (_e) { return null; } };

const writeTierPlan = (node, rec) => setSetting(`tier_plan:${String(node).toLowerCase()}`, JSON.stringify(rec));

// §1.1 /tier apply publishes a manifest: record what was handed to the agent, WITHOUT touching
// converged — that only advances when the agent confirms it.
function setTierPublishedPlan(node, { planHash, keepMediaIds = [] }) {
  const rec = getTierPlan(node) || emptyTierPlan();
  rec.published = { planHash, keepMediaIds, publishedAt: Date.now() };
  writeTierPlan(node, rec);
  return rec;
}

// §1.1 The agent reached exactly this published plan cleanly — the sole writer of converged. The
// report endpoint calls this only after checking body.converged && no errors && hash === published.
function markTierPlanConverged(node, { planHash, keepMediaIds }) {
  const rec = getTierPlan(node) || emptyTierPlan();
  rec.converged = { planHash, keepMediaIds: keepMediaIds || rec.published?.keepMediaIds || [], convergedAt: Date.now() };
  writeTierPlan(node, rec);
  return rec;
}

// §1.1 Record that the agent reported at all (any run — converged, still-working, or erroring), so
// "no report in N hours" is distinguishable from "healthy idle". inventoryStored bumps
// lastInventoryAt; errors are kept verbatim (capped) for the status surfaces.
function recordTierAgentReport(node, { inventoryStored = false, errors = [] } = {}) {
  const rec = getTierPlan(node) || emptyTierPlan();
  const now = Date.now();
  rec.lastAgentReportAt = now;
  rec.lastHeartbeatAt = now; // a full report is also proof of life
  if (inventoryStored) rec.lastInventoryAt = now;
  rec.lastErrors = Array.isArray(errors) ? errors.slice(0, 10) : [];
  writeTierPlan(node, rec);
  return rec;
}

// §op Heartbeat: bump the liveness timestamp on a lightweight agent contact (a clean no-op
// heartbeat or a drive-missing report). Proves the agent's timer fired and it reached the bot.
// `errors` sets the surfaced error state so a heartbeat can carry a degraded status (e.g. a
// drive-missing run is proof of life but NOT healthy — its mount errors must show as warn/⚠️, not
// a clean "recently checked in"). Pass `[]` on a clean no-op to clear any stale errors; omit it to
// leave the last recorded errors untouched. Inventory/convergence are never touched here.
function recordTierAgentHeartbeat(node, { errors } = {}) {
  const rec = getTierPlan(node) || emptyTierPlan();
  rec.lastHeartbeatAt = Date.now();
  if (errors !== undefined) rec.lastErrors = Array.isArray(errors) ? errors.slice(0, 10) : [];
  writeTierPlan(node, rec);
  return rec;
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

function takePersistentRateLimit(scope, identity, maxHits, periodMs, now = Date.now()) {
  return db.transaction(() => {
    db.prepare('DELETE FROM rate_limit_hits WHERE expires_at <= ?').run(now);
    const hits = db.prepare('SELECT COUNT(*) AS n FROM rate_limit_hits WHERE scope = ? AND identity = ? AND expires_at > ?')
      .get(scope, String(identity), now).n;
    if (hits >= maxHits) return false;
    db.prepare('INSERT INTO rate_limit_hits (scope, identity, hit_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(scope, String(identity), now, now + periodMs);
    return true;
  })();
}

function getAlertedAt(scope, key) {
  return db.prepare('SELECT last_alerted_at FROM alert_cooldowns WHERE scope = ? AND alert_key = ?')
    .get(scope, String(key))?.last_alerted_at || 0;
}

function setAlertedAt(scope, key, alertedAt = Date.now()) {
  db.prepare(`INSERT INTO alert_cooldowns (scope, alert_key, last_alerted_at) VALUES (?, ?, ?)
    ON CONFLICT(scope, alert_key) DO UPDATE SET last_alerted_at = excluded.last_alerted_at`)
    .run(scope, String(key), alertedAt);
}

function listAlertCooldowns(scope) {
  return db.prepare('SELECT alert_key, last_alerted_at FROM alert_cooldowns WHERE scope = ?').all(scope);
}

function clearAlertCooldown(scope, key) {
  db.prepare('DELETE FROM alert_cooldowns WHERE scope = ? AND alert_key = ?').run(scope, String(key));
}

function pruneAlertCooldowns(scope, before) {
  return db.prepare('DELETE FROM alert_cooldowns WHERE scope = ? AND last_alerted_at < ?').run(scope, before).changes;
}

const SEASON_ALERT_SCOPE = 'season-pack:no-grab';
function seasonAlertKey(seriesId, seasonNumber) {
  return `${Number(seriesId)}:${Number(seasonNumber)}`;
}

function seasonAlertRow(row) {
  if (!row) return null;
  let metadata = {};
  try { metadata = JSON.parse(row.metadata_json || '{}'); } catch (_err) {}
  return {
    key: row.alert_key,
    fingerprint: row.fingerprint,
    attemptCount: Number(row.attempt_count) || 0,
    lastAttemptedAt: Number(row.last_attempted_at) || 0,
    lastAlertedAt: Number(row.last_alerted_at) || 0,
    stoodDown: !!row.stood_down,
    ...metadata,
  };
}

function getSeasonAlertState(seriesId, seasonNumber) {
  return seasonAlertRow(db.prepare('SELECT * FROM alert_cooldowns WHERE scope = ? AND alert_key = ?')
    .get(SEASON_ALERT_SCOPE, seasonAlertKey(seriesId, seasonNumber)));
}

function recordSeasonNoGrab({ seriesId, seasonNumber, seriesTitle, fingerprint, missingCount, releaseCount, now = Date.now() }) {
  return db.transaction(() => {
    const key = seasonAlertKey(seriesId, seasonNumber);
    const previous = getSeasonAlertState(seriesId, seasonNumber);
    const decision = nextSeasonNoGrabAlert(previous, { fingerprint, now });
    const lastAlertedAt = decision.shouldAlert ? now : previous?.lastAlertedAt || now;
    const metadata = JSON.stringify({ seriesId: Number(seriesId), seasonNumber: Number(seasonNumber), seriesTitle, missingCount, releaseCount });
    db.prepare(`INSERT INTO alert_cooldowns
        (scope, alert_key, last_alerted_at, attempt_count, last_attempted_at, fingerprint, stood_down, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, alert_key) DO UPDATE SET
        last_alerted_at = excluded.last_alerted_at,
        attempt_count = excluded.attempt_count,
        last_attempted_at = excluded.last_attempted_at,
        fingerprint = excluded.fingerprint,
        stood_down = excluded.stood_down,
        metadata_json = excluded.metadata_json`)
      .run(SEASON_ALERT_SCOPE, key, lastAlertedAt, decision.attemptCount, now, fingerprint, decision.stoodDown ? 1 : 0, metadata);
    return { ...decision, lastAlertedAt, key };
  })();
}

function clearSeasonAlertState(seriesId, seasonNumber) {
  return db.prepare('DELETE FROM alert_cooldowns WHERE scope = ? AND alert_key = ?')
    .run(SEASON_ALERT_SCOPE, seasonAlertKey(seriesId, seasonNumber)).changes > 0;
}

function listSeasonAlertStates({ stoodDownOnly = false } = {}) {
  const rows = stoodDownOnly
    ? db.prepare('SELECT * FROM alert_cooldowns WHERE scope = ? AND stood_down = 1 ORDER BY last_attempted_at DESC').all(SEASON_ALERT_SCOPE)
    : db.prepare('SELECT * FROM alert_cooldowns WHERE scope = ? ORDER BY last_attempted_at DESC').all(SEASON_ALERT_SCOPE);
  return rows.map(seasonAlertRow);
}

// Records a webhook event key the first time it's seen. Returns true when this call recorded it
// (i.e. process the event), false when the key was already present (a redelivery/replay).
// Atomic claim-or-reject: a plain floor(now/window) bucket baked into the key would let two
// deliveries a fraction of a second apart straddle a bucket boundary and both be treated as new.
// This instead does a real sliding-window check against created_at in one statement (avoiding a
// separate check-then-insert race): if the key has never been seen, or was last seen outside the
// window, the row is (re)claimed and this returns true; if it's within the window, the WHERE
// clause blocks the update, changes stays 0, and this returns false (a genuine duplicate).
function recordWebhookEvent(eventKey, source) {
  const result = db.prepare(`
    INSERT INTO webhook_events (event_key, source, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(event_key) DO UPDATE SET source = excluded.source, created_at = CURRENT_TIMESTAMP
    WHERE webhook_events.created_at < datetime('now', ?)
  `).run(eventKey, source, `-${CONFIG.WEBHOOK_DEDUPE_WINDOW_MINUTES} minutes`);
  return result.changes > 0;
}

// Un-claims an event key after its processing failed, so a genuine redelivery (rather than a
// blind retry-storm one) can go through instead of being silently swallowed for the rest of the
// dedupe window.
function forgetWebhookEvent(eventKey) {
  db.prepare('DELETE FROM webhook_events WHERE event_key = ?').run(eventKey);
}

function pruneWebhookEvents(retentionDays) {
  return db.prepare("DELETE FROM webhook_events WHERE created_at < datetime('now', ?)").run(`-${retentionDays} days`).changes;
}

// Registers interest in a title that's already in the pipeline under someone else's request.
// Returns false when the caller is already subscribed (e.g. the original requester), so callers
// can tell "you're already tracked" apart from "added, will notify" without a separate lookup.
function addRequestSubscriber(mediaId, discordId) {
  const result = db.prepare('INSERT OR IGNORE INTO request_subscribers (media_id, discord_id) VALUES (?, ?)').run(mediaId, discordId);
  return result.changes > 0;
}

function listRequestSubscribers(mediaId) {
  return db.prepare('SELECT discord_id FROM request_subscribers WHERE media_id = ?').all(mediaId).map(r => r.discord_id);
}

function countRequestSubscribers(mediaId) {
  return db.prepare('SELECT COUNT(*) AS c FROM request_subscribers WHERE media_id = ?').get(mediaId).c;
}

function clearRequestSubscribers(mediaId) {
  return db.prepare('DELETE FROM request_subscribers WHERE media_id = ?').run(mediaId).changes;
}

function pruneRequestSubscribers(retentionDays) {
  return db.prepare("DELETE FROM request_subscribers WHERE created_at < datetime('now', ?)").run(`-${retentionDays} days`).changes;
}

// Standing toward auto-approval (#80). Deliberately not named "tier" — that word already means
// regional storage tiering elsewhere in this codebase (tier.js, /tier, /tier-member).
function getTrustScore(discordId) {
  return Number.parseInt(getSetting(`trust_score:${discordId}`) || '0', 10);
}

function bumpTrustScore(discordId, delta) {
  const next = Math.max(0, getTrustScore(discordId) + delta);
  setSetting(`trust_score:${discordId}`, String(next));
  return next;
}

function resetTrustScore(discordId) {
  setSetting(`trust_score:${discordId}`, '0');
}

// ---- Per-title priority for the capped Sonarr sweeps (see src/priority.js) ----
const listMediaPriority = () => db.prepare('SELECT * FROM media_priority ORDER BY rank, created_at').all();
const mediaPriorityMap = () => new Map(listMediaPriority().map(r => [r.key, Number(r.rank)]));
function setMediaPriority({ key, mediaType, title, rank, pinnedBy = null }) {
  db.prepare(`
    INSERT INTO media_priority (key, media_type, title, rank, pinned_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET rank = excluded.rank, title = excluded.title
  `).run(key, mediaType, title, rank, pinnedBy);
}
const clearMediaPriority = key => db.prepare('DELETE FROM media_priority WHERE key = ?').run(key);

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

function deleteSetting(key) {
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
}

const passkeyRow = row => row ? { ...row, transports: JSON.parse(row.transports) } : null;
const listPasskeys = () => db.prepare('SELECT credential_id, counter, transports, label, created_at, last_used_at FROM dashboard_passkeys ORDER BY created_at').all().map(passkeyRow);
const getPasskey = credentialId => passkeyRow(db.prepare('SELECT * FROM dashboard_passkeys WHERE credential_id = ?').get(credentialId));
function savePasskey({ credentialId, publicKey, counter, transports, label, createdAt }) {
  db.prepare('INSERT INTO dashboard_passkeys (credential_id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(credentialId, publicKey, counter, JSON.stringify(transports || []), label, createdAt);
}
const updatePasskeyUse = (credentialId, counter, lastUsedAt) => db.prepare('UPDATE dashboard_passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?').run(counter, lastUsedAt, credentialId).changes > 0;
const renamePasskey = (credentialId, label) => db.prepare('UPDATE dashboard_passkeys SET label = ? WHERE credential_id = ?').run(label, credentialId).changes > 0;
const revokePasskey = credentialId => db.prepare('DELETE FROM dashboard_passkeys WHERE credential_id = ?').run(credentialId).changes > 0;

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

function setPendingRequestNotice(nonce, channelId, messageId) {
  if (!/^[0-9a-f]{8}$/.test(String(nonce || ''))) return false;
  const key = `pending_request:${nonce}`;
  const raw = getSetting(key);
  if (!raw) return false;
  let payload;
  try { payload = JSON.parse(raw); } catch (_e) { return false; }
  const value = JSON.stringify({ ...payload, approvalChannelId: channelId, approvalMessageId: messageId });
  return db.prepare('UPDATE app_settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ? AND value = ?').run(value, key, raw).changes > 0;
}

function listPendingRequests() {
  return db.prepare("SELECT key, value, updated_at FROM app_settings WHERE key LIKE 'pending_request:%' ORDER BY updated_at").all()
    .flatMap(row => {
      try {
        const payload = JSON.parse(row.value);
        return [{ ...payload, nonce: row.key.slice('pending_request:'.length), createdAt: payload.createdAt || row.updated_at }];
      } catch (_e) {
        return [];
      }
    });
}

// Finds the nonce for a still-gated request matching this requester + media, so /request-cancel
// can drop it the same way a Deny button would. Table is small (only currently-pending gate
// requests live here), so a scan is fine.
function findPendingRequestNonce(discordId, mediaType, tmdbId, is4k) {
  const rows = db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'pending_request:%'").all();
  for (const row of rows) {
    let payload;
    try { payload = JSON.parse(row.value); } catch (_e) { continue; }
    if (payload.discordId === discordId && payload.mediaType === mediaType && payload.tmdbId === tmdbId && Boolean(payload.is4k) === Boolean(is4k)) {
      return row.key.slice('pending_request:'.length);
    }
  }
  return null;
}

module.exports = { db, DB_PATH, ensureColumn, runMigrations, schemaVersion, audit, upsertTierNode, getTierNode, listTierNodes, setTierNodeEnabled, addTierNodeMember, removeTierNodeMember, listTierNodeMembers, listTierNodeFolders, addTierNodeFolder, removeTierNodeFolder, replaceTierNodeFolders, setTierAgentToken, getTierAgentTokenHash, replaceTierNodeFiles, listTierNodeFiles, listRequestsByRequesters, getTierPlan, setTierPublishedPlan, markTierPlanConverged, recordTierAgentReport, recordTierAgentHeartbeat, storeUserEmail, linkUserToEmail, findConflictingRealUser, getUserByDiscordId, getUserByCanonicalEmail, markUserInvited, markOverseerrCreated, removeUser, upsertRequest, addToKeepList, isInKeepList, recordPendingDeletion, markPendingDeletion, postponePendingDeletion, recordEscalationWatch, getWatchingEscalations, getEscalationById, setEscalationState, setEscalationTvdbId, setEscalationAvistazFit, markEscalationArrMissingAlerted, touchEscalationApprovedAt, resolveEscalationForMediaKey, recordGrabJob, setGrabJobIdentity, getGrabJob, getGrabJobByHash, getGrabJobByRelease, listActiveGrabJobs, nextTransferableGrabJob, setGrabJobState, countGrabJobsToday, requeueGrabTransfer, resetInterruptedGrabTransfers, stashGrabOffer, takeGrabOffer, restashGrabOffer, listAdoptedGrabJobs, setAdoptIgnored, clearAdoptIgnored, isAdoptIgnored, listAdoptIgnored, markAdoptOffered, isAdoptOffered, clearAdoptOffered, listAdoptOfferedHashes, getSeasonSearchTimes, recordSeasonSearch, listRecentSeasonSearches, listRequestedTvdbIds, setUserHomeServer, enqueueStageJob, getStageJob, nextQueuedStageJob, listActiveStageJobs, markStageJobCopying, finishStageJob, requeueStageJob, resetInterruptedStageJobs, recordStagedItem, getStagedItem, listStagedItems, removeStagedItem, touchStagedItem, setStagedItemPinned, countRecentPromotions, recordPromotion, createDownloadToken, getDownloadRecordByRawToken, revokeAllDownloadLinks, cleanExpiredTokens, takePersistentRateLimit, getAlertedAt, setAlertedAt, listAlertCooldowns, clearAlertCooldown, pruneAlertCooldowns, getSeasonAlertState, recordSeasonNoGrab, clearSeasonAlertState, listSeasonAlertStates, getSetting, setSetting, deleteSetting, listPasskeys, getPasskey, savePasskey, updatePasskeyUse, renamePasskey, revokePasskey, listMediaPriority, mediaPriorityMap, setMediaPriority, clearMediaPriority, stashPendingRequest, takePendingRequest, restashPendingRequest, setPendingRequestNotice, listPendingRequests, findPendingRequestNonce, recordWebhookEvent, forgetWebhookEvent, pruneWebhookEvents, addRequestSubscriber, listRequestSubscribers, countRequestSubscribers, clearRequestSubscribers, pruneRequestSubscribers, getTrustScore, bumpTrustScore, resetTrustScore };
module.exports.reconcileRequestStatuses = reconcileRequestStatuses;
Object.assign(module.exports, {
  recordSeasonEpisodeFallbackEvidence,
  getSeasonEpisodeFallback,
  listSeasonEpisodeFallbacks,
  markSeasonEpisodeFallbackSubmitted,
  attachSeasonEpisodeFallbackCommand,
  finishSeasonEpisodeFallback,
  deferSubmittedSeasonEpisodeFallback,
  clearSeasonEpisodeFallback,
});
