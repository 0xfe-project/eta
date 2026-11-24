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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  ETA_EXTENSION,
  parseConfigFields,
} from "@eta/client-contracts/plugin-fields";
import { formatSkillName, loadSkills, parseSkillText } from "@eta/harness";

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
/**
 * Where a manifest is looked for, in order. The first is the spec's; the other two are the
 * Cursor and Claude Code plugin layouts, which share `skills/<name>/SKILL.md` with it.
 */
const MANIFEST_PATHS = [
  "plugin.json",
  ".cursor-plugin/plugin.json",
  ".claude-plugin/plugin.json",
] as const;
/** Fields only a Cursor or Claude Code manifest has, and eta reads nothing from. */
const FOREIGN_FIELDS = new Set(["displayName", "logo", "category", "tags"]);
/** (`logo` is kept as a path for the host to read safely; the rest is not read.) */
/** Components of those plugins that eta does not load. */
const FOREIGN_COMPONENTS = [
  "commands",
  "agents",
  "hooks",
  "rules",
  "lspServers",
  "outputStyles",
  "themes",
];
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
  /** Where the plugin says it lives; only a hint for its icon. */
  homepage?: string;
  /** The plugin's own picture, a path inside its root, as a Cursor or Claude manifest names it. Never read here. */
  logo?: string;
}

interface PluginSkill {
  name: string;
  description: string;
  /** Its directory: `<root>/skills/<name>`. */
  dir: string;
  /** The name the file gave, when it was not a legal one and `name` is the formatted one. */
  renamedFrom?: string;
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
  /**
   * A remote server's sign-in on eta's own loop: `false` never signs in (a 401 is an error),
   * `"oauth"` always may. Left out, it is inferred (`toMcpEntries`). Ignored on stdio.
   */
  auth?: false | "oauth";
}

