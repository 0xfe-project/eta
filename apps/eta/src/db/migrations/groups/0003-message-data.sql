-- A message's kind-specific payload (REFACTOR.md §9, P3.1).
--
-- `kind` says what a message is; this says what it carries. The first user is the task card: a
-- `task_draft` holds {title, description} — the proposal — and the `task_card` it becomes holds
-- {task_id} plus the task's facts, refreshed whenever the task changes. The client renders the
-- card from these fields, so they are part of the product's shape rather than a cache of ours.
ALTER TABLE group_message ADD COLUMN data TEXT NOT NULL DEFAULT '{}';
