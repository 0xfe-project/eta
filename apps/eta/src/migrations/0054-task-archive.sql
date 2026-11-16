-- A task can be archived: put away, not deleted and not a status. `archived_at` is when (NULL: on
-- the board), `archived_by` who: `auto` (the host, for a done or cancelled task left quiet), `user`,
-- or an agent's id. The board leaves archived tasks out of its lists and counts them everywhere
-- else; anything new on an archived task's timeline brings it back (`tasks/store.ts`). Old tasks
-- are on the board, as they always were: no row is changed.
ALTER TABLE task ADD COLUMN archived_at INTEGER;
ALTER TABLE task ADD COLUMN archived_by TEXT;

CREATE INDEX task_archived ON task (archived_at);

-- The timeline says when a task was put away (`archived`) and when, and why, it came back
-- (`unarchived`). A CHECK cannot be altered, so the table is made again, as 0051 did, with every
-- row copied as it is; nothing references it.
CREATE TABLE task_activity_next (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'created', 'comment', 'status', 'assignee', 'title', 'description', 'conversation', 'artifact',
      'run_queued', 'run_started', 'run_completed', 'run_failed', 'run_interrupted', 'run_nudged',
      'dependency', 'parent', 'subtask', 'archived', 'unarchived'
    )
  ),
  actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system')),
  actor_agent TEXT,
  body TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

INSERT INTO task_activity_next (id, task_id, run_id, kind, actor, actor_agent, body, data, created_at)
SELECT id, task_id, run_id, kind, actor, actor_agent, body, data, created_at FROM task_activity ORDER BY rowid;

DROP TABLE task_activity;
ALTER TABLE task_activity_next RENAME TO task_activity;
CREATE INDEX task_activity_task ON task_activity (task_id, kind);
-- The archiver asks every task for its newest entry.
CREATE INDEX task_activity_newest ON task_activity (task_id, created_at);
