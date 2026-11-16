-- Hardening (codex review, doc 36): one tenant per user enforced at the
-- schema level, and key age becomes visible/auditable.
CREATE UNIQUE INDEX IF NOT EXISTS tenants_user_unique ON tenants(user_id) WHERE user_id IS NOT NULL;

ALTER TABLE tenants ADD COLUMN key_created_at INTEGER;
