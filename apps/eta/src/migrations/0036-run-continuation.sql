-- A comment on a task whose run has ended is a prompt, not a note: it wakes the executor again,
-- and the executor carries on in the session it already has — it knows what it did last time, and
-- the comment is usually an answer to what it asked for. Such a run is a continuation: it works in
-- the task's existing session instead of opening a fresh one.
--
-- `continues_run_id` says which run's session a run continues (NULL: it opens its own, which is
-- what every run did before, and what `tasks.rerun` still does: rerun forgets, a comment doesn't).
--
-- `session_key` is what the session is held in (`tasks/session-key.ts`: the task, not the run).
-- The machine holding a session files its journal, its prompt and its tools under that key, and a
-- session never changes it, so the run that made the session records it and every later run of
-- that session reuses it. A run before this has no key of its own: it was made while the key
-- named it, so `task-run:<its id>` is what its session is held in.
ALTER TABLE task_run ADD COLUMN continues_run_id TEXT REFERENCES task_run (id) ON DELETE SET NULL;
ALTER TABLE task_run ADD COLUMN session_key TEXT;
