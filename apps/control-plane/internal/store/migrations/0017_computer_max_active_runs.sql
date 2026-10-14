-- +goose Up
-- How many runs a computer works on at once (its assignees' and assisting
-- agents', every runtime): set per computer, 3 unless the user changed it.
ALTER TABLE computer ADD COLUMN max_active_runs integer NOT NULL DEFAULT 3,
    ADD CONSTRAINT computer_max_active_runs_check CHECK (max_active_runs BETWEEN 1 AND 20);

-- +goose Down
ALTER TABLE computer DROP COLUMN max_active_runs;
