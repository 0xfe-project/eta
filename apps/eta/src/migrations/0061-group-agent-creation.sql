CREATE TABLE group_agent_creation (
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, client_id)
);
