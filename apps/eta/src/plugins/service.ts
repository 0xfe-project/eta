/**
 * Plugins, as the product uses them: a registry of what exists, rows of what the user decided, and
 * the answers to three questions every other part asks. What can an agent use? What does a session
 * get from that? What may it read?
 *
 * A plugin is usable while its configuration holds: nothing required is missing, and everything
 * saved still fits the fields of the version on disk. When an upgrade breaks that it goes back to
 * `needs_config`, and agents that have it enabled skip it; nothing runs on a configuration that no
 * longer fits. The stamp names the plugins an agent can use with their contents and when their
 * values were saved, so any of that changing reopens its sessions.
 */
import type {
  FieldIssue,
  OpenedPlugin,
  PluginAgentLevel,
  PluginEnvView,
  PluginField,
  PluginHeaderView,
  PluginServerView,
  PluginState,
  PluginTestResult,
  PluginValue,
  PluginView,
  Redaction,
  SessionMcpServer,
} from "@eta/client-contracts";
import type {
  CredentialRecord,
  McpConfigSource,
  McpServerEntry,
  RefreshStoredTokensOptions,
} from "@eta/mcp";
import type { RuntimeExtras, SessionMeta } from "@eta/server";
import type { Database } from "bun:sqlite";
import type { Buffer } from "node:buffer";
import type { AgentStore } from "../agents/store";
import type { MachineHub, MachineLink } from "../machines/hub";
import type { MachineStore } from "../machines/store";
import type { PluginEntry } from "./registry";
import type { UserHeader } from "./store";
import process from "node:process";
import {
  agentLevel,
  agentLevels,
  configIssues,
  effectiveValue,
  fieldIssue,
} from "@eta/client-contracts/plugin-fields";
import {
  claimServerNames,
  mcpServerKey,
  plainRemote,
  pluginChunks,
  pluginMcpSources,
  resolvePluginServers,
  runtimeExtras,
  serversConfig,
  toMcpEntries,
  withSessionServers,
} from "@eta/daemon";
import { createRefreshDedupingFetch, refreshStoredTokens } from "@eta/mcp";
import { CredentialRows } from "../mcp/credentials";
import { CURSOR_AUTH_HEADER, isCursorServer } from "./cursor-login";
import {
  envProblem,
  headerProblem,
  MAX_ENV_PER_SERVER,
  MAX_HEADERS_PER_SERVER,
} from "./headers";
import { PluginRegistry } from "./registry";
import { serverViews } from "./server-view";
import { PluginRows } from "./store";
import { notTested, secretsOf } from "./test-server";

export interface PluginsOptions {
  db: Database;
  dataDir: string;
  key: Buffer;
  agents: AgentStore;
  machines: MachineStore;
  hub: MachineHub;
  /** Say that what plugins are, or what agents make of them, moved. */
  changed: () => void;
  warn: (message: string) => void;
  /** What refreshes a sign-in, shared with the connections that use it (`McpService.refreshFetch`). */
  fetchFn?: RefreshStoredTokensOptions["fetchFn"];
}

/** A sign-in token this close to its end is refreshed before it is handed out. */
const EXPIRY_MARGIN_MS = 60_000;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Plugins that are not a directory on this host but are made by another part of it (a connected
 * Composio toolkit, `@composio/<slug>`). They are agents' choices and have the user's switch like any
 * plugin; they have no skills, fields or files, and are on the wire as their own list, not as a
 * `PluginView`.
 */
export interface VirtualPlugins {
  /** Whether the name is one of this kind, usable or not. */
  owns: (name: string) => boolean;
  /** Whether it can be used now. */
  has: (name: string) => boolean;
  /** The servers an agent of eta's own loop gets for its plugins of this kind, all at once. */
  mcpSource: (names: readonly string[]) => McpConfigSource | undefined;
  /** What the use of an agent's plugins of this kind is made of: another one reopens the sessions of the agent. */
  identity: (names: readonly string[]) => string | undefined;
  /** What the agents have enabled of this kind, one list of names for each agent: what is made ready for them. */
  demand: (sets: () => string[][]) => void;
  /** Make ready what the agents have enabled now (nothing when it already is). */
  refresh: () => void;
  /** What an agent is told of its plugins of this kind: slug, display name, and whether each is ready (null: not known). */
  toolkitsFor: (
    names: readonly string[],
  ) => { slug: string; name: string; ready: boolean | null }[];
  /** What no session may pass on. */
  secrets: () => Redaction[];
  onChange: (listener: () => void) => void;
}

/** A value of a field: what the caller sent, checked to be something a field can hold. */
function isValue(value: unknown): value is PluginValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

/** Read from the environment each time, so a command installed since is found. */
const has = (command: string): boolean =>
  Bun.which(command, { PATH: process.env.PATH ?? "" }) !== null;

