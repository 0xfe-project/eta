-- Supervisor observations that need Captain's judgement. A review is durable before it is
-- delivered, so a restart or a busy Captain cannot silently lose an operational decision.
CREATE TABLE captain_review (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversation (id) ON DELETE CASCADE,
  task_id TEXT REFERENCES task (id) ON DELETE CASCADE,
  assignment_id TEXT REFERENCES captain_assignment (id) ON DELETE CASCADE,
  checkpoint_seq INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'running', 'completed', 'failed')
  ),
  message_id TEXT REFERENCES message (id) ON DELETE SET NULL,
  reply_id TEXT REFERENCES message (id) ON DELETE SET NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER
);

CREATE INDEX captain_review_pending
  ON captain_review (status, created_at);
CREATE INDEX captain_review_assignment
  ON captain_review (assignment_id, checkpoint_seq);
CREATE INDEX captain_review_reply
  ON captain_review (reply_id);
