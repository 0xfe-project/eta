-- +goose Up
-- Files the user attaches to a chat message (docs/architecture/chat-runtime.md):
-- uploaded while the message is written, their bytes in S3 under
-- attachments/<id>; the message's attachment blocks name them. sent_at is
-- set by the first message that carries one: from then on it is history and
-- can no longer be deleted.
CREATE TABLE chat_attachment (
    id uuid PRIMARY KEY,
    agent_id uuid NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
    name text NOT NULL,
    content_type text NOT NULL,
    size bigint NOT NULL,
    created_at timestamptz NOT NULL,
    sent_at timestamptz
);
CREATE INDEX chat_attachment_agent ON chat_attachment (agent_id);
