-- +goose Up
-- Task cards are only the confirmed drafts they replaced (which keep the
-- draft's reply_to_id). Cards appended when a task was linked to a group
-- repeated the tool call's card and the group's task list; the task and its
-- group link stay.
DELETE FROM message WHERE kind = 'task_card' AND reply_to_id IS NULL;

-- +goose Down
SELECT 1;
