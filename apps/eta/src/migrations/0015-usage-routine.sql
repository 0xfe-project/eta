-- Usage by routine: a routine's run is a session that belongs to no agent, so its generations
-- were counted with no owner. `routine_id` names the routine whose run (or brief revision) made
-- one. Like `agent_id` it carries no foreign key: what a routine cost outlives the routine.
-- Rows from before this column keep NULL and stay in the agentless group until they age out.
ALTER TABLE usage ADD COLUMN routine_id TEXT;
