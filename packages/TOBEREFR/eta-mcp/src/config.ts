// Ported from pi-mcp-adapter/config.ts, utils.ts and metadata-cache.ts#computeServerHash (MIT, see ../NOTICE); no file discovery, imports from other tools or trust prompts.
/**
 * Servers come from sources the caller lists (the user's `mcp.json`, a project's
 * `.mcp.json`); this merges them and fingerprints each result.
 *
 * Ported from pi-mcp-adapter's `config.ts`, `utils.ts` and `metadata-cache.ts#computeServerHash`
 * (MIT), without its file discovery, imports from other tools, project trust and settings: where
 * the files live and which of them to trust is the caller's business here.
 */
import type {
  McpConfigSource,
  McpLifecycle,
  McpServerDefinition,
  McpServerEntry,
} from "./types";
import { createHash } from "node:crypto";
import process from "node:process";

export interface ResolvedServers {
  servers: Map<string, McpServerDefinition>;
  /** Entries that were skipped or partly ignored, as sentences for a log or a status page. */
  issues: string[];
}

const LIFECYCLES = new Set<McpLifecycle>([
  "lazy",
  "keep-alive",
  "lazy-keep-alive",
]);
const TYPES = new Set(["stdio", "http", "streamable-http", "sse"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

/** `${NAME}`, `$env:NAME` and `{env:NAME}` read the environment; a missing variable is empty. */
export function interpolateEnv(
  value: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return value
    .replace(/\$\{(\w+)\}/g, (_, name: string) => environment[name] ?? "")
    .replace(/\$env:(\w+)/g, (_, name: string) => environment[name] ?? "")
    .replace(/\{env:(\w+)\}/g, (_, name: string) => environment[name] ?? "");
}

function interpolateRecord(
  record: Record<string, string> | undefined,
  environment: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      interpolateEnv(value, environment),
    ]),
  );
}

/** Reads one server entry; fields of the wrong type are dropped and named in `issues`. */
function parseEntry(
  name: string,
  raw: unknown,
  issues: string[],
): McpServerEntry | undefined {
  if (!isRecord(raw)) {
    issues.push(`server "${name}": not an object`);
    return undefined;
  }
  const entry: McpServerEntry = {};
  const drop = (field: string): void => {
    issues.push(`server "${name}": ignored malformed "${field}"`);
  };
  const text = (field: keyof McpServerEntry): string | undefined => {
    const value = raw[field];
    if (value === undefined) return undefined;
    if (typeof value === "string" && value.length > 0) return value;
    drop(field);
    return undefined;
  };
  const flag = (field: keyof McpServerEntry): boolean | undefined => {
    const value = raw[field];
    if (value === undefined) return undefined;
    if (typeof value === "boolean") return value;
    drop(field);
    return undefined;
  };
  const amount = (field: keyof McpServerEntry): number | undefined => {
    const value = raw[field];
    if (value === undefined) return undefined;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
    drop(field);
    return undefined;
  };

  const command = text("command");
  const url = text("url");
  if (command !== undefined) entry.command = command;
  if (url !== undefined) entry.url = url;
  if (command === undefined && url === undefined) {
    issues.push(`server "${name}": needs a "command" or a "url"`);
    return undefined;
  }
  if (command !== undefined && url !== undefined) {
    issues.push(`server "${name}": has both "command" and "url"`);
    return undefined;
  }

  if (raw.args !== undefined) {
    const args = stringList(raw.args);
    if (args) entry.args = args;
    else drop("args");
  }
  for (const field of ["env", "headers"] as const) {
    if (raw[field] === undefined) continue;
    const record = stringRecord(raw[field]);
    if (record) entry[field] = record;
    else drop(field);
  }
  const cwd = text("cwd");
  if (cwd !== undefined) entry.cwd = cwd;
  const description = text("description");
  if (description !== undefined) entry.description = description;
  const bearerToken = text("bearerToken");
  if (bearerToken !== undefined) entry.bearerToken = bearerToken;
  const bearerTokenEnv = text("bearerTokenEnv");
  if (bearerTokenEnv !== undefined) entry.bearerTokenEnv = bearerTokenEnv;

  for (const field of ["inheritEnv", "disabled"] as const) {
    const value = flag(field);
    if (value !== undefined) entry[field] = value;
  }
  for (const field of ["idleTimeout", "requestTimeoutMs"] as const) {
    const value = amount(field);
    if (value !== undefined) entry[field] = value;
  }

  if (raw.type !== undefined) {
    if (typeof raw.type === "string" && TYPES.has(raw.type)) {
      entry.type = raw.type as NonNullable<McpServerEntry["type"]>;
    } else {
      drop("type");
    }
  }
  if (raw.auth !== undefined) {
    if (raw.auth === "oauth" || raw.auth === "bearer" || raw.auth === false) {
      entry.auth = raw.auth;
    } else {
      drop("auth");
    }
  }
  if (raw.lifecycle !== undefined) {
    if (
      typeof raw.lifecycle === "string" &&
      LIFECYCLES.has(raw.lifecycle as McpLifecycle)
    ) {
      entry.lifecycle = raw.lifecycle as McpLifecycle;
    } else {
      drop("lifecycle");
    }
  }
  if (raw.directTools !== undefined) {
    const list = stringList(raw.directTools);
    if (typeof raw.directTools === "boolean")
      entry.directTools = raw.directTools;
    else if (list) entry.directTools = list;
    else drop("directTools");
  }
  if (raw.approveTools !== undefined) {
    const list = stringList(raw.approveTools);
    if (
      typeof raw.approveTools === "boolean" ||
      raw.approveTools === "destructive"
    ) {
      entry.approveTools = raw.approveTools;
    } else if (list) {
      entry.approveTools = list;
    } else {
      drop("approveTools");
    }
  }
  for (const field of ["includeTools", "excludeTools"] as const) {
    if (raw[field] === undefined) continue;
    const list = stringList(raw[field]);
    if (list) entry[field] = list;
    else drop(field);
  }
  if (raw.searchKeywords !== undefined) {
    if (isRecord(raw.searchKeywords)) {
      const keywords: Record<string, string[]> = {};
      for (const [pattern, words] of Object.entries(raw.searchKeywords)) {
        const list = stringList(words);
        if (list) keywords[pattern] = list;
        else drop(`searchKeywords.${pattern}`);
      }
      entry.searchKeywords = keywords;
    } else {
      drop("searchKeywords");
    }
  }
  return entry;
}

