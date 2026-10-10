-- +goose Up
-- When the runner started opening the run's place and native agent; set
-- before the call, like sent_at. A run that has it but no session was
-- interrupted mid-open (a deploy, a crash) and may have opened a place: it
-- fails rather than open a second one.

ALTER TABLE task_run ADD COLUMN opening_at timestamp with time zone;
