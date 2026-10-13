-- +goose Up
-- 请 Agent 协助 (docs/architecture/tasks.md): another agent on the task's
-- computer does one piece of work on it (a review, a test run) beside its
-- assignee. Its runs and sessions are the task's second lane: one active run
-- per lane, and its own session in a place AXP opens for it, never the
-- assignee's. Assisting changes neither the task's status nor its assignee.

ALTER TABLE task_session ADD COLUMN assist boolean NOT NULL DEFAULT false;
DROP INDEX task_session_open;
CREATE UNIQUE INDEX task_session_open ON task_session (task_id, computer_id, runtime, provider, assist) WHERE closed_at IS NULL;

ALTER TABLE task_run ADD COLUMN assist boolean NOT NULL DEFAULT false;
DROP INDEX task_run_active;
CREATE UNIQUE INDEX task_run_active ON task_run (task_id, assist) WHERE status IN ('starting', 'running');

-- A bounded review loop: an assisting agent reviews the assignee's delivery;
-- a review asking for changes sends them to the assignee, whose next run is
-- reviewed again, until a review passes or max_rounds reviews are done.
CREATE TABLE task_review_loop (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    -- The reviewer and what it is asked each round.
    runtime text NOT NULL,
    provider text NOT NULL,
    request text NOT NULL,
    max_rounds int NOT NULL CHECK (max_rounds BETWEEN 1 AND 10),
    -- Reviews done (each one a round).
    rounds int NOT NULL DEFAULT 0,
    state text NOT NULL CHECK (state IN ('active', 'passed', 'exhausted', 'blocked', 'stopped')),
    reason text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);
-- One unfinished loop per task: a new one cannot reset an exhausted budget.
CREATE UNIQUE INDEX task_review_loop_open ON task_review_loop (task_id) WHERE state IN ('active', 'exhausted', 'blocked');

-- A request for assistance: started (as an assisting run) at once, or once
-- the assignee's run it depends on has delivered. The runner starts waiting
-- ones in the order they were asked for, each a run of its own.
CREATE TABLE task_assist (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    -- The requester's idempotency key: the same key is the same request.
    key text,
    runtime text NOT NULL,
    provider text NOT NULL,
    request text NOT NULL,
    -- It looks at the task's delivered pull request, pinned at its head.
    review_pull boolean NOT NULL,
    -- The assignee's run whose successful delivery it waits for; none: now.
    after_run_id uuid REFERENCES task_run(id) ON DELETE SET NULL,
    waits boolean NOT NULL,
    loop_id uuid REFERENCES task_review_loop(id) ON DELETE CASCADE,
    round int,
    state text NOT NULL CHECK (state IN ('waiting', 'blocked', 'started', 'cancelled')),
    -- Why it waits, or is blocked or cancelled.
    reason text,
    run_id uuid REFERENCES task_run(id) ON DELETE SET NULL,
    -- What it was given to look at, when it started.
    pull_url text,
    head_sha text,
    -- Its structured result: pass, or changes_requested with feedback.
    verdict text CHECK (verdict IN ('pass', 'changes_requested')),
    feedback text,
    verdict_at timestamptz,
    created_at timestamptz NOT NULL,
    started_at timestamptz
);
CREATE INDEX task_assist_task ON task_assist (task_id, created_at);
CREATE UNIQUE INDEX task_assist_key ON task_assist (task_id, key) WHERE key IS NOT NULL;
CREATE INDEX task_assist_waiting ON task_assist (created_at) WHERE state = 'waiting';
