-- A conversation: one timeline in one project, with agents taking part. There is no table of
-- wakes: a wake is a reply row in `message`, which carries its own status (queued, working, ...)
-- and the message that woke it.
CREATE TABLE conversation (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('group', 'direct')),
  name TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  decided TEXT NOT NULL DEFAULT '',
  -- The conversation's own steward. NULL follows the project's.
  steward_id TEXT REFERENCES agent (id) ON DELETE SET NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  -- How far the user has read; the unread count is the distance past it.
  read_seq INTEGER NOT NULL DEFAULT 0,
  -- The newest row's seq, kept here so a new row's seq is allocated in one statement.
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX conversation_project ON conversation (project_id);

-- Who takes part. `session_id` is the upstream session that holds this agent's side of the
-- conversation (made on its first wake), and `last_seq` is how far it has been shown the
-- timeline: what it is told at its next wake is what came after.
CREATE TABLE participant (
  conversation_id TEXT NOT NULL REFERENCES conversation (id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
  session_id TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  invited_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, agent_id)
);

CREATE INDEX participant_agent ON participant (agent_id);

-- The timeline. `seq` is per conversation and is the order it is read in; a reply takes its place
-- when it is queued and keeps it while its text arrives, so `revision` grows and `seq` does not.
-- `agent_id` has no foreign key: a row outlives the agent that wrote it.
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'mention', 'system')),
  author TEXT NOT NULL CHECK (author IN ('user', 'agent', 'system')),
  agent_id TEXT,
  text TEXT NOT NULL DEFAULT '',
  thinking TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'done' CHECK (
    status IN ('queued', 'working', 'waiting_for_input', 'done', 'failed', 'stopping', 'stopped')
  ),
  revision INTEGER NOT NULL DEFAULT 1,
  mentions TEXT NOT NULL DEFAULT '[]',
  -- The user row a branch of the conversation descends from; what the five-wake budget counts
  -- agent-to-agent mentions under, across every branch.
  root_message_id TEXT,
  -- For a reply, the row that woke it.
  reply_to_id TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);

CREATE INDEX message_root ON message (conversation_id, root_message_id) WHERE kind = 'mention';

-- What is in flight, which is all a restart and the agents' status ever ask about.
CREATE INDEX message_active ON message (status) WHERE status IN ('queued', 'working', 'waiting_for_input', 'stopping');
