-- The schema as Django left it (chat 0009, routines 0001): migration 1, the
-- baseline every later migration builds on (store.go). A database Django
-- migrated already has it.

CREATE TABLE agent (
    id uuid NOT NULL,
    name character varying(100) NOT NULL,
    description text NOT NULL,
    model character varying(100),
    desired_state character varying(16) NOT NULL,
    status character varying(32) NOT NULL,
    generation bigint NOT NULL,
    config_version bigint NOT NULL,
    last_active_at timestamp with time zone,
    deleted_at timestamp with time zone,
    product_status character varying(32) NOT NULL,
    product_revision bigint NOT NULL,
    last_command_seq bigint NOT NULL,
    last_error_code character varying(64),
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    conversation_id uuid NOT NULL,
    plugins jsonb NOT NULL,
    CONSTRAINT agent_counters_valid CHECK (((config_version >= 0) AND (generation >= 0) AND (last_command_seq >= 0) AND (product_revision >= 1))),
    CONSTRAINT agent_desired_state_valid CHECK (((desired_state)::text = ANY ((ARRAY['stopped'::character varying, 'running'::character varying])::text[]))),
    CONSTRAINT agent_product_status_valid CHECK (((product_status)::text = ANY ((ARRAY['idle'::character varying, 'working'::character varying, 'waiting_for_input'::character varying, 'unavailable'::character varying])::text[]))),
    CONSTRAINT agent_status_valid CHECK (((status)::text = ANY ((ARRAY['stopped'::character varying, 'provisioning'::character varying, 'recovering'::character varying, 'ready'::character varying, 'busy'::character varying, 'stopping'::character varying, 'recovery_failed'::character varying, 'error'::character varying])::text[])))
);

CREATE TABLE agent_command (
    id uuid NOT NULL,
    agent_sequence bigint NOT NULL,
    kind character varying(16) NOT NULL,
    status character varying(32) NOT NULL,
    input jsonb NOT NULL,
    codex_turn_id character varying(100),
    interrupt_requested_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    error_code character varying(64),
    agent_id uuid NOT NULL,
    runtime_instance_id uuid,
    queue_seq bigint,
    CONSTRAINT agent_command_kind_valid CHECK (((kind)::text = ANY ((ARRAY['turn'::character varying, 'compact'::character varying])::text[]))),
    CONSTRAINT agent_command_sequence_valid CHECK ((agent_sequence >= 1)),
    CONSTRAINT agent_command_status_valid CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'waiting_approval'::character varying, 'succeeded'::character varying, 'failed'::character varying, 'cancelled'::character varying, 'interrupted'::character varying])::text[])))
);

CREATE TABLE agent_event (
    id uuid NOT NULL,
    source_event_id character varying(100),
    source_seq bigint,
    seq bigint NOT NULL,
    type character varying(64) NOT NULL,
    schema_version integer NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    agent_id uuid NOT NULL,
    command_id uuid,
    conversation_id uuid NOT NULL,
    runtime_instance_id uuid
);

CREATE TABLE agent_session (
    agent_id uuid NOT NULL,
    thread_id character varying(100),
    status character varying(32) NOT NULL,
    sdk_version character varying(50) NOT NULL,
    runtime_version character varying(100) NOT NULL,
    last_turn_id character varying(100),
    last_resume_at timestamp with time zone,
    last_error character varying(100),
    CONSTRAINT agent_session_status_valid CHECK (((status)::text = ANY ((ARRAY['new'::character varying, 'recovering'::character varying, 'ready'::character varying, 'recovery_failed'::character varying])::text[])))
);

CREATE TABLE api_idempotency (
    id uuid NOT NULL,
    method character varying(10) NOT NULL,
    canonical_path character varying(500) NOT NULL,
    key character varying(255) NOT NULL,
    request_hash character varying(64) NOT NULL,
    response_status integer NOT NULL,
    response_body jsonb NOT NULL,
    resource_id character varying(64),
    created_at timestamp with time zone NOT NULL
);

