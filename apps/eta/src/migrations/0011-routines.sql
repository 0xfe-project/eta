-- A routine: an agent that runs on a schedule and leaves a report. It has no agent behind it, only a
-- model, a brief (see 0013) and a clock; each run is one short session in a directory of its own.
-- Times are epoch milliseconds, like everything on the wire.
CREATE TABLE routine (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Where a sent report is posted, as a system row. NULL posts nowhere. Conversations are not
  -- deleted today; if one goes, the routine keeps running and stops posting.
  conversation_id TEXT REFERENCES conversation (id) ON DELETE SET NULL,
  -- `provider:modelId`. NULL means whatever the settings choose.
  model TEXT,
  -- The shape the page offers, as JSON: {kind: daily | weekly | hourly | cron, ...}. The clock
  -- derives every time from it and the zone; no next run is stored.
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX routine_conversation ON routine (conversation_id);

-- One run of a routine. `running` is the only state a restart has to settle: nothing is running
-- then, so whatever was is failed.
CREATE TABLE routine_run (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routine (id) ON DELETE CASCADE,
  started_by TEXT NOT NULL CHECK (started_by IN ('schedule', 'user')),
  status TEXT NOT NULL CHECK (status IN ('running', 'sent', 'no_news', 'failed')),
  -- The upstream session that did the work; set a moment after the run starts.
  session_id TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  title TEXT,
  report TEXT,
  -- Written by a run for the one after it.
  handoff TEXT,
  error TEXT,
  -- When the user looked at it finished. An unseen report or failure is something waiting for them.
  seen_at INTEGER
);

-- A routine runs once at a time. The index is what says so, so two triggers arriving together
-- cannot both start a run, whatever the code in front of it believes.
CREATE UNIQUE INDEX routine_run_one_at_a_time ON routine_run (routine_id) WHERE status = 'running';
CREATE INDEX routine_run_recent ON routine_run (routine_id, started_at DESC);
CREATE INDEX routine_run_session ON routine_run (session_id) WHERE session_id IS NOT NULL;
