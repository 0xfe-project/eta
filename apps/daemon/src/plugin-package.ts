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
  "hooks",
  "rules",
  "lspServers",
  "outputStyles",
  "themes",
];
const MAX_AGENT_FILE_BYTES = 256 * 1024;
const MAX_PLUGIN_AGENTS = 64;
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
  /** Environment variable to field name, or a foreign `${VAR}` template for mixed env values. */
  env: Record<string, string>;
  /** Header name to template (`Bearer {api_key}`). */
  headers: Record<string, string>;
  /** Foreign argument templates by index (`{ 1: "--token=${TOKEN}" }`), when args hold `${VAR}`. */
  args?: Record<number, string>;
  /**
   * A remote server's sign-in on eta's own loop: `false` never signs in (a 401 is an error),
   * `"oauth"` always may. Left out, it is inferred (`toMcpEntries`). Ignored on stdio.
   */
  auth?: false | "oauth";
}

export interface LoadedPluginAgent {
  id: string;
  name: string;
  description: string;
  path: string;
  instructions: string;
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
  agents: LoadedPluginAgent[];
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
    if (foreign && (field === "mcpServers" || field === "agents")) continue;
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

/** `${NAME}` or `${NAME:-default}` in a Claude Code or Cursor MCP file. */
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
  "auth",
]);

interface ForeignVarRef {
  name: string;
  defaultValue?: string;
}

interface ForeignServer {
  /** The server as eta's own `mcp.json` writes it. */
  raw: Record<string, unknown>;
  /** Environment variable to the field name, or a `${VAR}` template for mixed values. */
  env: Record<string, string>;
  /** Header name to template (`Bearer {TOKEN}`). */
  headers: Record<string, string>;
  /** Argument templates by index, when args reference `${VAR}`. */
  args?: Record<number, string>;
  /** Remote server auth mode mapped from foreign `auth`, when declared. */
  auth?: false | "oauth";
  /** Every foreign variable referenced by this server, in order. */
  vars: ForeignVarRef[];
  ignored: string[];
  notices: string[];
}

/** Parse one `${...}` body (`NAME` or `NAME:-default`), or `null` for built-in placeholders. */
function parseForeignExpr(expr: string): ForeignVarRef | null | string {
  if (expr.includes("${")) return `\${${expr}} is not a plain variable`;
  const sep = expr.indexOf(":-");
  const name = sep === -1 ? expr : expr.slice(0, sep);
  const defaultValue = sep === -1 ? undefined : expr.slice(sep + 2);
  if (name === "PLUGIN_ROOT" || name === "PLUGIN_DATA")
    return defaultValue === undefined
      ? null
      : `\${${expr}} is not a plain variable`;
  if (!ENV_NAME.test(name)) return `\${${expr}} is not a plain variable`;
  return defaultValue === undefined ? { name } : { name, defaultValue };
}

/** The variables of `text` other than built-in placeholders, or why it cannot be used. */
function foreignVars(text: string): ForeignVarRef[] | string {
  const vars: ForeignVarRef[] = [];
  for (const [, expr] of text.matchAll(FOREIGN_VAR)) {
    const parsed = parseForeignExpr(expr!);
    if (typeof parsed === "string") return parsed;
    if (parsed !== null) vars.push(parsed);
  }
  return vars;
}

/** Variable names referenced by a foreign `${VAR}` / `${VAR:-default}` template. */
export function foreignVarNames(text: string): string[] {
  const parsed = foreignVars(text);
  return typeof parsed === "string" ? [] : parsed.map((one) => one.name);
}

/** Whether `text` is a single `${VAR}` or `${VAR:-default}` placeholder with no surrounding text. */
function singleForeignPlaceholder(text: string): string | undefined {
  const matches = [...text.matchAll(FOREIGN_VAR)];
  if (matches.length !== 1 || matches[0]![0] !== text) return undefined;
  const parsed = parseForeignExpr(matches[0]![1]!);
  return parsed !== null && typeof parsed !== "string"
    ? parsed.name
    : undefined;
}

