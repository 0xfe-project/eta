-- The market's catalogs, kept so opening the market does not wait for the network. One row per
-- catalog address (the address as the user wrote it, before any proxy). The body is the document as
-- it came, JSON text; it is untrusted and checked again every time it is read. `etag` and
-- `last_modified` are what the server said, sent back to ask "has it changed".
CREATE TABLE market_catalog_cache (
  url TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  fetched_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL,
  size INTEGER NOT NULL
);
