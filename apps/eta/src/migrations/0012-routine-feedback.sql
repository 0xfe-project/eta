-- What the user said about a run. The brief is revised from it in the background; the revision
-- is the brief version that names this row (0013), and `revision_failed` is the other way it can
-- have ended. Neither: it is still to come.
CREATE TABLE routine_feedback (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES routine_run (id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revision_failed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX routine_feedback_run ON routine_feedback (run_id);