/** Map a foreign server's `auth` field for remote or stdio servers. */
function parseForeignAuth(
  auth: unknown,
  stdio: boolean,
): { auth?: false | "oauth"; notice?: string; error?: string } {
  if (auth === undefined) return {};
  if (stdio) return { notice: "auth is for remote servers; ignored" };
  if (auth === false) return { auth: false };
  if (typeof auth === "string") {
    if (/^oauth2?$/i.test(auth)) return { auth: "oauth" };
    return { error: `unsupported auth mode ${JSON.stringify(auth)}` };
  }
  if (isPlain(auth) && typeof auth.type === "string") {
    if (/^oauth2?$/i.test(auth.type)) return { auth: "oauth" };
    if (auth.type.toLowerCase() === "none") return { auth: false };
    return { error: `unsupported auth type ${JSON.stringify(auth.type)}` };
  }
  return { error: "unsupported auth configuration" };
}

/** One server of a Claude Code or Cursor file, in the shape eta's own file has, or why it is skipped. */
function mapForeignServer(entry: unknown): ForeignServer | string {
  if (!isPlain(entry)) return "must be an object";
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
  const argTemplates: Record<number, string> = {};
  const vars: ForeignVarRef[] = [];
  const notices: string[] = [];

  const authMapped = parseForeignAuth(entry.auth, raw.type === "stdio");
  if (authMapped.error !== undefined) return authMapped.error;
  if (authMapped.notice !== undefined) notices.push(authMapped.notice);

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
      for (const [index, arg] of args.entries()) {
        const found = foreignVars(arg);
        if (typeof found === "string") return `args: ${found}`;
        if (found.length > 0) {
          argTemplates[index] = arg;
          vars.push(...found);
        }
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
        const found = foreignVars(text);
        if (typeof found === "string") return `env ${name}: ${found}`;
        if (found.length === 0) fixed[name] = text;
        else {
          if (RESERVED_ENV.has(name.toUpperCase()))
            return `env must not contain ${name}`;
          if (!ENV_NAME.test(name))
            return `${name} cannot be set from configuration`;
          vars.push(...found);
          const whole = singleForeignPlaceholder(text);
          env[name] = whole ?? text;
        }
      }
      raw.env = fixed;
    }
  } else {
    if (typeof entry.url !== "string") return "url must be a string";
    if (entry.url.includes("${")) return "url holds a variable";
    raw.url = entry.url;
    if (entry.headers !== undefined) {
      if (!isStringMap(entry.headers)) return "headers must be strings";
      if (!validHeaders(entry.headers))
        return "headers are not valid HTTP headers";
      const fixed: Record<string, string> = {};
      for (const [name, value] of Object.entries(entry.headers)) {
        const text = swap(value);
        if (text.includes("${PLUGIN_ROOT}") || text.includes("${PLUGIN_DATA}"))
          return `header ${name} holds the plugin directory`;
        const found = foreignVars(text);
        if (typeof found === "string") return `header ${name}: ${found}`;
        if (found.length === 0) fixed[name] = value;
        else {
          vars.push(...found);
          headers[name] = text.replace(FOREIGN_VAR, (_, expr: string) => {
            const parsed = parseForeignExpr(expr);
            return parsed !== null && typeof parsed !== "string"
              ? `{${parsed.name}}`
              : _;
          });
        }
      }
      raw.headers = fixed;
    }
  }
  return {
    raw,
    env,
    headers,
    ...(Object.keys(argTemplates).length === 0 ? {} : { args: argTemplates }),
    ...(authMapped.auth === undefined ? {} : { auth: authMapped.auth }),
    vars,
    ignored,
    notices,
  };
}

interface ForeignVarMeta {
  servers: string[];
  hasUndefaulted: boolean;
  defaultValue?: string;
  secret: boolean;
  hasNonEmptySecretDefault: boolean;
}

