-- A file can come with a task's comment, as it comes with a message. An attachment belongs to a
-- conversation or to a task, never both: `conversation_id` loses its NOT NULL and `task_id` comes
-- beside it, and a CHECK keeps exactly one of them. A task's file is claimed by its comment
-- (`message_id` is then the comment's task_activity id) and goes with the task.
--
-- A column's NOT NULL cannot be dropped in place, so the table is made again and its rows copied.
-- Nothing references `attachment`, so dropping the old one cascades nowhere.
CREATE TABLE attachment_next (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversation (id) ON DELETE CASCADE,
  task_id TEXT REFERENCES task (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  message_id TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((conversation_id IS NULL) <> (task_id IS NULL))
);

INSERT INTO attachment_next (id, conversation_id, task_id, name, content_type, size, message_id, created_at)
SELECT id, conversation_id, NULL, name, content_type, size, message_id, created_at FROM attachment ORDER BY rowid;

DROP TABLE attachment;

ALTER TABLE attachment_next RENAME TO attachment;

CREATE INDEX attachment_conversation ON attachment (conversation_id);
CREATE INDEX attachment_task ON attachment (task_id);
CREATE INDEX attachment_unsent ON attachment (created_at) WHERE message_id IS NULL;
