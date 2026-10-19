-- Credentials of outside integrations, sealed. Today that is the OAuth state of MCP servers
-- (`integration = 'mcp'`: tokens, the registered client, the discovery state, a login's PKCE
-- verifier), modelled on opencode's `credential` table.
--
-- `key` names what the credential is for (for MCP: a hash of the server's URL, so one sign-in
-- serves every agent) and `kind` which piece it is. `value` is the JSON of the piece, sealed:
-- AES-256-GCM under the host's key (`secret.key` in the data directory), so a copy of the
-- database alone reads nothing.
CREATE TABLE credential (
  id TEXT PRIMARY KEY,
  integration TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  value BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (integration, key, kind)
);
