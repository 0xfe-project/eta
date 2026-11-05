-- A Captain relay question points at the assigned agent's original Inbox question. When the user
-- answers the relay, this link is what turns that answer into a new Captain decision review.
ALTER TABLE interaction ADD COLUMN relay_of TEXT
  REFERENCES interaction (id) ON DELETE SET NULL;

CREATE INDEX interaction_relay
  ON interaction (relay_of, created_at);
