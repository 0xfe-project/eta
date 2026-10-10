-- +goose NO TRANSACTION
-- +goose Up
-- An agent's replies at work (RefreshAgentStatus, stopReplies, under the
-- conversation lock) are found by agent and status, not by reading the
-- agent's whole history. Not a partial index on the active statuses: the
-- queries pass them as a parameter, and a cached (generic) plan cannot prove
-- a parameter implies such an index's predicate, so it would go unused.
-- Built without blocking writes; a build an earlier attempt left invalid is
-- dropped first.
DROP INDEX CONCURRENTLY IF EXISTS message_agent_reply_status_idx;
CREATE INDEX CONCURRENTLY message_agent_reply_status_idx ON message (agent_id, status) WHERE role = 'assistant';
