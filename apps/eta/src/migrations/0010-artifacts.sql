-- Artifacts: static sites an agent published, their versions, and their public shares. The rows
-- say what exists; the bytes are files under `<dataDir>/artifacts/<artifact>/<version>/`
-- (`archive.zip`, and the extracted site under `files/`). A version row is written only after its
-- files are there, so a row always has its bytes and a directory without a row is a crash's
-- leftover that the next publish of that number replaces.
CREATE TABLE artifact (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  -- The agent that published it. Only it may add a version. No foreign key: the artifact stays
  -- when the agent goes, and nobody can add to it then.
  publisher_agent TEXT,
  -- What it was published for and where it came from.
  task_id TEXT REFERENCES task (id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversation (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX artifact_task ON artifact (task_id);

CREATE TABLE artifact_version (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifact (id) ON DELETE CASCADE,
  -- From 1, per artifact. A published version never changes.
  number INTEGER NOT NULL,
  files INTEGER NOT NULL,
  -- The extracted files' total size, and the ZIP's.
  bytes INTEGER NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (artifact_id, number)
);

-- A public share: a token bound to one version. Revoking is for good (the row keeps the record),
-- and sharing again makes a new token instead of reviving this one.
CREATE TABLE artifact_share (
  token TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES artifact_version (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX artifact_share_version ON artifact_share (version_id);
-- A version is shared at most once at a time.
CREATE UNIQUE INDEX artifact_share_live ON artifact_share (version_id) WHERE revoked_at IS NULL;
