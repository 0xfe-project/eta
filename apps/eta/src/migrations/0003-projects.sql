-- A project: a directory on a machine, with an optional steward (the agent who takes what nobody
-- is named for). `agent_home` is the workspace every agent gets; it is a project like any other
-- except that it is made with the agent and holds the agent's private chat.
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machine (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'project' CHECK (kind IN ('project', 'agent_home')),
  steward_id TEXT REFERENCES agent (id) ON DELETE SET NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (machine_id, path)
);
