/* eslint-disable no-template-curly-in-string -- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are the spec's literal placeholders */
/**
 * Reading an Agent Plugin (spec 1.0.0), the part the primary and a daemon share.
 *
 * ```
 * plugin.json              the manifest; eta's own data is under extensions["tech.0xfe.eta"]
 * skills/<name>/SKILL.md   Agent Skills
 * mcp.json                 MCP servers
 * ```
 *
 * The spec's failure boundaries are the shape of this file. A manifest that breaks the schema
 * rejects the plugin; an unknown top-level field is reported and ignored; a broken `mcp.json` turns
 * MCP off and leaves the skills; a broken server or skill is skipped alone. Nothing that was
 * skipped is lost to the user: it is in `reports`, and the settings page shows those.
 *
 * Reading runs none of the plugin. What becomes of the servers is `plugin-launch.ts`.
 */
import type { PluginField } from "@eta/client-contracts";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  ETA_EXTENSION,
  parseConfigFields,
} from "@eta/client-contracts/plugin-fields";
import { loadSkills } from "@eta/harness";

export class PluginError extends Error {
  override readonly name = "PluginError";
}

const PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const MANIFEST_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);
const RESERVED_ENV = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);
const ENV_NAME = /^[A-Z_]\w*$/i;
/** RFC 9110's `token`. */
const HEADER_NAME = /^[\w!#$%&'*+.^`|~-]+$/;
const COMMAND_NAME = /^[\w.+-]+$/;
/** `{field}` in a header template of the extension. */
const TEMPLATE_FIELD = /\{([A-Z_]\w*)\}/gi;

interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
}

interface PluginSkill {
  name: string;
  description: string;
  /** Its directory: `<root>/skills/<name>`. */
  dir: string;
}

type PluginServerConfig =
  | {
      type: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
    }
  | {
      type: "streamable-http" | "sse";
      url: string;
      headers: Record<string, string>;
    };

export interface PluginServer {
  name: string;
  config: PluginServerConfig;
}

/** What the extension says about one server: where the configuration goes. */
interface PluginServerBinding {
  /** Environment variable to field. */
  env: Record<string, string>;
  /** Header name to template (`Bearer {api_key}`). */
  headers: Record<string, string>;
}

export interface PluginPackage {
  /** The filesystem-resolved plugin root. */
  root: string;
  manifest: PluginManifest;
  /** What was found wrong and ignored, for the user. */
  reports: string[];
  skills: PluginSkill[];
  servers: PluginServer[];
  fields: PluginField[];
  /** Why `config` is invalid, when it is; the plugin cannot be configured until it is fixed. */
  configProblems: string[];
  bindings: Record<string, PluginServerBinding>;
  /** Commands it needs on a machine; only ever a hint. */
  requires: string[];
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isStringMap = (value: unknown): value is Record<string, string> =>
  isPlain(value) &&
  Object.values(value).every((item) => typeof item === "string");

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The filesystem-resolved form of a path whose last parts may not exist yet. */
export async function resolvedPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path
      ? path
      : join(await resolvedPath(parent), basename(path));
  }
}

/** Whether a filesystem-resolved path is `root` or under it. */
export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** The manifest, or the reason the plugin is rejected. */
function parseManifest(
  raw: unknown,
  reports: string[],
): { manifest: PluginManifest; extensions: Record<string, unknown> } {
  if (!isPlain(raw)) throw new PluginError("plugin.json must be a JSON object");
  for (const field of Object.keys(raw))
    if (!MANIFEST_FIELDS.has(field))
      reports.push(`plugin.json: unknown field ${field} was ignored`);
  if (raw.$schema !== PLUGIN_SCHEMA)
    throw new PluginError(
      `plugin.json: unsupported $schema ${JSON.stringify(raw.$schema)}`,
    );
  const { name } = raw;
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 64 ||
    !/^[a-z0-9.-]+$/.test(name) ||
    !/^[a-z0-9]/.test(name) ||
    !/[a-z0-9]$/.test(name) ||
    name.includes("--") ||
    name.includes("..")
  )
    throw new PluginError(`plugin.json: invalid name ${JSON.stringify(name)}`);
  for (const field of [
    "version",
    "description",
    "homepage",
    "repository",
    "license",
  ])
    if (raw[field] !== undefined && typeof raw[field] !== "string")
      throw new PluginError(`plugin.json: ${field} must be a string`);
  if (raw.keywords !== undefined && !isStrings(raw.keywords))
    throw new PluginError("plugin.json: keywords must be a list of strings");
  if (raw.author !== undefined) {
    const author = raw.author;
    if (
      !isPlain(author) ||
      Object.entries(author).some(
        ([key, value]) =>
          !["name", "email", "url"].includes(key) || typeof value !== "string",
      )
    )
      throw new PluginError(
        "plugin.json: author takes only name, email and url, as strings",
      );
  }
  let extensions: Record<string, unknown> = {};
  if (raw.extensions !== undefined) {
    if (isPlain(raw.extensions)) extensions = raw.extensions;
    else reports.push("plugin.json: extensions is not an object; ignored");
  }
  return {
    manifest: {
      name,
      ...(raw.version === undefined ? {} : { version: raw.version as string }),
      ...(raw.description === undefined
        ? {}
        : { description: raw.description as string }),
    },
    extensions,
  };
}

