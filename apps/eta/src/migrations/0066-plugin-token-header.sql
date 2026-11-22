-- A plugin's remote MCP server may be told to carry its sign-in access token in a request header of
-- its own choosing (the header name and whether the value is the token as it is or "Bearer <token>").
-- Only the choice is stored: the token itself is read from the sign-in store on every request.
CREATE TABLE plugin_token_header (
  plugin TEXT NOT NULL,
  server TEXT NOT NULL,
  name TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('raw', 'bearer')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin, server)
);
