-- Market logos read from a plugin's repository, kept so they are not fetched again after a restart.
-- The key is the repository, the ref and the path as the catalog gave them. `status` is 'hit' (a
-- picture) or 'miss' (the repository confirmed there is none); a failed read is never stored. The
-- bytes are untrusted: they are checked again each time they are read.
CREATE TABLE plugin_icon (
  repo TEXT NOT NULL,
  ref TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  mime TEXT,
  data BLOB,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (repo, ref, path)
);
