-- +goose Up
-- What the user sets for a built-in bundle whose bundle.json declares a
-- config (docs/architecture/bundles.md#配置): the values as JSON, sealed
-- (AES-GCM, a key derived from AXP_SECRET_KEY), since some are secrets.
CREATE TABLE bundle_config (
    bundle text PRIMARY KEY,
    sealed bytea NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
