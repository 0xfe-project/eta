-- Tasks wait for other tasks. An edge says "this task does not start before that one is resolved":
-- in review or done, or only done when `require_done` is set. A task can wait for many, and many
-- can wait for one. The rules (what resolves, what is a cycle) are `tasks/graph.ts`; this is rows.
-- Old tasks have no edges and behave as they always did.
CREATE TABLE task_dependency (
  task_id TEXT NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  require_done INTEGER NOT NULL DEFAULT 0 CHECK (require_done IN (0, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);

CREATE INDEX task_dependency_target ON task_dependency (depends_on_id);

-- A queued run can wait for its task's dependencies (`waiting_deps`), and only the runs that start
-- the work wait for them (`waits_for_deps`: a task's first run and a rerun; a comment's wake and a
-- mentioned agent's answer do not). A CHECK cannot be altered, so the table is made again, with
-- every column it has gained since 0034 (0036, 0038, 0048) copied as it is. The run it continues
-- is written against the new table's own name, which the rename turns into `task_run`; nothing
-- else references the table.
CREATE TABLE task_run_next (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  machine_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'starting', 'running', 'completed', 'failed', 'interrupted')
  ),
  -- Why a queued run waits: its task's previous run, its dependencies, its machine's limit, or the
  -- machine itself. Which tasks it waits for is read from the graph, never stored here.
  queue_reason TEXT CHECK (
    queue_reason IN ('task_busy', 'waiting_deps', 'machine_full', 'machine_offline')
  ),
  session_id TEXT,
  -- The directory the session works in.
  workspace TEXT,
  -- Whether it was reminded once that a run ends with finish_task.
  nudged INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  continues_run_id TEXT REFERENCES task_run_next (id) ON DELETE SET NULL,
  session_key TEXT,
  agent_id TEXT,
  last_event_at INTEGER,
  error_code TEXT,
  retryable INTEGER,
  waits_for_deps INTEGER NOT NULL DEFAULT 0 CHECK (waits_for_deps IN (0, 1))
);

INSERT INTO task_run_next (
  id, task_id, machine_id, status, queue_reason, session_id, workspace, nudged, error, created_at,
  started_at, finished_at, continues_run_id, session_key, agent_id, last_event_at, error_code,
  retryable
)
SELECT
  id, task_id, machine_id, status, queue_reason, session_id, workspace, nudged, error, created_at,
  started_at, finished_at, continues_run_id, session_key, agent_id, last_event_at, error_code,
  retryable
FROM task_run ORDER BY rowid;

DROP TABLE task_run;
ALTER TABLE task_run_next RENAME TO task_run;

CREATE INDEX task_run_task ON task_run (task_id, created_at);
CREATE INDEX task_run_open ON task_run (status) WHERE status IN ('queued', 'starting', 'running');
CREATE INDEX task_run_session ON task_run (session_id) WHERE session_id IS NOT NULL;

-- The timeline learns what the graph does to a task: a dependency added, removed, deleted with its
-- task, or cancelled (`dependency`); a parent set or taken away (`parent`) and, on the parent, a
-- subtask that came or went (`subtask`). All of them at once, so the table is made again only this
-- time; nothing references it.
CREATE TABLE task_activity_next (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'created', 'comment', 'status', 'assignee', 'title', 'description', 'conversation', 'artifact',
      'run_queued', 'run_started', 'run_completed', 'run_failed', 'run_interrupted', 'run_nudged',
      'dependency', 'parent', 'subtask'
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
