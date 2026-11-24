/* eslint-disable no-template-curly-in-string -- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are the spec's literal placeholders */
/**
 * From a plugin's configuration to what a session is given, on the machine the session runs on.
 *
 * `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded once, in `args`, `env` and `cwd`, and nothing
 * else is (§9.2). The user's configuration does not go through that: the extension says which
 * variable or header each field becomes, and it is added here, so `mcp.json` stays a file any client
 * can read and the values stay out of the plugin's files.
 *
 * One resolution (`resolvePluginServers`), two shapes. An external runtime takes a stdio server as a
 * command, arguments and an environment, with no working directory, so one that must start in the
 * plugin's directory is started through `sh`, and it has no sse (`toSessionServers`). eta's own
 * loop takes `@eta/mcp`'s entries, which keep their working directory and do speak sse, and a
 * remote server there signs in with OAuth unless the extension sends `Authorization`
 * (`toMcpEntries`). Names are `<plugin>-<server>`; one that two servers would share goes to the
 * first, and the other is left out and reported.
 *
 * Skills reach a runtime in one of two ways. Claude Code takes them natively, as `--plugin-dir`; the
 * others have nothing per session, and hear of them in the system prompt. Claude Code is not given
 * the plugin itself: a directory there is read as a Claude plugin, whose `hooks/` run and whose
 * `commands/` load, and eta supports neither. It gets a generated directory with only the valid
 * skills in it, by symlink.
 */
import type {
  PluginField,
  PluginValue,
  SessionMcpServer,
} from "@eta/client-contracts";
import type { McpConfigSource, McpServerEntry } from "@eta/mcp";
import type { RuntimeExtras } from "@eta/server";
import type { PluginPackage, PluginServer } from "./plugin-package";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isCursorServer } from "@eta/client-contracts";
import { effectiveValue } from "@eta/client-contracts/plugin-fields";
import { renderSkillDirs } from "@eta/server";
import { fillTemplate, isWithin } from "./plugin-package";

/** The values one server gets, by name: resolved on the primary, kept in memory everywhere. */
interface ServerConfig {
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** Some of `headers` were attached by the user, not by the plugin: no sign-in is offered instead. */
  userHeaders?: boolean;
  /** The sign-in token goes in this header too (from the user's choice for this server). */
  tokenHeader?: { name: string; format: "raw" | "bearer" };
}

/** A header the user attached to one remote server of a plugin. */
export interface UserHeaderInput {
  server: string;
  name: string;
  value: string;
  /** The user confirmed sending it over plain http to a host that is not this machine. */
  plainOk: boolean;
}

/** An environment variable the user set on one stdio server of a plugin. */
export interface UserEnvInput {
  server: string;
  name: string;
  value: string;
}

/** Plain http to a host other than this machine: a header sent there crosses the network in clear. */
export function plainRemote(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return !(
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\./.test(host)
  );
}
export type ServersConfig = Record<string, ServerConfig>;

