-- Human accounts (Better Auth) own tenants. Better Auth manages its own
-- user/session/account tables in this same database; we only link a tenant to
-- a user id so console sessions resolve to the same scoping as API keys.
ALTER TABLE tenants ADD COLUMN user_id TEXT;

CREATE INDEX IF NOT EXISTS tenants_user_idx ON tenants(user_id);
