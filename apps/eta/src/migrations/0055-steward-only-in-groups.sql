-- A steward belongs to a conversation, never to a project, and is one of its members or nobody.
--
-- Until now a conversation's `steward_id` NULL meant "follow the project's", `no_steward` said "none
-- at all", and a message that named nobody pulled the steward into the conversation if it was not a
-- member. Each conversation now keeps who answered it: the one it would have picked, written down,
-- and nobody when that one is not a member (it was only ever there by being pulled in, which no
-- longer happens).
UPDATE conversation
   SET steward_id = CASE
         WHEN no_steward = 1 THEN NULL
         ELSE COALESCE(
           steward_id,
           (SELECT project.steward_id FROM project WHERE project.id = conversation.project_id)
         )
       END;

UPDATE conversation
   SET steward_id = NULL
 WHERE steward_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM participant
      WHERE participant.conversation_id = conversation.id
        AND participant.agent_id = conversation.steward_id
   );

ALTER TABLE conversation DROP COLUMN no_steward;

-- What a project's `steward_id` still meant was "whose workspace this is", on the `agent_home` an
-- agent gets with itself. The column says that now, and only there. A column with a foreign key
-- cannot be dropped, and making `project` again would cascade into every conversation, so it is
-- renamed: it keeps its reference to the agent and its ON DELETE SET NULL.
ALTER TABLE project RENAME COLUMN steward_id TO owner_agent_id;

UPDATE project SET owner_agent_id = NULL WHERE kind <> 'agent_home';
