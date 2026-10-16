-- Routines: agents that run on a schedule (REFACTOR.md §9, P3.3).
--
-- A routine has a brief (its standing instructions), versions of that brief, runs, and the user's
-- feedback on a run. Feedback is absorbed into a new version of the brief, which is why the briefs
-- are rows rather than a column: the history is the point — a routine's requirements change over
-- time, and "why does it do that" is answered by the version that introduced it.
CREATE TABLE routine (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  -- The browser's shape, as JSON: {kind: daily|weekly|hourly|cron, …}. The scheduler reads it
  -- through `cronOf`, and the page counts down with the same expression.
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE routine_brief (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routine (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  -- The feedback this version was revised from; null when the user wrote it. A brief keeps its
  -- text when that feedback goes.
  feedback_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (routine_id, version)
);

CREATE INDEX routine_brief_routine ON routine_brief (routine_id, version DESC);

CREATE TABLE routine_run (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routine (id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  report TEXT,
  -- Written by a run for the next one: what it learned that the next should know.
  handoff TEXT,
  error TEXT,
  -- When the user saw it finished: an unseen report or failure is something waiting for them.
  seen_at TEXT
);

-- A routine runs once at a time: the unique index is what enforces it, so two triggers cannot both
-- start a run even if they arrive in the same millisecond.
CREATE UNIQUE INDEX routine_run_running ON routine_run (routine_id) WHERE status = 'running';
CREATE INDEX routine_run_started ON routine_run (routine_id, started_at DESC);

CREATE TABLE routine_feedback (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES routine_run (id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- The revision could not be made; the brief stays as it was.
  revision_failed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX routine_feedback_run ON routine_feedback (run_id);
