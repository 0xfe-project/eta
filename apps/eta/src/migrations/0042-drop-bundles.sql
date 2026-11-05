-- Environment bundles are gone, and what the host kept about them goes with them. The files a user
-- may have under `~/.eta/bundles` are theirs: nothing here or at startup touches them.
DROP TABLE bundle_config;
DROP TABLE bundle_source;
ALTER TABLE agent DROP COLUMN bundles;
