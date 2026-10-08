-- +goose Up
-- Tasks and remote computers (docs/architecture/tasks.md): the task board,
-- the computers that run agents for it through the agenvo relay, and the
-- relay's OAuth tokens.

-- A computer: one `axp` daemon, enrolled with a one-time code, which
-- supervises an agenvo connector per runtime on that machine.
CREATE TABLE computer (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    -- The install command's code (sha256), until the daemon enrolls.
    enroll_code_hash text UNIQUE,
    enroll_expires_at timestamptz,
    -- The daemon's and CLI's credential (sha256), once enrolled.
    token_hash text UNIQUE,
    hostname text,
    os text,
    arch text,
    -- Where task workspaces live on the computer: <root>/<task id>/.
    workspace_root text,
    -- The axp binary's path, for agents whose PATH lacks it.
    cli_path text,
    last_seen_at timestamptz,
    created_at timestamptz NOT NULL
);

-- An agenvo connector on a computer, as its daemon reports it, and its
-- device on the relay once paired.
CREATE TABLE computer_runtime (
    computer_id uuid NOT NULL REFERENCES computer(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('paseo', 'herdr')),
    -- Providers the runtime can launch (codex, claude, ...).
    providers text[] NOT NULL DEFAULT '{}',
    -- A pairing waiting for the user: its code and the device fingerprint the
    -- daemon's terminal shows.
    pairing_code text,
    pairing_fingerprint text,
    device_id text,
    error text,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (computer_id, kind)
);

CREATE TABLE task (
    id uuid PRIMARY KEY,
    number bigserial UNIQUE,
    title text NOT NULL,
    description text NOT NULL DEFAULT '',
    status text NOT NULL CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled')),
    -- Nobody, the user, or an agent on a remote computer.
    assignee text NOT NULL CHECK (assignee IN ('none', 'user', 'remote')),
    computer_id uuid REFERENCES computer(id) ON DELETE SET NULL,
    runtime text CHECK (runtime IN ('paseo', 'herdr')),
    provider text,
    -- owner/name on GitHub, for `axp repo checkout`.
    repository text,
    -- The AXP agent that created it; the user when null.
    created_by_agent uuid REFERENCES agent(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK ((assignee = 'remote') = (computer_id IS NOT NULL AND runtime IS NOT NULL AND provider IS NOT NULL))
);

-- One native agent on a computer working on a task; follow-ups go to it.
CREATE TABLE task_session (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    computer_id uuid NOT NULL REFERENCES computer(id) ON DELETE CASCADE,
    runtime text NOT NULL,
    provider text NOT NULL,
    device_id text NOT NULL,
    instance_id text NOT NULL,
    -- The workspace on the computer.
    workspace text NOT NULL,
    -- The native agent: Paseo's agent id, or Herdr's session and agent name.
    native jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    -- Replaced by another assignee; never reused.
    closed_at timestamptz
);
CREATE UNIQUE INDEX task_session_open ON task_session (task_id, computer_id, runtime, provider) WHERE closed_at IS NULL;

-- One turn of a remote agent on a task: the first brief or a follow-up.
CREATE TABLE task_run (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    session_id uuid REFERENCES task_session(id) ON DELETE SET NULL,
    computer_id uuid REFERENCES computer(id) ON DELETE SET NULL,
    runtime text NOT NULL,
    provider text NOT NULL,
    status text NOT NULL CHECK (status IN ('queued', 'preparing', 'starting', 'running', 'completed', 'failed', 'cancelled')),
    -- What it was sent.
    prompt text NOT NULL,
    workspace text,
    -- When the prompt was handed to the relay; set before the call, so a lost
    -- confirmation is checked against the native state, never resent.
    sent_at timestamptz,
    -- The agent stopped without commenting and was reminded once.
    nudged_at timestamptz,
    -- The user asked to stop it.
    interrupt_requested_at timestamptz,
    error text,
    created_at timestamptz NOT NULL,
    finished_at timestamptz
);
CREATE INDEX task_run_task ON task_run (task_id, created_at);
CREATE UNIQUE INDEX task_run_active ON task_run (task_id) WHERE status IN ('preparing', 'starting', 'running');

-- The task's timeline: comments and everything that happened to it.
CREATE TABLE task_activity (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    run_id uuid REFERENCES task_run(id) ON DELETE SET NULL,
    kind text NOT NULL,
    -- user, agent (an AXP agent), remote (a remote agent) or system.
    actor text NOT NULL,
    actor_agent uuid REFERENCES agent(id) ON DELETE SET NULL,
    body text,
    data jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL
);
CREATE INDEX task_activity_task ON task_activity (task_id, created_at);

-- The control plane's OAuth client and tokens on the relay's MCP endpoint.
-- One row; refreshes lock it, since a refresh token works once.
CREATE TABLE relay_token (
    id int PRIMARY KEY CHECK (id = 1),
    client_id text NOT NULL,
    access_token text NOT NULL,
    refresh_token text NOT NULL,
    expires_at timestamptz NOT NULL
);
