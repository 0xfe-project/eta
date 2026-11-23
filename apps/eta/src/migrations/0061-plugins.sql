-- The plugin tables, in one migration. They were first seven migrations (0061 to 0067);
-- a database that already ran the first six runs this once more, so each table is made only where it
-- is missing: it adds cursor_credential and leaves the rest as it is. (A table of the same name with
-- another shape would pass unnoticed; none is known to exist.)

-- A plugin the user switched off for every agent. Nothing here means it is on, so the plugins that
-- exist already stay on. The agents' own choices (agent_plugin) are not touched by this.
CREATE TABLE IF NOT EXISTS plugin_disabled (
  plugin TEXT PRIMARY KEY
);

-- Request headers the user attached to a plugin's remote MCP server (authentication that the plugin
-- file does not declare). Per plugin and per server; the value is sealed like every other secret.
-- A header's name is unique per server whatever its case. `plain_ok` is the user's confirmation to
-- send it over plain http to a host that is not this machine.
CREATE TABLE IF NOT EXISTS plugin_header (
  plugin TEXT NOT NULL,
  server TEXT NOT NULL,
  name_lc TEXT NOT NULL,
  name TEXT NOT NULL,
  sealed BLOB NOT NULL,
  secret INTEGER NOT NULL,
  plain_ok INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin, server, name_lc)
);

-- Environment variables the user set on a plugin's stdio MCP server (values the plugin file does not
-- carry). Per plugin and per server; the value is sealed like every other secret. A name is unique per
-- server. `secret` says the value is never sent back to the page.
CREATE TABLE IF NOT EXISTS plugin_env (
  plugin TEXT NOT NULL,
  server TEXT NOT NULL,
  name TEXT NOT NULL,
  sealed BLOB NOT NULL,
  secret INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin, server, name)
);

-- The market's catalogs, kept so opening the market does not wait for the network. One row per
-- catalog address (the address as the user wrote it, before any proxy). The body is the document as
-- it came, JSON text; it is untrusted and checked again every time it is read. `etag` and
-- `last_modified` are what the server said, sent back to ask "has it changed".
CREATE TABLE IF NOT EXISTS market_catalog_cache (
  url TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  fetched_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL,
  size INTEGER NOT NULL
);

-- Market logos read from a plugin's repository, kept so they are not fetched again after a restart.
-- The key is the repository, the ref and the path as the catalog gave them. `status` is 'hit' (a
-- picture) or 'miss' (the repository confirmed there is none); a failed read is never stored. The
-- bytes are untrusted: they are checked again each time they are read.
CREATE TABLE IF NOT EXISTS plugin_icon (
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

-- A plugin's remote MCP server may be told to carry its sign-in access token in a request header of
-- its own choosing (the header name and whether the value is the token as it is or "Bearer <token>").
-- Only the choice is stored: the token itself is read from the sign-in store on every request.
CREATE TABLE IF NOT EXISTS plugin_token_header (
  plugin TEXT NOT NULL,
  server TEXT NOT NULL,
  name TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('raw', 'bearer')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin, server)
);

-- The Cursor credential (x-cursor-auth), saved once for the host: a Cursor sign-in serves every
-- server on cursor.com. One row, sealed like every other secret. A header the user saved on one
-- server (plugin_header) is still that server's own and comes first.
CREATE TABLE IF NOT EXISTS cursor_credential (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sealed BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
