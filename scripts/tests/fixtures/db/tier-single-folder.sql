-- Anonymous representative of the tier schema before R2.1 multi-folder support
-- (commit 923a576). Apply after v3-core.sql.
CREATE TABLE tier_nodes (
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
CREATE TABLE tier_node_members (
  node TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (node, discord_id)
);
CREATE TABLE tier_agent_tokens (
  node TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE tier_node_files (
  node TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  size_bytes INTEGER DEFAULT 0,
  atime INTEGER,
  reported_at INTEGER,
  PRIMARY KEY (node, rel_path)
);

INSERT INTO tier_nodes (
  name, usable_bytes, folder_root, enabled
) VALUES (
  'fixture-edge', 500000000000, '/fixture/media', 1
);
INSERT INTO tier_node_files (
  node, rel_path, size_bytes, atime, reported_at
) VALUES (
  'fixture-edge', 'Movies/Fixture Movie (2025)', 123456789, 1735689600000, 1735689600000
);

