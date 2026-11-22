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
  "setEnabled",
  "setHeaders",
  "setEnv",
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
  /** The names of the variables the plugin fixes on a stdio server: shown, not editable. Absent from an older host. */
  lockedEnv?: string[];
  /** The names of the headers the plugin sets itself or eta adds from the configuration; never values. */
  headers: string[];
  /** Plain http to a host that is not this machine: the user's headers go there only once confirmed. */
  plainHttp: boolean;
  /** Why it will not run, when it will not (`sse` is not supported by the runtimes). */
  problem: string | null;
  /** The server's sign-in: stored (`signed_in`), or asked for by the server (`needs_login`); `expired`: a token is stored but the server refused it. Absent from an older host. */
  login?: "none" | "needs_login" | "signed_in" | "expired";
}

/** Which commands a machine is missing, of the ones the plugin says it needs. */
export interface PluginMachineView {
  machineId: string;
  name: string;
  missing: string[];
  /** False when the machine is offline and so was not looked at. */
  checked: boolean;
}

/**
 * A request header the user attached to one of the plugin's remote servers. A secret's value is
 * never sent: it says only that it is set, and a new value replaces it.
 */
export interface PluginHeaderView {
  server: string;
  name: string;
  secret: boolean;
  /** The value, for a header that is not a secret; null for a secret. */
  value: string | null;
  /** The user confirmed sending it over plain http to a host that is not this machine. */
  plainOk: boolean;
  /** Why it is not sent now, when it is not. */
  blocked: "plain-http" | null;
}

/** An environment variable the user set on a stdio server. A secret's value is never sent. */
export interface PluginEnvView {
  server: string;
  name: string;
  secret: boolean;
  /** The value, for a variable that is not a secret; null for a secret. */
  value: string | null;
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
  /** The user's switch for every agent. Off: no agent gets its skills or servers, whatever each enabled. */
  enabled: boolean;
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
  /** The headers the user attached to its remote servers. */
  headers: PluginHeaderView[];
  /** The variables the user set on its stdio servers. Absent from an older host. */
  env?: PluginEnvView[];
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
  /**
   * Replace the headers of one remote server: what is not listed is removed. A `value` of null keeps
   * the saved one (a secret is never read back), so it is allowed only for a header that is saved.
   */
  setHeaders: {
    name: string;
    server: string;
    headers: {
      name: string;
      value: string | null;
      secret: boolean;
      plainOk?: boolean;
    }[];
  };
  /** Replace the variables of one stdio server; a `value` of null keeps the saved one. */
  setEnv: {
    name: string;
    server: string;
    env: { name: string; value: string | null; secret: boolean }[];
  };
  /** Switch an installed plugin on or off for every agent; each agent's own choice is kept. */
  setEnabled: { name: string; enabled: boolean };
  /** Add a plugin from a git repository; `rev` is a branch, a tag or a commit. */
  add: { repo: string; rev?: string; path?: string };
  /** Fetch a git source again, resolving its `rev` anew. Without a name, every one. */
  update: { name?: string };
  /** Forget a git source (a local one is a directory the user keeps). */
  remove: { name: string };
  /** Read the plugins again and look at the machines for the commands they require. */
  recheck: Record<string, never>;
  /**
   * Connect to one server once, list what it offers (tools, and the counts of resources and
   * prompts), and close. Lists only: no tool is ever called. Runs on this click, never by itself.
   */
  testServer: { name: string; server: string };
  /** Start a sign-in for one remote server; the browser returns to the host's callback. */
  loginServer: { name: string; server: string; redirectOrigin?: string };
  /** Forget a server's sign-in. */
  logoutServer: { name: string; server: string };
  /** A plugin's logo as the host finds it: its own address, else the icon of its homepage. */
  logo: {
    own?: string | null;
    homepage?: string | null;
    plugin?: string | null;
    /** A market entry in a GitHub repository: its own logo is read from its manifest there (repo, ref, path). */
    repo?: string | null;
    ref?: string | null;
    path?: string | null;
  };
}

