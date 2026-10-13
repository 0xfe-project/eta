-- +goose Up
-- Artifacts (docs/architecture/artifacts.md): static sites agents publish
-- as ZIPs. Rows hold what they are and where they belong; their files are
-- objects in S3 under artifacts/<artifact>/<version>/.

-- An artifact: published by an AXP agent (in its chat) or by a remote
-- computer's agent (for a task), and only they publish its next versions.
CREATE TABLE artifact (
    id uuid PRIMARY KEY,
    title text NOT NULL,
    agent_id uuid REFERENCES agent(id) ON DELETE SET NULL,
    computer_id uuid REFERENCES computer(id) ON DELETE SET NULL,
    task_id uuid REFERENCES task(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);
CREATE INDEX artifact_task ON artifact (task_id);

-- A version never changes once published: an upload is a new version.
-- processing while its objects are written; failed versions keep their
-- error and no objects.
CREATE TABLE artifact_version (
    id uuid PRIMARY KEY,
    artifact_id uuid NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
    number int NOT NULL,
    status text NOT NULL CHECK (status IN ('processing', 'published', 'failed')),
    error text,
    -- The ZIP's size and sha256, its files' count and their total size.
    size bigint NOT NULL,
    sha256 text NOT NULL,
    files int NOT NULL,
    bytes bigint NOT NULL,
    created_at timestamptz NOT NULL,
    UNIQUE (artifact_id, number)
);

-- A public link to one version; revoking it ends it for good (sharing
-- again makes a new token).
CREATE TABLE artifact_share (
    token text PRIMARY KEY,
    version_id uuid NOT NULL REFERENCES artifact_version(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL,
    revoked_at timestamptz
);
CREATE UNIQUE INDEX artifact_share_active ON artifact_share (version_id) WHERE revoked_at IS NULL;
