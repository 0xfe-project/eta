// What this host serves today (the single-process build).
//
// A section whose API is not on this host yet is hidden rather than shown broken: a button that
// answers 404 is a bug the user found, not a feature waiting. Each flag names the phase that turns
// it back on, so removing one is deleting a line next to a reason.
//
// The chat, inbox, tasks, routines, artifacts, agents, archived groups and the provider settings
// are all on this host; nothing here is about them. Memory is not a flag: the host mounts it only
// when it has a memory sidecar (queries/memory.ts).
export const capabilities = {
  // P3.6: the bundle/plugin manager (/api/v1/bundles beyond an empty list).
  bundles: false,
  // P4.4: forge — the GitHub connection wizard (/api/forge/v1). Grok is P1.1, also not here.
  connections: false,
} as const;
