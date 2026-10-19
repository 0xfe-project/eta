-- Usage: one row per generation a session made, with the agent and conversation it was made for.
-- Rows are kept for 30 days (pruned at startup and once a day after that); every sum a client sees
-- is a read of this table, so there is no counter to drift.
--
-- `agent_id` and `conversation_id` are NULL for a session that belongs to neither, and carry no
-- foreign key: what an agent cost outlives the agent. `status` is how the generation ended: the
-- provider answered (`ok`), failed (`error`, with its own words in `error`), or the run was
-- stopped under it (`aborted`).
CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  conversation_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'aborted')),
  error TEXT
);

CREATE INDEX usage_at ON usage (at);
