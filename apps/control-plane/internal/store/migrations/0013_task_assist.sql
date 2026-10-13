-- +goose Up
-- 请 Agent 协助 (docs/architecture/tasks.md): another agent on the task's
-- computer does one piece of work on it (a review, a test run) beside its
-- assignee. Its runs and sessions are the task's second lane: one active run
-- per lane, and its own session in a place AXP opens for it, never the
-- assignee's. Assisting changes neither the task's status nor its assignee.

ALTER TABLE task_session ADD COLUMN assist boolean NOT NULL DEFAULT false;
DROP INDEX task_session_open;
CREATE UNIQUE INDEX task_session_open ON task_session (task_id, computer_id, runtime, provider, assist) WHERE closed_at IS NULL;

ALTER TABLE task_run ADD COLUMN assist boolean NOT NULL DEFAULT false;
DROP INDEX task_run_active;
CREATE UNIQUE INDEX task_run_active ON task_run (task_id, assist) WHERE status IN ('starting', 'running');
