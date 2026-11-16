PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  public_url TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sandboxes (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'preparing', 'running', 'draining', 'closed', 'failed')),
  host_id TEXT REFERENCES hosts(id),
  connection_token TEXT NOT NULL,
  device_ref TEXT,
  name TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  idle_timeout_ms INTEGER,
  operation_started_at INTEGER
);

CREATE INDEX IF NOT EXISTS sandboxes_queue_idx ON sandboxes(status, platform, created_at);
CREATE INDEX IF NOT EXISTS sandboxes_host_idx ON sandboxes(host_id, status);
