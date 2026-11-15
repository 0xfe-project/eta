-- A task can be part of another: a parent with subtasks does not run itself, and takes its status
-- from them (`tasks/graph.ts`). Waiting for a parent is waiting for all of its subtasks, so a stage
-- of work is a task with subtasks. Deleting a parent leaves its subtasks on the board, parentless.
-- Old tasks have no parent and behave as they always did.
ALTER TABLE task ADD COLUMN parent_id TEXT REFERENCES task (id) ON DELETE SET NULL;

CREATE INDEX task_parent ON task (parent_id) WHERE parent_id IS NOT NULL;
