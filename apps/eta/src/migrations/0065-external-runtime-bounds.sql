-- Clear legacy persona cards on external runtime agents (OAR and ACP).
UPDATE agent SET persona = '' WHERE runtime != 'eta' AND persona != '';

-- Pin any existing unpinned external runtime agents to the primary machine when one exists.
-- Existing participant rows are kept intact to preserve conversation history; runtime guards
-- enforce single-machine execution going forward.
UPDATE agent
SET machine_id = (SELECT id FROM machine WHERE kind = 'primary' LIMIT 1)
WHERE runtime != 'eta'
  AND machine_id IS NULL
  AND EXISTS (SELECT 1 FROM machine WHERE kind = 'primary');
