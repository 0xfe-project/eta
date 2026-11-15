-- Routines are run by Captain. A routine names no model and posts into no conversation any more:
-- every run is a new Captain session on Captain's model, and where a report goes besides the
-- routines page and Captain's own chat is written in the brief, for Captain to do with its tools.
-- So `routine.model` and `routine.conversation_id` go.
--
-- A run can also be `skipped`: its time came while Captain was off (the supervisor switched off,
-- or Captain has no model), and the row says so instead of nothing happening silently.
--
-- Neither change can be made in place (a column with a foreign key cannot be dropped, a CHECK
-- cannot be altered), so the four tables are made again and their rows copied. Children are
-- dropped before their parents so no ON DELETE runs, and each new table is renamed into place
-- last, which rewrites the references the other new tables hold to it.
CREATE TABLE routine_next (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- The shape the page offers, as JSON: {kind: daily | weekly | hourly | cron, ...}. The clock
  -- derives every time from it and the zone; no next run is stored.
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO routine_next (id, name, schedule, timezone, enabled, created_at, updated_at)
SELECT id, name, schedule, timezone, enabled, created_at, updated_at FROM routine;

CREATE TABLE routine_run_next (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routine_next (id) ON DELETE CASCADE,
  started_by TEXT NOT NULL CHECK (started_by IN ('schedule', 'user')),
  status TEXT NOT NULL CHECK (status IN ('running', 'sent', 'no_news', 'failed', 'skipped')),
  -- The Captain session that did the work; set a moment after the run starts.
  session_id TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  title TEXT,
  report TEXT,
  -- Written by a run for the one after it, and read by nothing else: no view, no notification.
  handoff TEXT,
  error TEXT,
  seen_at INTEGER
);

INSERT INTO routine_run_next
SELECT id, routine_id, started_by, status, session_id, started_at, finished_at, title, report,
       handoff, error, seen_at
  FROM routine_run;

CREATE TABLE routine_feedback_next (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES routine_run_next (id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revision_failed INTEGER NOT NULL DEFAULT 0
);

INSERT INTO routine_feedback_next
SELECT id, run_id, text, created_at, revision_failed FROM routine_feedback;

CREATE TABLE routine_brief_next (
  routine_id TEXT NOT NULL REFERENCES routine_next (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  feedback_id TEXT REFERENCES routine_feedback_next (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (routine_id, version)
);

INSERT INTO routine_brief_next
SELECT routine_id, version, text, feedback_id, created_at FROM routine_brief;

DROP TABLE routine_brief;

DROP TABLE routine_feedback;

DROP TABLE routine_run;

DROP TABLE routine;

ALTER TABLE routine_next RENAME TO routine;

ALTER TABLE routine_run_next RENAME TO routine_run;

ALTER TABLE routine_feedback_next RENAME TO routine_feedback;

ALTER TABLE routine_brief_next RENAME TO routine_brief;

CREATE UNIQUE INDEX routine_run_one_at_a_time ON routine_run (routine_id) WHERE status = 'running';

CREATE INDEX routine_run_recent ON routine_run (routine_id, started_at DESC);

CREATE INDEX routine_run_session ON routine_run (session_id) WHERE session_id IS NOT NULL;

CREATE INDEX routine_feedback_run ON routine_feedback (run_id);

CREATE UNIQUE INDEX routine_brief_feedback ON routine_brief (feedback_id) WHERE feedback_id IS NOT NULL;
