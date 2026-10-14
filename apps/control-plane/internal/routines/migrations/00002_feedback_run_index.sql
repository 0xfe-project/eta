-- +goose Up
-- A run's feedback is looked up by run (the routine's page, the run tools).

CREATE INDEX routine_feedback_run ON routine_feedback (run_id);
