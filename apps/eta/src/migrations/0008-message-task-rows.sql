-- The timeline gets two more kinds of row, the task board's: a draft an agent proposes
-- (`task_draft`) and the same row once the user has confirmed it (`task_card`). A CHECK cannot be
-- altered in SQLite, so the table is made again with the longer list. Nothing references `message`,
-- so there is nothing to detach first; the indexes go with the old table and are made again.
CREATE TABLE message_next (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'mention', 'system', 'task_draft', 'task_card')),
  author TEXT NOT NULL CHECK (author IN ('user', 'agent', 'system')),
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
-- Where the cards of a task are, in every conversation it was confirmed in.
CREATE INDEX message_task_card ON message (json_extract(data, '$.taskId')) WHERE kind = 'task_card';
