-- Anonymous representative of the original v3 core schema (commit c113239).
-- Values are synthetic and intentionally exercise preservation and bounded data repair.
PRAGMA user_version = 0;

CREATE TABLE users (
  discord_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  invited INTEGER DEFAULT 0,
  invited_at TEXT,
  requested_at TEXT NOT NULL,
  overseerr_created INTEGER DEFAULT 0,
  overseerr_user_id INTEGER,
  plex_username TEXT
);
CREATE TABLE requests (
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
CREATE TABLE keep_list (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  title TEXT NOT NULL,
  kept_by_discord_id TEXT,
  expires_at INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX idx_keep_unique ON keep_list(media_id, kept_by_discord_id);
CREATE TABLE download_tokens (
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
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  actor_discord_id TEXT,
  target_discord_id TEXT,
  metadata_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE download_access_log (
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
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE pending_deletions (
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
CREATE TABLE media_retention_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_class TEXT UNIQUE,
  retention_days INTEGER NOT NULL,
  enabled INTEGER DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users (
  discord_id, email, invited, invited_at, requested_at,
  overseerr_created, overseerr_user_id, plex_username
) VALUES (
  '100000000000000001', 'fixture@example.test', 1, '2025-01-01T00:00:00.000Z',
  '2025-01-01T00:00:00.000Z', 1, 41, 'fixture-user'
);
INSERT INTO requests (
  overseerr_request_id, media_id, media_type, is_4k, title,
  requested_by_discord_id, status, created_at
) VALUES (
  '', 'tmdb:101', 'movie', 0, 'Fixture Movie',
  '100000000000000001', 'available', '2025-01-02 00:00:00'
);
INSERT INTO keep_list (
  media_id, media_type, title, kept_by_discord_id, expires_at
) VALUES (
  'tmdb:101', 'movie', 'Fixture Movie', '100000000000000001', 1893456000000
);

