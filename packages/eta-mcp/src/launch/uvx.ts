// Ported from pi-mcp-adapter/npx-resolver.ts (MIT, see ../../NOTICE): the same cache and 24 hour rule for uvx.
/**
 * `uvx tool args` (and `uv tool run tool args`), resolved to the console script inside the
 * environment uv built for it.
 *
 * uv keeps ephemeral tool environments in `environments-v<N>/<hash>` under its cache directory,
 * and the hash covers more than the tool, so the environment is found by what is installed in it:
 * a `<tool>-<version>.dist-info` in its site-packages. An exact version must match; a floating one is taken only from an
 * environment under 24 hours old. Any flag other than `--from`, any version range or extras, and
 * any miss leave the original command alone.
 */
import type { LaunchCommand, ResolverEnv } from "./shared";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { CACHE_TTL_MS, readResolution, writeResolution } from "./shared";

interface ParsedUvx {
  /** The distribution to look for. */
  distribution: string;
  exactVersion?: string;
  /** The console script to start. */
  script: string;
  spec: string;
  extraArgs: string[];
}

const DISTRIBUTION = /^[A-Z0-9](?:[\w.-]*[A-Z0-9])?$/i;
const EXACT_PY_VERSION = /^\d+(?:\.\d+)*(?:(?:a|b|rc|\.post|\.dev)\d+)*$/;

/** `name`, `name@1.2.3`, `name==1.2.3`, `name@latest`; null for ranges, extras, URLs, paths. */
function parseDistribution(
  spec: string,
): { name: string; exactVersion?: string } | null {
  const pinned = spec.match(/^([^@=<>!~[\s]+)(?:==|@)(.+)$/);
  const name = pinned?.[1] ?? spec;
  const version = pinned?.[2];
  if (!DISTRIBUTION.test(name)) return null;
  if (version === undefined || version === "latest") return { name };
  return EXACT_PY_VERSION.test(version)
    ? { name, exactVersion: version }
    : null;
}

export function parseUvxArgs(args: string[]): ParsedUvx | null {
  let from: string | undefined;
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) return null;
    if (arg === "--from") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return null;
      from = value;
      index++;
      continue;
    }
    if (arg.startsWith("--from=")) {
      from = arg.slice("--from=".length);
      continue;
    }
    // --with, --python, --refresh and the rest change which environment runs: not ours to guess.
    if (arg.startsWith("-")) return null;
    break;
  }
  const first = args[index];
  if (!first) return null;
  const spec = from ?? first;
  const parsed = parseDistribution(spec);
  if (!parsed) return null;
  return {
    distribution: parsed.name,
    ...(parsed.exactVersion === undefined
      ? {}
      : { exactVersion: parsed.exactVersion }),
    script: from === undefined ? parsed.name : first,
    spec,
    extraArgs: args.slice(index + 1),
  };
}

let uvCacheMemo: string | null | undefined;

function defaultUvCacheDir(env: NodeJS.ProcessEnv): string | undefined {
  if (env.UV_CACHE_DIR) return env.UV_CACHE_DIR;
  if (uvCacheMemo === undefined) {
    try {
      const result = spawnSync("uv", ["cache", "dir"], { encoding: "utf8" });
      uvCacheMemo = result.status === 0 ? result.stdout.trim() || null : null;
    } catch {
      uvCacheMemo = null;
    }
  }
  return (
    uvCacheMemo ?? join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "uv")
  );
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Distribution names compare with `-`, `_` and `.` as one character, case aside. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "_");
}

/** The version of `distribution` installed in a uv environment, if it is. */
function installedVersion(
  environment: string,
  distribution: string,
): string | undefined {
  const lib = join(environment, "lib");
  if (!existsSync(lib)) return undefined;
  const wanted = normalize(distribution);
  for (const python of readdirSync(lib)) {
    const sitePackages = join(lib, python, "site-packages");
    if (!existsSync(sitePackages)) continue;
    for (const entry of readdirSync(sitePackages)) {
      // `<name with underscores>-<version>.dist-info`: the first dash ends the name.
      const dash = entry.indexOf("-");
      if (!entry.endsWith(".dist-info") || dash < 0) continue;
      if (normalize(entry.slice(0, dash)) !== wanted) continue;
      return entry.slice(dash + 1, -".dist-info".length);
    }
  }
  return undefined;
}

/** Resolves `uvx …` / `uv tool run …`; null for anything else or on any doubt. */
export function resolveUvx(
  command: string,
  args: string[],
  env: ResolverEnv,
): LaunchCommand | null {
  let invocation = args;
  if (command === "uv") {
    if (args[0] !== "tool" || args[1] !== "run") return null;
    invocation = args.slice(2);
  } else if (command !== "uvx") {
    return null;
  }
  const parsed = parseUvxArgs(invocation);
  if (!parsed) return null;

  const key = JSON.stringify(["uvx", parsed.spec, parsed.script]);
  const spec = {
    packageName: parsed.distribution,
    ...(parsed.exactVersion === undefined
      ? {}
      : { exactVersion: parsed.exactVersion }),
  };
  const remembered = readResolution(env, key, spec);
  if (remembered) return { command: remembered.bin, args: parsed.extraArgs };

  const cacheDir = (
    env.uvCacheDir ?? (() => defaultUvCacheDir(env.env ?? process.env))
  )();
  if (!cacheDir || !existsSync(cacheDir)) return null;
  const now = (env.now ?? Date.now)();
  const environments: Array<{ path: string; mtime: number }> = [];
  for (const group of readdirSync(cacheDir)) {
    if (!group.startsWith("environments-v")) continue;
    for (const name of readdirSync(join(cacheDir, group))) {
      const path = join(cacheDir, group, name);
      environments.push({ path, mtime: mtime(path) });
    }
  }
  environments.sort((a, b) => b.mtime - a.mtime);

  for (const candidate of environments) {
    if (!parsed.exactVersion && now - candidate.mtime >= CACHE_TTL_MS) continue;
    const version = installedVersion(candidate.path, parsed.distribution);
    if (version === undefined) continue;
    if (parsed.exactVersion && version !== parsed.exactVersion) continue;
    const bin = join(candidate.path, "bin", parsed.script);
    if (!existsSync(bin)) continue;
    writeResolution(env, key, { bin, isNode: false, version });
    return { command: bin, args: parsed.extraArgs };
  }
  return null;
}
