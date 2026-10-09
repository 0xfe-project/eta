-- +goose Up
-- Idempotency keys of POST requests (package idempotency): the response a
-- key got, replayed when the same request comes again. A database a service
-- created before the framework may have the table already.

CREATE TABLE IF NOT EXISTS api_idempotency (
    id uuid PRIMARY KEY,
    method varchar(10) NOT NULL,
    canonical_path varchar(500) NOT NULL,
    key varchar(255) NOT NULL,
    request_hash varchar(64) NOT NULL,
    response_status integer NOT NULL,
    response_body jsonb NOT NULL,
    resource_id varchar(64),
    created_at timestamptz NOT NULL,
    CONSTRAINT api_idempotency_key_uniq UNIQUE (method, canonical_path, key)
);
