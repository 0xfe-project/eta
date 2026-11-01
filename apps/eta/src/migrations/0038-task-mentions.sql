-- An agent mentioned on a task answers in its thread. It does so in a run of its own: the same queue,
-- the same machine slots and the same log as the executor's runs, but in a session of that agent
-- (`task:<task id>:<agent id>`, `tasks/session-key.ts`) that reads the task and the work and says
-- what it thinks, without taking the task over.
--
-- `agent_id` is that agent; NULL is the executor's run, which every run before this was. Each agent
-- is a lane of the task: a run waits for the previous run of its own lane, not for the others.
ALTER TABLE task_run ADD COLUMN agent_id TEXT;
