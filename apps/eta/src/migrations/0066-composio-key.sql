-- The Composio API key the user gave the market, sealed like every other secret the host keeps
-- (see ../secret.ts). One row at most. The key is never read back to a client and is no part of any
-- cache key.
CREATE TABLE composio_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sealed BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
