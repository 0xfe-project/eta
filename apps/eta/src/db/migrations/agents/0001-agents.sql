-- The agents: what an agent *is* — a name, a model, instructions, the plugins it loads.
--
-- A session is a conversation; an agent is the configuration those conversations belong to
-- (REFACTOR.md §9, P0.8). The group router reads this table in P2; P0 only needs it to exist.
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT,
  instructions TEXT NOT NULL DEFAULT '',
  plugins TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
