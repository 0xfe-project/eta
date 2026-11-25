// What the pick-several agent lists share, apart from the row component (fast refresh wants a
// component file to export components only).

/** With more agents than this, a list of them to pick from gets a search. */
export const AGENT_SEARCH_FROM = 8;

const RUNTIME_NAMES: Partial<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  qwen: "Qwen Code",
  pi: "Pi",
};

/** A runtime's name as a row shows it; an `acp.<id>` the row has no label for is shown as its id. */
export function runtimeName(runtime: string): string {
  return RUNTIME_NAMES[runtime] ?? runtime;
}
