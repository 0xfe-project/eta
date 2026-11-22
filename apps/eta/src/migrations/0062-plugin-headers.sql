-- Request headers the user attached to a plugin's remote MCP server (authentication that the plugin
-- file does not declare). Per plugin and per server; the value is sealed like every other secret.
-- A header's name is unique per server whatever its case. `plain_ok` is the user's confirmation to
-- send it over plain http to a host that is not this machine.
CREATE TABLE plugin_header (
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
