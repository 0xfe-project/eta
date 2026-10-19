-- Environment bundles. The bundles themselves are directories (built in, in the user's
-- `~/.eta/bundles`, or fetched from a repository); this is what the host adds to them.
--
-- The values a bundle is configured with, as one sealed blob per bundle: AES-256-GCM under the
-- host's key (`secret.key` in the data directory), so a copy of the database alone reads nothing.
CREATE TABLE bundle_config (
  name TEXT PRIMARY KEY,
  sealed BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The bundles taken from a repository: where from, and the commit `rev` resolved to when it was
-- fetched. A branch or tag moves, the commit does not; updating is the explicit `refresh`.
CREATE TABLE bundle_source (
  name TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  rev TEXT NOT NULL,
  path TEXT NOT NULL,
  sha TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- The bundles an agent loads, by name, as a JSON list. A name is not a foreign key: a bundle is a
-- directory that can come and go, and an agent that names one that is gone loads the rest.
ALTER TABLE agent ADD COLUMN bundles TEXT NOT NULL DEFAULT '[]';
