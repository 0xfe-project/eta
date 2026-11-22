-- Environment variables the user set on a plugin's stdio MCP server (values the plugin file does not
-- carry). Per plugin and per server; the value is sealed like every other secret. A name is unique per
-- server. `secret` says the value is never sent back to the page.
CREATE TABLE plugin_env (
  plugin TEXT NOT NULL,
  server TEXT NOT NULL,
  name TEXT NOT NULL,
  sealed BLOB NOT NULL,
  secret INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin, server, name)
);
