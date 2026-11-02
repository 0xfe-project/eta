-- What answers for an agent: eta's own loop, or an external agent runtime on the machine (Claude
-- Code, Codex, OpenCode, Pi) that its sessions delegate their runs to. `eta` is every agent before
-- this. For an external runtime, `model` is `runtime:modelId` in that runtime's own names (NULL is
-- the runtime's default), and a session keeps the runtime it was made with: an agent moved to
-- another runtime gets new sessions rather than a conversation two runtimes would share.
ALTER TABLE agent ADD COLUMN runtime TEXT NOT NULL DEFAULT 'eta';
