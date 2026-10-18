-- An install code for a machine that will run the daemon: one-time, good for 24 hours. Only the
-- code's digest is kept, so reading this table does not let anyone enrol a machine. Using a code
-- makes the machine row (pending, until the user approves its fingerprint) and links to it.
CREATE TABLE machine_enrollment (
  id TEXT PRIMARY KEY,
  code_digest TEXT NOT NULL UNIQUE,
  -- What the user called the machine when making the code; the machine's own hostname otherwise.
  name TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  machine_id TEXT REFERENCES machine (id) ON DELETE SET NULL
);
