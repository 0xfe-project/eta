-- Clean up any legacy daemon machines left in status = 'revoked' before hard machine removal.

-- 1. Fail any open task runs targeting revoked machines or belonging to non-captain agents pinned to them.
UPDATE task_run
   SET status = 'failed',
       queue_reason = NULL,
       error = 'Machine was removed.',
       last_event_at = unixepoch() * 1000,
       finished_at = unixepoch() * 1000
 WHERE status IN ('queued', 'starting', 'running')
   AND (
     machine_id IN (SELECT id FROM machine WHERE status = 'revoked')
     OR agent_id IN (
       SELECT id FROM agent
        WHERE COALESCE(system_role, '') <> 'captain'
          AND machine_id IN (SELECT id FROM machine WHERE status = 'revoked')
     )
     OR (
       agent_id IS NULL
       AND task_id IN (
         SELECT id FROM task
          WHERE COALESCE(assignee_agent, created_by_agent) IN (
            SELECT id FROM agent
             WHERE COALESCE(system_role, '') <> 'captain'
               AND machine_id IN (SELECT id FROM machine WHERE status = 'revoked')
          )
       )
     )
   );

-- 2. Archive agent_home projects owned by non-captain agents pinned to revoked machines.
UPDATE project
   SET archived = 1
 WHERE kind = 'agent_home'
   AND owner_agent_id IN (
     SELECT id FROM agent
      WHERE COALESCE(system_role, '') <> 'captain'
        AND machine_id IN (SELECT id FROM machine WHERE status = 'revoked')
   );

-- 3. Delete non-captain agents pinned to revoked machines BEFORE deleting machines
--    so ON DELETE SET NULL never leaves external agents with machine_id = NULL.
DELETE FROM agent
 WHERE COALESCE(system_role, '') <> 'captain'
   AND machine_id IN (SELECT id FROM machine WHERE status = 'revoked');

-- 4. Clear stale session pointers on any remaining participant rows referencing revoked machines
--    BEFORE DELETE FROM machine nulls participant.machine_id.
UPDATE participant
   SET session_id = NULL,
       pending_settings = NULL
 WHERE machine_id IN (SELECT id FROM machine WHERE status = 'revoked');

-- 5. Delete revoked machines (cascades projects, conversations, messages, participants,
--    attachments, captain_assignment, place_recent, place_clone_parent; sets NULL on tasks,
--    artifacts, and machine_enrollment).
DELETE FROM machine WHERE status = 'revoked';
