-- +goose Up
-- Schema only. Existing data is converted manually outside the application (#237).
CREATE TABLE chat_group (
    id uuid PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES conversation(id),
    name text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('group', 'direct')),
    direct_agent_id uuid UNIQUE REFERENCES agent(id),
    goal text NOT NULL DEFAULT '',
    decided text NOT NULL DEFAULT '',
    archived boolean NOT NULL DEFAULT false,
    read_seq bigint NOT NULL DEFAULT 0,
    revision bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK ((kind = 'direct') = (direct_agent_id IS NOT NULL))
);
CREATE TABLE group_participant (
    group_id uuid NOT NULL REFERENCES chat_group(id),
    agent_id uuid NOT NULL REFERENCES agent(id),
    member boolean NOT NULL,
    joined_at timestamptz NOT NULL,
    removed_at timestamptz,
    seen_seq bigint NOT NULL DEFAULT 0,
    codex_thread_id text,
    thread_status text NOT NULL DEFAULT 'new' CHECK (thread_status IN ('new', 'ready', 'archived', 'failed')),
    PRIMARY KEY (group_id, agent_id),
    UNIQUE (agent_id, codex_thread_id)
);
ALTER TABLE agent_command ADD COLUMN group_id uuid REFERENCES chat_group(id);
ALTER TABLE agent_command ADD COLUMN root_message_id uuid;
ALTER TABLE message ADD COLUMN group_id uuid REFERENCES chat_group(id);
ALTER TABLE message ADD COLUMN kind text NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'mention', 'system', 'task_draft', 'task_card'));
ALTER TABLE message ADD COLUMN data jsonb NOT NULL DEFAULT '{}';
ALTER TABLE message ADD COLUMN mention_count integer NOT NULL DEFAULT 0 CHECK (mention_count BETWEEN 0 AND 5);
ALTER TABLE message ADD COLUMN chain_stopped boolean NOT NULL DEFAULT false;
ALTER TABLE message ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE message ALTER COLUMN command_id DROP NOT NULL;
ALTER TABLE message DROP CONSTRAINT message_role_shape_valid;
ALTER TABLE message DROP CONSTRAINT message_reply_to_same_turn_fk;
ALTER TABLE message DROP CONSTRAINT message_role_valid;
ALTER TABLE message ADD CONSTRAINT message_role_valid CHECK (role IN ('user', 'assistant', 'system'));
ALTER TABLE agent_command ADD CONSTRAINT command_root_message_fk FOREIGN KEY (root_message_id) REFERENCES message(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE interaction ADD COLUMN group_id uuid REFERENCES chat_group(id);
ALTER TABLE chat_attachment DROP COLUMN agent_id;
ALTER TABLE chat_attachment ADD COLUMN group_id uuid REFERENCES chat_group(id);
CREATE INDEX message_group_seq ON message (group_id, seq);
CREATE INDEX message_group_search ON message USING gin (to_tsvector('simple', content::text || ' ' || data::text));
CREATE INDEX command_group_active ON agent_command (group_id) WHERE status IN ('queued', 'running', 'waiting_approval');
CREATE INDEX chat_attachment_group ON chat_attachment (group_id);
ALTER TABLE ui_event DROP CONSTRAINT ui_event_type_valid;
ALTER TABLE ui_event ADD CONSTRAINT ui_event_type_valid CHECK (type IN ('agent.updated','agent.deleted','message.updated','interaction.updated','group.updated'));
