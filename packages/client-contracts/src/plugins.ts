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
  "setTokenHeader",
  "cursorLoginStart",
  "cursorLoginStatus",
  "cursorLoginCancel",
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
  /** The server is one the host can sign in to with a Cursor account (cursor.com, https). Absent from an older host. */
  cursorServer?: boolean;
  /** A Cursor credential is saved for it (the header `CURSOR_AUTH_HEADER`); not whether the server accepts it. */
  cursorSignedIn?: boolean;
}

/** The request header a Cursor-hosted server reads the user's Cursor credential from. */
export const CURSOR_AUTH_HEADER = "x-cursor-auth";

/** Whether a server's address is Cursor's own: only then is a Cursor credential ever sent to it. */
export function isCursorServer(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "cursor.com" ||
        parsed.hostname.endsWith(".cursor.com"))
    );
  } catch {
    return false;
  }
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
  /** The servers told to send their sign-in token in a header. Absent from an older host. */
  tokenHeaders?: { server: string; name: string; format: "raw" | "bearer" }[];
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
  /** The connected toolkits, what `composioPlugins` answers, kept current. Absent from an older host. */
  toolkits?: PluginToolkitView[];
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
  /**
   * Send one remote server's sign-in token in a request header of the given name (`raw`: the token,
   * `bearer`: "Bearer <token>"); `header: null` turns it off. The token is never stored here.
   */
  setTokenHeader: {
    name: string;
    server: string;
    header: { name: string; format: "raw" | "bearer" } | null;
  };
  /**
   * Sign in to a Cursor account for one server of `cursor.com` (UNOFFICIAL, may stop working):
   * returns the page to open in the browser; the host waits (at most 120 s) and, once the user
   * confirmed, saves the credential as the secret header `header` (default `x-cursor-auth`) of
   * that server. Only on this click; one at a time; the credential is never returned.
   */
  cursorLoginStart: { name: string; server: string; header?: string };
  /** How a started Cursor sign-in stands. */
  cursorLoginStatus: { id: string };
  /** Stop waiting for the browser. */
  cursorLoginCancel: { id: string };
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
    /** A Composio toolkit's slug: the host looks up the logo address in its own list, and fetches it over https only. */
    composio?: string | null;
  };
  /** Keep the Composio API key, sealed. It is never sent back: `composioStatus` only says that one is set. */
  composioSetKey: { key: string };
  composioClearKey: Record<string, never>;
  composioStatus: Record<string, never>;
  /** Which toolkits are connected with Composio (read only). */
  composioConnected: Record<string, never>;
  /** The name and description of these toolkits, from the list the host keeps (read only, no request). */
  composioToolkits: { slugs: string[] };
  /** Start connecting one toolkit with Composio's own sign-in page; the user finishes it in the browser. */
  composioLink: { slug: string };
  /** Delete this host's accounts of one toolkit on Composio; it cannot be undone there. */
  composioDisconnect: { slug: string };
  /** Add a toolkit that needs no sign-in: it becomes a plugin, and Composio's sign-in is not asked for. */
  composioAdd: { slug: string };
  /** Take an added toolkit away again. Nothing is asked of Composio. */
  composioRemove: { slug: string };
  /** Which toolkits were added (read only). */
  composioAdded: Record<string, never>;
  /** The connected toolkits as plugins of their own (read only). */
  composioPlugins: Record<string, never>;
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
  /** What the server listed, as the tools are. Absent from an older host. */
  resources?: { name: string; description: string; params: string[] }[];
  prompts?: { name: string; description: string; params: string[] }[];
  /** The request header the server said it needs, when its refusal named one (not an OAuth token). */
  requiredHeader?: string;
  /** True when the server is one the host can sign in to with a Cursor account (cursor.com, https). */
  cursorServer?: boolean;
}

/**
 * What the host has kept for market entries, asked for many at once. Only memory and the database are
 * read: nothing is fetched, so it answers at once. The answer has one item per entry asked, in order;
 * at most PLUGIN_LOGOS_CACHED_MAX entries are looked at (the rest are "unknown"), and hits past about
 * 2 MB of picture data are "unknown" too. Asked of a host without it, the call fails: treat all as unknown.
 * An entry is a plugin in a repository, or `{ composio: slug }`, a Composio toolkit (the host finds
 * the logo address from its own list). A host that does not know the second form answers "unknown" for it.
 */
export interface PluginLogosCachedArgs {
  entries: (
    | {
        repo: string;
        ref: string;
        path: string;
        homepage?: string | null;
      }
    | { composio: string }
  )[];
}
export const PLUGIN_LOGOS_CACHED_MAX = 200;
export type PluginLogoCached =
  | { status: "hit"; type: string; data: string }
  /** Known: no picture (a letter is right). */
  | { status: "miss" }
  /** Not known: ask `logo` for it. */
  | { status: "unknown" };
export interface PluginLogosCachedResult {
  logos: PluginLogoCached[];
}

