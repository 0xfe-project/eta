-- An interaction: a question an agent's session asked, and what became of it. The session that
-- asked is parked on a promise inside its ask channel; this row is what a client reads to know the
-- question exists, and what a restart reads to know it is over.
--
-- `id` is derived from the session and the question (`<session>:<question>`), because the
-- question's own id is the model's tool call id and nothing promises two sessions never draw the
-- same one. Asking the same question again in the same session finds its row. `agent_id`,
-- `conversation_id` and `reply_id` carry no foreign key: the row is history, and outlives them.
CREATE TABLE interaction (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  agent_id TEXT,
  conversation_id TEXT,
  -- The reply row that was running when it was asked, when the ask happened inside a wake.
  reply_id TEXT,
  prompt TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  multi INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'canceled', 'expired')),
  -- The answer as the ask channel takes it (JSON); NULL when it was settled without one.
  answer TEXT,
  -- Grows on every change, so a client tells "the same card, newer" from "a second card".
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX interaction_status ON interaction (status, updated_at);
