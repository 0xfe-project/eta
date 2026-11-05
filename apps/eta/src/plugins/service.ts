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
  PluginField,
  PluginState,
  PluginValue,
  PluginView,
  Redaction,
} from "@eta/client-contracts";
import type { PlatformGroup } from "@eta/harness";
import type { RuntimeExtras, SessionMeta } from "@eta/server";
import type { Database } from "bun:sqlite";
import type { Buffer } from "node:buffer";
import type { AgentStore } from "../agents/store";
import type { MachineHub, MachineLink } from "../machines/hub";
import type { MachineStore } from "../machines/store";
import type { PluginEntry } from "./registry";
import process from "node:process";
import {
  agentLevel,
  agentLevels,
  configIssues,
  effectiveValue,
  fieldIssue,
} from "@eta/client-contracts/plugin-fields";
import {
  pluginChunks,
  pluginPlatformGroup,
  runtimeExtras,
  serversConfig,
  serverSupported,
} from "@eta/daemon";
import { needsOAuth } from "@eta/mcp";
import { redactor } from "@eta/server";
import { PluginRegistry } from "./registry";
import { PluginRows } from "./store";

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
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
  /** What a daemon has, by machine, of the commands asked about. */
  readonly #found = new Map<string, Set<string>>();
  /** The sends in flight, by `machine:hash`. */
  readonly #sending = new Map<string, Promise<void>>();
  /** The remote servers found to want a sign-in, as `plugin/server`. */
  #oauth = new Set<string>();

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
    // A machine that connects (or reconnects) is asked again what it has.
    options.hub.onReady(() => void this.recheck());
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

  #usable(entry: PluginEntry): boolean {
    return (
      entry.plugin !== undefined &&
      entry.problem === undefined &&
      entry.plugin.configProblems.length === 0 &&
      this.#issues(entry).length === 0
    );
  }

  stateOf(entry: PluginEntry): PluginState {
    return this.#usable(entry) ? "ready" : "needs_config";
  }

  /** Whether a plugin can be turned on for an agent now. */
  canEnable(name: string): boolean {
    const entry = this.registry.get(name);
    return entry !== undefined && this.#usable(entry);
  }

  /** The plugins an agent's sessions load, and the ones it enabled that they skip. */
  #split(agentId: string): { active: PluginEntry[]; skipped: string[] } {
    const active: PluginEntry[] = [];
    const skipped: string[] = [];
    for (const name of this.rows.enabled(agentId)) {
      const entry = this.registry.get(name);
      if (entry !== undefined && this.#usable(entry)) active.push(entry);
      else skipped.push(name);
    }
    return { active, skipped };
  }

  active(agentId: string): PluginEntry[] {
    return this.#split(agentId).active;
  }

  skipped(agentId: string): string[] {
    return this.#split(agentId).skipped;
  }

  /** What an agent's sessions were opened with, as far as plugins go. */
  stampOf(agentId: string): string {
    return this.active(agentId)
      .map((entry) => {
        const at = this.rows.configuredAt(entry.name);
        return `${entry.name}@${entry.hash}:${at}`;
      })
      .join(",");
  }

  /* ------------------------------------------------------------ what a session gets */

  skillDirsFor(meta: SessionMeta): string[] {
    if (meta.agentId === undefined) return [];
    return this.active(meta.agentId).flatMap((entry) =>
      entry.plugin!.skills.map((skill) => skill.dir),
    );
  }

  #activePlugins(agentId: string) {
    return this.active(agentId).map((entry) => ({
      plugin: entry.plugin!,
      hash: entry.hash!,
      config: serversConfig(entry.plugin!, this.rows.values(entry.name)),
    }));
  }

  /** A session of this machine's on an external runtime: skills to tell it of, servers to attach. */
  async runtimeExtrasFor(meta: SessionMeta): Promise<RuntimeExtras> {
    const { agentId } = meta;
    if (agentId === undefined) return {};
    return await runtimeExtras(this.#activePlugins(agentId), {
      dataDir: this.#dataDir,
      runtime: meta.runtime,
      warn: this.#warn,
    });
  }

  /** A session of this machine's on eta's own loop: its servers, as `eta.platform.mcp`. */
  async platformGroupsFor(
    meta: SessionMeta,
    sessionDir: string,
  ): Promise<PlatformGroup[]> {
    const { agentId } = meta;
    if (agentId === undefined) return [];
    const group = await pluginPlatformGroup(this.#activePlugins(agentId), {
      dataDir: this.#dataDir,
      sessionDir,
      clean: redactor(() => this.redactionsFor(agentId)),
      warn: this.#warn,
    });
    return group === undefined ? [] : [group];
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
    for (const entry of this.registry.entries()) {
      if (entry.plugin === undefined) continue;
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
   * open says what its servers get. A plugin that cannot be sent is left out and reported.
   */
  async openOn(link: MachineLink, agentId: string): Promise<OpenedPlugin[]> {
    const active = this.active(agentId);
    if (active.length === 0) return [];
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
        servers: serversConfig(entry.plugin!, this.rows.values(entry.name)),
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
    return this.registry
      .entries()
      .map((entry) => this.#viewOf(entry))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  #viewOf(entry: PluginEntry): PluginView {
    const { plugin } = entry;
    const values = this.rows.values(entry.name);
    const levels = this.rows.levels(entry.name);
    const requires = plugin?.requires ?? [];
    return {
      name: entry.name,
      version: plugin?.manifest.version ?? null,
      description: plugin?.manifest.description ?? "",
      source: entry.source,
      state: this.stateOf(entry),
      problem:
        entry.problem ??
        (plugin === undefined || plugin.configProblems.length === 0
          ? null
          : plugin.configProblems.join("; ")),
      reports: plugin?.reports ?? [],
      skills: (plugin?.skills ?? []).map(({ name, description }) => ({
        name,
        description,
      })),
      servers: (plugin?.servers ?? []).map((server) => {
        const binding = plugin?.bindings[server.name];
        const { config } = server;
        return {
          name: server.name,
          transport: config.type,
          ...(config.type === "stdio"
            ? { command: [config.command, ...config.args] }
            : { url: config.url }),
          env: Object.keys(binding?.env ?? {}),
          headers: Object.keys(binding?.headers ?? {}),
          problem: !serverSupported(server)
            ? "legacy HTTP+SSE is not supported"
            : this.#oauth.has(`${entry.name}/${server.name}`)
              ? "needs an OAuth sign-in, which eta does not support"
              : null,
        };
      }),
      requires,
      machines: this.#machineViews(requires),
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
      } else if (machine.kind === "daemon" && machine.status !== "revoked") {
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

  /**
   * Ask the remote servers that are given no credentials whether they want a sign-in, so the user
   * reads that on the settings page before an agent finds it out. Nothing configured is sent. It
   * runs apart from the check of commands: a slow server should not hold that up.
   */
  async #probeServers(): Promise<void> {
    const found = new Set<string>();
    await Promise.all(
      this.registry.entries().flatMap(({ name, plugin }) =>
        (plugin?.servers ?? []).map(async ({ name: server, config }) => {
          if (
            config.type !== "streamable-http" ||
            Object.keys(plugin?.bindings[server]?.headers ?? {}).length > 0
          )
            return;
          const asks = await needsOAuth({
            name: server,
            type: "http",
            url: config.url,
            headers: config.headers,
          });
          if (asks) found.add(`${name}/${server}`);
        }),
      ),
    );
    const same =
      found.size === this.#oauth.size &&
      [...found].every((key) => this.#oauth.has(key));
    this.#oauth = found;
    if (!same) this.#changed();
  }

  /** Read the plugins again and ask every machine that can be asked what it has. */
  async recheck(): Promise<void> {
    void this.#probeServers().catch((error: unknown) =>
      this.#warn(`[eta] could not check plugin servers: ${messageOf(error)}`),
    );
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
