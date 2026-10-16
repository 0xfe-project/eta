-- A reply is a row that changes: it starts as work in progress, and ends as text (REFACTOR.md §9,
-- P2.3).
--
-- `revision` is what a client uses to tell "the same message, newer" from "a second message": the
-- id stays, the revision grows, and applying the same revision twice changes nothing. The row's
-- `seq` never moves, so a reply keeps the place it started in.
ALTER TABLE group_message ADD COLUMN status TEXT NOT NULL DEFAULT 'done';
ALTER TABLE group_message ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
