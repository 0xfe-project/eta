-- What a task's runs used, in tokens (`tasks/usage.ts`). One row per model request of a run on
-- eta's own loop (the host's model layer sees each one), or per assistant message of a run on an
-- external runtime (its transcript is the only place it tells its tokens). Every row names its run,
-- so a task's usage is a read of its runs' rows, and a run belongs to exactly one task.
--
-- `provider` and `model` are the ones that answered, as the provider or runtime reported them. The
-- token columns are NULL when nothing was reported for the row: that is "no data", which is not 0.
-- `reasoning` is a subset of `output`, NULL when there was no breakdown. No money is kept here.
--
-- `source` is where the row came from: `model` and `transcript` were counted as the run went;
-- `usage` (the 30-day usage table) and `journal` (the session's journal on this machine) were
-- filled in for a run that ended before this table existed.
--
-- Unlike `usage` these rows are not pruned: they go with their run, which goes with its task.
CREATE TABLE task_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES task_run (id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input INTEGER,
  output INTEGER,
  cache_read INTEGER,
  cache_write INTEGER,
  reasoning INTEGER,
  source TEXT NOT NULL CHECK (source IN ('model', 'transcript', 'usage', 'journal')),
  CHECK (
    (input IS NULL AND output IS NULL AND cache_read IS NULL AND cache_write IS NULL AND reasoning IS NULL)
    OR (input IS NOT NULL AND output IS NOT NULL AND cache_read IS NOT NULL AND cache_write IS NOT NULL)
  )
);

CREATE INDEX task_usage_run ON task_usage (run_id);

-- How a run's usage is known: `live`, counted as it went (every run made from here on), or
-- `backfill`, filled in once from what earlier versions left. NULL is a run from before this that
-- has not been looked at yet; until it is, it reads as having no data.
ALTER TABLE task_run ADD COLUMN usage_counted TEXT CHECK (usage_counted IN ('live', 'backfill'));