/** A plugin's persistent data on this machine; kept across updates, made before it is used. */
export function pluginDataDir(dataDir: string, name: string): string {
  const dir = join(dataDir, "plugins", "data", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A value as an environment variable or a header holds it; a list is comma-separated. */
function textOf(value: PluginValue): string {
  return Array.isArray(value) ? value.join(",") : String(value);
}

/** What the extension makes of these values, for each server that has a binding. */
export function serversConfig(
  plugin: Pick<PluginPackage, "bindings" | "fields"> &
    Partial<Pick<PluginPackage, "servers">>,
  values: Readonly<Record<string, PluginValue | null | undefined>>,
  userHeaders: readonly UserHeaderInput[] = [],
  userEnv: readonly UserEnvInput[] = [],
  tokenHeaders: readonly {
    server: string;
    name: string;
    format: "raw" | "bearer";
  }[] = [],
): ServersConfig {
  const texts: Record<string, string | undefined> = {};
  for (const field of plugin.fields as PluginField[]) {
    const value = effectiveValue(field, values[field.name]);
    texts[field.name] = value === undefined ? undefined : textOf(value);
  }
  const config: ServersConfig = {};
  for (const [server, binding] of Object.entries(plugin.bindings)) {
    const env: Record<string, string> = {};
    for (const [name, field] of Object.entries(binding.env)) {
      const text = texts[field];
      if (text !== undefined) env[name] = text;
    }
    const headers: Record<string, string> = {};
    for (const [name, template] of Object.entries(binding.headers)) {
      const filled = fillTemplate(template, texts);
      if (filled !== undefined) headers[name] = filled;
    }
    config[server] = { env, headers };
  }
  // The user's headers go on top, whatever the case of a name the file or a binding set already.
  for (const header of userHeaders) {
    // An empty row (the editor's default Authorization) is nothing: not sent, not a choice.
    if (header.name.trim() === "" || header.value.trim() === "") continue;
    const server = plugin.servers?.find((one) => one.name === header.server);
    // Only a remote server takes headers; plain http to another machine needs the user's yes.
    if (server === undefined || server.config.type === "stdio") continue;
    if (plainRemote(server.config.url) && !header.plainOk) continue;
    const entry = (config[header.server] ??= { env: {}, headers: {} });
    const headers = entry.headers ?? {};
    for (const name of Object.keys(headers))
      if (name.toLowerCase() === header.name.toLowerCase())
        delete headers[name];
    headers[header.name] = header.value;
    entry.headers = headers;
    entry.userHeaders = true;
  }
  for (const one of tokenHeaders) {
    const server = plugin.servers?.find(
      (candidate) => candidate.name === one.server,
    );
    if (server === undefined || server.config.type === "stdio") continue;
    const entry = (config[one.server] ??= { env: {}, headers: {} });
    entry.tokenHeader = { name: one.name, format: one.format };
  }
  // The user's variables go on top of what the binding set, for a stdio server only.
  for (const one of userEnv) {
    if (one.name.trim() === "" || one.value === "") continue;
    const server = plugin.servers?.find(
      (candidate) => candidate.name === one.server,
    );
    if (server === undefined || server.config.type !== "stdio") continue;
    const entry = (config[one.server] ??= { env: {}, headers: {} });
    entry.env = { ...entry.env, [one.name]: one.value };
  }
  return config;
}

function expand(text: string, root: string, data: string): string {
  return text.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_, which: string) =>
    which === "ROOT" ? root : data,
  );
}

/** A name a runtime takes for a server: unique across plugins, and letters, digits, `-` and `_`. */
export function sessionServerName(plugin: string, server: string): string {
  return `${plugin}-${server}`.replace(/[^\w-]/g, "_");
}

/** Whether an external runtime can attach this server. None that eta runs speaks legacy HTTP+SSE. */
export const serverSupported = (server: PluginServer): boolean =>
  server.config.type !== "sse";

/** A plugin's server with everything the machine decides filled in, before it takes a client's shape. */
export type ResolvedServer = {
  /** The name a client knows it by: `<plugin>-<server>`, see `sessionServerName`. */
  name: string;
  plugin: string;
  server: string;
} & (
  | {
      type: "stdio";
      /** A `./` command resolved against the plugin; a bare one is left to PATH. */
      command: string;
      args: string[];
      env: Record<string, string>;
      /** Filesystem-resolved, and inside the plugin or its data directory. */
      cwd: string;
    }
  | {
      type: "streamable-http" | "sse";
      url: string;
      /** The file's headers, with the extension's over them whatever their case. */
      headers: Record<string, string>;
      /** What the extension declares (`mcp.<server>.auth`); left out, `toMcpEntries` infers it. */
      auth?: false | "oauth";
      /** Some of `headers` are the user's: a 401 then means they were refused, not that a sign-in is due. */
      userHeaders?: boolean;
      tokenHeader?: { name: string; format: "raw" | "bearer" };
    }
);

/** What a plugin gives `resolvePluginServers`: the package and the values of its fields. */
export type PluginServersInput = Pick<ActivePlugin, "plugin" | "config">;

/** A server whose name another took first: it is left out, and the plugin's report says why. */
export interface ServerNameClash {
  plugin: string;
  server: string;
  name: string;
  /** The plugin and server that has the name. */
  takenBy: { plugin: string; server: string };
}

