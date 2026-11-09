-- An assignee is the registry's id of the agent that executes a task, and a run looks it up by
-- that id. Until the write paths resolved it (`tasks/assignee.ts`), a draft_task or create_task
-- that named the assignee by its name stored the name, and such a task could not run: the queue
-- found no agent by that id. This turns those names into ids the way the write paths now do: an
-- exact name first, then one ignoring case, and only when exactly one agent has it. A value that
-- is an agent's id is not touched, so running this again changes nothing; a name nobody has, or
-- more than one agent has, is left as it is, and the queue says which agent it cannot find.
UPDATE task
   SET assignee_agent = (SELECT a.id FROM agent a WHERE a.name = TRIM(task.assignee_agent))
 WHERE assignee_agent IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM agent a WHERE a.id = task.assignee_agent)
   AND (SELECT COUNT(*) FROM agent a WHERE a.name = TRIM(task.assignee_agent)) = 1;

UPDATE task
   SET assignee_agent = (
         SELECT a.id FROM agent a WHERE LOWER(a.name) = LOWER(TRIM(task.assignee_agent))
       )
 WHERE assignee_agent IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM agent a WHERE a.id = task.assignee_agent)
   AND (SELECT COUNT(*) FROM agent a WHERE LOWER(a.name) = LOWER(TRIM(task.assignee_agent))) = 1;
