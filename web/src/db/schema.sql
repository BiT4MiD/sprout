-- ============================================================
--  SPROUT CONTROL CENTRE — SQLite schema
-- ------------------------------------------------------------
--  Design notes
--
--  * One row per (user, day, domain) for usage, so every rollup the
--    dashboard shows — 24h / 7d / 30d / year / lifetime, per category,
--    per domain — is a GROUP BY rather than a blob to re-parse. The
--    extension's current `timeStats[dateString][domain]` object cannot
--    be queried at all; this is the main reason the web app can show
--    more detail than the popup ever could.
--  * Settings are key/value rather than columns. The extension gains
--    settings constantly (there are ~50 storage keys today); a wide
--    table would need a migration for each one. `sync_version` on the
--    user row is what makes incremental sync cheap.
--  * Times are stored as UTC epoch milliseconds (INTEGER). Local
--    calendar days are stored separately as `local_date` TEXT
--    'YYYY-MM-DD' computed on the client, because "what did I do
--    today" must follow the user's clock, not the server's.
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- Accounts
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  email             TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name      TEXT,
  -- scrypt: stored as "scrypt$N$r$p$<salt b64>$<hash b64>" so the cost
  -- parameters travel with the hash and can be raised later per user.
  password_hash     TEXT    NOT NULL,
  timezone          TEXT    NOT NULL DEFAULT 'UTC',
  -- Bumped on every settings/rules write. Clients send the version they
  -- last saw; the server replies with only what changed since.
  sync_version      INTEGER NOT NULL DEFAULT 0,
  email_verified_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_login_at     INTEGER
);

