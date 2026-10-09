-- +goose Up
-- A run an AXP agent asked for (creating, reassigning or commenting on a
-- remote task) waits for the user to confirm it before the runner sends
-- anything to the remote computer.

ALTER TABLE task_run DROP CONSTRAINT task_run_status_check;
ALTER TABLE task_run ADD CONSTRAINT task_run_status_check CHECK (
    status IN ('awaiting_confirmation', 'queued', 'starting', 'running', 'completed', 'failed', 'cancelled')
);
