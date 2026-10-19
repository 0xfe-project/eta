/* eslint-disable no-template-curly-in-string -- `${NAME}` is the bundle format's own variable syntax */
/**
 * Environment bundles, the part both the primary and a daemon need.
 *
 * A bundle is a directory (the shapes are the old plugin's):
 *
 * ```
 * plugin.json        name, description, requires, config, service
 * mcp.json           { "mcpServers": { "<name>": { command, args, env, cwd } | { url, headers }, plus the
 *                    @eta/mcp fields: lifecycle, directTools, approveTools, auth, ... } }
 * skills/<name>/SKILL.md  Agent Skills (and whatever references they carry)
 * akhook.yml         hook rules, akhook's own file
 * ```
 *
 * This file reads one, turns it into what a session is given (skill directories, MCP server
 * configs, an akhook layer) and moves its files: from a directory to a map the primary can send,
 * and from a map to a directory a machine keeps under the contents' hash. Where bundles come from
 * and who they are configured by is the primary's business (`apps/eta/src/bundles`).
 *
 * The values a bundle's config holds reach exactly two kinds of process: its MCP servers (as
 * environment, and in `${NAME}` of a URL or header) and its hook commands (as environment). They
 * are not in the akhook text, not in the session's shell and not in a file.
 */
import type { McpServerEntry } from "@eta/mcp";
import type { ConfigInput } from "@eta/plugin-akhook";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import process from "node:process";
import { parseMcpServers } from "@eta/mcp";

export class BundleError extends Error {
  override readonly name = "BundleError";
}

/** One value the user gives a bundle. */
export interface BundleField {
  /** The environment variable it is given to the bundle's processes as. */
  name: string;
  title: string;
  description: string;
  secret: boolean;
  required: boolean;
  minLength: number;
  maxLength: number;
  pattern?: string | undefined;
}

/** A process the primary keeps for the bundle, on loopback. */
export interface BundleServiceSpec {
  /** Started in the bundle's directory; `${PLUGIN_ROOT}` is expanded in it. */
  command: string[];
  env: Record<string, string>;
  /** The path that answers once the service is up. */
  ready: string;
}

export interface BundleManifest {
  name: string;
  description: string;
  /** Commands that have to be on a machine's PATH for the bundle to work there. */
  requires: string[];
  config: BundleField[];
  service?: BundleServiceSpec | undefined;
}

