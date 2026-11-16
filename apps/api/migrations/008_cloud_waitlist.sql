-- Cloud waitlist. Cloud phones are given to approved accounts only; everyone
-- else who asks for one is counted here.
--
-- The approval flag itself (tenants.cloud_approved_at) is added by
-- CloudStore.ensureCloudApproval(), not by this file: accounts that exist when
-- the column first appears must be approved exactly once, and migration files
-- are re-run on every start.

-- One row per refused create. Deliberately no IP address, user agent, or any
-- other field that identifies a machine: only what was asked for.
CREATE TABLE IF NOT EXISTS waitlist_attempts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  account   TEXT NOT NULL,   -- tenant id, or 'anonymous' when logged out
  platform  TEXT,            -- ios | android | NULL when not stated
  client    TEXT NOT NULL    -- cli | mcp | sdk | web | unknown
);
CREATE INDEX IF NOT EXISTS waitlist_attempts_ts ON waitlist_attempts(ts);
CREATE INDEX IF NOT EXISTS waitlist_attempts_account ON waitlist_attempts(account);

-- The waitlist form: an email and what the person would use cloud phones for.
-- approved_at is set when an operator approves the email; an account that
-- signs up with it later starts approved.
CREATE TABLE IF NOT EXISTS waitlist_entries (
  email       TEXT PRIMARY KEY,   -- lower-cased
  use_case    TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  approved_at INTEGER
);
