-- El Capitan: one system-role agent, group assignments, prompt/settings history, memory pauses,
-- durable operations and notifications.

ALTER TABLE agent ADD COLUMN system_role TEXT;
CREATE UNIQUE INDEX agent_one_captain
  ON agent (system_role)
  WHERE system_role = 'captain';

-- A Captain message is not a user message. The author is part of the message CHECK, so the table
-- has to be rebuilt once more on SQLite.
CREATE TABLE message_next (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'mention', 'system', 'task_draft', 'task_card')),
  author TEXT NOT NULL CHECK (author IN ('user', 'agent', 'system', 'captain')),
  agent_id TEXT,
  text TEXT NOT NULL DEFAULT '',
  thinking TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'done' CHECK (
    status IN ('queued', 'working', 'waiting_for_input', 'done', 'failed', 'stopping', 'stopped')
  ),
  revision INTEGER NOT NULL DEFAULT 1,
  mentions TEXT NOT NULL DEFAULT '[]',
  root_message_id TEXT,
  reply_to_id TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);

INSERT INTO message_next (
  id, conversation_id, seq, kind, author, agent_id, text, thinking, status, revision, mentions,
  root_message_id, reply_to_id, data, created_at, updated_at
)
SELECT
  id, conversation_id, seq, kind, author, agent_id, text, thinking, status, revision, mentions,
  root_message_id, reply_to_id, data, created_at, updated_at
FROM message;

DROP TABLE message;
ALTER TABLE message_next RENAME TO message;

CREATE INDEX message_root ON message (conversation_id, root_message_id) WHERE kind = 'mention';
CREATE INDEX message_active ON message (status) WHERE status IN ('queued', 'working', 'waiting_for_input', 'stopping');
CREATE INDEX message_task_card ON message (json_extract(data, '$.taskId')) WHERE kind = 'task_card';

-- One Captain instruction. Captain is the source, never the task executor.
CREATE TABLE captain_assignment (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation (id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES message (id) ON DELETE CASCADE,
  root_message_id TEXT,
  captain_agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
  round INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'dispatched' CHECK (
    status IN ('dispatched', 'working', 'completed', 'failed', 'blocked', 'cancelled')
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX captain_assignment_conversation
  ON captain_assignment (conversation_id, created_at);
CREATE INDEX captain_assignment_message
  ON captain_assignment (message_id);

CREATE TABLE captain_assignment_target (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES captain_assignment (id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
  reply_id TEXT REFERENCES message (id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'dispatched' CHECK (
    status IN ('dispatched', 'working', 'completed', 'failed', 'blocked', 'cancelled')
  ),
  task_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (assignment_id, agent_id)
);

CREATE INDEX captain_assignment_target_agent
  ON captain_assignment_target (agent_id, status, created_at);

-- Every task produced by a Captain instruction points back to the instruction. The target agent
-- remains task.created_by_agent and therefore the executor.
ALTER TABLE task ADD COLUMN captain_assignment_id TEXT
  REFERENCES captain_assignment (id) ON DELETE SET NULL;
ALTER TABLE task ADD COLUMN captain_message_id TEXT
  REFERENCES message (id) ON DELETE SET NULL;
CREATE INDEX task_captain_assignment ON task (captain_assignment_id);

-- Prompt and settings history. A rollback appends a new version rather than deleting history.
CREATE TABLE captain_prompt_version (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('instructions', 'persona', 'base')),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  actor_agent TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (subject_id, kind, version)
);

CREATE INDEX captain_prompt_version_subject
  ON captain_prompt_version (subject_id, kind, version DESC);

CREATE TABLE captain_setting_version (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  value TEXT,
  actor_agent TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (key, version)
);

-- Persisted while paused, until explicitly resumed. Scope is group/direct conversation or task.
CREATE TABLE captain_memory_pause (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('conversation', 'task')),
  scope_id TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_type, scope_id)
);

-- Soft-deleted file memories, so a Captain delete can be reviewed and restored. Sidecar memories
-- keep their own deleted metadata.
CREATE TABLE captain_memory_archive (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  path TEXT NOT NULL,
  section TEXT NOT NULL,
  text TEXT NOT NULL,
  deleted_by TEXT,
  deleted_at INTEGER NOT NULL,
  restored_at INTEGER
);

CREATE INDEX captain_memory_archive_agent
  ON captain_memory_archive (agent_id, deleted_at);

-- Long-running or privileged writes. Pending rows survive a host restart.
CREATE TABLE captain_operation (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  actor_agent TEXT,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'rejected', 'applied', 'failed', 'expired')
  ),
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX captain_operation_status
  ON captain_operation (status, created_at);

CREATE TABLE captain_notification (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  read_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX captain_notification_unread
  ON captain_notification (read_at, created_at);

CREATE TABLE captain_retry (
  task_id TEXT PRIMARY KEY REFERENCES task (id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_run_id TEXT,
  stopped_at INTEGER,
  updated_at INTEGER NOT NULL
);
