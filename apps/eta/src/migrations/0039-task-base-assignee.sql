-- A task remembers where it starts and who it is for.
--
-- `base_branch` is the commit (a branch name, usually) the task's worktree is made on: the agent
-- that proposes the task knows which line the work belongs to, and an executor in an isolated
-- session cannot guess it. A `#number` is resolved to that task's `eta/task-<number>` branch
-- before it is stored, so one task can build on another. NULL is the old behavior: the worktree
-- starts at the project checkout's HEAD.
ALTER TABLE task ADD COLUMN base_branch TEXT;

-- `assignee_agent` is the agent that executes the task, which is not always the agent that
-- drafted it: a draft can be written on someone else's behalf. NULL falls back to the maker
-- (`created_by_agent`), so nothing made before this changes hands.
ALTER TABLE task ADD COLUMN assignee_agent TEXT;
