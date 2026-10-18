-- Small settings of the product itself (the tools that ask before they run, for one): a key and a
-- JSON value. What a setting means is the feature's business; this table only keeps it.
CREATE TABLE setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