const clashReport = (clash: ServerNameClash): string =>
  `mcp.json: server ${clash.server} skipped: its name ${clash.name} is taken by server ${clash.takenBy.server} of plugin ${clash.takenBy.plugin}`;

/**
 * The names of these plugins' servers, in order, and the ones that lose theirs to an earlier
 * server: `a-b` + `c` and `a` + `b-c` meet, and so do two that differ only in what `_` replaced.
 * Nothing is overridden silently: the later one is out.
 */
export function claimServerNames(
  plugins: readonly Pick<PluginPackage, "manifest" | "servers">[],
): {
  clashes: ServerNameClash[];
  isTaken: (plugin: string, server: string) => boolean;
} {
  const owners = new Map<string, { plugin: string; server: string }>();
  const clashes: ServerNameClash[] = [];
  const lost = new Set<string>();
  for (const { manifest, servers } of plugins)
    for (const server of servers) {
      const name = sessionServerName(manifest.name, server.name);
      const owner = owners.get(name);
      if (owner === undefined) {
        owners.set(name, { plugin: manifest.name, server: server.name });
        continue;
      }
      clashes.push({
        plugin: manifest.name,
        server: server.name,
        name,
        takenBy: owner,
      });
      lost.add(`${manifest.name}\0${server.name}`);
    }
  return {
    clashes,
    isTaken: (plugin, server) => lost.has(`${plugin}\0${server}`),
  };
}

/** The filesystem-resolved form of a path whose last parts may not exist yet, synchronously. */
function resolvedPathSync(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path
      ? path
      : join(resolvedPathSync(parent), basename(path));
  }
}

function resolveStdio(
  server: PluginServer,
  plugin: PluginPackage,
  data: string,
  config: ServerConfig | undefined,
): ResolvedServer {
  if (server.config.type !== "stdio")
    throw new Error(`${server.name} is not a stdio server`);
  const { root } = plugin;
  const { command, args, env, cwd } = server.config;
  const dir =
    cwd === undefined
      ? root
      : resolvedPathSync(
          cwd.startsWith("./") ? resolve(root, cwd) : expand(cwd, root, data),
        );
  const dataRooted = cwd?.startsWith("${PLUGIN_DATA}") === true;
  if (!isWithin(dataRooted ? resolvedPathSync(data) : root, dir))
    throw new Error(`cwd of ${server.name} resolves outside its directory`);
  return {
    name: sessionServerName(plugin.manifest.name, server.name),
    plugin: plugin.manifest.name,
    server: server.name,
    type: "stdio",
    command: command.startsWith("./") ? resolve(root, command) : command,
    args: args.map((arg) => expand(arg, root, data)),
    env: {
      ...Object.fromEntries(
        Object.entries(env).map(([name, value]) => [
          name,
          expand(value, root, data),
        ]),
      ),
      ...config?.env,
      PLUGIN_ROOT: root,
      PLUGIN_DATA: data,
    },
    cwd: dir,
  };
}

/**
 * Every server of these plugins as this machine starts or reaches it: placeholders expanded, the
 * working directory checked, the extension's environment and headers added, the name made and
 * claimed. A server that cannot be resolved, or whose name is taken, is said to `warn` and left out.
 * Shared by both shapes below, so an external runtime and eta's own loop cannot disagree.
 */
