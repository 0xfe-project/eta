-- A computer sessions run on. Only the primary (the one this host runs on) exists today; the other
-- kinds are the shape a daemon or an SSH target will take, so a project can already name its
-- machine and nothing about projects changes when they arrive.
CREATE TABLE machine (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('primary', 'daemon', 'ssh')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'offline', 'pending', 'revoked')),
  -- The digest of the key a daemon enrolled with, or an SSH host key; NULL for the primary.
  fingerprint TEXT,
  home TEXT,
  os TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

-- The primary's id is written once, here, and read from here ever after: a project that names it
-- keeps naming it across restarts and moves of the data directory.
CREATE UNIQUE INDEX machine_one_primary ON machine (kind) WHERE kind = 'primary';