CREATE TABLE approval (
    id uuid NOT NULL,
    generation bigint NOT NULL,
    sdk_request_id character varying(100) NOT NULL,
    kind character varying(32) NOT NULL,
    summary jsonb NOT NULL,
    status character varying(32) NOT NULL,
    decision character varying(16),
    expires_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    resolved_at timestamp with time zone,
    agent_id uuid NOT NULL,
    command_id uuid NOT NULL,
    runtime_instance_id uuid NOT NULL,
    CONSTRAINT approval_status_valid CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'decided'::character varying, 'applied'::character varying, 'expired'::character varying])::text[])))
);

CREATE TABLE conversation (
    id uuid NOT NULL,
    is_default boolean NOT NULL,
    title character varying(200) NOT NULL,
    archived_at timestamp with time zone,
    last_event_seq bigint NOT NULL,
    last_ui_event_seq bigint NOT NULL,
    last_message_seq bigint NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT conversation_seq_nonnegative CHECK (((last_event_seq >= 0) AND (last_message_seq >= 0) AND (last_ui_event_seq >= 0)))
);

CREATE TABLE interaction (
    id uuid NOT NULL,
    kind character varying(16) NOT NULL,
    prompt character varying(500) NOT NULL,
    options jsonb NOT NULL,
    status character varying(16) NOT NULL,
    revision bigint NOT NULL,
    answer jsonb,
    expires_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    agent_id uuid NOT NULL,
    approval_id uuid,
    conversation_id uuid NOT NULL,
    message_id uuid NOT NULL,
    CONSTRAINT interaction_kind_valid CHECK (((kind)::text = 'choice'::text)),
    CONSTRAINT interaction_revision_valid CHECK ((revision >= 1)),
    CONSTRAINT interaction_status_valid CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'submitted'::character varying, 'resolved'::character varying, 'expired'::character varying])::text[])))
);

CREATE TABLE message (
    id uuid NOT NULL,
    seq bigint NOT NULL,
    role character varying(16) NOT NULL,
    content jsonb NOT NULL,
    status character varying(32) NOT NULL,
    failure jsonb,
    revision bigint NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    agent_id uuid NOT NULL,
    command_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    reply_to_id uuid,
    CONSTRAINT message_counters_valid CHECK (((revision >= 1) AND (seq >= 1))),
    CONSTRAINT message_role_shape_valid CHECK ((((reply_to_id IS NULL) AND ((role)::text = 'user'::text) AND ((status)::text = 'completed'::text)) OR ((reply_to_id IS NOT NULL) AND ((role)::text = 'assistant'::text)))),
    CONSTRAINT message_role_valid CHECK (((role)::text = ANY ((ARRAY['user'::character varying, 'assistant'::character varying])::text[]))),
    CONSTRAINT message_status_valid CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'responding'::character varying, 'waiting_for_input'::character varying, 'stopping'::character varying, 'completed'::character varying, 'stopped'::character varying, 'failed'::character varying])::text[])))
);

CREATE TABLE routine (
    id uuid NOT NULL,
    name character varying(100) NOT NULL,
    model character varying(200) NOT NULL,
    schedule jsonb NOT NULL,
    timezone character varying(64) NOT NULL,
    enabled boolean NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);

CREATE TABLE routine_brief (
    id bigint NOT NULL,
    version integer NOT NULL,
    text text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    routine_id uuid NOT NULL,
    feedback_id uuid
);

ALTER TABLE routine_brief ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME routine_brief_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE routine_feedback (
    id uuid NOT NULL,
    text text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    revision_failed boolean NOT NULL,
    run_id uuid NOT NULL
);

CREATE TABLE routine_run (
    id uuid NOT NULL,
    status character varying(16) NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    report text,
    handoff text,
    error character varying(500),
    container_id character varying(100),
    routine_id uuid NOT NULL
);

