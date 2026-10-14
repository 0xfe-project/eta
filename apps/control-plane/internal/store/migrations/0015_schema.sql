-- +goose Up
-- The control plane's schema as of version 15, in one file. A database
-- migrated before this file has versions 1–15 recorded and skips it; later
-- changes are new files after it.

CREATE TABLE agent (
    id uuid NOT NULL,
    name varchar(100) NOT NULL,
    description text NOT NULL,
    model varchar(100),
    status varchar(32) NOT NULL,
    config_version bigint NOT NULL,
    last_active_at timestamptz,
    deleted_at timestamptz,
    product_status varchar(32) NOT NULL,
    product_revision bigint NOT NULL,
    last_command_seq bigint NOT NULL,
    last_error_code varchar(64),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    conversation_id uuid NOT NULL,
    plugins jsonb NOT NULL,
    bundles jsonb DEFAULT '[]'::jsonb NOT NULL,
    boot_id uuid,
    build_error text,
    CONSTRAINT agent_counters_valid CHECK (((config_version >= 0) AND (last_command_seq >= 0) AND (product_revision >= 1))),
    CONSTRAINT agent_product_status_valid CHECK (product_status IN ('idle', 'starting', 'working', 'waiting_for_input', 'unavailable')),
    CONSTRAINT agent_status_valid CHECK (status IN ('starting', 'ready', 'error')),
    CONSTRAINT agent_id_conversation_uniq UNIQUE (id, conversation_id),
    CONSTRAINT agent_pkey PRIMARY KEY (id)
);