function foreignFieldSpec(
  variable: string,
  meta: ForeignVarMeta,
): Record<string, unknown> {
  const description =
    meta.servers.length === 1
      ? `Used by the MCP server ${meta.servers[0]}.`
      : `Used by the MCP servers ${meta.servers.join(", ")}.`;
  const required = meta.secret
    ? meta.hasUndefaulted || meta.hasNonEmptySecretDefault
    : meta.hasUndefaulted;
  const attachDefault =
    !meta.secret && !meta.hasUndefaulted && meta.defaultValue !== undefined;
  return {
    type: "string",
    title: variable,
    description,
    required,
    secret: meta.secret,
    ...(attachDefault ? { default: meta.defaultValue } : {}),
  };
}

/**
 * The MCP servers of a Cursor or Claude Code plugin: `.mcp.json` and a root `mcp.json`, either
 * `{ "mcpServers": { ... } }` or a flat top-level server map. They become the servers eta's own
 * file has; a `${VAR}` (or `${VAR:-default}`) becomes a field the user fills in after installing,
 * and nothing runs before that.
 */
async function loadForeignServers(
  root: string,
  reports: string[],
  declared?: unknown,
): Promise<Pick<PluginPackage, "servers" | "fields" | "bindings">> {
  const servers: PluginServer[] = [];
  const bindings: Record<string, PluginServerBinding> = {};
  const specs: Record<string, unknown> = {};
  const varMeta = new Map<string, ForeignVarMeta>();
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
    if (!isPlain(raw)) {
      refused("it is not an object");
      continue;
    }
    let serverMap: Record<string, unknown>;
    if (Object.hasOwn(raw, "mcpServers")) {
      if (!isPlain(raw.mcpServers)) {
        refused("it has no mcpServers object");
        continue;
      }
      serverMap = raw.mcpServers;
    } else {
      // Claude Code plugins may ship a flat top-level server map in `.mcp.json`.
      const entries = Object.entries(raw).filter(
        ([key, value]) => !(key === "$schema" && typeof value === "string"),
      );
      if (entries.length > 0 && entries.every(([, value]) => !isPlain(value))) {
        refused("it has no mcpServers object");
        continue;
      }
      serverMap = Object.fromEntries(entries);
    }
    for (const [name, entry] of Object.entries(serverMap)) {
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
      const nextMeta = new Map<string, ForeignVarMeta>();
      for (const { name: variable, defaultValue } of mapped.vars) {
        const existing = nextMeta.get(variable) ?? varMeta.get(variable);
        const secret = existing?.secret ?? SECRET_NAME.test(variable);
        const merged: ForeignVarMeta = existing
          ? { ...existing, servers: [...existing.servers] }
          : {
              servers: [],
              hasUndefaulted: false,
              secret,
              hasNonEmptySecretDefault: false,
            };
        if (!merged.servers.includes(name)) merged.servers.push(name);
        if (defaultValue === undefined) merged.hasUndefaulted = true;
        else if (secret) {
          if (defaultValue !== "") merged.hasNonEmptySecretDefault = true;
        } else if (merged.defaultValue === undefined) {
          merged.defaultValue = defaultValue;
        }
        nextMeta.set(variable, merged);
      }
      const fresh: Record<string, unknown> = {};
      for (const [variable, meta] of nextMeta)
        fresh[variable] = foreignFieldSpec(variable, meta);
      const { problems } = parseConfigFields({ ...specs, ...fresh });
      if (problems.length > 0) {
        skip(
          `its variables cannot be configuration fields (${problems.join("; ")})`,
        );
        continue;
      }
      for (const [variable, meta] of nextMeta) varMeta.set(variable, meta);
      Object.assign(specs, fresh);
      servers.push({ name, config });
      if (
        Object.keys(mapped.env).length > 0 ||
        Object.keys(mapped.headers).length > 0 ||
        mapped.args !== undefined ||
        mapped.auth !== undefined
      )
        bindings[name] = {
          env: mapped.env,
          headers: mapped.headers,
          ...(mapped.args === undefined ? {} : { args: mapped.args }),
          ...(mapped.auth === undefined ? {} : { auth: mapped.auth }),
        };
      for (const notice of mapped.notices)
        reports.push(`${file}: server ${name}: ${notice}`);
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
  extraFields: readonly PluginField[] = [],
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
  const known = new Set([
    ...fields.map((field) => field.name),
    ...(configProblems.length === 0
      ? extraFields.map((field) => field.name)
      : []),
  ]);

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

/** Merge a foreign server's auto-mapped binding with an explicit eta extension binding. */
function mergeBindings(
  base: PluginServerBinding | undefined,
  over: PluginServerBinding | undefined,
): PluginServerBinding | undefined {
  if (base === undefined) return over;
  if (over === undefined) return base;
  const overHeaderNames = new Set(
    Object.keys(over.headers).map((name) => name.toLowerCase()),
  );
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(base.headers).filter(
        ([name]) => !overHeaderNames.has(name.toLowerCase()),
      ),
    ),
    ...over.headers,
  };
  const auth = over.auth !== undefined ? over.auth : base.auth;
  return {
    env: { ...base.env, ...over.env },
    headers,
    ...(base.args === undefined ? {} : { args: { ...base.args } }),
    ...(auth === undefined ? {} : { auth }),
  };
}

