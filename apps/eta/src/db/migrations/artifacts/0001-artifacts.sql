-- Artifacts: a static site an agent published, its versions, and its shares (REFACTOR.md §9, P3.2).
--
-- The rows hold what a reader needs to find the bytes; the bytes live under the data directory,
-- one prefix per version (`artifacts/<artifact>/<version>/{archive.zip,files/…}`). AXP kept them in
-- S3 and the doc says the object store is a seam — here it is the local disk, and moving it later
-- is a change to one module.
CREATE TABLE artifact (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  -- Who published it: an agent, or a remote computer (P4). Only the publisher may add a version —
  -- two agents publishing into one artifact is not a feature, it is a way to overwrite someone.
  publisher_agent TEXT,
  publisher_computer TEXT,
  -- The task it belongs to, when it was published for one.
  task_id TEXT REFERENCES task (id) ON DELETE SET NULL,
  -- The group it came from: what a group workspace lists.
  group_id TEXT REFERENCES chat_group (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX artifact_group ON artifact (group_id, updated_at);
CREATE INDEX artifact_task ON artifact (task_id);

CREATE TABLE artifact_version (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifact (id) ON DELETE CASCADE,
  -- Per artifact, from 1. A published version never changes.
  number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  -- Why it failed, when it did; the objects are gone by then.
  error TEXT,
  files INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (artifact_id, number)
);

CREATE INDEX artifact_version_artifact ON artifact_version (artifact_id, number);

-- A public share: a token bound to one version. Revoking is forever (the row keeps the record),
-- and sharing again mints a new token rather than un-revoking this one.
CREATE TABLE artifact_share (
  token TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES artifact_version (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX artifact_share_version ON artifact_share (version_id);
