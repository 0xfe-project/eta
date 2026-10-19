/**
 * The `bundles` target: environment bundles, as the settings page and the agent editor see them.
 *
 * A bundle is a directory that gives an agent a capability (skills, MCP servers, hook rules,
 * maybe a service). One section, `list`, says what exists, where each one came from, whether its
 * configuration is complete and, per machine, whether the commands it requires are there. A
 * secret is written and never read: a field that holds one is only ever reported as set or not.
 */

/** The actions this target has. One list, so the wire and the plugin cannot disagree. */
export const BUNDLE_ACTIONS = [
  "configure",
  "add",
  "remove",
  "refresh",
  "recheck",
] as const;
export type BundleAction = (typeof BUNDLE_ACTIONS)[number];

/** Where a bundle's files come from. */
export type BundleSource =
  | { kind: "builtin" }
  | { kind: "local" }
  | { kind: "git"; repo: string; rev: string; path: string };

/** One value a bundle asks the user for. */
export interface BundleField {
  /** The variable the value is given to the bundle's processes as. */
  name: string;
  title: string;
  /** Markdown. */
  description: string;
  /** A secret is never sent to a client: only `set` says that it has a value. */
  secret: boolean;
  required: boolean;
  maxLength: number;
  set: boolean;
  /** The value, for a field that is not a secret. */
  value: string | null;
}

/** Whether a machine has what the bundle `requires`. */
export interface BundleMachineStatus {
  machineId: string;
  name: string;
  /** False when a required command is missing, or the machine cannot be asked right now. */
  ready: boolean;
  /** The required commands that are not on the machine's PATH. */
  missing: string[];
  /** False when the machine is offline and so was not checked. */
  checked: boolean;
}

export type BundleServiceState = "stopped" | "starting" | "ready" | "error";

export interface BundleView {
  name: string;
  description: string;
  source: BundleSource;
  /** The commit a git source is at; null for the others. */
  sha: string | null;
  /** The commands it needs on a machine. */
  requires: string[];
  skills: string[];
  mcpServers: string[];
  /** Whether it brings hook rules. */
  hooks: boolean;
  fields: BundleField[];
  /** Every required field has a value. */
  configured: boolean;
  service: { state: BundleServiceState; message: string | null } | null;
  machines: BundleMachineStatus[];
  /** Why the bundle cannot be used (a manifest that does not parse), when it cannot. */
  problem: string | null;
}

export interface BundlesSections {
  list: BundleView[];
}

export interface BundleArgs {
  /** `null` clears a value; a field that is not named stays as it is. */
  configure: { name: string; values: Record<string, string | null> };
  /** Add a bundle from a git repository; `rev` is a branch, a tag or a commit. */
  add: { repo: string; rev?: string; path?: string };
  /** Forget a git source (the other sources are directories the user keeps). */
  remove: { name: string };
  /** Fetch git sources again: resolve their `rev` anew. Without a name, every one. */
  refresh: { name?: string };
  /** Look at the machines again for the commands bundles require. */
  recheck: Record<string, never>;
}
export interface BundleResults {
  configure: { name: string };
  add: { name: string };
  remove: { name: string };
  refresh: { names: string[] };
  recheck: Record<string, never>;
}