const toPosixRelative = (root: string, path: string): string =>
  relative(root, path).split(sep).join("/");

function slugifyAgentId(stem: string): string {
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === ""
    ? "agent"
    : slug.slice(0, 64).replace(/-+$/, "") || "agent";
}

function humanizeStem(stem: string): string {
  const words = stem.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (words === "") return stem;
  return words.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function hasClosingQuote(text: string, quote: "'" | '"'): boolean {
  if (text.length < 2 || !text.endsWith(quote)) return false;
  if (quote === "'") {
    let count = 0;
    for (let i = text.length - 1; i >= 1 && text[i] === "'"; i--) count++;
    return count % 2 === 1;
  }
  let backslashes = 0;
  for (let i = text.length - 2; i >= 1 && text[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 0;
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    trimmed.startsWith("'") &&
    hasClosingQuote(trimmed, "'")
  )
    return trimmed.slice(1, -1).replaceAll("''", "'");
  if (
    trimmed.length >= 2 &&
    trimmed.startsWith('"') &&
    hasClosingQuote(trimmed, '"')
  )
    return trimmed.slice(1, -1).replace(/\\(.)/g, (_, escaped: string) => {
      if (escaped === "n") return "\n";
      if (escaped === "r") return "\r";
      if (escaped === "t") return "\t";
      if (escaped === '"') return '"';
      if (escaped === "\\") return "\\";
      return escaped;
    });
  if (trimmed === "null" || trimmed === "~") return "";
  return trimmed;
}

function parseBlockScalar(lines: string[], style: "|" | ">"): string {
  let end = lines.length - 1;
  while (end >= 0 && lines[end]!.trim() === "") end--;
  if (end < 0) return "";
  const slice = lines.slice(0, end + 1);
  let minIndent = Number.POSITIVE_INFINITY;
  for (const line of slice) {
    if (line.trim() === "") continue;
    const indent = /^[ \t]*/.exec(line)![0].length;
    if (indent < minIndent) minIndent = indent;
  }
  const dedented = slice.map((line) =>
    line.trim() === "" ? "" : line.slice(minIndent),
  );
  if (style === "|") return dedented.join("\n").trim();
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of dedented) {
    if (line === "") {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
    } else {
      current.push(line.trim());
    }
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs.join("\n\n").trim();
}

function parseAgentFrontmatter(lines: string[]): {
  name: string;
  description: string;
} {
  let name = "";
  let description = "";
  const assign = (key: string, value: string): void => {
    const clean = value.trim();
    if (key === "name") name = clean;
    else if (key === "description") description = clean;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    const match = /^([a-z_][\w-]*)[ \t]*:(.*)$/i.exec(line);
    if (match === null) {
      i++;
      continue;
    }
    const key = match[1]!;
    const rest = match[2]!.trim();
    i++;
    const blockHeader = /^([|>])(?:[+-]?\d*|\d*[+-]?)[ \t]*(?:#.*)?$/.exec(
      rest,
    );
    if (blockHeader !== null) {
      const blockLines: string[] = [];
      while (
        i < lines.length &&
        (lines[i]!.trim() === "" || /^[ \t]/.test(lines[i]!))
      ) {
        blockLines.push(lines[i]!);
        i++;
      }
      if (key === "name" || key === "description")
        assign(key, parseBlockScalar(blockLines, blockHeader[1] as "|" | ">"));
      continue;
    }
    if (rest === "") {
      const indented: string[] = [];
      while (
        i < lines.length &&
        (lines[i]!.trim() === "" || /^[ \t]/.test(lines[i]!))
      ) {
        indented.push(lines[i]!);
        i++;
      }
      if (key === "name" || key === "description") {
        const firstNonEmpty = indented.find((item) => item.trim() !== "");
        if (
          firstNonEmpty !== undefined &&
          !firstNonEmpty.trimStart().startsWith("- ")
        )
          assign(key, unquoteYamlScalar(parseBlockScalar(indented, ">")));
      }
      continue;
    }
    const quote = rest.startsWith('"')
      ? '"'
      : rest.startsWith("'")
        ? "'"
        : undefined;
    if (quote !== undefined) {
      let combined = rest;
      while (!hasClosingQuote(combined, quote) && i < lines.length) {
        combined = `${combined}\n${lines[i]!.trim()}`;
        i++;
      }
      if (key === "name" || key === "description")
        assign(key, unquoteYamlScalar(combined));
      continue;
    }
    const parts = [rest];
    while (i < lines.length && /^[ \t]+\S/.test(lines[i]!)) {
      parts.push(lines[i]!.trim());
      i++;
    }
    if (key === "name" || key === "description")
      assign(key, unquoteYamlScalar(parts.join(" ")));
  }
  return { name, description };
}

function extractFirstParagraph(lines: string[]): string {
  const isBlockStart = (line: string): boolean =>
    /^(?:#{1,6}[ \t]|```|~~~|>|[*+-][ \t]|\d+\.[ \t]|(?:---|\*\*\*|___)[ \t]*$|\|)/.test(
      line,
    );
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  const collected: string[] = [];
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (line === "" || isBlockStart(line)) break;
    collected.push(line);
    i++;
  }
  return collected.join(" ").trim();
}

function parseAgentMarkdown(
  text: string,
  stem: string,
): { name: string; description: string; instructions: string } | null {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (/^---[ \t]*(?:\n|$)/.test(normalized)) {
    const lines = normalized.split("\n");
    const closeIndex = lines.findIndex(
      (line, index) => index > 0 && /^---[ \t]*$/.test(line),
    );
    if (closeIndex !== -1) {
      const meta = parseAgentFrontmatter(lines.slice(1, closeIndex));
      const instructions = lines
        .slice(closeIndex + 1)
        .join("\n")
        .trim();
      if (instructions === "") return null;
      return {
        name: meta.name || humanizeStem(stem),
        description: meta.description,
        instructions,
      };
    }
  }
  const trimmed = normalized.trim();
  if (trimmed === "") return null;
  const lines = trimmed.split("\n");
  const firstLine = lines[0]!;
  if (/^#[ \t]+\S/.test(firstLine)) {
    const title = firstLine
      .slice(1)
      .trim()
      .replace(/[ \t]+#+$/, "")
      .trim();
    const name = title || humanizeStem(stem);
    const description = extractFirstParagraph(lines.slice(1));
    return { name, description, instructions: trimmed };
  }
  return {
    name: humanizeStem(stem),
    description: "",
    instructions: trimmed,
  };
}

interface AgentCandidate {
  relPath: string;
  fullPath: string;
  realPath: string;
  stem: string;
  size: number;
}

async function scanAgentDir(
  dir: string,
  root: string,
  reports: string[],
  candidates: AgentCandidate[],
  seenReal: Set<string>,
): Promise<void> {
  for (const entryName of readdirSync(dir).sort()) {
    if (entryName.startsWith(".")) continue;
    const entryPath = join(dir, entryName);
    const relEntry = toPosixRelative(root, entryPath);
    let linkStat;
    try {
      linkStat = lstatSync(entryPath);
    } catch {
      continue;
    }
    const real = await resolvedPath(entryPath);
    const stat = statSync(entryPath, { throwIfNoEntry: false });
    if (!isWithin(root, real)) {
      if (
        /\.md$/i.test(entryName) ||
        stat?.isDirectory() === true ||
        linkStat.isSymbolicLink()
      )
        reports.push(`${relEntry}: resolves outside the plugin; skipped`);
      continue;
    }
    if (stat === undefined) continue;
    if (stat.isFile()) {
      if (!/\.md$/i.test(entryName)) continue;
      if (seenReal.has(real)) continue;
      seenReal.add(real);
      candidates.push({
        relPath: relEntry,
        fullPath: entryPath,
        realPath: real,
        stem: entryName.replace(/\.md$/i, ""),
        size: stat.size,
      });
    } else if (stat.isDirectory()) {
      const nestedFile = join(entryPath, "AGENT.md");
      try {
        lstatSync(nestedFile);
      } catch {
        continue;
      }
      const relNested = toPosixRelative(root, nestedFile);
      const nestedReal = await resolvedPath(nestedFile);
      if (!isWithin(root, nestedReal)) {
        reports.push(`${relNested}: resolves outside the plugin; skipped`);
        continue;
      }
      const nestedStat = statSync(nestedFile, { throwIfNoEntry: false });
      if (nestedStat?.isFile() !== true) continue;
      if (seenReal.has(nestedReal)) continue;
      seenReal.add(nestedReal);
      candidates.push({
        relPath: relNested,
        fullPath: nestedFile,
        realPath: nestedReal,
        stem: entryName,
        size: nestedStat.size,
      });
    }
  }
}

async function loadPluginAgents(
  root: string,
  reports: string[],
  declared?: unknown,
): Promise<LoadedPluginAgent[]> {
  const candidates: AgentCandidate[] = [];
  const seenReal = new Set<string>();
  const scannedDirs = new Set<string>();
  const badPaths = new Set<string>();

  const scanOnce = async (dir: string, realDir: string): Promise<void> => {
    if (scannedDirs.has(realDir)) return;
    scannedDirs.add(realDir);
    await scanAgentDir(dir, root, reports, candidates, seenReal);
  };

  const defaultDir = join(root, "agents");
  let hasDefault = false;
  try {
    lstatSync(defaultDir);
    hasDefault = true;
  } catch {
    hasDefault = false;
  }
  if (hasDefault) {
    const resolved = await resolvedPath(defaultDir);
    if (
      !isWithin(root, resolved) ||
      statSync(defaultDir, { throwIfNoEntry: false })?.isDirectory() !== true
    ) {
      badPaths.add("agents");
      reports.push("agents: not a directory inside the plugin; ignored");
    } else {
      await scanOnce(defaultDir, resolved);
    }
  }

  if (declared !== undefined) {
    const items =
      typeof declared === "string"
        ? [declared]
        : Array.isArray(declared)
          ? declared
          : null;
    if (items === null) {
      reports.push(
        "plugin.json: agents must be a path or list of paths; ignored",
      );
    } else {
      for (const item of items) {
        if (typeof item !== "string" || item.trim() === "") {
          reports.push(
            "plugin.json: agents must be a path or list of paths; ignored",
          );
          continue;
        }
        if (isAbsolute(item) || item.split(/[\\/]/).includes("..")) {
          reports.push(
            `plugin.json: agents path ${item}: must be relative and stay inside the plugin; ignored`,
          );
          continue;
        }
        const target = join(root, item);
        const relTarget = toPosixRelative(root, target);
        if (badPaths.has(relTarget)) continue;
        let exists = false;
        try {
          lstatSync(target);
          exists = true;
        } catch {
          exists = false;
        }
        if (!exists) {
          reports.push(
            `plugin.json: agents path ${item}: does not exist; ignored`,
          );
          continue;
        }
        const real = await resolvedPath(target);
        if (!isWithin(root, real)) {
          reports.push(
            `plugin.json: agents path ${item}: resolves outside the plugin; ignored`,
          );
          continue;
        }
        const stat = statSync(target, { throwIfNoEntry: false });
        if (stat === undefined) {
          reports.push(
            `plugin.json: agents path ${item}: does not exist; ignored`,
          );
          continue;
        }
        if (stat.isDirectory()) {
          await scanOnce(target, real);
        } else if (stat.isFile()) {
          const fileName = basename(target);
          if (fileName.startsWith(".") || !/\.md$/i.test(fileName)) {
            reports.push(
              `plugin.json: agents path ${item}: must be a markdown file; ignored`,
            );
            continue;
          }
          if (seenReal.has(real)) continue;
          seenReal.add(real);
          candidates.push({
            relPath: relTarget,
            fullPath: target,
            realPath: real,
            stem: fileName.replace(/\.md$/i, ""),
            size: stat.size,
          });
        } else {
          reports.push(
            `plugin.json: agents path ${item}: not a file or directory; ignored`,
          );
        }
      }
    }
  }

  candidates.sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );

  const agents: LoadedPluginAgent[] = [];
  const usedIds = new Set<string>();
  const uniqueId = (base: string): string => {
    if (!usedIds.has(base)) {
      usedIds.add(base);
      return base;
    }
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      const candidate =
        base.slice(0, Math.max(1, 64 - suffix.length)).replace(/-+$/, "") +
        suffix;
      if (!usedIds.has(candidate)) {
        usedIds.add(candidate);
        return candidate;
      }
    }
  };

  for (const candidate of candidates) {
    if (candidate.size > MAX_AGENT_FILE_BYTES) {
      reports.push(`${candidate.relPath}: exceeds 256 KiB limit; skipped`);
      continue;
    }
    let text: string;
    try {
      text = readFileSync(candidate.fullPath, "utf8");
    } catch (error) {
      reports.push(
        `${candidate.relPath}: could not be read (${messageOf(error)}); skipped`,
      );
      continue;
    }
    const parsed = parseAgentMarkdown(text, candidate.stem);
    if (parsed === null) {
      reports.push(`${candidate.relPath}: empty instructions; skipped`);
      continue;
    }
    if (agents.length >= MAX_PLUGIN_AGENTS) {
      reports.push(
        `agents: limit of ${MAX_PLUGIN_AGENTS} agents reached; remaining files skipped`,
      );
      break;
    }
    agents.push({
      id: uniqueId(slugifyAgentId(candidate.stem)),
      name: parsed.name,
      description: parsed.description,
      path: candidate.relPath,
      instructions: parsed.instructions,
    });
  }
  return agents;
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
  const agents = await loadPluginAgents(
    root,
    reports,
    foreign && isPlain(raw) ? raw.agents : undefined,
  );
  if (!foreign) {
    const listed = await loadServers(root, reports);
    const extension = parseExtension(
      extensions[ETA_EXTENSION],
      listed,
      reports,
    );
    return { root, manifest, reports, skills, agents, ...extension };
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
    mapped.fields,
  );
  const extFieldsByName = new Map(
    extension.fields.map((field) => [field.name, field]),
  );
  const mappedFieldNames = new Set(mapped.fields.map((field) => field.name));
  const fields: PluginField[] = [
    ...mapped.fields.map((field) => extFieldsByName.get(field.name) ?? field),
    ...extension.fields.filter((field) => !mappedFieldNames.has(field.name)),
  ];
  const bindings: Record<string, PluginServerBinding> = {};
  for (const server of extension.servers) {
    const merged = mergeBindings(
      mapped.bindings[server.name],
      extension.bindings[server.name],
    );
    if (merged !== undefined) bindings[server.name] = merged;
  }
  return {
    root,
    manifest,
    reports,
    layout: found,
    skills,
    agents,
    ...extension,
    fields,
    bindings,
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
