-- +goose Up
ALTER TABLE task ADD COLUMN group_id uuid REFERENCES chat_group(id);
ALTER TABLE task ADD COLUMN source_from bigint;
ALTER TABLE task ADD COLUMN source_to bigint;
ALTER TABLE task ADD CONSTRAINT task_source_range CHECK ((source_from IS NULL AND source_to IS NULL) OR (group_id IS NOT NULL AND source_from > 0 AND source_to >= source_from));
CREATE INDEX task_group ON task(group_id) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX message_group_task_card ON message(group_id, (data->>'task_id')) WHERE kind = 'task_card';

ALTER TABLE artifact ADD COLUMN group_id uuid REFERENCES chat_group(id);

-- +goose Down
ALTER TABLE artifact DROP COLUMN group_id;
DROP INDEX message_group_task_card;
ALTER TABLE task DROP CONSTRAINT task_source_range;
ALTER TABLE task DROP COLUMN source_from, DROP COLUMN source_to, DROP COLUMN group_id;
