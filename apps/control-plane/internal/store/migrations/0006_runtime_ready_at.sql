-- +goose Up
-- When a runtime instance first came up (reported ready or busy). One that
-- never did is timed out StartTimeout after it was created, however long it
-- keeps reporting "starting".

ALTER TABLE runtime_instance ADD COLUMN ready_at timestamp with time zone;
UPDATE runtime_instance SET ready_at = COALESCE(last_heartbeat_at, created_at)
    WHERE status IN ('ready', 'busy');