export class Plugins {
  readonly rows: PluginRows;
  readonly registry: PluginRegistry;
  readonly #dataDir: string;
  readonly #agents: AgentStore;
  readonly #machines: MachineStore;
  readonly #hub: MachineHub;
  readonly #changed: () => void;
  readonly #warn: (message: string) => void;
  /** The MCP sign-ins: what an external runtime's remote servers are sent as their token. */
  readonly #signIns: CredentialRows;
  readonly #refreshFetch: RefreshStoredTokensOptions["fetchFn"];
  /** The sign-in tokens handed to external runtimes, by `plugin.server`: no session may read them. */
  readonly #handedOut = new Map<string, string>();
  /** What a daemon has, by machine, of the commands asked about. */
  readonly #found = new Map<string, Set<string>>();
  /** The sends in flight, by `machine:hash`. */
  readonly #sending = new Map<string, Promise<void>>();
  #virtual: VirtualPlugins | undefined;

  constructor(options: PluginsOptions) {
    this.rows = new PluginRows(options.db, options.key);
    this.registry = new PluginRegistry({
      dataDir: options.dataDir,
      rows: this.rows,
      changed: () => {
        options.changed();
        void this.recheck();
      },
      warn: options.warn,
    });
    this.#dataDir = options.dataDir;
    this.#agents = options.agents;
    this.#machines = options.machines;
    this.#hub = options.hub;
    this.#changed = options.changed;
    this.#warn = options.warn;
    this.#signIns = new CredentialRows(options.db, options.key);
    this.#refreshFetch = options.fetchFn ?? createRefreshDedupingFetch();
    // A machine that connects (or reconnects) is asked again what it has.
    options.hub.onReady(() => void this.recheck());
  }

  /** Take plugins that are made by another part of the host. */
  setVirtual(virtual: VirtualPlugins): void {
    this.#virtual = virtual;
    virtual.demand(() => this.#virtualSets());
    virtual.onChange(() => this.#changed());
  }

  /** Read what is there and start noticing changes. */
  async start(): Promise<void> {
    await this.registry.restore();
    await this.registry.refresh();
    this.registry.watch();
    await this.recheck();
  }

  close(): void {
    this.registry.close();
  }

  /* ------------------------------------------------------------------ state */

  /** What keeps a plugin from being used, if anything. */
  #issues(entry: PluginEntry): FieldIssue[] {
    return configIssues(
      entry.plugin?.fields ?? [],
      this.rows.values(entry.name),
    );
  }

  /**
   * Variables a stdio server's file declares with an empty value: the author means "you fill this
   * in". Until the user has set each one, the plugin is not usable and nothing is started.
   */
  #missingEnv(entry: PluginEntry): { server: string; name: string }[] {
    const set = new Set(
      this.rows.env(entry.name).map((one) => `${one.server}\0${one.name}`),
    );
    return (entry.plugin?.servers ?? []).flatMap((def) =>
      def.config.type !== "stdio"
        ? []
        : Object.entries(
            (def.config as { env?: Record<string, string> }).env ?? {},
          )
            .filter(
              ([name, value]) =>
                value === "" && !set.has(`${def.name}\0${name}`),
            )
            .map(([name]) => ({ server: def.name, name })),
    );
  }