CREATE TABLE runtime_instance (
    id uuid NOT NULL,
    generation bigint NOT NULL,
    container_id character varying(100),
    host_id character varying(100) NOT NULL,
    image_digest character varying(200) NOT NULL,
    status character varying(16) NOT NULL,
    error_code character varying(64),
    controller_id character varying(100) NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    last_heartbeat_at timestamp with time zone,
    config_version bigint NOT NULL,
    last_source_seq bigint NOT NULL,
    end_reason character varying(64),
    ended_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    agent_id uuid NOT NULL,
    CONSTRAINT runtime_counters_valid CHECK (((generation >= 1) AND (last_source_seq >= 0))),
    CONSTRAINT runtime_status_valid CHECK (((status)::text = ANY ((ARRAY['provisioning'::character varying, 'recovering'::character varying, 'ready'::character varying, 'busy'::character varying, 'stopping'::character varying, 'stopped'::character varying, 'failed'::character varying])::text[])))
);

CREATE TABLE ui_event (
    id uuid NOT NULL,
    seq bigint NOT NULL,
    type character varying(32) NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    conversation_id uuid NOT NULL,
    CONSTRAINT ui_event_type_valid CHECK (((type)::text = ANY ((ARRAY['agent.updated'::character varying, 'agent.deleted'::character varying, 'message.updated'::character varying, 'interaction.updated'::character varying])::text[])))
);

ALTER TABLE ONLY agent_command
    ADD CONSTRAINT agent_command_id_agent_uniq UNIQUE (id, agent_id);

ALTER TABLE ONLY agent_command
    ADD CONSTRAINT agent_command_pkey PRIMARY KEY (id);

ALTER TABLE ONLY agent_command
    ADD CONSTRAINT agent_command_sequence_uniq UNIQUE (agent_id, agent_sequence);

ALTER TABLE ONLY agent_event
    ADD CONSTRAINT agent_event_conversation_seq_uniq UNIQUE (conversation_id, seq);

ALTER TABLE ONLY agent_event
    ADD CONSTRAINT agent_event_pkey PRIMARY KEY (id);

ALTER TABLE ONLY agent
    ADD CONSTRAINT agent_id_conversation_uniq UNIQUE (id, conversation_id);

ALTER TABLE ONLY agent
    ADD CONSTRAINT agent_pkey PRIMARY KEY (id);

ALTER TABLE ONLY agent_session
    ADD CONSTRAINT agent_session_pkey PRIMARY KEY (agent_id);

ALTER TABLE ONLY agent_session
    ADD CONSTRAINT agent_session_thread_id_key UNIQUE (thread_id);

ALTER TABLE ONLY api_idempotency
    ADD CONSTRAINT api_idempotency_key_uniq UNIQUE (method, canonical_path, key);

ALTER TABLE ONLY api_idempotency
    ADD CONSTRAINT api_idempotency_pkey PRIMARY KEY (id);

ALTER TABLE ONLY approval
    ADD CONSTRAINT approval_id_agent_uniq UNIQUE (id, agent_id);

ALTER TABLE ONLY approval
    ADD CONSTRAINT approval_pkey PRIMARY KEY (id);

ALTER TABLE ONLY approval
    ADD CONSTRAINT approval_sdk_request_uniq UNIQUE (runtime_instance_id, sdk_request_id);

ALTER TABLE ONLY conversation
    ADD CONSTRAINT conversation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY interaction
    ADD CONSTRAINT interaction_approval_id_key UNIQUE (approval_id);

ALTER TABLE ONLY interaction
    ADD CONSTRAINT interaction_pkey PRIMARY KEY (id);

ALTER TABLE ONLY message
    ADD CONSTRAINT message_conversation_seq_uniq UNIQUE (conversation_id, seq);

ALTER TABLE ONLY message
    ADD CONSTRAINT message_id_agent_command_uniq UNIQUE (id, agent_id, command_id);

ALTER TABLE ONLY message
    ADD CONSTRAINT message_one_per_role_per_command UNIQUE (command_id, role);

