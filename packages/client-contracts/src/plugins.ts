import type {
  FieldIssue,
  PluginAgentLevel,
  PluginField,
  PluginValue,
} from "./plugin-fields";

/**
 * The `plugins` target: Agent Plugins, as the settings page and the agent editor see them.
 *
 * A plugin is a directory with a `plugin.json` that gives an agent skills and MCP servers, and may
 * ask the user for values. `list` says what exists, where each came from, what it runs and whether
 * it can be enabled; `audit` says when an agent read a secret. A secret is written and never read
 * back: its field only ever says that it is set.
 */

/** The actions this target has. One list, so the wire and the plugin cannot disagree. */
export const PLUGIN_ACTIONS = [
  "configure",
  "setLevel",
  "add",
  "update",
  "remove",
  "recheck",
] as const;
export type PluginAction = (typeof PLUGIN_ACTIONS)[number];

/** Where a plugin's files come from. */
export type PluginSource =
  | { kind: "local"; path: string }
  /** `sha` is the commit `rev` was resolved to: it stays until the user asks to update. */
  | { kind: "git"; repo: string; rev: string; path: string; sha: string };

/**
 * `needs_config`: a required value is missing, or a value no longer fits. Its agents run without
 * it until it is fixed. `ready`: it can be enabled.
 */
export type PluginState = "needs_config" | "ready";

/** One value a plugin asks for, with what is saved. */
export type PluginFieldView = PluginField & {
  /** Whether it has a saved value. A secret's value is never sent: this is all that is known. */
  set: boolean;
  /** The saved value, for a field that is not a secret; null when there is none. */
  value: PluginValue | null;
  /** The level in force. */
  level: PluginAgentLevel;
  /** The levels the user can choose from. */
  levels: PluginAgentLevel[];
  /** Why the value in force does not fit, when it does not. */
  issue: FieldIssue | null;
};

/** One MCP server of a plugin, as the user is shown before enabling it. */
export interface PluginServerView {
  name: string;
  transport: "stdio" | "streamable-http" | "sse";
  /** What it runs: the command and its arguments, as written in `mcp.json`. */
  command?: string[];
  /** Where it connects. */
  url?: string;
  /** The environment variables eta sets from the configuration. */
  env: string[];
  /** The headers eta adds from the configuration. */
  headers: string[];
  /** Why it will not run, when it will not (`sse` is not supported by the runtimes). */
  problem: string | null;
}

/** Which commands a machine is missing, of the ones the plugin says it needs. */
export interface PluginMachineView {
  machineId: string;
  name: string;
  missing: string[];
  /** False when the machine is offline and so was not looked at. */
  checked: boolean;
}

export interface PluginAgentView {
  id: string;
  name: string;
}

export interface PluginView {
  name: string;
  /** Null for a plugin that could not be read, whose `name` is its directory's. */
  version: string | null;
  description: string;
  source: PluginSource;
  state: PluginState;
  /** Why the plugin cannot be used at all (a rejected manifest, a `config` that is invalid). */
  problem: string | null;
  /** What was found wrong and ignored: unknown fields, skipped skills and servers. */
  reports: string[];
  skills: { name: string; description: string }[];
  servers: PluginServerView[];
  requires: string[];
  machines: PluginMachineView[];
  fields: PluginFieldView[];
  /** The agents that have it enabled; they skip it while its state is `needs_config`. */
  agents: PluginAgentView[];
}

/** An agent read a secret. The value is not here, nor anywhere else that keeps a record. */
export interface PluginAuditView {
  id: number;
  at: number;
  sessionId: string;
  agentId: string | null;
  agentName: string | null;
  plugin: string;
  field: string;
  level: PluginAgentLevel;
}

export interface PluginsSections {
  list: PluginView[];
  audit: PluginAuditView[];
}

export interface PluginArgs {
  /** `null` clears a value; a field that is not named stays as it is. */
  configure: { name: string; values: Record<string, PluginValue | null> };
  /** Lower what agents may do with a field; `level` cannot be above what the manifest allows. */
  setLevel: { name: string; field: string; level: PluginAgentLevel };
  /** Add a plugin from a git repository; `rev` is a branch, a tag or a commit. */
  add: { repo: string; rev?: string; path?: string };
  /** Fetch a git source again, resolving its `rev` anew. Without a name, every one. */
  update: { name?: string };
  /** Forget a git source (a local one is a directory the user keeps). */
  remove: { name: string };
  /** Read the plugins again and look at the machines for the commands they require. */
  recheck: Record<string, never>;
}
export interface PluginResults {
  /** `issues` is what still keeps it from being enabled. */
  configure: { name: string; state: PluginState; issues: FieldIssue[] };
  setLevel: { name: string };
  add: { name: string };
  update: { names: string[] };
  remove: { name: string };
  recheck: Record<string, never>;
}