/**
 * The servers in a parsed `mcp.json`: `{ "mcpServers": { ... } }`, or the bare map. Entries that
 * cannot work are left out and reported.
 */
export function parseMcpServers(json: unknown): {
  servers: Record<string, McpServerEntry>;
  issues: string[];
} {
  const issues: string[] = [];
  const servers: Record<string, McpServerEntry> = {};
  const map =
    isRecord(json) && isRecord(json.mcpServers) ? json.mcpServers : json;
  if (!isRecord(map)) {
    issues.push('no "mcpServers" object');
    return { servers, issues };
  }
  for (const [name, raw] of Object.entries(map)) {
    const entry = parseEntry(name, raw, issues);
    if (entry) servers[name] = entry;
  }
  return { servers, issues };
}

/** Sorted-key JSON, so equal values serialise equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

/** The bearer token a definition resolves to, if any. */
export function resolveBearerToken(
  entry: Pick<McpServerEntry, "bearerToken" | "bearerTokenEnv">,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (entry.bearerToken !== undefined) {
    return interpolateEnv(entry.bearerToken, environment);
  }
  return entry.bearerTokenEnv ? environment[entry.bearerTokenEnv] : undefined;
}

/**
 * Hashes what decides which tools a server exposes: how it is started or reached, who it acts as,
 * and which tools are filtered. Lifecycle, timeouts, direct tools, keywords and approval are
 * runtime behaviour and stay out, so changing them keeps the cache.
 */
export function computeServerHash(
  entry: McpServerEntry,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const identity = {
    command:
      entry.command === undefined
        ? undefined
        : interpolateEnv(entry.command, environment),
    args: entry.args?.map((arg) => interpolateEnv(arg, environment)),
    env: interpolateRecord(entry.env, environment),
    inheritEnv:
      entry.command === undefined ? undefined : entry.inheritEnv === true,
    cwd:
      entry.cwd === undefined
        ? undefined
        : interpolateEnv(entry.cwd, environment),
    url:
      entry.url === undefined
        ? undefined
        : interpolateEnv(entry.url, environment),
    headers: interpolateRecord(entry.headers, environment),
    type: entry.type,
    auth: entry.auth,
    bearer: resolveBearerToken(entry, environment),
    includeTools: entry.includeTools,
    excludeTools: entry.excludeTools,
  };
  return createHash("sha256").update(stableStringify(identity)).digest("hex");
}

/**
 * Merges the sources in order, a later source replacing an earlier one's server of the same name
 * as a whole (half of one server's settings and half of another's would be neither).
 */
export function resolveServers(
  sources: readonly McpConfigSource[],
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedServers {
  const servers = new Map<string, McpServerDefinition>();
  const issues: string[] = [];
  for (const source of sources) {
    for (const [name, entry] of Object.entries(source.servers)) {
      const replaced = servers.get(name);
      if (replaced) {
        issues.push(
          `server "${name}": "${source.name}" overrides "${replaced.source}"`,
        );
      }
      servers.set(name, {
        ...entry,
        name,
        source: source.name,
        hash: computeServerHash(entry, environment),
      });
    }
  }
  return { servers, issues };
}

export const DEFAULT_LIFECYCLE: McpLifecycle = "lazy";

export function lifecycleOf(definition: McpServerEntry): McpLifecycle {
  return definition.lifecycle ?? DEFAULT_LIFECYCLE;
}
