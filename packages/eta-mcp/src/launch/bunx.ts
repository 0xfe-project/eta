// Ported from pi-mcp-adapter/npx-resolver.ts (MIT, see ../../NOTICE): the same cache and bin lookup for bunx.
/**
 * `bunx pkg args` (and `bun x pkg args`), resolved to the executable bunx unpacked.
 *
 * bunx keeps each package in its own directory under the temp directory,
 * `bunx-<uid>-<name>@<version or tag>/node_modules/<name>`. An exact version is found by its
 * directory name; a tag (`latest` when none was written) only while that directory is under
 * 24 hours old, the same freshness the other resolvers give a floating version. Nothing is run to
 * fill the cache: the first start goes through bunx, the next ones skip it.
 */
import type { LaunchCommand, ResolverEnv } from "./shared";
import { existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  binOfInstalledPackage,
  CACHE_TTL_MS,
  launchOf,
  parsePackageSpec,
  readResolution,
  writeResolution,
} from "./shared";

interface ParsedBunx {
  packageSpec: string;
  binName?: string;
  useBun: boolean;
  extraArgs: string[];
}

export function parseBunxArgs(args: string[]): ParsedBunx | null {
  let useBun = false;
  let packageSpec: string | undefined;
  let sawPackageFlag = false;
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) return null;
    if (arg === "--bun" || arg === "-b") {
      useBun = true;
      continue;
    }
    if (arg === "-p" || arg === "--package") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return null;
      packageSpec ??= value;
      sawPackageFlag = true;
      index++;
      continue;
    }
    if (arg.startsWith("--package=")) {
      packageSpec ??= arg.slice("--package=".length);
      sawPackageFlag = true;
      continue;
    }
    // --no-install, --force, --verbose and the rest change what bunx does: not ours to guess.
    if (arg.startsWith("-")) return null;
    break;
  }
  const rest = args.slice(index);
  if (sawPackageFlag) {
    const binName = rest[0];
    if (!packageSpec || !binName) return null;
    return { packageSpec, binName, useBun, extraArgs: rest.slice(1) };
  }
  const first = rest[0];
  if (!first) return null;
  return { packageSpec: first, useBun, extraArgs: rest.slice(1) };
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** `<dir>/node_modules/<package>` of the bunx directory for this package and version, if present. */
function findInstalled(
  env: ResolverEnv,
  packageName: string,
  exactVersion: string | undefined,
): string | undefined {
  const base = env.bunxDir ?? tmpdir();
  const uid = env.uid ?? process.getuid?.() ?? 0;
  const prefix = `bunx-${uid}-`;
  const parts = packageName.startsWith("@")
    ? packageName.split("/")
    : [packageName];
  let candidates: string[];
  if (exactVersion) {
    // For a scoped name the slash makes this the nested directory.
    candidates = [join(base, `${prefix}${packageName}@${exactVersion}`)];
  } else {
    // A tag: take the newest directory of this package, whatever tag it was fetched under.
    candidates = [];
    const names = existsSync(base) ? readdirSync(base) : [];
    for (const name of names) {
      if (name.startsWith(`${prefix}${packageName}@`))
        candidates.push(join(base, name));
    }
    if (packageName.startsWith("@")) {
      const scope = join(base, `${prefix}${parts[0]}`);
      if (existsSync(scope)) {
        for (const name of readdirSync(scope)) {
          if (name.startsWith(`${parts[1]}@`))
            candidates.push(join(scope, name));
        }
      }
    }
    candidates.sort((a, b) => mtime(b) - mtime(a));
  }

  const now = (env.now ?? Date.now)();
  for (const directory of candidates) {
    if (!existsSync(directory)) continue;
    if (!exactVersion && now - mtime(directory) >= CACHE_TTL_MS) continue;
    const installed = join(directory, "node_modules", ...parts);
    if (existsSync(join(installed, "package.json"))) return installed;
  }
  return undefined;
}

/** Resolves `bunx …` / `bun x …`; null for anything else or on any doubt. */
export function resolveBunx(
  command: string,
  args: string[],
  env: ResolverEnv,
): LaunchCommand | null {
  let invocation = args;
  if (command === "bun") {
    if (args[0] !== "x") return null;
    invocation = args.slice(1);
  } else if (command !== "bunx") {
    return null;
  }
  const parsed = parseBunxArgs(invocation);
  if (!parsed) return null;
  const spec = parsePackageSpec(parsed.packageSpec);
  if (!spec) return null;

  const key = JSON.stringify([
    "bunx",
    parsed.packageSpec,
    parsed.binName ?? "",
  ]);
  const runtime = parsed.useBun ? "bun" : "node";
  const remembered = readResolution(env, key, spec);
  if (remembered) return launchOf(remembered, parsed.extraArgs, runtime);

  const directory = findInstalled(env, spec.packageName, spec.exactVersion);
  if (!directory) return null;
  const resolved = binOfInstalledPackage(
    directory,
    spec.packageName,
    parsed.binName,
  );
  if (!resolved) return null;
  writeResolution(env, key, resolved);
  return launchOf(resolved, parsed.extraArgs, runtime);
}