export function resolvePluginServers(
  plugins: readonly PluginServersInput[],
  dataDir: string,
  warn: (message: string) => void,
): ResolvedServer[] {
  const { isTaken, clashes } = claimServerNames(
    plugins.map(({ plugin }) => plugin),
  );
  for (const clash of clashes)
    warn(`[eta] plugin ${clash.plugin}: ${clashReport(clash)}`);
  const resolved: ResolvedServer[] = [];
  for (const { plugin, config } of plugins) {
    const data = pluginDataDir(dataDir, plugin.manifest.name);
    for (const server of plugin.servers) {
      if (isTaken(plugin.manifest.name, server.name)) continue;
      if (server.config.type === "stdio") {
        try {
          resolved.push(
            resolveStdio(server, plugin, data, config[server.name]),
          );
        } catch (error) {
          warn(
            `[eta] plugin ${plugin.manifest.name}: ${error instanceof Error ? error.message : String(error)}; skipped`,
          );
        }
        continue;
      }
      const given = config[server.name]?.headers ?? {};
      const userHeaders = config[server.name]?.userHeaders === true;
      const auth = plugin.bindings[server.name]?.auth;
      const fixed = Object.entries(server.config.headers).filter(
        ([name]) =>
          !Object.keys(given).some(
            (added) => added.toLowerCase() === name.toLowerCase(),
          ),
      );
      resolved.push({
        name: sessionServerName(plugin.manifest.name, server.name),
        plugin: plugin.manifest.name,
        server: server.name,
        type: server.config.type,
        url: server.config.url,
        headers: { ...Object.fromEntries(fixed), ...given },
        ...(auth === undefined ? {} : { auth }),
        ...(userHeaders ? { userHeaders } : {}),
        ...(config[server.name]?.tokenHeader === undefined
          ? {}
          : { tokenHeader: config[server.name]!.tokenHeader! }),
      });
    }
  }
  return resolved;
}

/**
 * The shape an external runtime takes (oar's `SessionMcpServer`). A runtime has no working
 * directory for a stdio server, so it is started through `sh`; sse is left out.
 */
export function toSessionServers(
  servers: readonly ResolvedServer[],
  warn: (message: string) => void,
): SessionMcpServer[] {
  return servers.flatMap((server): SessionMcpServer[] => {
    if (server.type !== "stdio") {
      if (server.type === "sse") {
        warn(
          `[eta] plugin ${server.plugin}: server ${server.server} uses sse, which no runtime takes; skipped`,
        );
        return [];
      }
      return [
        {
          name: server.name,
          type: "http",
          url: server.url,
          ...(Object.keys(server.headers).length === 0
            ? {}
            : { headers: server.headers }),
        },
      ];
    }
    return [
      {
        name: server.name,
        command: "/bin/sh",
        args: [
          "-c",
          'cd "$0" && exec "$@"',
          server.cwd,
          server.command,
          ...server.args,
        ],
        env: server.env,
      },
    ];
  });
}

const hasAuthorization = (headers: Record<string, string>): boolean =>
  Object.keys(headers).some((name) => name.toLowerCase() === "authorization");

/**
 * A remote server's `auth` on eta's own loop: what the extension declares, else OAuth unless it is
 * already sent an `Authorization` header. The one place this is decided.
 */
function authOf(server: {
  url?: string;
  headers: Record<string, string>;
  auth?: false | "oauth";
  userHeaders?: boolean;
  tokenHeader?: unknown;
}): false | "oauth" | undefined {
  if (server.auth !== undefined) return server.auth;
  // A token header only means something with a sign-in.
  if (server.tokenHeader !== undefined) return "oauth";
  // The user chose how to authenticate: a refusal is reported as such, with no sign-in offered. A
  // Cursor-hosted server is two layers: the Cursor credential the user saved is a header, and the
  // service behind it (Google, say) still signs in with OAuth, unless the user sends Authorization.
  if (server.userHeaders === true)
    return server.url !== undefined &&
      isCursorServer(server.url) &&
      !hasAuthorization(server.headers)
      ? "oauth"
      : undefined;
  return hasAuthorization(server.headers) ? undefined : "oauth";
}

/**
 * The shape eta's own loop takes (`@eta/mcp`'s `McpServerEntry`), by name. A stdio server keeps
 * its working directory, sse is taken as it is, and a remote server's sign-in is `authOf`'s: one
 * that needs no sign-in never asks, and one declared `auth: false` never does.
 */
