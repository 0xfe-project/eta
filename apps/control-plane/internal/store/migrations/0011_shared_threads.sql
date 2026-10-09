-- +goose Up
-- A copy of an agent resumes the same Codex thread from its own copy of the
-- agent's home, so two agents may name one thread; each runtime only ever
-- reads its own home.

ALTER TABLE agent_session DROP CONSTRAINT IF EXISTS agent_session_thread_id_key;