CREATE TABLE agent_command (
    id uuid NOT NULL,
    agent_sequence bigint NOT NULL,
    kind varchar(16) NOT NULL,
    status varchar(32) NOT NULL,
    input jsonb NOT NULL,
    codex_turn_id varchar(100),
    interrupt_requested_at timestamptz,
    created_at timestamptz NOT NULL,
    started_at timestamptz,
    finished_at timestamptz,
    error_code varchar(64),
    agent_id uuid NOT NULL,
    delivered_at timestamptz,
    boot_id uuid,
    group_id uuid,
    root_message_id uuid,
    CONSTRAINT agent_command_kind_valid CHECK (kind IN ('turn', 'compact')),
    CONSTRAINT agent_command_sequence_valid CHECK (agent_sequence >= 1),
    CONSTRAINT agent_command_status_valid CHECK (status IN ('queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'interrupted')),
    CONSTRAINT agent_command_id_agent_uniq UNIQUE (id, agent_id),
    CONSTRAINT agent_command_pkey PRIMARY KEY (id),
    CONSTRAINT agent_command_sequence_uniq UNIQUE (agent_id, agent_sequence)
);

CREATE TABLE agent_event (
    id uuid NOT NULL,
    source_seq bigint,
    seq bigint NOT NULL,
    type varchar(64) NOT NULL,
    schema_version integer NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    agent_id uuid NOT NULL,
    command_id uuid,
    conversation_id uuid NOT NULL,
    boot_id uuid,
    CONSTRAINT agent_event_conversation_seq_uniq UNIQUE (conversation_id, seq),
    CONSTRAINT agent_event_pkey PRIMARY KEY (id)
);

CREATE TABLE approval (
    id uuid NOT NULL,
    sdk_request_id varchar(100) NOT NULL,
    kind varchar(32) NOT NULL,
    summary jsonb NOT NULL,
    status varchar(32) NOT NULL,
    decision varchar(16),
    expires_at timestamptz,
    created_at timestamptz NOT NULL,
    resolved_at timestamptz,
    agent_id uuid NOT NULL,
    command_id uuid NOT NULL,
    boot_id uuid,
    CONSTRAINT approval_status_valid CHECK (status IN ('pending', 'decided', 'applied', 'expired')),
    CONSTRAINT approval_id_agent_uniq UNIQUE (id, agent_id),
    CONSTRAINT approval_pkey PRIMARY KEY (id)
);

CREATE TABLE artifact (
    id uuid NOT NULL,
    title text NOT NULL,
    agent_id uuid,
    computer_id uuid,
    task_id uuid,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    group_id uuid,
    CONSTRAINT artifact_pkey PRIMARY KEY (id)
);

CREATE TABLE artifact_share (
    token text NOT NULL,
    version_id uuid NOT NULL,
    created_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CONSTRAINT artifact_share_pkey PRIMARY KEY (token)
);

CREATE TABLE artifact_version (
    id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    number integer NOT NULL,
    status text NOT NULL,
    error text,
    size bigint NOT NULL,
    sha256 text NOT NULL,
    files integer NOT NULL,
    bytes bigint NOT NULL,
    created_at timestamptz NOT NULL,
    CONSTRAINT artifact_version_status_check CHECK (status IN ('processing', 'published', 'failed')),
    CONSTRAINT artifact_version_artifact_id_number_key UNIQUE (artifact_id, number),
    CONSTRAINT artifact_version_pkey PRIMARY KEY (id)
);

CREATE TABLE bundle (
    name text NOT NULL,
    description text NOT NULL,
    script text NOT NULL,
    plugins jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    service jsonb,
    CONSTRAINT bundle_name_check CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
    CONSTRAINT bundle_pkey PRIMARY KEY (name)
);

CREATE TABLE bundle_config (
    bundle text NOT NULL,
    sealed bytea NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT bundle_config_pkey PRIMARY KEY (bundle)
);

CREATE TABLE chat_attachment (
    id uuid NOT NULL,
    name text NOT NULL,
    content_type text NOT NULL,
    size bigint NOT NULL,
    created_at timestamptz NOT NULL,
    sent_at timestamptz,
    group_id uuid,
    CONSTRAINT chat_attachment_pkey PRIMARY KEY (id)
);

CREATE TABLE chat_group (
    id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    direct_agent_id uuid,
    goal text DEFAULT '' NOT NULL,
    decided text DEFAULT '' NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    read_seq bigint DEFAULT 0 NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT chat_group_check CHECK (((kind = 'direct') = (direct_agent_id IS NOT NULL))),
    CONSTRAINT chat_group_kind_check CHECK (kind IN ('group', 'direct')),
    CONSTRAINT chat_group_direct_agent_id_key UNIQUE (direct_agent_id),
    CONSTRAINT chat_group_pkey PRIMARY KEY (id)
);

CREATE TABLE computer (
    id uuid NOT NULL,
    name text NOT NULL,
    enroll_code_hash text,
    enroll_expires_at timestamptz,
    token_hash text,
    hostname text,
    os text,
    arch text,
    cli_path text,
    created_at timestamptz NOT NULL,
    CONSTRAINT computer_enroll_code_hash_key UNIQUE (enroll_code_hash),
    CONSTRAINT computer_pkey PRIMARY KEY (id),
    CONSTRAINT computer_token_hash_key UNIQUE (token_hash)
);

CREATE TABLE computer_runtime (
    computer_id uuid NOT NULL,
    kind text NOT NULL,
    providers text[] DEFAULT '{}'::text[] NOT NULL,
    device_id text,
    updated_at timestamptz NOT NULL,
    CONSTRAINT computer_runtime_kind_check CHECK (kind IN ('paseo', 'herdr')),
    CONSTRAINT computer_runtime_pkey PRIMARY KEY (computer_id, kind)
);

CREATE TABLE conversation (
    id uuid NOT NULL,
    is_default boolean NOT NULL,
    title varchar(200) NOT NULL,
    archived_at timestamptz,
    last_event_seq bigint NOT NULL,
    last_ui_event_seq bigint NOT NULL,
    last_message_seq bigint NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT conversation_seq_nonnegative CHECK (((last_event_seq >= 0) AND (last_message_seq >= 0) AND (last_ui_event_seq >= 0))),
    CONSTRAINT conversation_pkey PRIMARY KEY (id)
);

CREATE TABLE event_position (
    stream text NOT NULL,
    seq bigint NOT NULL,
    CONSTRAINT event_position_pkey PRIMARY KEY (stream)
);

CREATE TABLE group_participant (
    group_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    member boolean NOT NULL,
    joined_at timestamptz NOT NULL,
    removed_at timestamptz,
    seen_seq bigint DEFAULT 0 NOT NULL,
    codex_thread_id text,
    thread_status text DEFAULT 'new' NOT NULL,
    CONSTRAINT group_participant_thread_status_check CHECK (thread_status IN ('new', 'ready', 'archived', 'failed')),
    CONSTRAINT group_participant_agent_id_codex_thread_id_key UNIQUE (agent_id, codex_thread_id),
    CONSTRAINT group_participant_pkey PRIMARY KEY (group_id, agent_id)
);

CREATE TABLE interaction (
    id uuid NOT NULL,
    kind varchar(16) NOT NULL,
    prompt varchar(500) NOT NULL,
    options jsonb NOT NULL,
    status varchar(16) NOT NULL,
    revision bigint NOT NULL,
    answer jsonb,
    expires_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    agent_id uuid NOT NULL,
    approval_id uuid,
    conversation_id uuid NOT NULL,
    message_id uuid NOT NULL,
    group_id uuid,
    CONSTRAINT interaction_kind_valid CHECK (kind = 'choice'),
    CONSTRAINT interaction_revision_valid CHECK (revision >= 1),
    CONSTRAINT interaction_status_valid CHECK (status IN ('pending', 'submitted', 'resolved', 'expired')),
    CONSTRAINT interaction_approval_id_key UNIQUE (approval_id),
    CONSTRAINT interaction_pkey PRIMARY KEY (id)
);

CREATE TABLE message (
    id uuid NOT NULL,
    seq bigint NOT NULL,
    role varchar(16) NOT NULL,
    content jsonb NOT NULL,
    status varchar(32) NOT NULL,
    failure jsonb,
    revision bigint NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    agent_id uuid,
    command_id uuid,
    conversation_id uuid NOT NULL,
    reply_to_id uuid,
    group_id uuid,
    kind text DEFAULT 'message' NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT message_author_valid CHECK (
        CASE
            WHEN kind IN ('system', 'task_card') THEN agent_id IS NULL AND role = 'assistant'
            WHEN kind IN ('mention', 'task_draft') THEN agent_id IS NOT NULL AND role = 'assistant'
            ELSE (role = 'user') = (agent_id IS NULL)
        END
    ),
    CONSTRAINT message_counters_valid CHECK (((revision >= 1) AND (seq >= 1))),
    CONSTRAINT message_kind_check CHECK (kind IN ('message', 'mention', 'system', 'task_draft', 'task_card')),
    CONSTRAINT message_role_valid CHECK (role IN ('user', 'assistant')),
    CONSTRAINT message_status_valid CHECK (status IN ('queued', 'responding', 'waiting_for_input', 'stopping', 'completed', 'stopped', 'failed')),
    CONSTRAINT message_conversation_seq_uniq UNIQUE (conversation_id, seq),
    CONSTRAINT message_id_agent_command_uniq UNIQUE (id, agent_id, command_id),
    CONSTRAINT message_one_per_role_per_command UNIQUE (command_id, role),
    CONSTRAINT message_pkey PRIMARY KEY (id)
);

CREATE TABLE relay_token (
    id integer NOT NULL,
    client_id text NOT NULL,
    access_token text NOT NULL,
    refresh_token text NOT NULL,
    expires_at timestamptz NOT NULL,
    CONSTRAINT relay_token_id_check CHECK (id = 1),
    CONSTRAINT relay_token_pkey PRIMARY KEY (id)
);

CREATE TABLE task (
    id uuid NOT NULL,
    number bigserial NOT NULL,
    title text NOT NULL,
    description text DEFAULT '' NOT NULL,
    status text NOT NULL,
    assignee text NOT NULL,
    computer_id uuid,
    runtime text,
    provider text,
    place jsonb,
    created_by_agent uuid,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    group_id uuid,
    CONSTRAINT task_assignee_check CHECK (assignee IN ('none', 'user', 'remote')),
    CONSTRAINT task_check CHECK (((assignee = 'remote') = ((computer_id IS NOT NULL) AND (runtime IS NOT NULL) AND (provider IS NOT NULL) AND (place IS NOT NULL)))),
    CONSTRAINT task_runtime_check CHECK (runtime IN ('paseo', 'herdr')),
    CONSTRAINT task_status_check CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled')),
    CONSTRAINT task_number_key UNIQUE (number),
    CONSTRAINT task_pkey PRIMARY KEY (id)
);

CREATE TABLE task_activity (
    id uuid NOT NULL,
    task_id uuid NOT NULL,
    run_id uuid,
    kind text NOT NULL,
    actor text NOT NULL,
    actor_agent uuid,
    body text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    CONSTRAINT task_activity_pkey PRIMARY KEY (id)
);

CREATE TABLE task_assist (
    id uuid NOT NULL,
    task_id uuid NOT NULL,
    key text,
    runtime text NOT NULL,
    provider text NOT NULL,
    request text NOT NULL,
    needs_pull boolean NOT NULL,
    after_run_id uuid,
    waits boolean NOT NULL,
    loop_id uuid,
    round integer,
    state text NOT NULL,
    reason text,
    run_id uuid,
    pull_url text,
    head_sha text,
    verdict text,
    feedback text,
    verdict_at timestamptz,
    created_at timestamptz NOT NULL,
    started_at timestamptz,
    CONSTRAINT task_assist_state_check CHECK (state IN ('waiting', 'blocked', 'started', 'cancelled')),
    CONSTRAINT task_assist_verdict_check CHECK (verdict IN ('pass', 'changes_requested')),
    CONSTRAINT task_assist_pkey PRIMARY KEY (id)
);

CREATE TABLE task_review_loop (
    id uuid NOT NULL,
    task_id uuid NOT NULL,
    runtime text NOT NULL,
    provider text NOT NULL,
    request text NOT NULL,
    max_rounds integer NOT NULL,
    rounds integer DEFAULT 0 NOT NULL,
    state text NOT NULL,
    reason text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT task_review_loop_max_rounds_check CHECK (((max_rounds >= 1) AND (max_rounds <= 10))),
    CONSTRAINT task_review_loop_state_check CHECK (state IN ('active', 'passed', 'exhausted', 'blocked', 'stopped')),
    CONSTRAINT task_review_loop_pkey PRIMARY KEY (id)
);

CREATE TABLE task_run (
    id uuid NOT NULL,
    task_id uuid NOT NULL,
    session_id uuid,
    computer_id uuid,
    runtime text NOT NULL,
    provider text NOT NULL,
    status text NOT NULL,
    prompt text NOT NULL,
    workspace text,
    sent_at timestamptz,
    nudged_at timestamptz,
    interrupt_requested_at timestamptz,
    error text,
    created_at timestamptz NOT NULL,
    finished_at timestamptz,
    opening_at timestamptz,
    assist boolean DEFAULT false NOT NULL,
    CONSTRAINT task_run_status_check CHECK (status IN ('queued', 'starting', 'running', 'completed', 'failed', 'cancelled')),
    CONSTRAINT task_run_pkey PRIMARY KEY (id)
);

CREATE TABLE task_session (
    id uuid NOT NULL,
    task_id uuid NOT NULL,
    computer_id uuid NOT NULL,
    runtime text NOT NULL,
    provider text NOT NULL,
    device_id text NOT NULL,
    instance_id text NOT NULL,
    workspace text NOT NULL,
    native jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    closed_at timestamptz,
    cleanup_pending boolean DEFAULT false NOT NULL,
    assist boolean DEFAULT false NOT NULL,
    CONSTRAINT task_session_pkey PRIMARY KEY (id)
);

CREATE TABLE ui_event (
    id uuid NOT NULL,
    seq bigint NOT NULL,
    type varchar(32) NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    conversation_id uuid NOT NULL,
    CONSTRAINT ui_event_type_valid CHECK (type IN ('agent.updated', 'agent.deleted', 'message.updated', 'interaction.updated', 'group.updated')),
    CONSTRAINT ui_event_conversation_seq_uniq UNIQUE (conversation_id, seq),
    CONSTRAINT ui_event_pkey PRIMARY KEY (id)
);

ALTER TABLE agent
    ADD CONSTRAINT agent_conversation_id_54c79dbd_fk_conversation_id FOREIGN KEY (conversation_id) REFERENCES conversation(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE agent_command
    ADD CONSTRAINT agent_command_agent_id_23e7fdc3_fk_agent_id FOREIGN KEY (agent_id) REFERENCES agent(id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT agent_command_group_id_fkey FOREIGN KEY (group_id) REFERENCES chat_group(id),
    ADD CONSTRAINT command_root_message_fk FOREIGN KEY (root_message_id) REFERENCES message(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE agent_event
    ADD CONSTRAINT agent_event_agent_conversation_fk FOREIGN KEY (agent_id, conversation_id) REFERENCES agent(id, conversation_id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT agent_event_agent_id_f03f1617_fk_agent_id FOREIGN KEY (agent_id) REFERENCES agent(id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT agent_event_command_id_c2c1b069_fk_agent_command_id FOREIGN KEY (command_id) REFERENCES agent_command(id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT agent_event_conversation_id_41740673_fk_conversation_id FOREIGN KEY (conversation_id) REFERENCES conversation(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE approval
    ADD CONSTRAINT approval_agent_id_57183a8c_fk_agent_id FOREIGN KEY (agent_id) REFERENCES agent(id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT approval_command_agent_fk FOREIGN KEY (command_id, agent_id) REFERENCES agent_command(id, agent_id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT approval_command_id_db7d2639_fk_agent_command_id FOREIGN KEY (command_id) REFERENCES agent_command(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE artifact
    ADD CONSTRAINT artifact_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agent(id) ON DELETE SET NULL,
    ADD CONSTRAINT artifact_computer_id_fkey FOREIGN KEY (computer_id) REFERENCES computer(id) ON DELETE SET NULL,
    ADD CONSTRAINT artifact_group_id_fkey FOREIGN KEY (group_id) REFERENCES chat_group(id),
    ADD CONSTRAINT artifact_task_id_fkey FOREIGN KEY (task_id) REFERENCES task(id) ON DELETE SET NULL;

ALTER TABLE artifact_share
    ADD CONSTRAINT artifact_share_version_id_fkey FOREIGN KEY (version_id) REFERENCES artifact_version(id) ON DELETE CASCADE;

ALTER TABLE artifact_version
    ADD CONSTRAINT artifact_version_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES artifact(id) ON DELETE CASCADE;

ALTER TABLE chat_attachment
    ADD CONSTRAINT chat_attachment_group_id_fkey FOREIGN KEY (group_id) REFERENCES chat_group(id);

ALTER TABLE chat_group
    ADD CONSTRAINT chat_group_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversation(id),
    ADD CONSTRAINT chat_group_direct_agent_id_fkey FOREIGN KEY (direct_agent_id) REFERENCES agent(id);

ALTER TABLE computer_runtime
    ADD CONSTRAINT computer_runtime_computer_id_fkey FOREIGN KEY (computer_id) REFERENCES computer(id) ON DELETE CASCADE;

ALTER TABLE group_participant
    ADD CONSTRAINT group_participant_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agent(id),
    ADD CONSTRAINT group_participant_group_id_fkey FOREIGN KEY (group_id) REFERENCES chat_group(id);

ALTER TABLE interaction
    ADD CONSTRAINT interaction_agent_conversation_fk FOREIGN KEY (agent_id, conversation_id) REFERENCES agent(id, conversation_id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT interaction_agent_id_15e9bc91_fk_agent_id FOREIGN KEY (agent_id) REFERENCES agent(id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT interaction_approval_agent_fk FOREIGN KEY (approval_id, agent_id) REFERENCES approval(id, agent_id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT interaction_approval_id_2a13c2d3_fk_approval_id FOREIGN KEY (approval_id) REFERENCES approval(id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT interaction_conversation_id_6b2af6f2_fk_conversation_id FOREIGN KEY (conversation_id) REFERENCES conversation(id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT interaction_group_id_fkey FOREIGN KEY (group_id) REFERENCES chat_group(id),
    ADD CONSTRAINT interaction_message_id_a38518f7_fk_message_id FOREIGN KEY (message_id) REFERENCES message(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE message
    ADD CONSTRAINT message_agent_conversation_fk FOREIGN KEY (agent_id, conversation_id) REFERENCES agent(id, conversation_id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT message_agent_id_98208da4_fk_agent_id FOREIGN KEY (agent_id) REFERENCES agent(id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT message_command_agent_fk FOREIGN KEY (command_id, agent_id) REFERENCES agent_command(id, agent_id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT message_command_id_b3e25873_fk_agent_command_id FOREIGN KEY (command_id) REFERENCES agent_command(id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT message_conversation_id_87e8709d_fk_conversation_id FOREIGN KEY (conversation_id) REFERENCES conversation(id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT message_group_id_fkey FOREIGN KEY (group_id) REFERENCES chat_group(id),
    ADD CONSTRAINT message_reply_to_id_e6325178_fk_message_id FOREIGN KEY (reply_to_id) REFERENCES message(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE task
    ADD CONSTRAINT task_computer_id_fkey FOREIGN KEY (computer_id) REFERENCES computer(id) ON DELETE SET NULL,
    ADD CONSTRAINT task_created_by_agent_fkey FOREIGN KEY (created_by_agent) REFERENCES agent(id) ON DELETE SET NULL,
    ADD CONSTRAINT task_group_id_fkey FOREIGN KEY (group_id) REFERENCES chat_group(id);

ALTER TABLE task_activity
    ADD CONSTRAINT task_activity_actor_agent_fkey FOREIGN KEY (actor_agent) REFERENCES agent(id) ON DELETE SET NULL,
    ADD CONSTRAINT task_activity_run_id_fkey FOREIGN KEY (run_id) REFERENCES task_run(id) ON DELETE SET NULL,
    ADD CONSTRAINT task_activity_task_id_fkey FOREIGN KEY (task_id) REFERENCES task(id) ON DELETE CASCADE;

ALTER TABLE task_assist
    ADD CONSTRAINT task_assist_after_run_id_fkey FOREIGN KEY (after_run_id) REFERENCES task_run(id) ON DELETE SET NULL,
    ADD CONSTRAINT task_assist_loop_id_fkey FOREIGN KEY (loop_id) REFERENCES task_review_loop(id) ON DELETE CASCADE,
    ADD CONSTRAINT task_assist_run_id_fkey FOREIGN KEY (run_id) REFERENCES task_run(id) ON DELETE SET NULL,
    ADD CONSTRAINT task_assist_task_id_fkey FOREIGN KEY (task_id) REFERENCES task(id) ON DELETE CASCADE;

ALTER TABLE task_review_loop
    ADD CONSTRAINT task_review_loop_task_id_fkey FOREIGN KEY (task_id) REFERENCES task(id) ON DELETE CASCADE;

ALTER TABLE task_run
    ADD CONSTRAINT task_run_computer_id_fkey FOREIGN KEY (computer_id) REFERENCES computer(id) ON DELETE SET NULL,
    ADD CONSTRAINT task_run_session_id_fkey FOREIGN KEY (session_id) REFERENCES task_session(id) ON DELETE SET NULL,
    ADD CONSTRAINT task_run_task_id_fkey FOREIGN KEY (task_id) REFERENCES task(id) ON DELETE CASCADE;

ALTER TABLE task_session
    ADD CONSTRAINT task_session_computer_id_fkey FOREIGN KEY (computer_id) REFERENCES computer(id) ON DELETE CASCADE,
    ADD CONSTRAINT task_session_task_id_fkey FOREIGN KEY (task_id) REFERENCES task(id) ON DELETE CASCADE;

ALTER TABLE ui_event
    ADD CONSTRAINT ui_event_conversation_id_e007badf_fk_conversation_id FOREIGN KEY (conversation_id) REFERENCES conversation(id) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX agent_command_agent_id_23e7fdc3 ON agent_command (agent_id);

CREATE INDEX agent_command_queue_idx ON agent_command (status, created_at);

CREATE INDEX agent_command_waiting_idx ON agent_command (agent_id, agent_sequence) WHERE status = 'queued';

CREATE INDEX agent_conversation_id_54c79dbd ON agent (conversation_id);

CREATE INDEX agent_conversation_idx ON agent (conversation_id, created_at, id);

CREATE INDEX agent_event_agent_id_f03f1617 ON agent_event (agent_id);

CREATE INDEX agent_event_agent_idx ON agent_event (agent_id, seq);

CREATE UNIQUE INDEX agent_event_boot_seq_uniq ON agent_event (agent_id, boot_id, source_seq);

CREATE INDEX agent_event_command_id_c2c1b069 ON agent_event (command_id);

CREATE INDEX agent_event_conversation_id_41740673 ON agent_event (conversation_id);

CREATE INDEX approval_agent_id_57183a8c ON approval (agent_id);

CREATE INDEX approval_agent_request_idx ON approval (agent_id, sdk_request_id);

CREATE INDEX approval_agent_status_idx ON approval (agent_id, status);

CREATE INDEX approval_command_id_db7d2639 ON approval (command_id);

CREATE UNIQUE INDEX artifact_share_active ON artifact_share (version_id) WHERE revoked_at IS NULL;

CREATE INDEX artifact_task ON artifact (task_id);

CREATE INDEX chat_attachment_group ON chat_attachment (group_id);

CREATE INDEX command_group_active ON agent_command (group_id) WHERE status IN ('queued', 'running', 'waiting_approval');

CREATE INDEX interaction_agent_id_15e9bc91 ON interaction (agent_id);

CREATE INDEX interaction_conversation_id_6b2af6f2 ON interaction (conversation_id);

CREATE INDEX interaction_message_id_a38518f7 ON interaction (message_id);

CREATE INDEX interaction_open_idx ON interaction (conversation_id, status);

CREATE INDEX message_active_idx ON message (conversation_id, role, status);

CREATE INDEX message_agent_id_98208da4 ON message (agent_id);

CREATE INDEX message_agent_reply_status_idx ON message (agent_id, status) WHERE role = 'assistant';

CREATE INDEX message_agent_seq_idx ON message (agent_id, seq);

CREATE INDEX message_command_id_b3e25873 ON message (command_id);

CREATE INDEX message_conversation_id_87e8709d ON message (conversation_id);

CREATE INDEX message_group_seq ON message (group_id, seq);

CREATE UNIQUE INDEX message_group_task_card ON message (group_id, ((data ->> 'task_id'))) WHERE kind = 'task_card';

CREATE INDEX message_reply_to_id_e6325178 ON message (reply_to_id);

CREATE UNIQUE INDEX one_active_execution_per_agent ON agent_command (agent_id) WHERE status IN ('running', 'waiting_approval');

CREATE UNIQUE INDEX one_default_conversation ON conversation (is_default) WHERE is_default;

CREATE INDEX task_activity_task ON task_activity (task_id, created_at);

CREATE UNIQUE INDEX task_assist_key ON task_assist (task_id, key) WHERE key IS NOT NULL;

CREATE INDEX task_assist_task ON task_assist (task_id, created_at);

CREATE INDEX task_assist_waiting ON task_assist (created_at) WHERE state = 'waiting';

CREATE INDEX task_group ON task (group_id) WHERE group_id IS NOT NULL;

CREATE UNIQUE INDEX task_review_loop_open ON task_review_loop (task_id) WHERE state IN ('active', 'exhausted', 'blocked');

CREATE UNIQUE INDEX task_run_active ON task_run (task_id, assist) WHERE status IN ('starting', 'running');

CREATE INDEX task_run_task ON task_run (task_id, created_at);

CREATE UNIQUE INDEX task_session_open ON task_session (task_id, computer_id, runtime, provider, assist) WHERE closed_at IS NULL;

CREATE INDEX ui_event_conversation_id_e007badf ON ui_event (conversation_id);