export interface Bundle {
  manifest: BundleManifest;
  /** Where it is on this machine. */
  dir: string;
  mcp: Record<string, McpServerEntry>;
  /** The names of the skill directories it has. */
  skills: string[];
  /** The text of its `akhook.yml`, when it has one. */
  hooks: string | undefined;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIELD = /^[A-Z][A-Z0-9_]{0,63}$/;
/** What a bundle's config cannot name: the system's variables and eta's own. */
const RESERVED =
  /^(?:PATH|HOME|USER|SHELL|PWD|LANG|TMPDIR|ETA_.*|LD_.*|NODE_.*|BUN_.*|DYLD_.*)$/;
const COMMAND = /^[\w.+-]+$/;

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function strings(where: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new BundleError(`${where} must be a list of strings`);
  return value as string[];
}

function stringMap(where: string, value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (
    !isPlain(value) ||
    Object.values(value).some((item) => typeof item !== "string")
  )
    throw new BundleError(`${where} must be a mapping of strings`);
  return value as Record<string, string>;
}

function readJson(path: string, optional: boolean): unknown {
  if (!existsSync(path)) {
    if (optional) return undefined;
    throw new BundleError(`${path} is missing`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new BundleError(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function compiles(pattern: string): boolean {
  try {
    return new RegExp(pattern, "u") instanceof RegExp;
  } catch {
    return false;
  }
}

/** `config` is a JSON Schema of an object whose properties are strings (the old bundle's). */
function fieldsOf(raw: unknown): BundleField[] {
  if (raw === undefined) return [];
  if (!isPlain(raw) || !isPlain(raw.properties ?? {}))
    throw new BundleError("plugin.json: config must be an object schema");
  const required = new Set(strings("config.required", raw.required));
  const fields: BundleField[] = [];
  for (const [name, spec] of Object.entries(raw.properties ?? {})) {
    if (!FIELD.test(name) || RESERVED.test(name))
      throw new BundleError(`config: ${name} cannot be a config variable`);
    if (!isPlain(spec) || spec.type !== "string")
      throw new BundleError(`config.${name}: must be a string property`);
    const maxLength = spec.maxLength ?? 4096;
    if (
      typeof maxLength !== "number" ||
      !Number.isInteger(maxLength) ||
      maxLength < 1 ||
      maxLength > 4096
    )
      throw new BundleError(`config.${name}: maxLength must be 1 to 4096`);
    const minLength = spec.minLength ?? 0;
    if (
      typeof minLength !== "number" ||
      !Number.isInteger(minLength) ||
      minLength < 0 ||
      minLength > maxLength
    )
      throw new BundleError(`config.${name}: minLength must be 0 to maxLength`);
    if (spec.pattern !== undefined && !compiles(String(spec.pattern)))
      throw new BundleError(`config.${name}: pattern does not compile`);
    fields.push({
      name,
      title: typeof spec.title === "string" ? spec.title : name,
      description: typeof spec.description === "string" ? spec.description : "",
      secret: spec.writeOnly === true,
      required: required.has(name),
      minLength,
      maxLength,
      ...(typeof spec.pattern === "string" ? { pattern: spec.pattern } : {}),
    });
  }
  for (const name of required)
    if (!fields.some((field) => field.name === name))
      throw new BundleError(`config: required ${name} is not a property`);
  return fields;
}

function serviceOf(raw: unknown): BundleServiceSpec | undefined {
  if (raw === undefined) return undefined;
  if (!isPlain(raw))
    throw new BundleError("plugin.json: service must be a mapping");
  const command = strings("service.command", raw.command);
  if (command.length === 0)
    throw new BundleError("plugin.json: service.command is empty");
  return {
    command,
    env: stringMap("service.env", raw.env),
    ready: typeof raw.ready === "string" ? raw.ready : "/",
  };
}

function mcpOf(raw: unknown): Record<string, McpServerEntry> {
  if (raw === undefined) return {};
  if (!isPlain(raw) || !isPlain(raw.mcpServers ?? {}))
    throw new BundleError("mcp.json: mcpServers must be a mapping");
  const declared = raw.mcpServers ?? {};
  for (const [name, decl] of Object.entries(declared)) {
    if (!/^[\w-]{1,32}$/.test(name))
      throw new BundleError(`mcp.json: ${name} is not a usable server name`);
    if (!isPlain(decl))
      throw new BundleError(`mcp.json: ${name} must be a mapping`);
  }
  // The library reads the whole entry (lifecycle, directTools, approveTools, ...); a bundle that
  // writes one wrong is refused rather than half loaded.
  const { servers, issues } = parseMcpServers({ mcpServers: declared });
  if (issues.length > 0) throw new BundleError(`mcp.json: ${issues[0]}`);
  return servers;
}

/** Read a bundle's directory. Throws `BundleError` for anything that does not parse. */
export function readBundle(dir: string): Bundle {
  const manifest = readJson(join(dir, "plugin.json"), false);
  if (!isPlain(manifest))
    throw new BundleError("plugin.json must be a mapping");
  if (typeof manifest.name !== "string" || !NAME.test(manifest.name))
    throw new BundleError(
      "plugin.json: name must be lowercase letters, digits and hyphens",
    );
  const requires = strings("plugin.json requires", manifest.requires);
  for (const command of requires)
    if (!COMMAND.test(command))
      throw new BundleError(`plugin.json: ${command} is not a command name`);
  const skillsDir = join(dir, "skills");
  const skills = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            existsSync(join(skillsDir, entry.name, "SKILL.md")),
        )
        .map((entry) => entry.name)
        .sort()
    : [];
  const hooksPath = join(dir, "akhook.yml");
  return {
    dir,
    manifest: {
      name: manifest.name,
      description:
        typeof manifest.description === "string" ? manifest.description : "",
      requires,
      config: fieldsOf(manifest.config),
      service: serviceOf(manifest.service),
    },
    mcp: mcpOf(readJson(join(dir, "mcp.json"), true)),
    skills,
    hooks: existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : undefined,
  };
}

/** Check a value against its field; the message names the field, never the value. */
export function checkValue(field: BundleField, value: string): void {
  if (value.length > field.maxLength)
    throw new BundleError(`${field.name} is longer than ${field.maxLength}`);
  if (value.length < field.minLength)
    throw new BundleError(`${field.name} is shorter than ${field.minLength}`);
  if (
    field.pattern !== undefined &&
    !new RegExp(field.pattern, "u").test(value)
  )
    throw new BundleError(`${field.name} is not in the form it asks for`);
}

/** Whether every required field has a value. */
export function isConfigured(
  manifest: BundleManifest,
  config: Readonly<Record<string, string>>,
): boolean {
  return manifest.config.every(
    (field) => !field.required || (config[field.name] ?? "") !== "",
  );
}

/* ----------------------------------------------------------- what a session gets */

/** A bundle as one session loads it. */
export interface ActiveBundle {
  bundle: Bundle;
  /** The user's values; empty keys are left out. */
  config: Readonly<Record<string, string>>;
  /** Every required value is there. Without that only the skills load. */
  configured: boolean;
  /** Where the bundle's service listens, when it has one and this machine can reach it. */
  serviceUrl?: string | undefined;
  /**
   * The LLM gateway as this machine reaches it, with the agent's own key for it: `url` is the
   * address `/v1` hangs off. Held in memory, given to the bundle's MCP servers only.
   */
  gateway?: { url: string; key: string } | undefined;
}

export interface SessionVars {
  /** The session's working directory. */
  cwd: string;
}

const VARIABLE = /\$\{([A-Z_]\w*)\}/gi;

function expand(
  text: string,
  vars: Readonly<Record<string, string>>,
  where: string,
): string {
  return text.replace(VARIABLE, (_, name: string) => {
    const value = vars[name];
    if (value === undefined)
      throw new BundleError(`${where}: \${${name}} has no value here`);
    return value;
  });
}

function varsOf(active: ActiveBundle, session: SessionVars) {
  const vars: Record<string, string> = {};
  for (const field of active.bundle.manifest.config)
    vars[field.name] = active.config[field.name] ?? "";
  vars.PLUGIN_ROOT = active.bundle.dir;
  vars.ETA_WORKSPACE_DIR = session.cwd;
  if (active.serviceUrl !== undefined) vars.ETA_SERVICE_URL = active.serviceUrl;
  if (active.gateway !== undefined) {
    vars.ETA_GATEWAY_URL = active.gateway.url;
    vars.ETA_AGENT_KEY = active.gateway.key;
  }
  return vars;
}

/** The skill directories of the bundle (`<dir>/skills`), when it has skills. */
export function bundleSkillDirs(active: ActiveBundle): string[] {
  return active.bundle.skills.length === 0
    ? []
    : [join(active.bundle.dir, "skills")];
}

/**
 * The MCP servers of the bundle, ready for the MCP library to start on this machine. A bundle that is not configured
 * has none, and a server that asks for something this machine does not have (the service's
 * address, from a daemon) is reported and left out.
 */
export function bundleMcpServers(
  active: ActiveBundle,
  session: SessionVars,
  warn: (message: string) => void = () => undefined,
): Record<string, McpServerEntry> {
  if (!active.configured) return {};
  const vars = varsOf(active, session);
  const servers: Record<string, McpServerEntry> = {};
  for (const [name, decl] of Object.entries(active.bundle.mcp)) {
    const where = `bundle ${active.bundle.manifest.name}, server ${name}`;
    const fill = (text: string): string => expand(text, vars, where);
    const fillAll = (record: Record<string, string>): Record<string, string> =>
      Object.fromEntries(
        Object.entries(record).map(([key, value]) => [key, fill(value)]),
      );
    try {
      const entry: McpServerEntry = { ...decl };
      if (decl.command !== undefined) {
        // The config reaches the process as its environment, under the names it was declared by.
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(active.config))
          if (value !== "") env[key] = value;
        Object.assign(env, fillAll(decl.env ?? {}));
        entry.command = fill(decl.command);
        entry.args = (decl.args ?? []).map(fill);
        entry.env = env;
        entry.cwd = decl.cwd === undefined ? active.bundle.dir : fill(decl.cwd);
      }
      if (decl.url !== undefined) entry.url = fill(decl.url);
      if (decl.headers !== undefined) entry.headers = fillAll(decl.headers);
      if (decl.bearerToken !== undefined)
        entry.bearerToken = fill(decl.bearerToken);
      servers[name] = entry;
    } catch (error) {
      warn(`[eta] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return servers;
}

/**
 * The bundle's hook rules as an akhook layer: its text with the paths filled in, rule ids put
 * under the bundle's name, and the config values as the environment of its commands (the text
 * itself never holds them).
 */
export function bundleHookLayer(
  active: ActiveBundle,
  session: SessionVars,
): Extract<ConfigInput, { text: string }> | undefined {
  const { hooks, manifest, dir } = active.bundle;
  if (hooks === undefined || !active.configured) return undefined;
  const text = hooks
    .replaceAll("${PLUGIN_ROOT}", dir)
    .replaceAll("${ETA_WORKSPACE_DIR}", session.cwd);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(active.config))
    if (value !== "") env[key] = value;
  return {
    name: `bundle:${manifest.name}`,
    text,
    env,
    idPrefix: `${manifest.name}/`,
  };
}

/* ---------------------------------------------------------------- moving files */

/** One file of a bundle as it travels: its bytes in base64, and whether it runs. */
interface BundleFile {
  data: string;
  exec?: boolean | undefined;
}
export type BundleFiles = Record<string, BundleFile>;

/** What a bundle sent to a machine may weigh: it all rides one frame of the link. */
export const BUNDLE_LIMITS = { files: 400, bytes: 2 * 1024 * 1024 } as const;

const SKIPPED = new Set([".git", "node_modules", ".DS_Store"]);

/** The files of a bundle directory, for the link. Symlinks are not followed. */
export function snapshotBundle(dir: string): BundleFiles {
  const files: BundleFiles = {};
  let bytes = 0;
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), {
      withFileTypes: true,
    })) {
      if (SKIPPED.has(entry.name)) continue;
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const full = join(dir, path);
        const data = readFileSync(full);
        bytes += data.length;
        if (
          Object.keys(files).length >= BUNDLE_LIMITS.files ||
          bytes > BUNDLE_LIMITS.bytes
        )
          throw new BundleError(
            `the bundle is larger than ${BUNDLE_LIMITS.bytes / 1024 / 1024} MiB or ${BUNDLE_LIMITS.files} files`,
          );
        files[path] = {
          data: data.toString("base64"),
          ...((statSync(full).mode & 0o111) === 0 ? {} : { exec: true }),
        };
      }
    }
  };
  walk("");
  return files;
}

/** A name for these contents: the same files always have the same hash. */
export function hashBundle(files: BundleFiles): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    const file = files[path]!;
    hash.update(`${path}\0${file.exec === true ? "x" : "-"}\0${file.data}\0`);
  }
  return hash.digest("hex").slice(0, 24);
}

/** A machine's copies of bundles, each in a directory named by its contents' hash. */
export class BundleStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  dir(hash: string): string {
    if (!/^[0-9a-f]{24}$/.test(hash)) throw new BundleError("bad bundle hash");
    return join(this.#root, hash);
  }

  has(hash: string): boolean {
    return existsSync(this.dir(hash));
  }

  /** Keep these files under `hash`, after checking they are the contents it names. */
  put(hash: string, files: BundleFiles): void {
    if (hashBundle(files) !== hash)
      throw new BundleError(
        "the bundle's files are not the ones its hash names",
      );
    if (this.has(hash)) return;
    const target = this.dir(hash);
    const partial = `${target}.partial-${process.pid}-${Date.now()}`;
    try {
      for (const [path, file] of Object.entries(files)) {
        const clean = normalize(path);
        if (isAbsolute(clean) || clean === ".." || clean.startsWith(`..${sep}`))
          throw new BundleError(`${path} is outside the bundle`);
        const full = join(partial, clean);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, Buffer.from(file.data, "base64"), {
          mode: file.exec === true ? 0o755 : 0o644,
        });
      }
      mkdirSync(partial, { recursive: true });
      renameSync(partial, target);
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      // Another put of the same contents won the race.
      if (this.has(hash)) return;
      throw error;
    }
  }
}
