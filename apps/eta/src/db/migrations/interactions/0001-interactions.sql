-- An interaction: a question an agent asked, and the human's answer to it (REFACTOR.md §9, P2.6 —
-- 审批 = ask, which is also what the product calls a confirmation card).
--
-- The id is the model's tool call id. The journal records the same exchange under it, so a session
-- that is replayed after a restart re-surfaces the card a client is already showing rather than a
-- second one, and an answer that was recorded is never asked again.
--
-- `status` moves pending → resolved, or pending → expired when the run it belonged to ended first.
-- `revision` grows on every change, which is what lets a client tell "the same card, newer" from
-- "a second card" — the same rule the timeline rows use.
CREATE TABLE interaction (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  -- The timeline row (a reply) this question came out of, when there was one.
  message_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'choice',
  prompt TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  answer TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX interaction_status ON interaction (status, created_at);
