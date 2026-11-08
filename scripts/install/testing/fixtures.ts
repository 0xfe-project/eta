/**
 * What the install script tests share: homes of their own, an environment without the
 * developer's tokens, release directories with their `SHA256SUMS`, and programs run to the end.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";

/**
 * Variables that would let a test reach a real repository or a real proxy, and `PSModulePath`:
 * PowerShell 7 sets it to its own modules, and a Windows PowerShell started under it then lacks
 * cmdlets such as `Get-FileHash`. Without it, each PowerShell finds its own.
 */
const INHERITED_BUT_NOT_WANTED = [
  "PSModulePath",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "ETA_RELEASES_URL",
  "ETA_RELEASES_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "CURL_HOME",
  "SHELL",
];

const tempDirs: string[] = [];

/** A new directory with a space in its name, which any unquoted path in a script trips on. */
export function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `eta install ${label}-`));
  tempDirs.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

/**
 * This process's environment without tokens, proxies, `SHELL` or `PATH`, plus `extra`.
 * Names are compared without case: Windows keeps one variable whatever the spelling.
 */
export function cleanEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const dropped = new Set(
    [...INHERITED_BUT_NOT_WANTED, "PATH", ...Object.keys(extra)].map((name) =>
      name.toUpperCase(),
    ),
  );
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !dropped.has(name.toUpperCase()))
      env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (value !== undefined) env[name] = value;
  }
  env.NO_PROXY = "127.0.0.1,localhost";
  return env;
}

function currentPath(): string {
  return (
    Object.entries(process.env).find(
      ([name]) => name.toUpperCase() === "PATH",
    )?.[1] ?? ""
  );
}

/**
 * Where Git for Windows keeps its POSIX tools, when they are not on `PATH` already: a terminal
 * other than Git Bash has only `git` itself there. Elsewhere, nothing.
 */
function gitForWindowsTools(): string[] {
  if (process.platform !== "win32" || Bun.which("sh") !== null) return [];
  const git = Bun.which("git");
  if (git === null) return [];
  const root = dirname(dirname(git));
  return [join(root, "usr", "bin"), join(root, "mingw64", "bin")];
}

/** `PATH` as the POSIX tests search it: this process's, then Git for Windows' tools. */
const POSIX_PATH: string = [currentPath(), ...gitForWindowsTools()].join(
  delimiter,
);

/** A POSIX tool on `POSIX_PATH`, or `null`. */
export function whichPosix(tool: string): string | null {
  return Bun.which(tool, { PATH: POSIX_PATH });
}

/** `POSIX_PATH` with `dirs` in front. */
export function pathWith(...dirs: string[]): string {
  return [...dirs, POSIX_PATH].join(delimiter);
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `SHA256SUMS` as `sha256sum` writes it. */
export function sumsFor(assets: Record<string, Uint8Array | string>): string {
  return Object.entries(assets)
    .map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`)
    .join("");
}

/** The `--version` line of a fake eta-host. */
export function versionLine(version: string): string {
  return `eta-host ${version} (37d8188c1234)`;
}

/** An eta-host for POSIX: a shell script that prints its version line. */
export function posixHost(version: string, extra = ""): string {
  return `#!/bin/sh\n# ${extra}\nif [ "$1" = "--version" ]; then\n  echo "${versionLine(version)}"\n  exit 0\nfi\nexit 3\n`;
}

/** The terminal interface is never run by the install script: any distinct bytes do. */
export function fakeTui(label: string): string {
  return `#!/bin/sh\necho "eta terminal ${label}"\n`;
}

interface PlatformFiles {
  tui: string;
  host: string;
}

/** The asset names for a platform, `.exe` on Windows. */
function assetNames(platform: string): PlatformFiles {
  const exe = platform.startsWith("windows") ? ".exe" : "";
  return { tui: `eta-${platform}${exe}`, host: `eta-host-${platform}${exe}` };
}

/** A release's three files for `platform`; `sums` replaces the correct `SHA256SUMS`. */
export function releaseAssets(
  platform: string,
  files: { tui: Uint8Array | string; host: Uint8Array | string },
  sums?: string,
): Record<string, Uint8Array | string> {
  const names = assetNames(platform);
  const pair = { [names.tui]: files.tui, [names.host]: files.host };
  return { ...pair, SHA256SUMS: sums ?? sumsFor(pair) };
}

/** Write `files` into `dir`; with `mode`, each gets that mode (it matters on POSIX only). */
export function writeFiles(
  dir: string,
  files: Record<string, Uint8Array | string>,
  mode?: number,
): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    if (mode !== undefined) chmodSync(path, mode);
  }
}

export interface Finished {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a program to its end; asynchronous, so a server in this process keeps answering. */
export async function runToEnd(
  argv: string[],
  options: { env: Record<string, string>; cwd?: string; timeoutMs?: number },
): Promise<Finished> {
  const child = Bun.spawn(argv, {
    env: options.env,
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 60_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
