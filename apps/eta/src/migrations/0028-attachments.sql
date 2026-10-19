-- Files a person attaches to a message. The bytes are under the data directory, per
-- conversation (`attachments/<conversation>/<id>-<name>`); this row says whose they are. An
-- attachment is uploaded before the message exists, so `message_id` is NULL until the message
-- that carries it is sent, and an unsent one can still be taken back.
CREATE TABLE attachment (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  message_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX attachment_conversation ON attachment (conversation_id);
CREATE INDEX attachment_unsent ON attachment (created_at) WHERE message_id IS NULL;
