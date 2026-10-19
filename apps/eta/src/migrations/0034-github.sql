-- The GitHub App agents act as. At most one App (`id = 1`), created from a manifest and installed
-- by the user; the user who authorized it (`github_user`, also one row); the logins in flight
-- (`github_pending`); and the pull requests agents opened for tasks (`task_pull`).
--
-- Secrets are sealed (AES-256-GCM under the host's `secret.key`): the App's private key, its
-- client secret, and the user's token and refresh token. The rest is what GitHub shows anyone.
CREATE TABLE github_app (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  app_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  html_url TEXT NOT NULL,
  owner TEXT NOT NULL,
  -- 'User' or 'Organization'.
  owner_type TEXT NOT NULL,
  -- The App's bot user, for commits; 0 until GitHub has told us.
  bot_id INTEGER NOT NULL DEFAULT 0,
  client_id TEXT,
  private_key BLOB NOT NULL,
  client_secret BLOB,
  created_at INTEGER NOT NULL
);

CREATE TABLE github_user (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  login TEXT NOT NULL,
  github_id INTEGER NOT NULL,
  -- JSON of { accessToken, expiresAt, refreshToken, refreshExpiresAt }, sealed.
  token BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A manifest waiting for GitHub to send the browser back (`kind = 'manifest'`), or an
-- authorization waiting for the same (`kind = 'authorization'`, with its PKCE verifier and the
-- redirect it named). The state is the only thing that makes a callback ours.
CREATE TABLE github_pending (
  state TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('manifest', 'authorization')),
  verifier TEXT,
  redirect_uri TEXT,
  created_at INTEGER NOT NULL
);

-- Pull requests a task delivered. Kept beside the task, not in it: the task board does not know
-- about GitHub, and a deleted task takes its pull requests' links with it.
CREATE TABLE task_pull (
  task_id TEXT NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  number INTEGER NOT NULL,
  opened_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, url)
);
