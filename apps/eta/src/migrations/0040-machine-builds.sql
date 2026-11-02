-- What a daemon said about its build when it last came up: the version (equal to the build the
-- primary carries when it is current), the platform it was built for (`linux-x64`), how it was
-- started (`service` is the one that can replace itself) and the link protocol it speaks. NULL
-- until a daemon reports them; the primary has none of them.
ALTER TABLE machine ADD COLUMN version TEXT;
ALTER TABLE machine ADD COLUMN platform TEXT;
ALTER TABLE machine ADD COLUMN install TEXT;
ALTER TABLE machine ADD COLUMN protocol INTEGER;
-- Why the last attempt to bring the daemon up to date failed; cleared when it is current.
ALTER TABLE machine ADD COLUMN update_error TEXT;
-- The Tailscale node the machine is, when it came in over the tailnet (its stable node id): how a
-- discovered peer is matched to a machine that is already here.
ALTER TABLE machine ADD COLUMN tailnet_node TEXT;

-- The machine an agent runs on, when it is pinned to one: its sessions are made there whatever
-- machine the conversation's or task's project is on, and an external runtime is that machine's.
-- NULL is every agent before this: its sessions follow the project.
ALTER TABLE agent ADD COLUMN machine_id TEXT REFERENCES machine (id) ON DELETE SET NULL;

-- The machine a participant's session was made on. NULL is every session before this, which was
-- made on the machine of the conversation's project, and still is unless the agent is pinned.
ALTER TABLE participant ADD COLUMN machine_id TEXT REFERENCES machine (id) ON DELETE SET NULL;
