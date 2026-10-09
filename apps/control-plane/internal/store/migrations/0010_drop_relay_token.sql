-- +goose Up
-- The relay's runtime calls go through its administrator API (the control
-- plane holds its secret); the OAuth grant kept here is no longer used.

DROP TABLE IF EXISTS relay_token;
