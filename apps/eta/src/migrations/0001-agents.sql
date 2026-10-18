-- An agent: a global configuration, not a container. It owns no sessions and no conversations;
-- a session belongs to an (agent, conversation) pair, and the agent's workspace is a project
-- (see 0003). Times are epoch milliseconds, like everything on the wire.
CREATE TABLE agent (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Added to the base of the system prompt of each of the agent's sessions.
  instructions TEXT NOT NULL DEFAULT '',
  -- The persona card it wears, by name. '' is the project's default card, which is a different
  -- statement from "no persona".
  persona TEXT NOT NULL DEFAULT '',
  -- `provider:modelId`. NULL means whatever the settings choose.
  model TEXT,
  thinking_level TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
