-- +goose Up
-- How bundles' services are (internal/bundlesvc): the controller writes
-- a row per bundle with a service, the API reads them.
CREATE TABLE bundle_service (
    bundle text NOT NULL,
    state text NOT NULL,
    message text NOT NULL,
    version text NOT NULL,
    revision text NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT bundle_service_pkey PRIMARY KEY (bundle),
    CONSTRAINT bundle_service_state_check CHECK (state IN ('deploying', 'ready', 'incompatible', 'error'))
);

-- +goose Down
DROP TABLE bundle_service;