/** A logo the host found: the picture, base64, and its type; null when there is none. */
export type PluginLogoResult = { type: string; data: string } | null;
export interface PluginResults {
  /** `issues` is what still keeps it from being enabled. */
  configure: { name: string; state: PluginState; issues: FieldIssue[] };
  setLevel: { name: string };
  setEnabled: { name: string; enabled: boolean };
  setHeaders: { name: string; server: string };
  setTokenHeader: { name: string; server: string };
  cursorLoginStart: { id: string; url: string; timeoutSeconds: number };
  cursorLoginStatus: {
    state: "waiting" | "done" | "failed" | "cancelled" | "expired";
    /** Why, in words; never the credential. */
    reason?: string;
    /** Seconds the credential claims to be valid (read from it, not verified); when done. */
    validForSeconds?: number;
  };
  cursorLoginCancel: { id: string };
  setEnv: { name: string; server: string };
  testServer: PluginTestResult;
  loginServer: { pendingId: string; authorizationUrl: string };
  logoutServer: { name: string; server: string };
  add: { name: string };
  update: { names: string[] };
  remove: { name: string };
  recheck: Record<string, never>;
  composioSetKey: { hasKey: boolean };
  composioClearKey: { hasKey: boolean };
  /** `enabled`: a key is set and the source is not switched off. */
  composioStatus: { hasKey: boolean; enabled: boolean };
  /**
   * The slugs of the toolkits with an ACTIVE account. Only a mark: a status other than `ready`
   * (no key, key refused, no answer) means none is known, not that none is connected.
   */
  composioConnected: { status: ComposioStatus; slugs: string[] };
  /** Only the slugs the kept list has; none when there is no key. */
  composioToolkits: {
    toolkits: { slug: string; name: string; description: string }[];
  };
  /** An https address on Composio's side; open it in the browser. */
  composioLink: { redirectUrl: string };
  /** Only a status; `removed` counts the accounts deleted. */
  composioDisconnect: { status: ComposioStatus; removed: number };
  composioAdd: { status: ComposioStatus };
  composioRemove: { removed: boolean };
  composioAdded: { slugs: string[] };
  composioPlugins: { plugins: ComposioPluginView[] };
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
  /** `composio`: the Composio toolkit list (built in, can be switched off, not removed). Absent: a git catalog. */
  kind?: "git" | "composio";
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
  /** When the host last had this catalog confirmed by its server (ms); absent or null when nothing is kept. */
  updatedAt?: number | null;
  /** Set when what is shown is a kept copy because reading again failed: why. */
  stale?: string | null;
  /**
   * Only for `source.kind === "composio"`: the toolkits are in `toolkits` (null when none is known yet);
   * `entries` is empty, or null when there is no answer.
   * `needs_key` and `key_rejected` are answers, not failures: `error` stays null.
   */
  status?: ComposioStatus;
  toolkits?: ComposioToolkit[] | null;
}

export type ComposioStatus = "ready" | "needs_key" | "key_rejected" | "error";

/**
 * A connected Composio toolkit as a plugin: `@composio/<slug>`. It is not a `PluginView` (it has no
 * files, skills or fields). `ready`: its session checked out and agents may use it; `error`: it did
 * not, and nothing is offered. `enabled` is the user's switch for every agent, as for any plugin.
 */
export interface ComposioPluginView {
  name: string;
  slug: string;
  state: "ready" | "error";
  enabled: boolean;
}

/**
 * An entry of the `toolkits` section of the `plugins` target: a toolkit and the provider it comes
 * from. The only provider is `composio`; a client leaves out the entries of one it does not know.
 */
export interface PluginToolkitView extends ComposioPluginView {
  provider: string;
}

/** How a toolkit signs in, from the schemes Composio lists: `unknown` for one eta does not know. */
export type ComposioAuth = "api_key" | "oauth" | "none" | "unknown";

/**
 * A Composio toolkit. Installing it is not `marketInstall`: no git source is added. The user
 * connects it with `composioLink`.
 */
export interface ComposioToolkit {
  kind: "composio";
  slug: string;
  name: string;
  description: string;
  auth: ComposioAuth;
  /** The schemes as Composio names them, for display. */
  authSchemes: string[];
  /** Whether Composio offers its own sign-in for it (no OAuth app of the user's own is needed). */
  managed: boolean;
  categories: string[];
  /** An https address, or null; the picture is fetched by the host (`logo` with `composio`). */
  logo: string | null;
  appUrl: string | null;
  toolsCount: number | null;
  /** The source's address and its display name, as on a git entry. */
  source: string;
  sourceName: string;
}

/**
 * The text a link starts with when it failed because Composio has no managed sign-in for the
 * toolkit and the project has no auth config of its own for it. The client shows its own sentence
 * in place of the host's.
 */
export const COMPOSIO_NO_MANAGED_LOGIN = "composio_no_managed_login";

/** Where a user makes an auth config of their own on Composio (its documentation names this address). */
export const COMPOSIO_AUTH_CONFIGS_URL =
  "https://dashboard.composio.dev/~/project/auth-configs";

/**
 * The scheme of an auth config that can be made for a toolkit Composio has no sign-in of its own
 * for, with no credentials from eta: a key the user types on Composio's page, or dynamic client
 * registration, which needs none. A key comes first. Undefined for a toolkit that has a managed
 * sign-in, and for one whose schemes need an OAuth app of the user's own (or are not known): a
 * config for those is not made here.
 */
export function composioOwnScheme(
  toolkit: Pick<ComposioToolkit, "managed" | "authSchemes">,
): "API_KEY" | "BEARER_TOKEN" | "DCR_OAUTH" | undefined {
  if (toolkit.managed) return undefined;
  return (["API_KEY", "BEARER_TOKEN", "DCR_OAUTH"] as const).find((scheme) =>
    toolkit.authSchemes.includes(scheme),
  );
}

/** Whether connecting a toolkit needs an auth config the user made on Composio: nothing here can make one. */
export function composioNeedsOwnConfig(
  toolkit: Pick<ComposioToolkit, "managed" | "auth" | "authSchemes">,
): boolean {
  return (
    !toolkit.managed &&
    toolkit.auth !== "none" &&
    composioOwnScheme(toolkit) === undefined
  );
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
