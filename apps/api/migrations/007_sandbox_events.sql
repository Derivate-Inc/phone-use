-- Per-sandbox action log (tier 1 observability). One row per RPC verb the
-- worker executes. `detail` is a small redacted JSON string: typed text is
-- never stored (lengths only) — people log into real accounts on these phones.
-- tenant_id is denormalized because reap() deletes closed sandboxes after 7
-- days and the events must outlive them.
CREATE TABLE IF NOT EXISTS sandbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sandbox_id TEXT NOT NULL,
  tenant_id TEXT,
  ts INTEGER NOT NULL,
  method TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_sandbox_events_sandbox ON sandbox_events(sandbox_id, ts);
CREATE INDEX IF NOT EXISTS idx_sandbox_events_tenant ON sandbox_events(tenant_id, ts);