/** Whether text holds a control character other than a tab. */
const hasControl = (text: string): boolean =>
  [...text].some((char) => {
    const code = char.codePointAt(0)!;
    return (code < 0x20 && code !== 0x09) || code === 0x7f;
  });

/** Whether a header is one HTTP allows: a token for a name, no control characters in a value. */
function validHeaders(headers: Record<string, string>): boolean {
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const folded = name.toLowerCase();
    if (!HEADER_NAME.test(name) || seen.has(folded)) return false;
    seen.add(folded);
    if (hasControl(value)) return false;
  }
  return true;
}

function isLoopback(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** Why a remote server's `url` breaks §7.2.1, or nothing. */
function urlProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "url is not an absolute URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return "url must be http or https";
  if (url.username !== "" || url.password !== "")
    return "url must not contain user information";
  if (raw.includes("#")) return "url must not contain a fragment";
  if (url.protocol === "http:" && !isLoopback(url.hostname))
    return "a url that is not loopback must use https";
  return undefined;
}

const CLOSED_KEYS = {
  stdio: new Set(["type", "command", "args", "env", "cwd"]),
  remote: new Set(["type", "url", "headers"]),
};

/** One entry of `mcpServers`, or why it is skipped. */
async function parseServer(
  raw: unknown,
  root: string,
): Promise<PluginServerConfig | string> {
  if (!isPlain(raw)) return "must be an object";
  const type = raw.type;
  if (type === "streamable-http" || type === "sse") {
    for (const key of Object.keys(raw))
      if (!CLOSED_KEYS.remote.has(key)) return `unknown field ${key}`;
    if (typeof raw.url !== "string") return "url must be a string";
    const problem = urlProblem(raw.url);
    if (problem !== undefined) return problem;
    const headers = raw.headers ?? {};
    if (!isStringMap(headers)) return "headers must be strings";
    if (!validHeaders(headers)) return "headers are not valid HTTP headers";
    return { type, url: raw.url, headers };
  }
  if (type !== "stdio") return `unknown type ${JSON.stringify(type)}`;
  for (const key of Object.keys(raw))
    if (!CLOSED_KEYS.stdio.has(key)) return `unknown field ${key}`;
  const { command } = raw;
  if (typeof command !== "string" || command === "")
    return "command must be a string";
  if (command.startsWith("./")) {
    if (!isWithin(root, await resolvedPath(resolve(root, command))))
      return "command resolves outside the plugin";
  } else if (/[\s/\\]/.test(command)) {
    return "command must be one bare executable name or a ./ path";
  }
  const args = raw.args ?? [];
  if (!isStrings(args)) return "args must be strings";
  const env = raw.env ?? {};
  if (!isStringMap(env)) return "env must be strings";
  for (const name of Object.keys(env))
    if (RESERVED_ENV.has(name.toUpperCase()))
      return `env must not contain ${name}`;
  const { cwd } = raw;
  if (cwd !== undefined) {
    if (typeof cwd !== "string") return "cwd must be a string";
    const problem = await cwdProblem(cwd, root);
    if (problem !== undefined) return problem;
  }
  return {
    type,
    command,
    args,
    env,
    ...(typeof cwd === "string" ? { cwd } : {}),
  };
}

