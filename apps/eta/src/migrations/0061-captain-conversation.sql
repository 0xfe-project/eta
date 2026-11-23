-- eta: foreign keys off
--
-- There are no private chats any more. Captain's conversation is the captain module's own kind,
-- and every other private chat becomes a group of one: the agent it was with, as its steward.
-- Ids stay, so the messages, tasks, artifacts, attachments and sessions that point at them stay
-- where they are; names and whether a chat was put away stay too.
--
-- A CHECK cannot be altered, and the old one does not let a row be `captain`, so the table is made
-- again and each row copied into it with its new kind. A row that ends up neither fails the new
-- CHECK and stops the migration.
CREATE TABLE conversation_next (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('group', 'captain')),
  name TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  decided TEXT NOT NULL DEFAULT '',
  -- Who takes a user message that names nobody: a member, or NULL for none.
  steward_id TEXT REFERENCES agent (id) ON DELETE SET NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  -- How far the user has read; the unread count is the distance past it.
  read_seq INTEGER NOT NULL DEFAULT 0,
  -- The newest row's seq, kept here so a new row's seq is allocated in one statement.
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO conversation_next (
  id, project_id, kind, name, goal, decided, steward_id, archived, read_seq, last_seq, created_at,
  updated_at
)
SELECT id, project_id,
       CASE
         WHEN kind <> 'direct' THEN kind
         -- Captain's: the private chat Captain is in.
         WHEN EXISTS (
           SELECT 1 FROM participant
             JOIN agent ON agent.id = participant.agent_id
            WHERE participant.conversation_id = conversation.id
              AND agent.system_role = 'captain'
         ) THEN 'captain'
         -- The rest: a group of one.
         ELSE 'group'
       END,
       name, goal, decided,
       CASE
         WHEN kind <> 'direct' THEN steward_id
         -- Its agent is its steward. A chat whose agent was deleted has nobody left, and none.
         ELSE (
           SELECT participant.agent_id FROM participant
            WHERE participant.conversation_id = conversation.id
            ORDER BY participant.rowid LIMIT 1
         )
       END,
       archived, read_seq, last_seq, created_at, updated_at
  FROM conversation ORDER BY rowid;

DROP TABLE conversation;
ALTER TABLE conversation_next RENAME TO conversation;
CREATE INDEX conversation_project ON conversation (project_id);
