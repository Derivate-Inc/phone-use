-- RFC 8628 device authorization: CLI logins that work without a browser or a
-- reachable localhost (SSH, Docker, CI, remote dev boxes).
CREATE TABLE IF NOT EXISTS device_auth (
  device_code   TEXT PRIMARY KEY,
  user_code     TEXT NOT NULL UNIQUE,
  client_name   TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | denied
  tenant_id     TEXT,
  api_key       TEXT,                             -- minted at approval, read once
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  approved_at   INTEGER
);
CREATE INDEX IF NOT EXISTS device_auth_user_code ON device_auth(user_code);
CREATE INDEX IF NOT EXISTS device_auth_expiry ON device_auth(expires_at);
