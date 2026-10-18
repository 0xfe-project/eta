-- The task board. A task has a number, so that a conversation can say "#12" and mean one task for
-- good, and a timeline of what happened to it.
--
-- The number is the row id, and AUTOINCREMENT is what makes it never reused: without it SQLite
-- hands out max+1, and deleting the newest task would give its number to the next one.
CREATE TABLE task (
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (
    status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled')
  ),
  assignee TEXT NOT NULL DEFAULT 'none' CHECK (assignee IN ('none', 'user')),
  -- The agent that made it; NULL is the user. No foreign key: a task outlives its author.
  created_by_agent TEXT,
  -- The conversation it is discussed in. A conversation is never removed; this is for safety.
  conversation_id TEXT REFERENCES conversation (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX task_updated ON task (updated_at);
CREATE INDEX task_conversation ON task (conversation_id);

-- What happened to a task, in order (the row order is the order): the timeline its page reads and
-- the source of the summary a card shows. `kind` says what; `data` has the details of that kind.
CREATE TABLE task_activity (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('created', 'comment', 'status', 'assignee', 'title', 'description', 'conversation', 'artifact')
  ),
  actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system')),
  -- No foreign key, like `message.agent_id`: what an agent did stays after it is gone.
  actor_agent TEXT,
  body TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX task_activity_task ON task_activity (task_id, kind);
