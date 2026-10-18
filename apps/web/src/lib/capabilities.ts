// What this host serves today (the single-process build).
//
// A section whose API is not on this host yet is hidden rather than shown broken: a button that
// answers 404 is a bug the user found, not a feature waiting. Each flag names the phase that turns
// it back on, so removing one is deleting a line next to a reason.
//
// The chat, inbox, tasks, routines, artifacts, agents, archived groups and the provider settings
// are all on this host; nothing here is about them.
export const capabilities = {
  // P3.4 (em0 deferred): the memory bundle's service (/api/bundles/memory/v1).
  memory: false,
  // P3.6: the bundle/plugin manager (/api/v1/bundles beyond an empty list).
  bundles: false,
  // P4.4: forge — the GitHub connection wizard (/api/forge/v1). Grok is P1.1, also not here.
  connections: false,
  // P4: remote computers (/api/v1/computers).
  computers: false,
} as const;
