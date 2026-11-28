-- eta: foreign keys off
--
-- Routines can now be driven by external event triggers in addition to (or instead of) a clock
-- schedule:
-- - `routine.schedule` becomes nullable (`NULL` for trigger-only routines; service validation still
--   requires at least one of schedule or trigger).
-- - `routine_run.started_by` allows `'trigger'` alongside `'schedule'` and `'user'`.
-- - `routine_trigger` stores each routine's external trigger binding and remote instance state.
-- - `routine_trigger_event` is the idempotent, durable event queue used to coalesce bursts and hold
--   events while a run is in progress or Captain is off.

CREATE TABLE routine_next (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  schedule TEXT,
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO routine_next (id, name, schedule, timezone, enabled, created_at, updated_at)
SELECT id, name, schedule, timezone, enabled, created_at, updated_at FROM routine;

-- It names `routine`, the table it will point at once `routine_next` is renamed: with the legacy
-- ALTER TABLE behaviour (macOS's system SQLite) a rename does not rewrite the references of other
-- tables, and `routine_next` would stay there, a table that is gone.
CREATE TABLE routine_run_next (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routine (id) ON DELETE CASCADE,
  started_by TEXT NOT NULL CHECK (started_by IN ('schedule', 'user', 'trigger')),
  status TEXT NOT NULL CHECK (status IN ('running', 'sent', 'no_news', 'failed', 'skipped')),
  session_id TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  title TEXT,
  report TEXT,
  handoff TEXT,
  error TEXT,
  seen_at INTEGER
);

INSERT INTO routine_run_next (
  id, routine_id, started_by, status, session_id, started_at, finished_at, title, report, handoff,
  error, seen_at
)
SELECT id, routine_id, started_by, status, session_id, started_at, finished_at, title, report,
       handoff, error, seen_at
  FROM routine_run;

DROP TABLE routine_run;

DROP TABLE routine;

ALTER TABLE routine_next RENAME TO routine;

ALTER TABLE routine_run_next RENAME TO routine_run;

CREATE UNIQUE INDEX routine_run_one_at_a_time ON routine_run (routine_id) WHERE status = 'running';

CREATE INDEX routine_run_recent ON routine_run (routine_id, started_at DESC);

CREATE INDEX routine_run_session ON routine_run (session_id) WHERE session_id IS NOT NULL;

CREATE TABLE routine_trigger (
  routine_id TEXT PRIMARY KEY REFERENCES routine (id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  source TEXT NOT NULL,
  trigger_slug TEXT NOT NULL,
  account_id TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  requested_mode TEXT CHECK (requested_mode IS NULL OR requested_mode IN ('webhook', 'poll')),
  requested_polling_interval INTEGER,
  instance_id TEXT,
  effective_mode TEXT CHECK (effective_mode IS NULL OR effective_mode IN ('webhook', 'poll')),
  polling_interval INTEGER,
  fallback_reason TEXT,
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('active', 'disabled', 'error')),
  last_error TEXT,
  last_event_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX routine_trigger_provider_instance
  ON routine_trigger (provider, instance_id)
  WHERE instance_id IS NOT NULL;

CREATE TABLE routine_trigger_event (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routine (id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  instance_id TEXT,
  trigger_slug TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'dispatched', 'done', 'dropped', 'expired')),
  run_id TEXT REFERENCES routine_run (id) ON DELETE SET NULL,
  UNIQUE (routine_id, event_id)
);

CREATE INDEX routine_trigger_event_queue
  ON routine_trigger_event (routine_id, state, occurred_at, received_at);

CREATE INDEX routine_trigger_event_run
  ON routine_trigger_event (run_id)
  WHERE run_id IS NOT NULL;