ALTER TABLE ONLY message
    ADD CONSTRAINT message_pkey PRIMARY KEY (id);

ALTER TABLE ONLY routine_brief
    ADD CONSTRAINT routine_brief_feedback_id_key UNIQUE (feedback_id);

ALTER TABLE ONLY routine_brief
    ADD CONSTRAINT routine_brief_pkey PRIMARY KEY (id);

ALTER TABLE ONLY routine_brief
    ADD CONSTRAINT routine_brief_version_uniq UNIQUE (routine_id, version);

ALTER TABLE ONLY routine_feedback
    ADD CONSTRAINT routine_feedback_pkey PRIMARY KEY (id);

ALTER TABLE ONLY routine
    ADD CONSTRAINT routine_pkey PRIMARY KEY (id);

ALTER TABLE ONLY routine_run
    ADD CONSTRAINT routine_run_pkey PRIMARY KEY (id);

ALTER TABLE ONLY runtime_instance
    ADD CONSTRAINT runtime_agent_generation_uniq UNIQUE (agent_id, generation);

ALTER TABLE ONLY runtime_instance
    ADD CONSTRAINT runtime_id_agent_uniq UNIQUE (id, agent_id);

ALTER TABLE ONLY runtime_instance
    ADD CONSTRAINT runtime_instance_container_id_key UNIQUE (container_id);

ALTER TABLE ONLY runtime_instance
    ADD CONSTRAINT runtime_instance_pkey PRIMARY KEY (id);

ALTER TABLE ONLY ui_event
    ADD CONSTRAINT ui_event_conversation_seq_uniq UNIQUE (conversation_id, seq);

ALTER TABLE ONLY ui_event
    ADD CONSTRAINT ui_event_pkey PRIMARY KEY (id);

CREATE INDEX agent_command_agent_id_23e7fdc3 ON agent_command USING btree (agent_id);

CREATE INDEX agent_command_queue_idx ON agent_command USING btree (status, created_at);

CREATE INDEX agent_command_runtime_instance_id_5ebc2d90 ON agent_command USING btree (runtime_instance_id);

CREATE INDEX agent_conversation_id_54c79dbd ON agent USING btree (conversation_id);

CREATE INDEX agent_conversation_idx ON agent USING btree (conversation_id, created_at, id);

CREATE INDEX agent_event_agent_id_f03f1617 ON agent_event USING btree (agent_id);

CREATE INDEX agent_event_agent_idx ON agent_event USING btree (agent_id, seq);

CREATE INDEX agent_event_command_id_c2c1b069 ON agent_event USING btree (command_id);

CREATE INDEX agent_event_conversation_id_41740673 ON agent_event USING btree (conversation_id);

CREATE INDEX agent_event_runtime_instance_id_218960a2 ON agent_event USING btree (runtime_instance_id);

CREATE UNIQUE INDEX agent_event_source_id_uniq ON agent_event USING btree (runtime_instance_id, source_event_id) WHERE (source_event_id IS NOT NULL);

CREATE UNIQUE INDEX agent_event_source_seq_uniq ON agent_event USING btree (runtime_instance_id, source_seq) WHERE (source_seq IS NOT NULL);

CREATE INDEX agent_session_thread_id_38b97c21_like ON agent_session USING btree (thread_id varchar_pattern_ops);

CREATE INDEX approval_agent_id_57183a8c ON approval USING btree (agent_id);

CREATE INDEX approval_agent_status_idx ON approval USING btree (agent_id, status);

CREATE INDEX approval_command_id_db7d2639 ON approval USING btree (command_id);

CREATE INDEX approval_runtime_instance_id_4ec416ca ON approval USING btree (runtime_instance_id);

CREATE INDEX interaction_agent_id_15e9bc91 ON interaction USING btree (agent_id);

CREATE INDEX interaction_conversation_id_6b2af6f2 ON interaction USING btree (conversation_id);

CREATE INDEX interaction_message_id_a38518f7 ON interaction USING btree (message_id);

