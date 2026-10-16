-- How far the user has read (REFACTOR.md §9, P2.1).
--
-- The sidebar's unread badge is "the group's timeline went past what the user last looked at", and
-- that is a fact about the group, not about any one member: one number, moved forward when the
-- user opens the group. Never backward — re-opening an old group does not make messages unread.
ALTER TABLE chat_group ADD COLUMN read_seq INTEGER NOT NULL DEFAULT 0;
