-- +goose Up
-- A user's bundle may run a service (docs/architecture/bundles.md#服务):
-- its Kubernetes objects as YAML, and what it uses of AXP.
ALTER TABLE bundle ADD COLUMN service jsonb;

-- +goose Down
ALTER TABLE bundle DROP COLUMN service;
