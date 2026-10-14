-- +goose Up
-- When the user saw a finished run (opened its routine): a report or a
-- failure they have not seen yet is something waiting for them. Runs
-- finished before this are counted as seen.

ALTER TABLE routine_run ADD COLUMN seen_at timestamptz;
UPDATE routine_run SET seen_at = finished_at WHERE finished_at IS NOT NULL;
