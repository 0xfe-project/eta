-- +goose Up
-- Routines moved to the routine service (apps/routine-service), which keeps
-- them in a database of its own; what they had here is not carried over.

DROP TABLE routine_brief, routine_feedback, routine_run, routine;
