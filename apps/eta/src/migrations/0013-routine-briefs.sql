-- The versions of a routine's brief. A change is a new version and never an edit, because the old
-- one is what the earlier runs were following: "why does it do that" is answered by the version
-- that introduced it, and restoring an old text writes it as the newest.
CREATE TABLE routine_brief (
  routine_id TEXT NOT NULL REFERENCES routine (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  -- The feedback this version was revised from; NULL when a person wrote it.
  feedback_id TEXT REFERENCES routine_feedback (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (routine_id, version)
);

-- One revision per piece of feedback, even if two passes race to make it.
CREATE UNIQUE INDEX routine_brief_feedback ON routine_brief (feedback_id) WHERE feedback_id IS NOT NULL;
