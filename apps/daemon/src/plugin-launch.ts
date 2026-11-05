/* eslint-disable no-template-curly-in-string -- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are the spec's literal placeholders */
/**
 * From a plugin's configuration to what a session is given, on the machine the session runs on.
 *
 * `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded once, in `args`, `env` and `cwd`, and nothing
 * else is (§9.2). The user's configuration does not go through that: the extension says which
 * variable or header each field becomes, and it is added here, so `mcp.json` stays a file any client
 * can read and the values stay out of the plugin's files.
 *
 * A runtime takes a stdio server as a command, arguments and an environment, with no working
 * directory, so one that must start in the plugin's directory is started through `sh`.
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
import type { RuntimeExtras } from "@eta/server";
import type { PluginPackage, PluginServer } from "./plugin-package";
import { mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { effectiveValue } from "@eta/client-contracts/plugin-fields";
import { renderSkillDirs } from "@eta/server";
import { fillTemplate, isWithin, resolvedPath } from "./plugin-package";

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

/** Whether a runtime can attach this server. No runtime eta runs on speaks legacy HTTP+SSE. */
export const serverSupported = (server: PluginServer): boolean =>
  server.config.type !== "sse";

async function stdioServer(
  server: PluginServer,
  plugin: PluginPackage,
  data: string,
  config: ServerConfig | undefined,
): Promise<SessionMcpServer> {
  if (server.config.type !== "stdio")
    throw new Error(`${server.name} is not a stdio server`);
  const { root } = plugin;
  const { command, args, env, cwd } = server.config;
  const dir =
    cwd === undefined
      ? root
      : await resolvedPath(
          cwd.startsWith("./") ? resolve(root, cwd) : expand(cwd, root, data),
        );
  const dataRooted = cwd?.startsWith("${PLUGIN_DATA}") === true;
  if (!isWithin(dataRooted ? await resolvedPath(data) : root, dir))
    throw new Error(`cwd of ${server.name} resolves outside its directory`);
  const target = command.startsWith("./") ? resolve(root, command) : command;
  return {
    name: sessionServerName(plugin.manifest.name, server.name),
    command: "/bin/sh",
    args: [
      "-c",
      'cd "$0" && exec "$@"',
      dir,
      target,
      ...args.map((arg) => expand(arg, root, data)),
    ],
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
  };
}

/** The plugin's servers as a runtime takes them, with what is not attached said to `warn`. */
export async function sessionServers(
  plugin: PluginPackage,
  dataDir: string,
  config: ServersConfig,
  warn: (message: string) => void,
): Promise<SessionMcpServer[]> {
  const servers: SessionMcpServer[] = [];
  const data = pluginDataDir(dataDir, plugin.manifest.name);
  for (const server of plugin.servers) {
    if (!serverSupported(server)) {
      warn(
        `[eta] plugin ${plugin.manifest.name}: server ${server.name} uses sse, which no runtime takes; skipped`,
      );
      continue;
    }
    if (server.config.type === "streamable-http") {
      const given = config[server.name]?.headers ?? {};
      const fixed = Object.entries(server.config.headers).filter(
        ([name]) =>
          !Object.keys(given).some(
            (added) => added.toLowerCase() === name.toLowerCase(),
          ),
      );
      const headers = { ...Object.fromEntries(fixed), ...given };
      servers.push({
        name: sessionServerName(plugin.manifest.name, server.name),
        type: "http",
        url: server.config.url,
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
      });
      continue;
    }
    try {
      servers.push(
        await stdioServer(server, plugin, data, config[server.name]),
      );
    } catch (error) {
      warn(
        `[eta] plugin ${plugin.manifest.name}: ${error instanceof Error ? error.message : String(error)}; skipped`,
      );
    }
  }
  return servers;
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
  const mcpServers: SessionMcpServer[] = [];
  for (const { plugin, config } of plugins)
    mcpServers.push(...(await sessionServers(plugin, dataDir, config, warn)));
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