CREATE INDEX interaction_open_idx ON interaction USING btree (conversation_id, status);

CREATE INDEX message_active_idx ON message USING btree (conversation_id, role, status);

CREATE INDEX message_agent_id_98208da4 ON message USING btree (agent_id);

CREATE INDEX message_agent_seq_idx ON message USING btree (agent_id, seq);

CREATE INDEX message_command_id_b3e25873 ON message USING btree (command_id);

CREATE INDEX message_conversation_id_87e8709d ON message USING btree (conversation_id);

CREATE INDEX message_reply_to_id_e6325178 ON message USING btree (reply_to_id);

CREATE UNIQUE INDEX one_active_execution_per_agent ON agent_command USING btree (agent_id) WHERE ((status)::text = ANY ((ARRAY['running'::character varying, 'waiting_approval'::character varying])::text[]));

CREATE UNIQUE INDEX one_default_conversation ON conversation USING btree (is_default) WHERE is_default;

CREATE UNIQUE INDEX one_live_runtime_per_agent ON runtime_instance USING btree (agent_id) WHERE (ended_at IS NULL);

CREATE UNIQUE INDEX one_running_run_per_routine ON routine_run USING btree (routine_id) WHERE ((status)::text = 'running'::text);

CREATE INDEX routine_brief_routine_id_7fecbb03 ON routine_brief USING btree (routine_id);

CREATE INDEX routine_feedback_run_id_5847bac4 ON routine_feedback USING btree (run_id);

CREATE INDEX routine_run_routine_id_c55d5f7a ON routine_run USING btree (routine_id);

CREATE INDEX runtime_instance_agent_id_91ccebe3 ON runtime_instance USING btree (agent_id);

CREATE INDEX runtime_instance_container_id_17e58ee1_like ON runtime_instance USING btree (container_id varchar_pattern_ops);

CREATE INDEX ui_event_conversation_id_e007badf ON ui_event USING btree (conversation_id);