/** What a connection test found. Secrets are never in it. */
export interface PluginTestResult {
  status: "ok" | "failed" | "needs_setup" | "needs_login" | "off";
  /** Why, in words; empty when ok. */
  message: string;
  /** Milliseconds from start to the last answer. */
  ms: number;
  /** From the server's initialize answer. */
  serverName: string | null;
  serverVersion: string | null;
  tools: { name: string; description: string; params: string[] }[];
  /** How many tools the server listed, when more than are shown. */
  toolCount: number;
  /** Null when the server does not offer them. */
  resourceCount: number | null;
  promptCount: number | null;
}

/** A logo the host found: the picture, base64, and its type; null when there is none. */
export type PluginLogoResult = { type: string; data: string } | null;
export interface PluginResults {
  /** `issues` is what still keeps it from being enabled. */
  configure: { name: string; state: PluginState; issues: FieldIssue[] };
  setLevel: { name: string };
  setEnabled: { name: string; enabled: boolean };
  setHeaders: { name: string; server: string };
  setEnv: { name: string; server: string };
  testServer: PluginTestResult;
  loginServer: { pendingId: string; authorizationUrl: string };
  logoutServer: { name: string; server: string };
  add: { name: string };
  update: { names: string[] };
  remove: { name: string };
  recheck: Record<string, never>;
}

/**
 * The online market: a catalog (one JSON document at a URL the user can change) whose entries are
 * git sources pinned to a commit. Installing one is adding that git source, after the user was
 * shown what it would run. The catalog is not trusted: every field here was checked by the host.
 */
export interface MarketEntry {
  name: string;
  description: string;
  author: string;
  version: string;
  repo: string;
  path: string;
  /**
   * The commit the catalog pins, 40 hex digits; never a branch or a tag. Null when the catalog pins
   * none: the host then resolves the repository's current commit when it is previewed, and installs
   * that very commit.
   */
  rev: string | null;
  homepage: string | null;
  /** Commands it says it needs; only a hint, and the preview says what the plugin itself says. */
  requires: string[];
  /** Whether a plugin of this name is installed already, and from where. */
  installed: "no" | "this" | "other";
  /** Why eta cannot install it (a source it does not read); null when it can. */
  unsupported: string | null;
  /** The source (its catalog address) it was listed by, and its display name. */
  source: string;
  sourceName: string;
}

/** An entry the host threw away, and why. */
export interface MarketRejected {
  /** Its place in the catalog, from 1. */
  index: number;
  name: string | null;
  reason: string;
}

/** A catalog the market reads. `name` is what the user calls it; `""` when nothing. */
export interface MarketSource {
  url: string;
  name: string;
  /** A source that is off stays in the list, but is not read and shows no entries. */
  enabled: boolean;
}

/** The sources and the GitHub proxy, as set. */
export interface MarketSettings {
  sources: MarketSource[];
  /** The prefix of a GitHub proxy, with one trailing slash; `""` when there is none. */
  proxy: string;
}

/** What one source gave, or why it gave nothing. One failing source does not touch the others. */
export interface MarketSourceCatalog {
  source: MarketSource;
  /** Null when the catalog could not be read; `error` says why. */
  entries: MarketEntry[] | null;
  rejected: MarketRejected[];
  error: string | null;
}

/** Every source's catalog. Installed plugins are never touched by any of them. */
export interface MarketCatalog {
  sources: MarketSourceCatalog[];
  proxy: string;
}

/** An MCP server as it would start: what the user must see before saying yes. */
export interface MarketServerView extends PluginServerView {
  /** Variables the plugin sets itself, as written in its `mcp.json`. */
  fixedEnv: Record<string, string>;
  cwd: string | null;
}

/** What installing an entry would put on the machine, read from the files at the pinned commit. */
export interface MarketPreview {
  name: string;
  version: string | null;
  description: string;
  repo: string;
  path: string;
  /** The commit that was read, and the one that will be installed. */
  sha: string;
  requires: string[];
  servers: MarketServerView[];
  skills: { name: string; description: string }[];
  /** The proxy this was read through, when the repository is on GitHub and a proxy is set. */
  proxy: string | null;
  /** What the loader found wrong and ignored. */
  reports: string[];
  /** The manifest path of a Claude Code or Cursor layout, null for a native plugin.json. Plain information. */
  layout: string | null;
  /** The values it will ask for after it is installed. */
  fields: { name: string; secret: boolean; required: boolean }[];
}