/** Why a `cwd` breaks §7.2.1. A `${PLUGIN_DATA}` one is checked again where that directory is. */
async function cwdProblem(
  cwd: string,
  root: string,
): Promise<string | undefined> {
  const rooted = /^\$\{PLUGIN_ROOT\}(?:\/|$)/.test(cwd);
  if (/^\$\{PLUGIN_DATA\}(?:\/|$)/.test(cwd))
    return isWithin("/d", resolve("/d", cwd.slice("${PLUGIN_DATA}/".length)))
      ? undefined
      : "cwd resolves outside the plugin's data";
  if (!rooted && !cwd.startsWith("./"))
    return "cwd must start with ./, ${PLUGIN_ROOT} or ${PLUGIN_DATA}";
  const path = rooted
    ? resolve(root, cwd.slice("${PLUGIN_ROOT}/".length))
    : resolve(root, cwd);
  return isWithin(root, await resolvedPath(path))
    ? undefined
    : "cwd resolves outside the plugin";
}

async function loadServers(
  root: string,
  reports: string[],
): Promise<PluginServer[]> {
  const path = join(root, "mcp.json");
  try {
    lstatSync(path);
  } catch {
    return [];
  }
  const refused = (why: string): PluginServer[] => {
    reports.push(`mcp.json: ${why}; MCP is off for this plugin`);
    return [];
  };
  if (!isWithin(root, await resolvedPath(path)))
    return refused("it resolves outside the plugin");
  if (!statSync(path, { throwIfNoEntry: false })?.isFile())
    return refused("it is not a file");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return refused(`not valid JSON (${messageOf(error)})`);
  }
  if (!isPlain(raw)) return refused("it is not an object");
  if (raw.$schema !== MCP_SCHEMA)
    return refused(`unsupported $schema ${JSON.stringify(raw.$schema)}`);
  const extra = Object.keys(raw).find(
    (key) => key !== "$schema" && key !== "mcpServers",
  );
  if (extra !== undefined) return refused(`unknown field ${extra}`);
  if (!isPlain(raw.mcpServers)) return refused("mcpServers is not an object");
  const servers: PluginServer[] = [];
  for (const [name, entry] of Object.entries(raw.mcpServers)) {
    const config = await parseServer(entry, root);
    if (typeof config === "string")
      reports.push(`mcp.json: server ${name} skipped: ${config}`);
    else servers.push({ name, config });
  }
  return servers;
}

async function loadSkillDirs(
  root: string,
  reports: string[],
): Promise<PluginSkill[]> {
  const location = join(root, "skills");
  try {
    lstatSync(location);
  } catch {
    return [];
  }
  const resolved = await resolvedPath(location);
  if (
    !isWithin(root, resolved) ||
    !statSync(location, { throwIfNoEntry: false })?.isDirectory()
  ) {
    reports.push("skills: not a directory inside the plugin; ignored");
    return [];
  }
  const skills: PluginSkill[] = [];
  for (const name of readdirSync(location).sort()) {
    const dir = join(location, name);
    // A README beside the skills is common, and under Bun a stat through a file throws.
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    const file = join(dir, "SKILL.md");
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    if (!isWithin(root, await resolvedPath(file))) {
      reports.push(`skills/${name}: resolves outside the plugin; skipped`);
      continue;
    }
    // One directory at a time: the spec looks at immediate children and goes no deeper.
    const { skills: found, diagnostics } = await loadSkills([dir]);
    const skill = found.find((candidate) => candidate.filePath === file);
    if (skill === undefined || diagnostics.length > 0) {
      const why =
        diagnostics.map((item) => item.message).join("; ") ||
        "it has no description";
      reports.push(`skills/${name}: skipped: ${why}`);
      continue;
    }
    skills.push({ name: skill.name, description: skill.description, dir });
  }
  return skills;
}

/** `extensions["tech.0xfe.eta"]`. Other namespaces are not ours to look at. */
function parseExtension(
  raw: unknown,
  servers: PluginServer[],
  reports: string[],
): Pick<
  PluginPackage,
  "fields" | "configProblems" | "bindings" | "requires" | "servers"
