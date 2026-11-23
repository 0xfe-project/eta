-- The Cursor credential (x-cursor-auth), saved once for the host: a Cursor sign-in serves every
-- server on cursor.com. One row, sealed like every other secret. A header the user saved on one
-- server (plugin_header) is still that server's own and comes first.
CREATE TABLE cursor_credential (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sealed BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
