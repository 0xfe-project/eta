-- +goose Up
-- Idempotency-Key replay is gone from the public API; nothing reads or
-- writes its responses.

DROP TABLE api_idempotency;
