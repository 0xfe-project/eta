-- An agent edit waits here until its conversation session can accept it.
ALTER TABLE participant ADD COLUMN pending_settings TEXT;
