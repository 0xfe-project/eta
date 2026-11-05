-- A conversation can say it has no steward of its own and does not follow its project's either:
-- a NULL steward_id alone means "follow the project".
ALTER TABLE conversation ADD COLUMN no_steward INTEGER NOT NULL DEFAULT 0;
