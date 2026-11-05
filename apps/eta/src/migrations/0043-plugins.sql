-- Plugins: where the ones from git came from (a local one is a directory, and needs no row), what
-- the user configured, how far they let agents read it, and which agents use which.
CREATE TABLE plugin_source (
  name TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  rev TEXT NOT NULL,
  path TEXT NOT NULL,
  sha TEXT NOT NULL,
  -- The branch or tag `sha` was read from, for servers that only give out what they advertise.
  ref TEXT,
  added_at INTEGER NOT NULL
);

-- One configuration per plugin, global: the values as sealed JSON.
CREATE TABLE plugin_config (
  plugin TEXT PRIMARY KEY,
  sealed BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Only what the user lowered; everything else is at what the manifest declares.
CREATE TABLE plugin_agent_level (
  plugin TEXT NOT NULL,
  field TEXT NOT NULL,
  level TEXT NOT NULL,
  PRIMARY KEY (plugin, field)
);

-- A plugin is named, not referenced: it is a directory, and can come and go with the agent's row
-- still saying that it wants it.
CREATE TABLE agent_plugin (
  agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  plugin TEXT NOT NULL,
  PRIMARY KEY (agent_id, plugin)
);

-- Who read which secret, and when. Outlives the agent; the value is never here.
CREATE TABLE plugin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  plugin TEXT NOT NULL,
  field TEXT NOT NULL,
  level TEXT NOT NULL
);
CREATE INDEX plugin_audit_at ON plugin_audit (at DESC);