ALTER TABLE ONLY agent_command
    ADD CONSTRAINT agent_command_agent_id_23e7fdc3_fk_agent_id FOREIGN KEY (agent_id) REFERENCES agent(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY agent_command
    ADD CONSTRAINT agent_command_runtime_agent_fk FOREIGN KEY (runtime_instance_id, agent_id) REFERENCES runtime_instance(id, agent_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY agent_command
    ADD CONSTRAINT agent_command_runtime_instance_id_5ebc2d90_fk_runtime_i FOREIGN KEY (runtime_instance_id) REFERENCES runtime_instance(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY agent
    ADD CONSTRAINT agent_conversation_id_54c79dbd_fk_conversation_id FOREIGN KEY (conversation_id) REFERENCES conversation(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY agent_event
    ADD CONSTRAINT agent_event_agent_conversation_fk FOREIGN KEY (agent_id, conversation_id) REFERENCES agent(id, conversation_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY agent_event
    ADD CONSTRAINT agent_event_agent_id_f03f1617_fk_agent_id FOREIGN KEY (agent_id) REFERENCES agent(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY agent_event
    ADD CONSTRAINT agent_event_command_id_c2c1b069_fk_agent_command_id FOREIGN KEY (command_id) REFERENCES agent_command(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY agent_event
    ADD CONSTRAINT agent_event_conversation_id_41740673_fk_conversation_id FOREIGN KEY (conversation_id) REFERENCES conversation(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY agent_event
    ADD CONSTRAINT agent_event_runtime_instance_id_218960a2_fk_runtime_instance_id FOREIGN KEY (runtime_instance_id) REFERENCES runtime_instance(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY agent_session
    ADD CONSTRAINT agent_session_agent_id_5238daea_fk_agent_id FOREIGN KEY (agent_id) REFERENCES agent(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY approval
    ADD CONSTRAINT approval_agent_id_57183a8c_fk_agent_id FOREIGN KEY (agent_id) REFERENCES agent(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY approval
    ADD CONSTRAINT approval_command_agent_fk FOREIGN KEY (command_id, agent_id) REFERENCES agent_command(id, agent_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY approval
    ADD CONSTRAINT approval_command_id_db7d2639_fk_agent_command_id FOREIGN KEY (command_id) REFERENCES agent_command(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY approval
    ADD CONSTRAINT approval_runtime_agent_fk FOREIGN KEY (runtime_instance_id, agent_id) REFERENCES runtime_instance(id, agent_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY approval
    ADD CONSTRAINT approval_runtime_instance_id_4ec416ca_fk_runtime_instance_id FOREIGN KEY (runtime_instance_id) REFERENCES runtime_instance(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY interaction
    ADD CONSTRAINT interaction_agent_conversation_fk FOREIGN KEY (agent_id, conversation_id) REFERENCES agent(id, conversation_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY interaction
    ADD CONSTRAINT interaction_agent_id_15e9bc91_fk_agent_id FOREIGN KEY (agent_id) REFERENCES agent(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY interaction
    ADD CONSTRAINT interaction_approval_agent_fk FOREIGN KEY (approval_id, agent_id) REFERENCES approval(id, agent_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY interaction
    ADD CONSTRAINT interaction_approval_id_2a13c2d3_fk_approval_id FOREIGN KEY (approval_id) REFERENCES approval(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY interaction
    ADD CONSTRAINT interaction_conversation_id_6b2af6f2_fk_conversation_id FOREIGN KEY (conversation_id) REFERENCES conversation(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY interaction
    ADD CONSTRAINT interaction_message_id_a38518f7_fk_message_id FOREIGN KEY (message_id) REFERENCES message(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY message
    ADD CONSTRAINT message_agent_conversation_fk FOREIGN KEY (agent_id, conversation_id) REFERENCES agent(id, conversation_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY message
    ADD CONSTRAINT message_agent_id_98208da4_fk_agent_id FOREIGN KEY (agent_id) REFERENCES agent(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY message
    ADD CONSTRAINT message_command_agent_fk FOREIGN KEY (command_id, agent_id) REFERENCES agent_command(id, agent_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY message
    ADD CONSTRAINT message_command_id_b3e25873_fk_agent_command_id FOREIGN KEY (command_id) REFERENCES agent_command(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY message
    ADD CONSTRAINT message_conversation_id_87e8709d_fk_conversation_id FOREIGN KEY (conversation_id) REFERENCES conversation(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY message
    ADD CONSTRAINT message_reply_to_id_e6325178_fk_message_id FOREIGN KEY (reply_to_id) REFERENCES message(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY message
    ADD CONSTRAINT message_reply_to_same_turn_fk FOREIGN KEY (reply_to_id, agent_id, command_id) REFERENCES message(id, agent_id, command_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY routine_brief
    ADD CONSTRAINT routine_brief_feedback_id_59380b0a_fk_routine_feedback_id FOREIGN KEY (feedback_id) REFERENCES routine_feedback(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY routine_brief
    ADD CONSTRAINT routine_brief_routine_id_7fecbb03_fk_routine_id FOREIGN KEY (routine_id) REFERENCES routine(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY routine_feedback
    ADD CONSTRAINT routine_feedback_run_id_5847bac4_fk_routine_run_id FOREIGN KEY (run_id) REFERENCES routine_run(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY routine_run
    ADD CONSTRAINT routine_run_routine_id_c55d5f7a_fk_routine_id FOREIGN KEY (routine_id) REFERENCES routine(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY runtime_instance
    ADD CONSTRAINT runtime_instance_agent_id_91ccebe3_fk_agent_id FOREIGN KEY (agent_id) REFERENCES agent(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY ui_event
    ADD CONSTRAINT ui_event_conversation_id_e007badf_fk_conversation_id FOREIGN KEY (conversation_id) REFERENCES conversation(id) DEFERRABLE INITIALLY DEFERRED;
