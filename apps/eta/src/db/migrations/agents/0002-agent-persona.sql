-- Which persona card an agent wears (FRONTEND_REFACTOR.md §7, P7).
--
-- A persona is a markdown card discovered from a project's `.eta/personas/`; it is the agent's
-- voice and rules, separate from its instructions. Empty means "whichever the project's default
-- is" — the harness already falls back that way, so storing "" would be storing a second opinion
-- about the same thing.
--
-- The name, not the path: a card can move between projects, and an agent that pinned a file would
-- stop finding its own persona the moment the project moved.
ALTER TABLE agents ADD COLUMN persona TEXT NOT NULL DEFAULT '';
