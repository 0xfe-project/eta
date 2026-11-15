-- There is no default model any more: an agent on eta's own loop, and a routine (which always runs
-- there), names the model it runs on. One that named none ran on the config's default model, else
-- its first one; that model is written onto it here, so it keeps running on what it ran on.
-- An agent on an external runtime keeps NULL: that runtime has a default of its own.
--
-- SQL cannot read the config file, so the host puts that model in `temp.migration_input` before
-- migrating (`model-backfill.ts`). Without it (no config, no models, a test) nothing changes, and
-- an agent left without a model is told to choose one when it is next asked to answer.
CREATE TEMP TABLE IF NOT EXISTS migration_input (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

UPDATE agent
SET model = (SELECT value FROM temp.migration_input WHERE key = 'fallback_model')
WHERE runtime = 'eta'
  AND (model IS NULL OR model = '')
  AND EXISTS (SELECT 1 FROM temp.migration_input WHERE key = 'fallback_model');

UPDATE routine
SET model = (SELECT value FROM temp.migration_input WHERE key = 'fallback_model')
WHERE (model IS NULL OR model = '')
  AND EXISTS (SELECT 1 FROM temp.migration_input WHERE key = 'fallback_model');
