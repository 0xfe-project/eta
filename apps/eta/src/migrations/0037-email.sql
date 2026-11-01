-- Mail accounts, threads and messages are independent of agents. A normal session is
-- linked to a thread only when the user explicitly hands the thread to an agent.
CREATE TABLE email_account (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_secure INTEGER NOT NULL,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL,
  imap_secure INTEGER NOT NULL DEFAULT 0,
  inbox_folder TEXT NOT NULL DEFAULT 'INBOX',
  junk_folder TEXT,
  poll_interval_seconds INTEGER NOT NULL DEFAULT 60,
  username TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'ready', 'error')),
  last_error TEXT,
  last_checked_at INTEGER,
  last_poll_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE email_thread (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES email_account (id) ON DELETE CASCADE,
  peer TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'assigned', 'archived')),
  unread INTEGER NOT NULL DEFAULT 1,
  root_message_id TEXT,
  latest_message_id TEXT,
  last_message_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX email_thread_account ON email_thread (account_id, last_message_at DESC);
CREATE INDEX email_thread_root ON email_thread (root_message_id);

CREATE TABLE email_message (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES email_thread (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES email_account (id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  status TEXT NOT NULL CHECK (status IN ('received', 'draft', 'sending', 'accepted', 'failed')),
  remote_key TEXT,
  folder TEXT,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL DEFAULT '',
  html_body TEXT NOT NULL DEFAULT '',
  rfc_message_id TEXT,
  in_reply_to TEXT,
  references_json TEXT NOT NULL DEFAULT '[]',
  eta_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX email_message_remote ON email_message (account_id, remote_key) WHERE remote_key IS NOT NULL;
CREATE UNIQUE INDEX email_message_rfc ON email_message (account_id, direction, rfc_message_id) WHERE rfc_message_id IS NOT NULL;
CREATE INDEX email_message_thread ON email_message (thread_id, created_at);

CREATE TABLE email_cursor (
  account_id TEXT NOT NULL REFERENCES email_account (id) ON DELETE CASCADE,
  folder TEXT NOT NULL,
  uid_validity TEXT,
  uid INTEGER,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, folder)
);

CREATE TABLE session_email (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES email_thread (id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, thread_id)
);
CREATE INDEX session_email_thread ON session_email (thread_id);

CREATE TABLE email_proposal (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES email_account (id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES email_thread (id) ON DELETE SET NULL,
  reply_to_message_id TEXT REFERENCES email_message (id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('new', 'reply')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'accepted', 'failed', 'discarded')),
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  cc_address TEXT NOT NULL DEFAULT '',
  bcc_address TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  markdown TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX email_proposal_session ON email_proposal (session_id, created_at DESC);
CREATE INDEX email_proposal_status ON email_proposal (status, updated_at);
