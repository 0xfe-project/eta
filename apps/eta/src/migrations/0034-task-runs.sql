-- Tasks run. The agent that made a task is its executor (`created_by_agent`), and every run of it
-- is a fresh session of that agent, in a workspace of the task's project: a git worktree of its
-- own, or the project directory itself.
--
-- Nobody is "assigned" any more: the executor is fixed, and what used to be handing the work back
-- to the user is the task moving to review. A task made before this has no executor and no
-- project; it is a note on the board that cannot run.
ALTER TABLE task DROP COLUMN assignee;

-- Where the executor works. `workspace_mode` is the agent's choice when it proposed the task;
-- the worktree's path and branch are written when the first run makes it, and kept after the run.
ALTER TABLE task ADD COLUMN project_id TEXT REFERENCES project (id) ON DELETE SET NULL;
ALTER TABLE task ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'local' CHECK (workspace_mode IN ('worktree', 'local'));
ALTER TABLE task ADD COLUMN worktree_path TEXT;
ALTER TABLE task ADD COLUMN worktree_branch TEXT;
-- The conversation the task was proposed in, for good (`conversation_id` is where it is discussed
-- now and can be moved): the executor's result is posted here.
ALTER TABLE task ADD COLUMN origin_conversation_id TEXT REFERENCES conversation (id) ON DELETE SET NULL;

-- How many runs a machine works on at once; the rest wait in the queue.
ALTER TABLE machine ADD COLUMN max_active_runs INTEGER NOT NULL DEFAULT 2 CHECK (max_active_runs BETWEEN 1 AND 20);

-- One attempt of the executor at the task. The row is the queue: a `queued` run waits for its
-- machine's free slot and for the task's previous run to end. `session_id` is the fresh session
-- (on `machine_id`) the run works in, which is also its log: the transcript is the session's.
CREATE TABLE task_run (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  machine_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'starting', 'running', 'completed', 'failed', 'interrupted')
  ),
  -- Why a queued run waits: its task's previous run, or its machine's limit, or the machine itself.
  queue_reason TEXT CHECK (queue_reason IN ('task_busy', 'machine_full', 'machine_offline')),
  session_id TEXT,
  -- The directory the session works in.
  workspace TEXT,
  -- Whether it was reminded once that a run ends with finish_task.
  nudged INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE INDEX task_run_task ON task_run (task_id, created_at);
CREATE INDEX task_run_open ON task_run (status) WHERE status IN ('queued', 'starting', 'running');
CREATE INDEX task_run_session ON task_run (session_id) WHERE session_id IS NOT NULL;

-- The timeline learns the runs: its entries can name the run they are about, and there are kinds
-- for a run's life. A CHECK cannot be altered, so the table is made again (nothing references it).
CREATE TABLE task_activity_next (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'created', 'comment', 'status', 'assignee', 'title', 'description', 'conversation', 'artifact',
      'run_queued', 'run_started', 'run_completed', 'run_failed', 'run_interrupted', 'run_nudged'
    )
  ),
  actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system')),
  actor_agent TEXT,
  body TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

INSERT INTO task_activity_next (id, task_id, kind, actor, actor_agent, body, data, created_at)
SELECT id, task_id, kind, actor, actor_agent, body, data, created_at FROM task_activity;

DROP TABLE task_activity;
ALTER TABLE task_activity_next RENAME TO task_activity;
CREATE INDEX task_activity_task ON task_activity (task_id, kind);
