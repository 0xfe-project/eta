-- +goose Up
-- Agents run in one long-lived container each, built from their bundles,
-- with their state on a Docker volume (docs/architecture/chat-runtime.md).
-- Gone: runtime instances and their leases, generations and snapshots, the
-- thread record (the runtime finds its thread on the volume), approvals and
-- interactions (Codex runs without approval prompts), compaction commands.

DROP TABLE interaction, approval, agent_session CASCADE;

-- Waiting commands are rows: delivered_at is when the controller handed one
-- to the runtime boot boot_id (a prompt, or a steer the running turn took).
ALTER TABLE agent_command DROP COLUMN runtime_instance_id, DROP COLUMN queue_seq,
    ADD COLUMN delivered_at timestamp with time zone,
    ADD COLUMN boot_id uuid;
UPDATE agent_command SET status = 'failed', finished_at = COALESCE(finished_at, now()), error_code = 'REPLY_INTERRUPTED'
    WHERE status IN ('queued', 'running', 'waiting_approval');
ALTER TABLE agent_command DROP CONSTRAINT agent_command_status_valid,
    ADD CONSTRAINT agent_command_status_valid CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'));
DROP INDEX one_active_execution_per_agent;
CREATE UNIQUE INDEX one_active_execution_per_agent ON agent_command (agent_id) WHERE status = 'running';
CREATE INDEX agent_command_waiting_idx ON agent_command (agent_id, agent_sequence) WHERE status = 'queued';

-- Events are a runtime boot's, in order.
ALTER TABLE agent_event DROP COLUMN runtime_instance_id, DROP COLUMN source_event_id,
    ADD COLUMN boot_id uuid;
CREATE UNIQUE INDEX agent_event_boot_seq_uniq ON agent_event (agent_id, boot_id, source_seq);

DROP TABLE runtime_instance CASCADE;

UPDATE message SET status = 'failed', failure = '{"code": "REPLY_INTERRUPTED", "message": "执行中断，无法确认结果，未自动重试。"}'
    WHERE role = 'assistant' AND status IN ('queued', 'responding', 'waiting_for_input', 'stopping');
ALTER TABLE message DROP CONSTRAINT message_status_valid,
    ADD CONSTRAINT message_status_valid CHECK (status IN ('queued', 'responding', 'stopping', 'completed', 'stopped', 'failed'));

-- The agent's bundles (names, built in or the user's), and the plugins they
-- add, which the runtime gateway checks routes against. status is the
-- runtime's: starting until the current container's runtime reports itself,
-- boot_id; error with last_error_code (and build_error, a failed image
-- build's output) when it cannot run.
ALTER TABLE agent DROP COLUMN desired_state, DROP COLUMN generation,
    ADD COLUMN bundles jsonb NOT NULL DEFAULT '[]',
    ADD COLUMN boot_id uuid,
    ADD COLUMN build_error text;
UPDATE agent SET bundles = plugins, status = 'starting',
    product_status = CASE WHEN product_status IN ('waiting_for_input', 'working', 'starting') THEN 'idle' ELSE product_status END;
ALTER TABLE agent DROP CONSTRAINT agent_status_valid,
    ADD CONSTRAINT agent_status_valid CHECK (status IN ('starting', 'ready', 'error')),
    DROP CONSTRAINT agent_product_status_valid,
    ADD CONSTRAINT agent_product_status_valid CHECK (product_status IN ('idle', 'starting', 'working', 'unavailable')),
    DROP CONSTRAINT IF EXISTS agent_counters_valid,
    ADD CONSTRAINT agent_counters_valid CHECK (config_version >= 0 AND last_command_seq >= 0 AND product_revision >= 1);

-- The user's bundles; the built-in ones are files in the image.
CREATE TABLE bundle (
    name text PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
    description text NOT NULL,
    -- Run as root when an agent's image is built.
    script text NOT NULL,
    plugins jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);

-- How far the controller has imported the runtimes' event stream (JetStream
-- AGENT_EVENTS), in the same transaction as what it imported.
CREATE TABLE event_position (
    stream text PRIMARY KEY,
    seq bigint NOT NULL
);
