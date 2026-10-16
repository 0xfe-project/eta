-- Groups, their participants and their timeline (REFACTOR.md §9, P2.1).
--
-- A group is a conversation several agents can take part in. It holds no business state (that is
-- the task board's, in P3); what it holds is who is in it, what was said, and which messages woke
-- which agent. `private` marks the single-agent group an agent gets for itself — private groups
-- cannot change members, and a message in one wakes its only member without naming it.
CREATE TABLE chat_group (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  decided TEXT NOT NULL DEFAULT '',
  private INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Who takes part. `session_id` is where this agent's conversation in this group lives; P2.2 puts
-- a session there, and the mapping survives a restart because it is a row, not a variable.
CREATE TABLE group_participant (
  group_id TEXT NOT NULL REFERENCES chat_group (id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  session_id TEXT,
  -- How far this agent has been shown: what "the rest is context" is measured against.
  last_seq INTEGER NOT NULL DEFAULT 0,
  invited_at TEXT NOT NULL,
  PRIMARY KEY (group_id, agent_id)
);

-- The timeline. `seq` is per group and is what a client resumes from.
--
-- `root_message_id` is the user message a branch descends from: an agent's message mentioning
-- another agent is a `mention` message, and those are what the five-wake budget counts — across
-- every branch of one root, not per agent.
CREATE TABLE group_message (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES chat_group (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_agent_id TEXT,
  text TEXT NOT NULL DEFAULT '',
  mentions TEXT NOT NULL DEFAULT '[]',
  root_message_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (group_id, seq)
);

-- The wake decision, recorded rather than executed: which message wakes which agent, in what
-- order. P2.2 takes a queued wake and injects it into that (agent × group) session; nothing else
-- reads this table.
CREATE TABLE group_wake (
  group_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, agent_id, message_id)
);

CREATE INDEX group_wake_queued ON group_wake (group_id, agent_id, state, seq);
CREATE INDEX group_message_root ON group_message (group_id, root_message_id);