export interface PluginPackage {
  /** The filesystem-resolved plugin root. */
  root: string;
  manifest: PluginManifest;
  /** What was found wrong and ignored, for the user. */
  reports: string[];
  /** The manifest path of a Claude Code or Cursor layout; absent for a native plugin.json. Information, not a problem. */
  layout?: string;
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

const isString = (value: unknown): value is string => typeof value === "string";

const isAuthor = (value: unknown): boolean =>
  isPlain(value) &&
  Object.entries(value).every(
    ([key, item]) =>
      ["name", "email", "url"].includes(key) && typeof item === "string",
  );

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isStringMap = (value: unknown): value is Record<string, string> =>
  isPlain(value) &&
  Object.values(value).every((item) => typeof item === "string");

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The filesystem-resolved form of a path whose last parts may not exist yet. */
async function resolvedPath(path: string): Promise<string> {
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

/** Whether a manifest's `skills` is `skills/`, or a list of directories that are under it. */
function skillsInPlace(value: unknown, root: string): boolean {
  const paths =
    typeof value === "string" ? [value] : isStrings(value) ? value : undefined;
  if (paths === undefined) return false;
  return paths.every((path) => {
    if (/^(?:\.\/)?skills\/?$/.test(path)) return true;
    const name = /^(?:\.\/)?skills\/([^/]+)\/?$/.exec(path)?.[1];
    return (
      name !== undefined &&
      name !== ".." &&
      statSync(join(root, "skills", name), {
        throwIfNoEntry: false,
      })?.isDirectory() === true
    );
  });
}

/** The manifest, or the reason the plugin is rejected. */
function parseManifest(
  raw: unknown,
  reports: string[],
  foreign: boolean,
  root: string,
): { manifest: PluginManifest; extensions: Record<string, unknown> } {
  if (!isPlain(raw)) throw new PluginError("plugin.json must be a JSON object");
  for (const field of Object.keys(raw)) {
    if (MANIFEST_FIELDS.has(field)) continue;
    if (foreign && FOREIGN_FIELDS.has(field)) continue;
    // Claude and Cursor manifests carry fields eta does not know; that is normal, not a problem.
    if (foreign && field === "mcpServers") continue;
    if (foreign && field === "skills") {
      if (!skillsInPlace(raw.skills, root))
        reports.push(
          "plugin.json: skills is not at skills/; only skills/ is read",
        );
    } else if (foreign && FOREIGN_COMPONENTS.includes(field))
      reports.push(`plugin.json: ${field} is not supported by eta; ignored`);
    else if (!foreign)
      reports.push(`plugin.json: unknown field ${field} was ignored`);
  }
  if (foreign) {
    // Someone else's manifest: a field that does not fit is left out, the plugin is not refused.
    const optional = {
      version: isString,
      description: isString,
      homepage: isString,
      repository: isString,
      license: isString,
      keywords: isStrings,
      author: isAuthor,
    } as const;
    for (const [field, fits] of Object.entries(optional))
      if (raw[field] !== undefined && !fits(raw[field])) {
        reports.push(`plugin.json: ${field} does not fit and was ignored`);
        delete raw[field];
      }
  } else if (raw.$schema !== PLUGIN_SCHEMA)
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
      ...(typeof raw.homepage === "string" ? { homepage: raw.homepage } : {}),
      ...(foreign && typeof raw.logo === "string" ? { logo: raw.logo } : {}),
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

/** `${NAME}` in a Claude Code or Cursor MCP file. */
const FOREIGN_VAR = /\$\{([^}]*)\}/g;
/** A variable that is a secret by its name. */
const SECRET_NAME = /key|token|secret|auth|password|credential/i;
/** Claude Code's file, then Cursor's. */
const FOREIGN_MCP_FILES = [".mcp.json", "mcp.json"] as const;
const FOREIGN_SERVER_KEYS = new Set([
  "type",
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "headers",
]);

interface ForeignServer {
  /** The server as eta's own `mcp.json` writes it. */
  raw: Record<string, unknown>;
  /** Environment variable to the variable of the file that fills it. */
  env: Record<string, string>;
  /** Header name to template (`Bearer {TOKEN}`). */
  headers: Record<string, string>;
  ignored: string[];
}

/** The variables of `text` other than the plugin's own directory, or why it cannot be used. */
function foreignVars(text: string): string[] | string {
  const names: string[] = [];
  for (const [, name] of text.matchAll(FOREIGN_VAR)) {
    if (name === "PLUGIN_ROOT") continue;
    if (!ENV_NAME.test(name!)) return `\${${name}} is not a plain variable`;
    names.push(name!);
  }
  return names;
}

/** One server of a Claude Code or Cursor file, in the shape eta's own file has, or why it is skipped. */
function mapForeignServer(entry: unknown): ForeignServer | string {
  if (!isPlain(entry)) return "must be an object";
  if (entry.auth !== undefined)
    return "it signs in with OAuth, which eta does not do for these plugins";
  const swap = (text: string): string =>
    text.replaceAll("${CLAUDE_PLUGIN_ROOT}", "${PLUGIN_ROOT}");
  const ignored = Object.keys(entry).filter(
    (key) => !FOREIGN_SERVER_KEYS.has(key),
  );
  const kind = entry.type ?? (typeof entry.url === "string" ? "http" : "stdio");
  const raw: Record<string, unknown> = {
    type: kind === "http" ? "streamable-http" : kind,
  };
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};

  if (raw.type === "stdio") {
    if (typeof entry.command !== "string") return "command must be a string";
    let command = swap(entry.command);
    if (command.startsWith("${PLUGIN_ROOT}/"))
      command = `./${command.slice("${PLUGIN_ROOT}/".length)}`;
    if (command.includes("${")) return "command holds a variable";
    raw.command = command;
    if (entry.args !== undefined) {
      if (!isStrings(entry.args)) return "args must be strings";
      const args = entry.args.map(swap);
      for (const arg of args) {
        const names = foreignVars(arg);
        if (typeof names === "string" || names.length > 0)
          return "args hold a variable eta cannot fill in";
      }
      raw.args = args;
    }
    if (entry.cwd !== undefined) {
      if (typeof entry.cwd !== "string") return "cwd must be a string";
      raw.cwd = swap(entry.cwd);
    }
    if (entry.env !== undefined) {
      if (!isStringMap(entry.env)) return "env must be strings";
      const fixed: Record<string, string> = {};
      for (const [name, value] of Object.entries(entry.env)) {
        const text = swap(value);
        const names = foreignVars(text);
        if (typeof names === "string") return `env ${name}: ${names}`;
        if (names.length === 0) fixed[name] = text;
        else if (names.length === 1 && text === `\${${names[0]}}`)
          env[name] = names[0]!;
        else return `env ${name} mixes text with a variable`;
      }
      raw.env = fixed;
    }
  } else {
    if (typeof entry.url !== "string") return "url must be a string";
    if (entry.url.includes("${")) return "url holds a variable";
    raw.url = entry.url;
    if (entry.headers !== undefined) {
      if (!isStringMap(entry.headers)) return "headers must be strings";
      const fixed: Record<string, string> = {};
      for (const [name, value] of Object.entries(entry.headers)) {
        const names = foreignVars(value);
        if (typeof names === "string") return `header ${name}: ${names}`;
        if (value.includes("${PLUGIN_ROOT}"))
          return `header ${name} holds the plugin directory`;
        if (names.length === 0) fixed[name] = value;
        else
          headers[name] = value.replace(
            FOREIGN_VAR,
            (_, field: string) => `{${field}}`,
          );
      }
      raw.headers = fixed;
    }
  }
  return { raw, env, headers, ignored };
}

/**
 * The MCP servers of a Cursor or Claude Code plugin: `.mcp.json` and a root `mcp.json`, both
 * `{ "mcpServers": { ... } }`. They become the servers eta's own file has; a `${VAR}` becomes a
 * field the user fills in after installing, and nothing runs before that.
 */
async function loadForeignServers(
  root: string,
  reports: string[],
  declared?: unknown,
): Promise<Pick<PluginPackage, "servers" | "fields" | "bindings">> {
  const servers: PluginServer[] = [];
  const bindings: Record<string, PluginServerBinding> = {};
  const specs: Record<string, unknown> = {};
  // What plugin.json's mcpServers names (a path, a list of paths, or the servers themselves),
  // then the conventional files; a file named twice is read once.
  const sources: { file: string; inline?: unknown; declared: boolean }[] = [];
  for (const item of Array.isArray(declared)
    ? declared
    : declared === undefined
      ? []
      : [declared]) {
    if (typeof item === "string") sources.push({ file: item, declared: true });
    else if (isPlain(item))
      sources.push({
        file: "plugin.json mcpServers",
        inline: item,
        declared: true,
      });
    else
      reports.push(
        "plugin.json: mcpServers must be a path or an object; ignored",
      );
  }
  for (const file of FOREIGN_MCP_FILES) sources.push({ file, declared: false });
  const read = new Set<string>();
  for (const source of sources) {
    const { file } = source;
    const refused = (why: string): void => {
      reports.push(`${file}: ${why}; its MCP servers are not loaded`);
    };
    let raw: unknown;
    if (source.inline !== undefined) raw = { mcpServers: source.inline };
    else {
      if (isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
        refused("the path must be relative and stay inside the plugin");
        continue;
      }
      const path = join(root, file);
      if (statSync(path, { throwIfNoEntry: false }) === undefined) {
        if (source.declared) refused("the file does not exist");
        continue;
      }
      const real = await resolvedPath(path);
      if (!isWithin(root, real)) {
        refused("it resolves outside the plugin");
        continue;
      }
      if (!statSync(path).isFile()) {
        refused("it is not a file");
        continue;
      }
      if (read.has(real)) continue;
      read.add(real);
      try {
        raw = JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        refused(`not valid JSON (${messageOf(error)})`);
        continue;
      }
    }
    if (!isPlain(raw) || !isPlain(raw.mcpServers)) {
      refused("it has no mcpServers object");
      continue;
    }
    for (const [name, entry] of Object.entries(raw.mcpServers)) {
      const skip = (why: string): void => {
        reports.push(`${file}: server ${name} skipped: ${why}`);
      };
      if (servers.some((server) => server.name === name)) {
        skip("a server of that name is already loaded");
        continue;
      }
      const mapped = mapForeignServer(entry);
      if (typeof mapped === "string") {
        skip(mapped);
        continue;
      }
      const config = await parseServer(mapped.raw, root);
      if (typeof config === "string") {
        skip(config);
        continue;
      }
      const names = [
        ...Object.values(mapped.env),
        ...Object.values(mapped.headers).flatMap((t) =>
          [...t.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!),
        ),
      ];
      const fresh: Record<string, unknown> = {};
      for (const variable of names)
        fresh[variable] = {
          type: "string",
          title: variable,
          description: `Used by the MCP server ${name}.`,
          required: true,
          secret: SECRET_NAME.test(variable),
        };
      const { problems } = parseConfigFields({ ...specs, ...fresh });
      if (problems.length > 0) {
        skip(
          `its variables cannot be configuration fields (${problems.join("; ")})`,
        );
        continue;
      }
      Object.assign(specs, fresh);
      servers.push({ name, config });
      if (
        Object.keys(mapped.env).length > 0 ||
        Object.keys(mapped.headers).length > 0
      )
        bindings[name] = { env: mapped.env, headers: mapped.headers };
      if (mapped.ignored.length > 0)
        reports.push(
          `${file}: server ${name}: ${mapped.ignored.join(", ")} not supported by eta; ignored`,
        );
    }
  }
  return { servers, bindings, fields: parseConfigFields(specs).fields };
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
  interface Found {
    dirName: string;
    dir: string;
    file: string;
    raw: string;
    legal: boolean;
  }
  const found: Found[] = [];
  for (const dirName of readdirSync(location).sort()) {
    const dir = join(location, dirName);
    const file = join(dir, "SKILL.md");
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    if (!isWithin(root, await resolvedPath(file))) {
      reports.push(`skills/${dirName}: resolves outside the plugin; skipped`);
      continue;
    }
    // One directory at a time: the spec looks at immediate children and goes no deeper.
    const parsed = parseSkillText(
      readFileSync(file, "utf8"),
      file,
      dirName,
      true,
    );
    if (parsed.skill === null) {
      const why =
        parsed.diagnostics.map((item) => item.message).join("; ") ||
        "it has no description";
      reports.push(`skills/${dirName}: skipped: ${why}`);
      continue;
    }
    // The harness loader honours the ignore files in the skill's directory; a skill it leaves out is
    // one they ignore (the text itself was read above).
    const visible = await loadSkills([dir]);
    if (!visible.skills.some((candidate) => candidate.filePath === file)) {
      reports.push(`skills/${dirName}: skipped: ignored by an ignore file`);
      continue;
    }
    found.push({
      dirName,
      dir,
      file,
      raw: parsed.skill.name,
      legal: parsed.diagnostics.length === 0,
    });
  }
  // Legal names keep theirs. A name that is not legal is formatted; when two end up the same, the
  // one whose directory sorts first keeps it and the next get -2, -3, so the result does not depend
  // on the order the directories were read in.
  const taken = new Set(found.filter((one) => one.legal).map((one) => one.raw));
  const skills: PluginSkill[] = [];
  for (const one of found) {
    let name = one.raw;
    if (!one.legal) {
      const base = formatSkillName(one.raw);
      if (base === "") {
        reports.push(
          `skills/${one.dirName}: skipped: name "${one.raw}" has no usable characters`,
        );
        continue;
      }
      name = base;
      for (let n = 2; taken.has(name); n++) {
        const suffix = `-${n}`;
        name = base.slice(0, 64 - suffix.length).replace(/-+$/, "") + suffix;
      }
      const checked = parseSkillText(
        readFileSync(one.file, "utf8"),
        one.file,
        one.dirName,
        true,
        name,
      );
      if (name === one.raw || checked.diagnostics.length > 0) {
        // Not a naming fault we fix (a name that is legal but not the directory's, a bad description).
        const why =
          checked.diagnostics.map((item) => item.message).join("; ") ||
          "the name does not match its directory";
        reports.push(`skills/${one.dirName}: skipped: ${why}`);
        continue;
      }
      taken.add(name);
      reports.push(`skills/${one.dirName}: renamed "${one.raw}" -> "${name}"`);
    }
    const description = parseSkillText(
      readFileSync(one.file, "utf8"),
      one.file,
      one.dirName,
      true,
      name,
    ).skill!.description;
    skills.push({
      name,
      description,
      dir: one.dir,
      ...(name === one.raw ? {} : { renamedFrom: one.raw }),
    });
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
      const {
        env = {},
        headers = {},
        auth,
      } = binding as Partial<PluginServerBinding>;
      const stdio =
        servers.find((entry) => entry.name === server)?.config.type === "stdio";
      if (auth !== undefined && stdio)
        reports.push(
          `extension: mcp.${server}.auth is for remote servers; ignored`,
        );
      bindings[server] = {
        env,
        headers,
        ...(auth === undefined || stdio ? {} : { auth }),
      };
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
    (key) => key !== "env" && key !== "headers" && key !== "auth",
  );
  if (extra !== undefined) return `its binding has an unknown key ${extra}`;
  if (
    binding.auth !== undefined &&
    binding.auth !== false &&
    binding.auth !== "oauth"
  )
    return 'its auth must be false or "oauth"';
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
  const found = MANIFEST_PATHS.find((candidate) =>
    statSync(join(root, candidate), { throwIfNoEntry: false })?.isFile(),
  );
  if (found === undefined) throw new PluginError("plugin.json is missing");
  const path = join(root, found);
  if (!isWithin(root, await resolvedPath(path)))
    throw new PluginError(`${found} resolves outside the plugin`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PluginError(`${found}: ${messageOf(error)}`);
  }
  const foreign = found !== "plugin.json";
  const reports: string[] = [];
  const { manifest, extensions } = parseManifest(raw, reports, foreign, root);
  const skills = await loadSkillDirs(root, reports);
  if (!foreign) {
    const listed = await loadServers(root, reports);
    const extension = parseExtension(
      extensions[ETA_EXTENSION],
      listed,
      reports,
    );
    return { root, manifest, reports, skills, ...extension };
  }
  const mapped = await loadForeignServers(
    root,
    reports,
    isPlain(raw) ? raw.mcpServers : undefined,
  );
  reportForeignParts(root, reports);
  const extension = parseExtension(
    extensions[ETA_EXTENSION],
    mapped.servers,
    reports,
  );
  return {
    root,
    manifest,
    reports,
    layout: found,
    skills,
    ...extension,
    fields: [...mapped.fields, ...extension.fields],
    bindings: { ...mapped.bindings, ...extension.bindings },
  };
}

/** What a Cursor or Claude Code plugin ships that eta does not load, for the user to see. */
function reportForeignParts(root: string, reports: string[]): void {
  for (const name of FOREIGN_COMPONENTS) {
    const kind = statSync(join(root, name), { throwIfNoEntry: false });
    if (kind === undefined) continue;
    reports.push(`${name}/: not supported by eta; ignored`);
  }
}