export function toMcpEntries(
  servers: readonly ResolvedServer[],
): Record<string, McpServerEntry> {
  return Object.fromEntries(
    servers.map((server): [string, McpServerEntry] => {
      if (server.type === "stdio")
        return [
          server.name,
          {
            type: "stdio",
            command: server.command,
            args: server.args,
            env: server.env,
            cwd: server.cwd,
          },
        ];
      const auth = authOf(server);
      return [
        server.name,
        {
          type: server.type,
          url: server.url,
          ...(Object.keys(server.headers).length === 0
            ? {}
            : { headers: server.headers }),
          ...(auth === undefined ? {} : { auth }),
          ...(server.tokenHeader === undefined
            ? {}
            : { tokenHeader: server.tokenHeader }),
        },
      ];
    }),
  );
}

/**
 * The sources eta's own loop gets from these plugins: one `plugin:<plugin>` each, in their order,
 * a plugin with no server left out. The primary and a daemon both call it, so a session gets the
 * same servers wherever it runs.
 */
export function pluginMcpSources(
  plugins: readonly PluginServersInput[],
  dataDir: string,
  warn: (message: string) => void,
): McpConfigSource[] {
  const resolved = resolvePluginServers(plugins, dataDir, warn);
  return plugins.flatMap(({ plugin }) => {
    const name = plugin.manifest.name;
    const servers = toMcpEntries(
      resolved.filter((server) => server.plugin === name),
    );
    return Object.keys(servers).length === 0
      ? []
      : [{ name: `plugin:${name}`, servers }];
  });
}

/** One plugin's servers as an external runtime takes them; the shape `runtimeExtras` gives. */
export function sessionServers(
  plugin: PluginPackage,
  dataDir: string,
  config: ServersConfig,
  warn: (message: string) => void,
): SessionMcpServer[] {
  return toSessionServers(
    resolvePluginServers([{ plugin, config }], dataDir, warn),
    warn,
  );
}

/** A plugin a session uses, on the machine the session runs on. */
export interface ActivePlugin {
  plugin: PluginPackage;
  hash: string;
  config: ServersConfig;
}

/** A directory holding only this plugin's skills, the way Claude Code reads a plugin. */
function skillsOnlyDir(active: ActivePlugin, dataDir: string): string {
  const { plugin, hash } = active;
  // By contents: a plugin that changes gets a new one, and nothing moves under a running session.
  const dir = join(
    dataDir,
    "plugin-runtime",
    "claude",
    hash,
    plugin.manifest.name,
  );
  const skills = join(dir, "skills");
  mkdirSync(skills, { recursive: true });
  for (const skill of plugin.skills) {
    try {
      symlinkSync(skill.dir, join(skills, skill.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return dir;
}

/**
 * What a session on an external runtime gets, with more servers after its plugins': a server whose
 * name is already taken is left out and reported, so no two of a name reach the runtime and an
 * installed plugin's server is never replaced.
 */
export function withSessionServers(
  extras: RuntimeExtras,
  added: readonly SessionMcpServer[],
  warn: (message: string) => void,
): RuntimeExtras {
  const servers = extras.mcpServers ?? [];
  const taken = new Set(servers.map((server) => server.name));
  const kept = added.filter((server) => {
    if (taken.has(server.name)) {
      warn(
        `[eta] server ${server.name} skipped: its name is taken by another server of the session`,
      );
      return false;
    }
    taken.add(server.name);
    return true;
  });
  return kept.length === 0
    ? extras
    : { ...extras, mcpServers: [...servers, ...kept] };
}

/** What a session on an external runtime gets from its plugins, wherever it runs. */
export async function runtimeExtras(
  plugins: readonly ActivePlugin[],
  options: {
    dataDir: string;
    runtime: string | undefined;
    warn: (message: string) => void;
  },
): Promise<RuntimeExtras> {
  const { dataDir, runtime, warn } = options;
  const mcpServers = toSessionServers(
    resolvePluginServers(plugins, dataDir, warn),
    warn,
  );
  const skilled = plugins.filter(({ plugin }) => plugin.skills.length > 0);
  if (runtime === "claude")
    return {
      mcpServers,
      launchArgs: skilled.flatMap((active) => [
        "--plugin-dir",
        skillsOnlyDir(active, dataDir),
      ]),
    };
  return {
    mcpServers,
    skills: await renderSkillDirs(
      skilled.flatMap(({ plugin }) => plugin.skills.map((skill) => skill.dir)),
      warn,
    ),
  };
}
