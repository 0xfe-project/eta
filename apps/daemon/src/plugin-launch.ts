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
import type { McpServerEntry } from "@eta/mcp";
import type { RuntimeExtras } from "@eta/server";
import type { PluginPackage, PluginServer } from "./plugin-package";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { effectiveValue } from "@eta/client-contracts/plugin-fields";
import { renderSkillDirs } from "@eta/server";
import { fillTemplate, isWithin } from "./plugin-package";

/** The values one server gets, by name: resolved on the primary, kept in memory everywhere. */
interface ServerConfig {
  env?: Record<string, string>;
  headers?: Record<string, string>;
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
  plugin: Pick<PluginPackage, "bindings" | "fields">,
  values: Readonly<Record<string, PluginValue | null | undefined>>,
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
 * The shape eta's own loop takes (`@eta/mcp`'s `McpServerEntry`), by name. A stdio server keeps
 * its working directory, sse is taken as it is, and a remote server signs in with OAuth unless it
 * is already sent an `Authorization` header: one that needs no sign-in never asks.
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
      return [
        server.name,
        {
          type: server.type,
          url: server.url,
          ...(Object.keys(server.headers).length === 0
            ? {}
            : { headers: server.headers }),
          ...(hasAuthorization(server.headers)
            ? {}
            : { auth: "oauth" as const }),
        },
      ];
    }),
  );
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