> {
  const empty = { fields: [], configProblems: [], bindings: {}, requires: [] };
  if (raw === undefined) return { ...empty, servers };
  if (!isPlain(raw)) {
    reports.push(`extensions.${ETA_EXTENSION} is not an object; ignored`);
    return { ...empty, servers };
  }
  for (const key of Object.keys(raw))
    if (!["config", "mcp", "requires"].includes(key))
      reports.push(`extensions.${ETA_EXTENSION}.${key} is unknown; ignored`);
  const { fields, problems: configProblems } = parseConfigFields(raw.config);
  const known = new Set(fields.map((field) => field.name));

  let requires: string[] = [];
  if (raw.requires !== undefined) {
    if (
      isStrings(raw.requires) &&
      raw.requires.every((command) => COMMAND_NAME.test(command))
    )
      requires = raw.requires;
    else reports.push("requires must be a list of command names; ignored");
  }

  const bindings: Record<string, PluginServerBinding> = {};
  /** Servers whose binding is broken: without it they would run without their configuration. */
  const broken = new Set<string>();
  const mcp = raw.mcp ?? {};
  if (!isPlain(mcp)) reports.push("mcp in the extension is not an object");
  else {
    for (const [server, binding] of Object.entries(mcp)) {
      if (!servers.some((entry) => entry.name === server)) {
        reports.push(`extension: mcp.${server} names no server of mcp.json`);
        continue;
      }
      const problem = bindingProblem(binding, known);
      if (problem !== undefined) {
        reports.push(`mcp.json: server ${server} skipped: ${problem}`);
        broken.add(server);
        continue;
      }
      const { env = {}, headers = {} } =
        binding as Partial<PluginServerBinding>;
      bindings[server] = { env, headers };
    }
  }
  return {
    fields,
    configProblems,
    bindings,
    requires,
    servers: servers.filter((server) => !broken.has(server.name)),
  };
}

/** What is wrong with one server's entry in the extension, or nothing. */
function bindingProblem(
  binding: unknown,
  fields: ReadonlySet<string>,
): string | undefined {
  if (!isPlain(binding)) return "its binding is not an object";
  const extra = Object.keys(binding).find(
    (key) => key !== "env" && key !== "headers",
  );
  if (extra !== undefined) return `its binding has an unknown key ${extra}`;
  const env = binding.env ?? {};
  const headers = binding.headers ?? {};
  if (!isStringMap(env) || !isStringMap(headers))
    return "env and headers of its binding must be strings";
  for (const [name, field] of Object.entries(env)) {
    if (!ENV_NAME.test(name) || RESERVED_ENV.has(name.toUpperCase()))
      return `${name} cannot be set from configuration`;
    if (!fields.has(field)) return `env ${name} names unknown field ${field}`;
  }
  if (!validHeaders(headers)) return "its headers are not valid HTTP headers";
  for (const [name, template] of Object.entries(headers))
    for (const [, field] of template.matchAll(TEMPLATE_FIELD))
      if (!fields.has(field!))
        return `header ${name} names unknown field ${field}`;
  return undefined;
}

/** The fields a header template fills in; `values` has each as text, or it is left out. */
export function fillTemplate(
  template: string,
  values: Readonly<Record<string, string | undefined>>,
): string | undefined {
  let complete = true;
  const filled = template.replace(TEMPLATE_FIELD, (_, field: string) => {
    const value = values[field];
    if (value === undefined) complete = false;
    return value ?? "";
  });
  return complete ? filled : undefined;
}

/** Read and validate the plugin at `dir`; throws `PluginError` when the spec rejects it. */
export async function loadPlugin(dir: string): Promise<PluginPackage> {
  const root = await resolvedPath(dir);
  const path = join(root, "plugin.json");
  if (!statSync(path, { throwIfNoEntry: false })?.isFile())
    throw new PluginError("plugin.json is missing");
  if (!isWithin(root, await resolvedPath(path)))
    throw new PluginError("plugin.json resolves outside the plugin");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PluginError(`plugin.json: ${messageOf(error)}`);
  }
  const reports: string[] = [];
  const { manifest, extensions } = parseManifest(raw, reports);
  const skills = await loadSkillDirs(root, reports);
  const listed = await loadServers(root, reports);
  const extension = parseExtension(extensions[ETA_EXTENSION], listed, reports);
  return { root, manifest, reports, skills, ...extension };
}
