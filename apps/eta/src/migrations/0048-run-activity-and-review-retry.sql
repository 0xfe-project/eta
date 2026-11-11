-- A run reports when its journal last moved, and how its failure was classified. Review delivery is
-- retried with backoff; a failed review must not advance the assignment checkpoint.
ALTER TABLE task_run ADD COLUMN last_event_at INTEGER;
ALTER TABLE task_run ADD COLUMN error_code TEXT;
ALTER TABLE task_run ADD COLUMN retryable INTEGER;

UPDATE task_run
   SET last_event_at = COALESCE(started_at, created_at, finished_at)
 WHERE last_event_at IS NULL;

ALTER TABLE captain_review ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE captain_review ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
