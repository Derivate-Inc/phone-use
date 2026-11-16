-- Multi-tenancy + metering.
--
-- Two gaps the v0 left open: one API token meant any caller could enumerate and
-- delete the whole fleet, and nothing recorded usage.

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- sha-256 of the API key; the key itself is shown once at creation and never stored.
  key_hash TEXT NOT NULL UNIQUE,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);

CREATE INDEX IF NOT EXISTS tenants_key_idx ON tenants(key_hash);

-- Existing rows predate tenancy; they belong to no tenant and are only visible to admins.
ALTER TABLE sandboxes ADD COLUMN tenant_id TEXT REFERENCES tenants(id);

CREATE INDEX IF NOT EXISTS sandboxes_tenant_idx ON sandboxes(tenant_id, status);

-- One row per sandbox, written when it reaches a terminal state. billed_ms is the
-- running window (create → close), which is what the customer is charged for.
CREATE TABLE IF NOT EXISTS usage (
  sandbox_id TEXT PRIMARY KEY,
  tenant_id TEXT,
  platform TEXT NOT NULL,
  host_id TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  billed_ms INTEGER NOT NULL,
  end_reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_tenant_idx ON usage(tenant_id, ended_at);
