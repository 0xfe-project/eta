// Ported from pi-mcp-adapter/npx-resolver.ts (MIT, see ../../NOTICE).
/**
 * `npx -y pkg args` and `npm exec --package pkg -- bin args`, resolved to the executable inside
 * npm's `_npx` cache.
 */
import type { ChildProcess } from "node:child_process";
import type { LaunchCommand, ResolverEnv } from "./shared";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  binOfInstalledPackage,
  launchOf,
  parsePackageSpec,
  readResolution,
  writeResolution,
} from "./shared";

interface ParsedInvocation {
  packageSpec: string;
  binName?: string;
  extraArgs: string[];
}

export function parseNpxArgs(args: string[]): ParsedInvocation | null {
  const separator = args.indexOf("--");
  const before = separator >= 0 ? args.slice(0, separator) : args;
  const after = separator >= 0 ? args.slice(separator + 1) : [];

  const positionals: string[] = [];
  let packageSpec: string | undefined;
  let sawPackageFlag = false;
  let foundFirstPositional = false;

  for (let i = 0; i < before.length; i++) {
    const arg = before[i];
    if (arg === undefined) return null;
    if (foundFirstPositional) {
      positionals.push(arg);
      continue;
    }
    if (arg === "-y" || arg === "--yes") continue;
    if (arg === "-p" || arg === "--package") {
      const value = before[i + 1];
      if (!value || value.startsWith("-")) return null;
      packageSpec ??= value;
      sawPackageFlag = true;
      i++;
      continue;
    }
    if (arg.startsWith("--package=")) {
      const value = arg.slice("--package=".length);
      if (!value) return null;
      packageSpec ??= value;
      sawPackageFlag = true;
      continue;
    }
    // Any other flag changes what npx does (--no-install, --prefer-online, ...): not ours to guess.
    if (arg.startsWith("-")) return null;
    positionals.push(arg);
    foundFirstPositional = true;
  }

  const separated =
    separator >= 0 && after.length > 0 ? ["--", ...after] : after;

  if (sawPackageFlag) {
    const binName = positionals[0];
    if (!packageSpec || !binName) return null;
    return {
      packageSpec,
      binName,
      extraArgs: [...positionals.slice(1), ...separated],
    };
  }
  const first = positionals[0];
  if (!first) return null;
  return {
    packageSpec: first,
    extraArgs: [...positionals.slice(1), ...separated],
  };
}

export function parseNpmExecArgs(args: string[]): ParsedInvocation | null {
  if (args[0] !== "exec") return null;
  const execArgs = args.slice(1);
  const separator = execArgs.indexOf("--");
  if (separator < 0) return null;
  const before = execArgs.slice(0, separator);
  const after = execArgs.slice(separator + 1);

  let packageSpec: string | undefined;
  for (let i = 0; i < before.length; i++) {
    const arg = before[i];
    if (arg === undefined) return null;
    if (arg === "-y" || arg === "--yes") continue;
    if (arg === "--package") {
      const value = before[i + 1];
      if (!value || value.startsWith("-")) return null;
      packageSpec ??= value;
      i++;
      continue;
    }
    if (arg.startsWith("--package=")) {
      const value = arg.slice("--package=".length);
      if (!value) return null;
      packageSpec ??= value;
      continue;
    }
    if (arg.startsWith("-")) return null;
  }
  const binName = after[0];
  if (!packageSpec || !binName) return null;
  return { packageSpec, binName, extraArgs: after.slice(1) };
}

let npmCacheDirMemo: string | null | undefined;

function defaultNpmCacheDir(env: NodeJS.ProcessEnv): string | undefined {
  if (env.NPM_CONFIG_CACHE) return env.NPM_CONFIG_CACHE;
  if (npmCacheDirMemo === undefined) {
    try {
      const result = spawnSync("npm", ["config", "get", "cache"], {
        encoding: "utf8",
      });
      npmCacheDirMemo =
        result.status === 0 ? result.stdout.trim() || null : null;
    } catch {
      npmCacheDirMemo = null;
    }
  }
  return npmCacheDirMemo ?? undefined;
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** The newest `_npx/<hash>/node_modules/<package>` that has the package, at the exact version if one is pinned. */
function findInstalled(
  cacheDir: string,
  packageName: string,
  exactVersion: string | undefined,
): string | undefined {
  const npxDir = join(cacheDir, "_npx");
  if (!existsSync(npxDir)) return undefined;
  const parts = packageName.startsWith("@")
    ? packageName.split("/")
    : [packageName];
  const roots = readdirSync(npxDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      path: join(npxDir, entry.name),
      mtime: mtime(join(npxDir, entry.name)),
    }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const root of roots) {
    const directory = join(root.path, "node_modules", ...parts);
    const manifest = join(directory, "package.json");
    if (!existsSync(manifest)) continue;
    if (exactVersion) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
          version?: unknown;
        };
        if (pkg.version !== exactVersion) continue;
      } catch {
        continue;
      }
    }
    return directory;
  }
  return undefined;
}

const WARM_TIMEOUT_MS = 30_000;

/** Fills npm's cache without running the package: `npm exec` of a one-liner under that package. */
async function warmNpmCache(
  packageSpec: string,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(
        "npm",
        ["exec", "--yes", "--package", packageSpec, "--", "node", "-e", "1"],
        { stdio: "ignore" },
      );
    } catch {
      resolve();
      return;
    }
    // finish and stop refer to each other (and the timer to stop), so they are hoisted functions.
    let timer: ReturnType<typeof setTimeout> | undefined;
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve();
    }
    function stop(): void {
      child.kill();
      finish();
    }
    timer = setTimeout(stop, WARM_TIMEOUT_MS);
    timer.unref();
    signal?.addEventListener("abort", stop, { once: true });
    child.on("close", finish);
    child.on("error", finish);
  });
}

/** Resolves `npx …` / `npm exec …`; null for anything else or on any doubt. */
export async function resolveNpx(
  command: string,
  args: string[],
  env: ResolverEnv,
  signal?: AbortSignal,
): Promise<LaunchCommand | null> {
  const parsed =
    command === "npx"
      ? parseNpxArgs(args)
      : command === "npm"
        ? parseNpmExecArgs(args)
        : null;
  if (!parsed) return null;
  const spec = parsePackageSpec(parsed.packageSpec);
  if (!spec) return null;

  const key = JSON.stringify([
    command,
    parsed.packageSpec,
    parsed.binName ?? "",
  ]);
  const remembered = readResolution(env, key, spec);
  if (remembered) return launchOf(remembered, parsed.extraArgs);

  const cacheDir = (
    env.npmCacheDir ?? (() => defaultNpmCacheDir(env.env ?? process.env))
  )();
  if (!cacheDir) return null;
  const lookup = (): ReturnType<typeof binOfInstalledPackage> => {
    const directory = findInstalled(
      cacheDir,
      spec.packageName,
      spec.exactVersion,
    );
    return directory
      ? binOfInstalledPackage(directory, spec.packageName, parsed.binName)
      : null;
  };

  let resolved = lookup();
  if (!resolved && env.warm !== false) {
    await (env.warm ?? warmNpmCache)(parsed.packageSpec, signal);
    resolved = lookup();
  }
  if (!resolved) return null;
  writeResolution(env, key, resolved);
  return launchOf(resolved, parsed.extraArgs);
}
