// Ported from pi-mcp-adapter/npx-resolver.ts (MIT, see ../../NOTICE): the resolution cache, package-spec parsing and bin lookup shared by the three runners.
/**
 * Pieces every launcher resolver needs: a 24 hour resolution cache, package specs, and finding an
 * installed package's executable.
 *
 * A resolver turns `npx -y pkg` (or `bunx`, `uvx`) into the executable the runner would end up
 * starting, so the runner's own process (npm alone sits at ~143 MB) and its resolution step
 * (a second or two per start) are skipped. Whenever anything is in doubt the resolver returns
 * nothing and the original command runs.
 */
import { Buffer } from "node:buffer";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import process from "node:process";

export const CACHE_VERSION = 1;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Z][0-9A-Z.-]*)?(?:\+[0-9A-Z][0-9A-Z.-]*)?$/i;

export interface LaunchCommand {
  command: string;
  args: string[];
}

/** Where a resolver looks, and what it may run. Every field is replaceable for tests. */
export interface ResolverEnv {
  /** Where resolutions are remembered; without it they are not. */
  cacheFile?: string | undefined;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** npm's cache directory (`_npx` lives in it). Default: `NPM_CONFIG_CACHE`, else `npm config get cache`. */
  npmCacheDir?: () => string | undefined;
  /** Where bunx unpacks packages. Default: the temp directory. */
  bunxDir?: string;
  /** The uid in bunx's directory names. Default: the process's. */
  uid?: number;
  /** uv's cache directory. Default: `UV_CACHE_DIR`, else `uv cache dir`. */
  uvCacheDir?: () => string | undefined;
  /** Fills npm's cache for a package nobody has run yet (the one step that runs a process). Off when false. */
  warm?: ((packageSpec: string, signal?: AbortSignal) => Promise<void>) | false;
}

export interface PackageSpec {
  packageName: string;
  /** Set only for an exact version; ranges and tags (`latest`, `^1`) are not pinned. */
  exactVersion?: string;
}

/** `name`, `name@tag`, `@scope/name@1.2.3`. Null for anything else (URLs, paths). */
export function parsePackageSpec(spec: string): PackageSpec | null {
  const trimmed = spec.trim();
  // URLs, paths, git specs and anything else that is not a registry name are not ours to resolve.
  if (!trimmed || /[\s:\\]/.test(trimmed) || trimmed.startsWith("."))
    return null;
  let packageName: string;
  let requested: string | undefined;
  if (trimmed.startsWith("@")) {
    const slash = trimmed.indexOf("/");
    if (slash < 0) return null;
    const at = trimmed.lastIndexOf("@");
    if (at > slash) {
      packageName = trimmed.slice(0, at);
      requested = trimmed.slice(at + 1);
    } else {
      packageName = trimmed;
    }
  } else {
    const at = trimmed.indexOf("@");
    packageName = at >= 0 ? trimmed.slice(0, at) : trimmed;
    requested = at >= 0 ? trimmed.slice(at + 1) : undefined;
  }
  if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(packageName)) return null;
  const version = requested?.replace(/^=/, "").replace(/^v/i, "");
  return {
    packageName,
    ...(version && EXACT_VERSION.test(version)
      ? { exactVersion: version }
      : {}),
  };
}

function defaultBinName(packageName: string): string {
  return packageName.startsWith("@")
    ? (packageName.split("/")[1] ?? packageName)
    : packageName;
}

/** The bin names a package is likely to use for itself, the explicit one first. */
function binCandidates(packageName: string, explicit?: string): string[] {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (packageName.startsWith("@")) {
    const [scope = "", name = ""] = packageName.slice(1).split("/");
    if (name) candidates.push(name);
    if (scope && name) candidates.push(`${scope}-${name}`);
  } else {
    candidates.push(packageName);
  }
  return [...new Set(candidates.filter(Boolean))];
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return "";
  }
}

