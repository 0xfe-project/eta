-- The task board (REFACTOR.md §9, P3.1 — the local half).
--
-- A task is a piece of work the user can see and move: it has a number (so a group can say
-- "第 12 条" and mean one thing), a status, an assignee, and a timeline of what happened to it.
-- This is the *product's* task, not the kernel's per-session todo list (`TaskService`): the two
-- meet at the card a draft becomes in a group's timeline.
--
-- What is missing on purpose: `computer_id` / `runtime` / `provider` / `place` and the run,
-- assist and review-loop tables. Those belong to remote dispatch, which is P4 — a column that
-- nothing writes is a column that lies about what this host can do.
CREATE TABLE task (
  id TEXT PRIMARY KEY,
  -- The human-facing number: never reused, assigned in the same transaction as the row.
  number INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  -- 'none' or 'user' until P4 adds 'remote'.
  assignee TEXT NOT NULL DEFAULT 'none',
  -- The agent that created it, when one did; a task made by the user has no agent.
  created_by_agent TEXT,
  group_id TEXT REFERENCES chat_group (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX task_status ON task (status, updated_at);
CREATE INDEX task_group ON task (group_id);

-- What happened to a task, in order: the timeline a detail view reads and the source of the
-- summary a card shows. `kind` is free-form on purpose — the set grows with the features that
-- write it (comment, status, assignee, title, description, group, artifact, deliverable).
CREATE TABLE task_activity (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  -- Who did it: user, agent, remote or system. `actor_agent` names the agent when there is one.
  actor TEXT NOT NULL,
  actor_agent TEXT,
  body TEXT,
  -- Kind-specific details, e.g. {"from": "todo", "to": "in_progress"} for a status change.
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX task_activity_task ON task_activity (task_id, created_at);
