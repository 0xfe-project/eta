-- A plugin the user switched off for every agent. Nothing here means it is on, so the plugins that
-- exist already stay on. The agents' own choices (agent_plugin) are not touched by this.
CREATE TABLE plugin_disabled (
  plugin TEXT PRIMARY KEY
);