-- Browser sessions for the dashboard (cookie holds the opaque token id;
-- token_hash is a SHA-256 of the secret so a DB leak can't be replayed).
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT    PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT    NOT NULL,
  user_agent    TEXT,
  ip            TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ------------------------------------------------------------
-- Paired browsers
-- ------------------------------------------------------------
-- A device is one browser profile running the extension. The dashboard
-- mints a short code; the extension redeems it once for a long-lived
-- API token. Codes are single-use and expire in minutes.
CREATE TABLE IF NOT EXISTS devices (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT    NOT NULL,           -- "Chrome on bitmid"
  platform         TEXT,                        -- navigator.userAgentData
  extension_version TEXT,
  token_hash       TEXT    NOT NULL UNIQUE,     -- SHA-256 of the bearer token
  last_sync_at     INTEGER,
  last_sync_version INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  revoked_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code       TEXT    PRIMARY KEY,               -- 8 chars, Crockford base32
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  device_id  INTEGER REFERENCES devices(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_pairing_expires ON pairing_codes(expires_at);

-- ------------------------------------------------------------
-- Settings  (mirrors the extension's chrome.storage.local keys)
-- ------------------------------------------------------------
-- `value_json` holds a JSON-encoded scalar/array/object so booleans,
-- numbers and lists round-trip without a type column per row.
-- `scope` says who owns the truth for a key:
--    'account' — same on every device (block rules, AI config, goals)
--    'device'  — per browser (theme, floating widget, soundscape volume)
CREATE TABLE IF NOT EXISTS settings (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   INTEGER          REFERENCES devices(id) ON DELETE CASCADE,
  key         TEXT    NOT NULL,
  value_json  TEXT    NOT NULL,
  scope       TEXT    NOT NULL DEFAULT 'account' CHECK (scope IN ('account','device')),
  updated_at  INTEGER NOT NULL,
  version     INTEGER NOT NULL,                 -- users.sync_version at write time
  PRIMARY KEY (user_id, device_id, key)
);
CREATE INDEX IF NOT EXISTS idx_settings_version ON settings(user_id, version);

-- ------------------------------------------------------------
-- Blocking rules
-- ------------------------------------------------------------
-- Replaces the flat `blacklist` array. A row per pattern means the
-- dashboard can attach a reason, a schedule and per-rule stats — none
-- of which the array could carry.
CREATE TABLE IF NOT EXISTS rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pattern      TEXT    NOT NULL,                -- normalised domain, e.g. "reddit.com"
  kind         TEXT    NOT NULL DEFAULT 'block'
                 CHECK (kind IN ('block','allow','shield')),
  -- 'shield' rules soften a site instead of blocking it; shield_type
  -- names which cleaner runs: youtube_zen | twitter_clean | reddit_clean
  shield_type  TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  -- NULL schedule_id = always in force for the active block mode.
  schedule_id  INTEGER REFERENCES schedules(id) ON DELETE SET NULL,
  note         TEXT,
  source       TEXT    NOT NULL DEFAULT 'user'
                 CHECK (source IN ('user','ai','default','import')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (user_id, pattern, kind)
);
CREATE INDEX IF NOT EXISTS idx_rules_user ON rules(user_id, enabled);

CREATE TABLE IF NOT EXISTS schedules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,                 -- "Work hours", "Evening wind-down"
  days_mask   INTEGER NOT NULL DEFAULT 127,     -- bit 0 = Sunday … bit 6 = Saturday
  start_min   INTEGER NOT NULL,                 -- minutes past local midnight
  end_min     INTEGER NOT NULL,                 -- may be < start_min to wrap midnight
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_user ON schedules(user_id);

-- ------------------------------------------------------------
-- Telemetry  (the reason the dashboard can be more detailed)
-- ------------------------------------------------------------
-- One row per user/day/domain. `seconds` accumulates; `category` is
-- denormalised at write time so historical rows keep the classification
-- they had, even if the categoriser later changes its mind.
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   INTEGER          REFERENCES devices(id) ON DELETE SET NULL,
  local_date  TEXT    NOT NULL,                 -- 'YYYY-MM-DD' in the user's timezone
  domain      TEXT    NOT NULL,
  seconds     INTEGER NOT NULL DEFAULT 0,
  category    TEXT    NOT NULL DEFAULT 'neutral'
                 CHECK (category IN ('productive','research','neutral','distracting')),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, local_date, domain, device_id)
);
CREATE INDEX IF NOT EXISTS idx_usage_date   ON usage_daily(user_id, local_date);
CREATE INDEX IF NOT EXISTS idx_usage_domain ON usage_daily(user_id, domain);

-- Deep Work sessions. One row per completed or abandoned sprint, which
-- is what makes "your best focus hour is 10am" and per-session debriefs
-- possible — the extension only ever kept a running count.
CREATE TABLE IF NOT EXISTS focus_sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id      INTEGER          REFERENCES devices(id) ON DELETE SET NULL,
  client_uuid    TEXT    NOT NULL,              -- idempotency key from the extension
  local_date     TEXT    NOT NULL,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  planned_min    INTEGER NOT NULL,
  actual_seconds INTEGER NOT NULL DEFAULT 0,
  intention      TEXT,
  outcome        TEXT CHECK (outcome IN ('accomplished','partially','derailed','abandoned')),
  alignment_score INTEGER,
  UNIQUE (user_id, client_uuid)
);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON focus_sessions(user_id, local_date);

-- Every interception. Per-attempt rows let the dashboard show which
-- sites you fight hardest and at what hour, instead of one daily total.
CREATE TABLE IF NOT EXISTS block_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   INTEGER          REFERENCES devices(id) ON DELETE SET NULL,
  client_uuid TEXT    NOT NULL,
  domain      TEXT    NOT NULL,
  local_date  TEXT    NOT NULL,
  local_hour  INTEGER NOT NULL CHECK (local_hour BETWEEN 0 AND 23),
  occurred_at INTEGER NOT NULL,
  outcome     TEXT    NOT NULL DEFAULT 'blocked'
                 CHECK (outcome IN ('blocked','hall_pass','proceeded')),
  UNIQUE (user_id, client_uuid)
);
CREATE INDEX IF NOT EXISTS idx_block_date   ON block_events(user_id, local_date);
CREATE INDEX IF NOT EXISTS idx_block_domain ON block_events(user_id, domain);

-- Focus checklist, synced so the block screen and dashboard agree.
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_uuid TEXT    NOT NULL,
  text        TEXT    NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  completed_at INTEGER,
  deleted_at  INTEGER,
  UNIQUE (user_id, client_uuid)
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, deleted_at);

-- Append-only audit of security-relevant actions. Shown on the Account
-- page so the user can see logins and pairings they didn't make.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  action      TEXT    NOT NULL,                 -- login.success, device.paired, …
  detail_json TEXT,
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);

-- Schema version marker, read by migrate.js.
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '1');