  #usable(entry: PluginEntry): boolean {
    return (
      entry.plugin !== undefined &&
      entry.problem === undefined &&
      entry.plugin.configProblems.length === 0 &&
      this.#issues(entry).length === 0 &&
      this.#missingEnv(entry).length === 0
    );
  }

  stateOf(entry: PluginEntry): PluginState {
    return this.#usable(entry) ? "ready" : "needs_config";
  }

  /**
   * The Composio toolkits an agent has enabled and the user has not switched off, whether or not
   * they are ready: what `list_toolkits` tells it. Read from eta's own state; no request is made.
   */
  toolkitsOf(
    agentId: string,
  ): { slug: string; name: string; ready: boolean | null }[] {
    const off = this.rows.disabled();
    const names = this.rows
      .enabled(agentId)
      .filter((name) => this.#virtual?.owns(name) === true && !off.has(name));
    return this.#virtual?.toolkitsFor(names) ?? [];
  }

  /** Whether a plugin can be turned on for an agent now. */
  canEnable(name: string): boolean {
    if (this.#virtual?.owns(name) === true) return this.#virtual.has(name);
    const entry = this.registry.get(name);
    return entry !== undefined && this.#usable(entry);
  }

  /**
   * What a plugin's servers are given: its fields' values, then the user's headers on top. A server
   * on cursor.com with no Cursor credential of its own gets the host's, as one of the user's headers:
   * the service behind it still signs in with OAuth.
   */
  #config(entry: PluginEntry): ReturnType<typeof serversConfig> {
    const own = this.rows.headers(entry.name);
    const host = this.rows.cursorCredential();
    const shared: UserHeader[] =
      host === undefined
        ? []
        : (entry.plugin?.servers ?? []).flatMap((def) =>
            def.config.type === "stdio" ||
            !isCursorServer(def.config.url) ||
            own.some(
              (header) =>
                header.server === def.name &&
                header.name.toLowerCase() === CURSOR_AUTH_HEADER,
            )
              ? []
              : [
                  {
                    server: def.name,
                    name: CURSOR_AUTH_HEADER,
                    value: host,
                    secret: true,
                    plainOk: false,
                  },
                ],
          );
    return serversConfig(
      entry.plugin!,
      this.rows.values(entry.name),
      [...own, ...shared],
      this.rows.env(entry.name),
      this.rows.tokenHeaders(entry.name),
    );
  }

  /** Names the plugin itself fixes on a stdio server (its file, or a field): read-only for the user. */
  #fixedEnv(entry: PluginEntry, server: string): string[] {
    const def = entry.plugin?.servers.find((one) => one.name === server);
    if (def === undefined || def.config.type !== "stdio") return [];
    return [
      ...new Set([
        // An empty value in the file is a blank for the user to fill, not a fixed one.
        ...Object.entries(
          (def.config as { env?: Record<string, string> }).env ?? {},
        )
          .filter(([, value]) => value !== "")
          .map(([name]) => name),
        ...Object.keys(entry.plugin?.bindings[server]?.env ?? {}),
        "PLUGIN_ROOT",
        "PLUGIN_DATA",
      ]),
    ];
  }

  /**
   * What a connection test of one server needs: the server as a session would get it, or the
   * reason there is nothing to connect to. Nothing here connects.
   */
  testPlan(
    name: string,
    server: string,
  ):
    | { result: PluginTestResult }
    | { entry: McpServerEntry; secrets: string[] } {
    const entry = this.#existing(name);
    if (this.rows.disabled().has(name))
      return { result: notTested("off", "the plugin is off") };
    const def = entry.plugin?.servers.find((one) => one.name === server);
    if (entry.plugin === undefined || def === undefined)
      throw new Error(`${name} has no server ${server}`);
    if (!this.#usable(entry))
      return {
        result: notTested("needs_setup", "required values are missing"),
      };
    const resolved = resolvePluginServers(
      [{ plugin: entry.plugin, config: this.#config(entry) }],
      this.#dataDir,
      this.#warn,
    ).filter((one) => one.server === server);
    const [mcp] = Object.values(toMcpEntries(resolved));
    if (mcp === undefined)
      return {
        result: notTested("failed", "the server could not be resolved"),
      };
    return { entry: mcp, secrets: secretsOf(mcp) };
  }

  /** The plugins an agent's sessions load, and the ones it enabled that they skip. */
  #split(agentId: string): {
    active: PluginEntry[];
    skipped: string[];
    virtual: string[];
  } {
    const active: PluginEntry[] = [];
    const skipped: string[] = [];
    const virtual: string[] = [];
    // The user's switch comes first: a plugin that is off is no one's, and is not "skipped" either.
    const off = this.rows.disabled();
    for (const name of this.rows.enabled(agentId)) {
      if (off.has(name)) continue;
      // One that is not connected any more is not "skipped": nothing is wrong, it is only not there.
      if (this.#virtual?.owns(name) === true) {
        if (this.#virtual.has(name)) virtual.push(name);
        continue;
      }
      const entry = this.registry.get(name);
      if (entry !== undefined && this.#usable(entry)) active.push(entry);
      else skipped.push(name);
    }
    return { active, skipped, virtual };
  }

  active(agentId: string): PluginEntry[] {
    return this.#split(agentId).active;
  }

  skipped(agentId: string): string[] {
    return this.#split(agentId).skipped;
  }

  /** The plugins of the virtual kind each agent has enabled and the user has not switched off, one list for each agent. */
  #virtualSets(): string[][] {
    const off = this.rows.disabled();
    const byAgent = new Map<string, string[]>();
    for (const { agentId, plugin } of this.rows.allEnabled())
      if (this.#virtual?.owns(plugin) === true && !off.has(plugin))
        byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), plugin]);
    return [...byAgent.values()];
  }

  /** What an agent's sessions were opened with, as far as plugins go. */
  stampOf(agentId: string): string {
    this.#virtual?.refresh();
    const { active, virtual } = this.#split(agentId);
    // One session stands behind all of an agent's virtual plugins, so one id.
    const identity = this.#virtual?.identity(virtual) ?? "";
    return [
      ...active.map((entry) => {
        const at = this.rows.configuredAt(entry.name);
        return `${entry.name}@${entry.hash}:${at}`;
      }),
      ...virtual.map((name) => `${name}@${identity}`),
    ].join(",");
  }

  /* ------------------------------------------------------------ what a session gets */

  skillDirsFor(meta: SessionMeta): string[] {
    if (meta.agentId === undefined) return [];
    return this.active(meta.agentId).flatMap((entry) =>
      entry.plugin!.skills.map((skill) => skill.dir),
    );
  }

  /**
   * A session of this machine's on an external runtime: skills to tell it of, servers to attach.
   * The agent's ready Composio toolkits come after its installed plugins' servers, as http servers
   * with the key as their header (what eta's own loop is given too); an installed plugin's server
   * of the same name keeps it, and the toolkit is left out and reported.
   */
  async runtimeExtrasFor(meta: SessionMeta): Promise<RuntimeExtras> {
    const { agentId } = meta;
    if (agentId === undefined) return {};
    const { active } = this.#split(agentId);
    const external = meta.runtime !== undefined && meta.runtime !== "eta";
    return withSessionServers(
      await runtimeExtras(
        await Promise.all(
          active.map(async (entry) => ({
            plugin: entry.plugin!,
            hash: entry.hash!,
            config: external
              ? await this.#withSignIns(entry, this.#config(entry))
              : this.#config(entry),
          })),
        ),
        { dataDir: this.#dataDir, runtime: meta.runtime, warn: this.#warn },
      ),
      this.toolkitServersFor(agentId),
      this.#warn,
    );
  }

  /**
   * The agent's ready Composio toolkits in the shape an external runtime takes: the one server of
   * their one session, as eta's own loop is given it. On this machine it comes after the installed
   * plugins' servers (`runtimeExtrasFor`); on a daemon's it goes in the open
   * (`OpenSessionArgs.mcpServers`), since it is no file to send, and the daemon puts it after the
   * plugins' the same way.
   */
  toolkitServersFor(agentId: string): SessionMcpServer[] {
    return this.#sessionServersOf(this.#split(agentId).virtual);
  }

  /** The servers of a set of virtual plugins in the shape an external runtime takes. */
  #sessionServersOf(names: readonly string[]): SessionMcpServer[] {
    const source = this.#virtual?.mcpSource(names);
    if (source === undefined) return [];
    return Object.entries(source.servers).flatMap(([server, entry]) =>
      entry.url === undefined
        ? []
        : [
            {
              name: server,
              type: "http" as const,
              url: entry.url,
              ...(entry.headers === undefined
                ? {}
                : { headers: entry.headers }),
            },
          ],
    );
  }

  /**
   * A plugin's servers' configuration with the sign-in of each remote OAuth server in its headers,
   * for a runtime that cannot sign in itself: `Authorization`, and the server's own token header if
   * the user chose one. A server that has no sign-in, or whose sign-in cannot be refreshed, is left
   * as it is, so its 401 reaches the agent. Headers that are already there are never replaced.
   */
  async #withSignIns(
    entry: PluginEntry,
    config: ReturnType<typeof serversConfig>,
  ): Promise<ReturnType<typeof serversConfig>> {
    const resolved = resolvePluginServers(
      [{ plugin: entry.plugin!, config }],
      this.#dataDir,
      () => {},
    );
    const entries = toMcpEntries(resolved);
    const next = { ...config };
    const has = (headers: Record<string, string>, name: string): boolean =>
      Object.keys(headers).some(
        (one) => one.toLowerCase() === name.toLowerCase(),
      );
    for (const server of resolved) {
      if (server.type === "stdio" || entries[server.name]?.auth !== "oauth")
        continue;
      const token = await this.#signInToken(entry.name, server);
      if (token === undefined) continue;
      const tokenHeader = config[server.server]?.tokenHeader;
      const headers = { ...config[server.server]?.headers };
      if (!has(server.headers, "authorization"))
        headers.Authorization = `Bearer ${token}`;
      if (tokenHeader !== undefined && !has(server.headers, tokenHeader.name))
        headers[tokenHeader.name] =
          tokenHeader.format === "bearer" ? `Bearer ${token}` : token;
      next[server.server] = { ...config[server.server], headers };
    }
    return next;
  }

  /** The access token of a server's stored sign-in, refreshed first when it has run out. */
  async #signInToken(
    plugin: string,
    server: { server: string; url: string },
  ): Promise<string | undefined> {
    const who = `plugin ${plugin}: server ${server.server}`;
    const serverKey = mcpServerKey(server.url);
    let tokens: CredentialRecord["tokens"] | undefined =
      await this.#signIns.get(serverKey, "tokens");
    if (tokens === undefined) {
      this.#warn(`[eta] ${who} has no sign-in; it is sent without a token`);
      return undefined;
    }
    const savedAt = this.#signIns.savedAt(serverKey, "tokens");
    if (
      tokens.expires_in !== undefined &&
      savedAt !== undefined &&
      savedAt + tokens.expires_in * 1000 - EXPIRY_MARGIN_MS <= Date.now()
    ) {
      try {
        tokens = await refreshStoredTokens({
          serverKey,
          serverUrl: server.url,
          store: this.#signIns,
          fetchFn: this.#refreshFetch,
        });
      } catch (error) {
        this.#warn(
          `[eta] ${who}: its sign-in expired and could not be refreshed (${messageOf(error)}); it is sent without a token`,
        );
        return undefined;
      }
      if (tokens === undefined) {
        this.#warn(
          `[eta] ${who}: its sign-in expired and has no refresh token; it is sent without a token`,
        );
        return undefined;
      }
    }
    this.#handedOut.set(`${plugin}.${server.server}`, tokens.access_token);
    return tokens.access_token;
  }

  /**
   * The MCP servers eta's own loop gets from an agent's plugins, on this machine: one source per
   * plugin, `plugin:<name>`, and one for all its virtual plugins (the Composio toolkits), for
   * `McpHost` to put before the user's and the project's files. An agent on an external runtime has
   * none here; its runtime is given them (`runtimeExtrasFor`), its Composio toolkits among them.
   */
  mcpSourcesFor(agentId: string): McpConfigSource[] {
    if (this.#agents.get(agentId)?.runtime !== "eta") return [];
    this.#virtual?.refresh();
    const { active, virtual } = this.#split(agentId);
    const own =
      active.length === 0
        ? []
        : pluginMcpSources(
            active.map((entry) => ({
              plugin: entry.plugin!,
              config: this.#config(entry),
            })),
            this.#dataDir,
            this.#warn,
          );
    const toolkits =
      virtual.length === 0 ? undefined : this.#virtual?.mcpSource(virtual);
    return toolkits === undefined ? own : [...own, toolkits];
  }

  /**
   * What each plugin loses to another's server names, among the installed plugins. An agent's
   * plugins are claimed in name order (`rows.enabled`), so the later by name is the one left out,
   * but only in the sessions of an agent that has both enabled: the report says that, since one
   * installed plugin that nobody enables takes nothing from anyone.
   */
  #clashes(): Map<string, string[]> {
    const loaded = this.registry
      .entries()
      .flatMap((entry) => (entry.plugin === undefined ? [] : [entry.plugin]))
      .sort((a, b) =>
        a.manifest.name < b.manifest.name
          ? -1
          : a.manifest.name > b.manifest.name
            ? 1
            : 0,
      );
    const reports = new Map<string, string[]>();
    for (const clash of claimServerNames(loaded).clashes)
      reports.set(clash.plugin, [
        ...(reports.get(clash.plugin) ?? []),
        `mcp.json: server ${clash.server}: its name ${clash.name} is also that of server ${clash.takenBy.server} of plugin ${clash.takenBy.plugin}; an agent with both enabled skips this one`,
      ]);
    return reports;
  }

  /**
   * The saved secrets a session must not pass on: every plugin's, whether its agent uses the plugin
   * or not. The ones it is allowed to read as `value` stay: taking them out would undo the answer.
   */
  redactionsFor(agentId: string | undefined): Redaction[] {
    const readable = new Set<string>();
    if (agentId !== undefined)
      for (const entry of this.active(agentId)) {
        const levels = this.rows.levels(entry.name);
        for (const field of entry.plugin!.fields)
          if (agentLevel(field, levels[field.name]) === "value")
            readable.add(`${entry.name}.${field.name}`);
      }
    const redactions: Redaction[] = [];
    const host = this.rows.cursorCredential();
    if (host !== undefined)
      redactions.push({ value: host, label: "[secret cursor credential]" });
    redactions.push(...(this.#virtual?.secrets() ?? []));
    // A sign-in token an external runtime was given is as secret as a header the user attached.
    for (const [label, value] of this.#handedOut)
      redactions.push({ value, label: `[secret ${label} sign-in]` });
    for (const entry of this.registry.entries()) {
      if (entry.plugin === undefined) continue;
      // A header the user attached is a credential too, and no agent may read it.
      for (const header of this.rows.headers(entry.name))
        if (header.secret)
          redactions.push({
            value: header.value,
            label: `[secret ${entry.name}.${header.server}.${header.name}]`,
          });
      // So is a secret variable the user set on a stdio server.
      for (const one of this.rows.env(entry.name))
        if (one.secret)
          redactions.push({
            value: one.value,
            label: `[secret ${entry.name}.${one.server}.${one.name}]`,
          });
      const values = this.rows.values(entry.name);
      for (const field of entry.plugin.fields) {
        const value = values[field.name];
        const label = `${entry.name}.${field.name}`;
        if (field.secret && typeof value === "string" && !readable.has(label))
          redactions.push({ value, label: `[secret ${label}]` });
      }
    }
    return redactions;
  }

  /**
   * The agent's plugins on a daemon's machine: the files it does not keep yet are sent, and the
   * open says what its servers get (their environment and headers, whatever runtime the agent is
   * on). A plugin that cannot be sent is left out and reported.
   */
  async openOn(link: MachineLink, agentId: string): Promise<OpenedPlugin[]> {
    const active = this.active(agentId);
    if (active.length === 0) return [];
    const runtime = this.#agents.get(agentId)?.runtime;
    const external = runtime !== undefined && runtime !== "eta";
    const { missing } = await link.machine("pluginHave", {
      hashes: [...new Set(active.map((entry) => entry.hash!))],
    });
    const opened: OpenedPlugin[] = [];
    for (const entry of active) {
      try {
        if (missing.includes(entry.hash!)) await this.#send(link, entry);
      } catch (error) {
        this.#warn(
          `[eta] plugin ${entry.name} could not be sent: ${messageOf(error)}`,
        );
        continue;
      }
      opened.push({
        name: entry.name,
        hash: entry.hash!,
        // An external runtime and eta's own loop both start the servers on the machine. Only an
        // external runtime is given the sign-in token: eta's own loop signs in on its own.
        servers: external
          ? await this.#withSignIns(entry, this.#config(entry))
          : this.#config(entry),
      });
    }
    return opened;
  }

  /** Send a plugin's files; two sessions opening at once wait for the same send. */
  async #send(link: MachineLink, entry: PluginEntry): Promise<void> {
    const key = `${link.machineId}:${entry.hash!}`;
    const sending = this.#sending.get(key);
    if (sending !== undefined) return await sending;
    const send = this.#sendFiles(link, entry).finally(() =>
      this.#sending.delete(key),
    );
    this.#sending.set(key, send);
    await send;
  }

  async #sendFiles(link: MachineLink, entry: PluginEntry): Promise<void> {
    const hash = entry.hash!;
    const chunks = pluginChunks(entry.dir);
    let next = chunks.next();
    while (next.done !== true) {
      const after = chunks.next();
      await link.machine(
        "pluginPut",
        { hash, files: next.value, done: after.done === true },
        { timeoutMs: 60_000 },
      );
      next = after;
    }
  }

  /* ------------------------------------------------------------------ the wire */

  view(): PluginView[] {
    const clashes = this.#clashes();
    return this.registry
      .entries()
      .map((entry) => this.#viewOf(entry, clashes.get(entry.name) ?? []))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  #viewOf(entry: PluginEntry, clashes: string[]): PluginView {
    const { plugin } = entry;
    const values = this.rows.values(entry.name);
    const levels = this.rows.levels(entry.name);
    const off = this.rows.disabled();
    const requires = plugin?.requires ?? [];
    return {
      name: entry.name,
      version: plugin?.manifest.version ?? null,
      description: plugin?.manifest.description ?? "",
      source: entry.source,
      enabled: !off.has(entry.name),
      state: this.stateOf(entry),
      problem:
        entry.problem ??
        (plugin === undefined || plugin.configProblems.length === 0
          ? null
          : plugin.configProblems.join("; ")),
      reports: [...(plugin?.reports ?? []), ...clashes],
      skills: (plugin?.skills ?? []).map(({ name, description }) => ({
        name,
        description,
      })),
      servers: this.#serversOf(entry),
      requires,
      machines: this.#machineViews(requires),
      headers: this.#headerViews(entry),
      tokenHeaders: this.rows.tokenHeaders(entry.name),
      env: this.#envViews(entry),
      fields: (plugin?.fields ?? []).map((field: PluginField) => {
        const saved = values[field.name];
        return {
          ...field,
          set: saved !== undefined,
          value: field.secret ? null : (saved ?? null),
          level: agentLevel(field, levels[field.name]),
          levels: agentLevels(field),
          issue: fieldIssue(field, saved) ?? null,
        };
      }),
      agents: this.rows.agentsOf(entry.name).flatMap((id) => {
        const agent = this.#agents.get(id);
        return agent === undefined ? [] : [{ id, name: agent.name }];
      }),
    };
  }

  /**
   * The servers as shown, with the Cursor state worked out here from the address and the saved
   * header, not from what a test saw: a Cursor-hosted server without a saved credential needs the
   * Cursor sign-in whatever its 401 says. Says nothing of whether the server accepts the credential.
   */
  #serversOf(entry: PluginEntry): PluginServerView[] {
    const saved = this.rows.headers(entry.name);
    const host = this.rows.cursorCredential() !== undefined;
    return serverViews(entry.plugin).map((view) => {
      if (view.url === undefined || !isCursorServer(view.url)) return view;
      return {
        ...view,
        cursorServer: true,
        cursorSignedIn:
          host ||
          saved.some(
            (one) =>
              one.server === view.name &&
              one.name.toLowerCase() === CURSOR_AUTH_HEADER,
          ),
      };
    });
  }

  /** The user's headers as the page sees them: a secret's value stays here. */
  #headerViews(entry: PluginEntry): PluginHeaderView[] {
    return this.rows.headers(entry.name).map((header) => {
      const server = entry.plugin?.servers.find(
        (one) => one.name === header.server,
      );
      const plain =
        server !== undefined &&
        server.config.type !== "stdio" &&
        plainRemote(server.config.url);
      return {
        server: header.server,
        name: header.name,
        secret: header.secret,
        value: header.secret ? null : header.value,
        plainOk: header.plainOk,
        blocked: plain && !header.plainOk ? "plain-http" : null,
      };
    });
  }

  /** The user's variables on stdio servers as the page sees them: a secret's value stays here. */
  #envViews(entry: PluginEntry): PluginEnvView[] {
    return this.rows.env(entry.name).map((one) => ({
      server: one.server,
      name: one.name,
      secret: one.secret,
      value: one.secret ? null : one.value,
    }));
  }

  #machineViews(requires: readonly string[]): PluginView["machines"] {
    if (requires.length === 0) return [];
    const views: PluginView["machines"] = [];
    for (const machine of this.#machines.list()) {
      if (machine.kind === "primary") {
        views.push({
          machineId: machine.id,
          name: machine.name,
          missing: requires.filter((command) => !has(command)),
          checked: true,
        });
      } else if (machine.kind === "daemon") {
        const found = this.#found.get(machine.id);
        views.push({
          machineId: machine.id,
          name: machine.name,
          missing:
            found === undefined
              ? []
              : requires.filter((command) => !found.has(command)),
          checked: found !== undefined && machine.status === "online",
        });
      }
    }
    return views;
  }

  /** Forget cached command checks for a removed machine. */
  forgetMachine(machineId: string): void {
    this.#found.delete(machineId);
  }

  /** Read the plugins again and ask every machine that can be asked what it has. */
  async recheck(): Promise<void> {
    const commands = [
      ...new Set(
        this.registry
          .entries()
          .flatMap((entry) => entry.plugin?.requires ?? []),
      ),
    ].sort();
    if (commands.length > 0)
      await Promise.all(
        this.#machines
          .list()
          .filter((machine) => machine.kind === "daemon")
          .map(async (machine) => {
            const link = this.#hub.link(machine.id);
            if (link === undefined) return;
            try {
              const { found } = await link.machine(
                "which",
                { commands },
                { timeoutMs: 10_000 },
              );
              this.#found.set(machine.id, new Set(found));
            } catch (error) {
              this.#warn(
                `[eta] could not ask ${machine.name} for commands: ${messageOf(error)}`,
              );
            }
          }),
      );
    this.#changed();
  }

  #existing(name: string): PluginEntry {
    const entry = this.registry.get(name);
    if (entry === undefined) throw new Error(`no such plugin: ${name}`);
    return entry;
  }

  /** The host's check, whatever the form said: nothing that does not fit is ever saved. */
  configure(
    name: string,
    patch: Readonly<Record<string, unknown>>,
  ): { state: PluginState; issues: FieldIssue[] } {
    const entry = this.#existing(name);
    const fields = entry.plugin?.fields ?? [];
    const values = this.rows.values(name);
    for (const [key, value] of Object.entries(patch)) {
      const field = fields.find((candidate) => candidate.name === key);
      if (field === undefined) throw new Error(`${name} has no field ${key}`);
      if (value === null) {
        delete values[key];
        continue;
      }
      if (!isValue(value)) throw new Error(`${key}: not a value`);
      // A secret left blank is one left alone.
      if (value === "" && field.secret) continue;
      if (value === "") {
        delete values[key];
        continue;
      }
      const issue = fieldIssue({ ...field, required: false }, value);
      if (issue !== undefined)
        throw new Error(
          `${key}: ${issue.code}${issue.limit === undefined ? "" : ` ${issue.limit}`}`,
        );
      values[key] = value;
    }
    this.rows.saveValues(name, values);
    this.#changed();
    return {
      state: this.stateOf(entry),
      issues: configIssues(fields, values),
    };
  }

  /** Switch a plugin on or off for every agent. What each agent enabled is left as it is. */
  setEnabled(name: string, enabled: boolean): void {
    if (this.#virtual?.has(name) !== true) this.#existing(name);
    this.rows.setDisabled(name, !enabled);
    this.#virtual?.refresh();
    this.#changed();
  }

  /**
   * Replace the headers of one remote server. A secret is written and not read back: a `null`
   * value keeps what is saved under that name. Nothing that does not fit is ever saved.
   */
  setHeaders(
    name: string,
    server: string,
    headers: readonly {
      name: string;
      value: string | null;
      secret: boolean;
      plainOk?: boolean;
    }[],
  ): void {
    const entry = this.#existing(name);
    const def = entry.plugin?.servers.find((one) => one.name === server);
    if (def === undefined || def.config.type === "stdio")
      throw new Error(`${name} has no remote server ${server}`);
    if (headers.length > MAX_HEADERS_PER_SERVER)
      throw new Error(`at most ${MAX_HEADERS_PER_SERVER} headers per server`);
    const saved = new Map(
      this.rows
        .headers(name)
        .filter((header) => header.server === server)
        .map((header) => [header.name.toLowerCase(), header]),
    );
    const plain = plainRemote(def.config.url);
    const seen = new Set<string>();
    const next = headers.map((header) => {
      const key = header.name.trim().toLowerCase();
      const value = header.value ?? saved.get(key)?.value;
      if (value === undefined)
        throw new Error(`header ${header.name} has no saved value to keep`);
      const problem = headerProblem(header.name.trim(), value);
      if (problem !== undefined) throw new Error(problem);
      if (seen.has(key))
        throw new Error(`header ${header.name} is listed twice`);
      seen.add(key);
      return {
        server,
        name: header.name.trim(),
        value,
        secret: header.secret,
        plainOk: plain && header.plainOk === true,
      };
    });
    this.rows.saveHeaders(name, server, next);
    this.#changed();
  }

  /**
   * Save one secret header of one remote server (replacing a header of that name, keeping the
   * others). For a credential the host got itself; the value is sealed like any secret header and
   * is in no message.
   */
  setSecretHeader(
    name: string,
    server: string,
    header: string,
    value: string,
  ): void {
    const entry = this.#existing(name);
    const def = entry.plugin?.servers.find((one) => one.name === server);
    if (def === undefined || def.config.type === "stdio")
      throw new Error(`${name} has no remote server ${server}`);
    const clean = header.trim();
    const problem = headerProblem(clean, value);
    if (problem !== undefined) throw new Error(problem);
    const key = clean.toLowerCase();
    const kept = this.rows
      .headers(name)
      .filter((one) => one.server === server && one.name.toLowerCase() !== key);
    if (kept.length + 1 > MAX_HEADERS_PER_SERVER)
      throw new Error(`at most ${MAX_HEADERS_PER_SERVER} headers per server`);
    this.rows.saveHeaders(name, server, [
      ...kept,
      { server, name: clean, value, secret: true, plainOk: false },
    ]);
    this.#changed();
  }

  /**
   * Save the Cursor credential for the host: every server on cursor.com uses it unless it has a
   * header of its own. A copy the user already has on a Cursor server is brought up to date, or it
   * would keep the old one in front of this.
   */
  setCursorCredential(value: string): void {
    const problem = headerProblem(CURSOR_AUTH_HEADER, value);
    if (problem !== undefined) throw new Error(problem);
    this.rows.saveCursorCredential(value);
    for (const entry of this.registry.entries()) {
      const own = this.rows.headers(entry.name);
      const isCopy = (header: UserHeader): boolean => {
        const def = entry.plugin?.servers.find(
          (one) => one.name === header.server,
        );
        return (
          header.name.toLowerCase() === CURSOR_AUTH_HEADER &&
          def !== undefined &&
          def.config.type !== "stdio" &&
          isCursorServer(def.config.url)
        );
      };
      for (const server of new Set(
        own.filter(isCopy).map((header) => header.server),
      ))
        this.rows.saveHeaders(
          entry.name,
          server,
          own
            .filter((header) => header.server === server)
            .map((header) => (isCopy(header) ? { ...header, value } : header)),
        );
    }
    this.#changed();
  }

  /**
   * Tell one remote server to carry its sign-in token in a request header (`null` turns it off).
   * Only the header's name and format are saved; the token is read from the sign-in store on each
   * request. `Authorization` is refused: the sign-in already sends it there.
   */
  setTokenHeader(
    name: string,
    server: string,
    header: { name: string; format: "raw" | "bearer" } | null,
  ): void {
    const entry = this.#existing(name);
    const def = entry.plugin?.servers.find((one) => one.name === server);
    if (def === undefined || def.config.type === "stdio")
      throw new Error(`${name} has no remote server ${server}`);
    if (header !== null) {
      const clean = header.name.trim();
      const problem = headerProblem(clean, "x");
      if (problem !== undefined) throw new Error(problem);
      if (clean.toLowerCase() === "authorization")
        throw new Error("Authorization already carries the sign-in token");
      if (header.format !== "raw" && header.format !== "bearer")
        throw new Error("the format is raw or bearer");
      this.rows.saveTokenHeader(name, server, {
        name: clean,
        format: header.format,
      });
    } else this.rows.saveTokenHeader(name, server, null);
    this.#changed();
  }

  /**
   * Replace the environment variables the user set on one stdio server. A secret is written and
   * not read back: a `null` value keeps what is saved under that name. A name the plugin fixes
   * itself cannot be set. Nothing that does not fit is ever saved, and no message has a value.
   */
  setEnv(
    name: string,
    server: string,
    env: readonly { name: string; value: string | null; secret: boolean }[],
  ): void {
    const entry = this.#existing(name);
    const def = entry.plugin?.servers.find((one) => one.name === server);
    if (def === undefined || def.config.type !== "stdio")
      throw new Error(`${name} has no stdio server ${server}`);
    if (env.length > MAX_ENV_PER_SERVER)
      throw new Error(`at most ${MAX_ENV_PER_SERVER} variables per server`);
    const saved = new Map(
      this.rows
        .env(name)
        .filter((one) => one.server === server)
        .map((one) => [one.name, one]),
    );
    const fixed = new Set(this.#fixedEnv(entry, server));
    const seen = new Set<string>();
    const next = env.map((one) => {
      const variable = one.name.trim();
      const value = one.value ?? saved.get(variable)?.value;
      if (value === undefined)
        throw new Error(`variable ${one.name} has no saved value to keep`);
      const problem = envProblem(variable, value);
      if (problem !== undefined) throw new Error(problem);
      if (fixed.has(variable))
        throw new Error(
          `${variable} is set by the plugin and cannot be changed`,
        );
      if (seen.has(variable))
        throw new Error(`variable ${variable} is listed twice`);
      seen.add(variable);
      return { server, name: variable, value, secret: one.secret };
    });
    this.rows.saveEnv(name, server, next);
    this.#changed();
  }

  /** Move a field's level; what the manifest declares is the most it can be. */
  setLevel(name: string, fieldName: string, level: PluginAgentLevel): void {
    const entry = this.#existing(name);
    const field = entry.plugin?.fields.find(
      (candidate) => candidate.name === fieldName,
    );
    if (field === undefined)
      throw new Error(`${name} has no field ${fieldName}`);
    if (!agentLevels(field).includes(level))
      throw new Error(`${fieldName} cannot be set to ${level}`);
    this.rows.saveLevel(name, fieldName, level === field.agent ? null : level);
    this.#changed();
  }

  async update(name: string | undefined): Promise<string[]> {
    const names =
      name === undefined ? this.rows.sources().map((row) => row.name) : [name];
    for (const each of names) await this.registry.update(each);
    return names;
  }

  /* --------------------------------------------------------- what an agent reads */

  /** An agent read a secret: on the record, and on the settings page. */
  audited(entry: Parameters<PluginRows["audit"]>[0]): void {
    this.rows.audit(entry);
    this.#changed();
  }

  /** A field of a plugin an agent has in use, with the value in force; undefined when it has none. */
  readable(
    agentId: string,
    pluginName: string,
  ):
    | {
        fields: {
          field: PluginField;
          level: PluginAgentLevel;
          value: PluginValue | undefined;
        }[];
      }
    | undefined {
    const entry = this.active(agentId).find(
      (candidate) => candidate.name === pluginName,
    );
    if (entry === undefined) return undefined;
    const values = this.rows.values(pluginName);
    const levels = this.rows.levels(pluginName);
    return {
      fields: entry.plugin!.fields.map((field) => ({
        field,
        level: agentLevel(field, levels[field.name]),
        value: effectiveValue(field, values[field.name]),
      })),
    };
  }
}
