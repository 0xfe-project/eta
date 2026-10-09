-- +goose Up
-- An agent whose work waits on its environment being prepared is "starting".

ALTER TABLE agent DROP CONSTRAINT agent_product_status_valid;
ALTER TABLE agent ADD CONSTRAINT agent_product_status_valid CHECK (
    product_status IN ('idle', 'starting', 'working', 'waiting_for_input', 'unavailable')
);
