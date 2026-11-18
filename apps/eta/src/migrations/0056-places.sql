-- Places: what each machine's directories were used for lately, kept on the host so the web, the
-- phone and the terminal share them (they each kept their own before: the browser's localStorage,
-- the phone's storage, nothing in the terminal). A path is the machine's own text, as
-- `@eta/places` normalized it on that machine.
CREATE TABLE place_recent (
  machine_id TEXT NOT NULL REFERENCES machine (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (machine_id, path)
);
CREATE INDEX place_recent_used ON place_recent (machine_id, used_at);

-- Where the last clone on a machine went: the next one is offered the same parent.
CREATE TABLE place_clone_parent (
  machine_id TEXT PRIMARY KEY REFERENCES machine (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