/** A script run by node: a JS extension, or a `#!…node` first line. */
export function isNodeScript(path: string): boolean {
  const extension = extname(path).toLowerCase();
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs")
    return true;
  try {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(256);
      readSync(fd, buffer, 0, 256, 0);
      const first = buffer.toString("utf8").split("\n")[0] ?? "";
      return first.startsWith("#!") && first.includes("node");
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export interface ResolvedBin {
  bin: string;
  isNode: boolean;
  version?: string;
}

/**
 * The executable of a package installed at `packageDir` (`…/node_modules/<name>`): the `.bin` link
 * if there is one, else the path `package.json` names.
 */
export function binOfInstalledPackage(
  packageDir: string,
  packageName: string,
  binName?: string,
): ResolvedBin | null {
  let pkg: { bin?: string | Record<string, string>; version?: string };
  try {
    pkg = JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf8"),
    ) as typeof pkg;
  } catch {
    return null;
  }
  const field = pkg.bin;
  if (!field) return null;

  let chosen: string | undefined;
  let relative: string | undefined;
  if (typeof field === "string") {
    chosen = defaultBinName(packageName);
    relative = field;
  } else {
    for (const candidate of binCandidates(packageName, binName)) {
      const target = field[candidate];
      if (target) {
        chosen = candidate;
        relative = target;
        break;
      }
    }
    if (!relative) {
      // Not for an explicitly requested bin: `-p pkg other-bin` must not start a different one.
      if (binName) return null;
      const first = Object.entries(field)[0];
      if (first) [chosen, relative] = first;
    }
  }
  if (!relative) return null;

  const parts = packageDir.split(sep);
  const modules = parts.lastIndexOf("node_modules");
  const nodeModules =
    modules >= 0
      ? parts.slice(0, modules + 1).join(sep)
      : join(packageDir, "..");
  const link = chosen ? join(nodeModules, ".bin", chosen) : undefined;
  let bin = link && existsSync(link) ? safeRealpath(link) : "";
  if (!bin) {
    bin = resolve(packageDir, relative);
    if (!existsSync(bin)) return null;
  }
  return {
    bin,
    isNode: isNodeScript(bin),
    ...(pkg.version === undefined ? {} : { version: pkg.version }),
  };
}

interface StoredResolution {
  bin: string;
  resolvedAt: number;
  isNode: boolean;
  version?: string;
}

function readStore(file: string): Record<string, StoredResolution> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      version?: number;
      entries?: Record<string, StoredResolution>;
    };
    if (
      raw.version !== CACHE_VERSION ||
      typeof raw.entries !== "object" ||
      raw.entries === null
    ) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(raw.entries).filter(
        ([, entry]) =>
          typeof entry?.bin === "string" &&
          typeof entry.resolvedAt === "number" &&
          typeof entry.isNode === "boolean",
      ),
    );
  } catch {
    return {};
  }
}

/**
 * A resolution remembered for 24 hours. An exact version is remembered for as long as the file it
 * points at exists: that version cannot change under the same number.
 */
export function readResolution(
  env: ResolverEnv,
  key: string,
  spec: PackageSpec,
): ResolvedBin | null {
  if (!env.cacheFile) return null;
  const entry = readStore(env.cacheFile)[key];
  if (!entry || !existsSync(entry.bin)) return null;
  const now = (env.now ?? Date.now)();
  if (spec.exactVersion) {
    if (entry.version !== spec.exactVersion) return null;
  } else if (now - entry.resolvedAt >= CACHE_TTL_MS) {
    return null;
  }
  return {
    bin: entry.bin,
    isNode: entry.isNode,
    ...(entry.version === undefined ? {} : { version: entry.version }),
  };
}

export function writeResolution(
  env: ResolverEnv,
  key: string,
  resolved: ResolvedBin,
): void {
  if (!env.cacheFile) return;
  try {
    const entries = readStore(env.cacheFile);
    entries[key] = { ...resolved, resolvedAt: (env.now ?? Date.now)() };
    mkdirSync(dirname(env.cacheFile), { recursive: true });
    const temporary = `${env.cacheFile}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({ version: CACHE_VERSION, entries }),
      "utf8",
    );
    renameSync(temporary, env.cacheFile);
  } catch {
    // Remembering is best effort; the resolution itself already worked.
  }
}

/** How the resolved executable is started: node scripts through node, anything else directly. */
export function launchOf(
  resolved: ResolvedBin,
  extraArgs: string[],
  runtime = "node",
): LaunchCommand {
  return resolved.isNode
    ? { command: runtime, args: [resolved.bin, ...extraArgs] }
    : { command: resolved.bin, args: extraArgs };
}
