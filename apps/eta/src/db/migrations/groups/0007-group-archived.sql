-- Archiving a conversation, as a fact rather than a client-side wish (FRONTEND_REFACTOR.md §9, t89).
--
-- The product's `archived` was hardcoded `false` in the translation layer: the sidebar had an
-- "archived" section and a menu item for it, and nothing behind either. A chip in the interface
-- that cannot be true is a lie the interface tells every time it renders.
--
-- Not a delete: the timeline, its tasks and its artifacts stay, and unarchiving is one flag away.
-- Default 0 so every conversation that exists today stays where it is.
ALTER TABLE chat_group ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
