-- The face an agent wears: the seed its avatar is drawn from, and the last few it was drawn from,
-- newest first, as a JSON list. NULL is the agent's id, so every agent before this keeps its face.
ALTER TABLE agent ADD COLUMN avatar_seed TEXT;
ALTER TABLE agent ADD COLUMN avatar_seeds TEXT NOT NULL DEFAULT '[]';
