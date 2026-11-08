/**
 * Proves that this platform's install script installs the build in a directory: the release
 * workflow runs it on each platform's runner after building eta and eta-host.
 *
 *   bun scripts/install/try-install.ts <directory>
 *
 * The directory holds `eta-<platform>` and `eta-host-<platform>` (`.exe` on Windows). They are
 * copied to a temporary directory with a `SHA256SUMS`, and the install script installs them with
 * `--from` into a temporary home. The installed files must be the same bytes, the installed
 * eta-host must print the same `--version`, and on Linux and macOS both must be executable.
 * A failure is printed as a GitHub Actions error annotation, and the exit code is 1.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const HERE = import.meta.dir;
const ON_WINDOWS = process.platform === "win32";
const ANY_EXECUTE = 0o111;

/** The builds there are, by Node's platform and architecture. */
const BUILDS: Record<string, string> = {
  "linux-x64": "linux-x64",
  "darwin-arm64": "darwin-arm64",
  "win32-x64": "windows-x64",
};

class TryFailure extends Error {}

interface Ran {
  code: number;
  output: string;
}

/** `argv` run to its end. A program that cannot be started at all comes back as exit code -1. */
async function run(argv: string[], env?: Record<string, string>): Promise<Ran> {
  let child;
  try {
    child = Bun.spawn(argv, {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return {
      code: -1,
      output: error instanceof Error ? error.message : String(error),
    };
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: `${stdout}${stderr}`.trim() };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * This process's environment for the install script, in `home`. `PSModulePath` is left out:
 * PowerShell 7 sets it to its own modules, which Windows PowerShell cannot load.
 */
function installEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name.toUpperCase() !== "PSMODULEPATH")
      env[name] = value;
  }
  env.HOME = home;
  if (ON_WINDOWS) env.USERPROFILE = home;
  return env;
}

function installCommand(release: string): string[] {
  return ON_WINDOWS
    ? [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(HERE, "install.ps1"),
        "-From",
        release,
      ]
    : ["sh", join(HERE, "install.sh"), "--from", release];
}

async function versionOf(path: string): Promise<Ran> {
  return await run([path, "--version"]);
}

/** The conclusion, or a `TryFailure` for each check that does not hold. */
async function tryInstall(dir: string): Promise<string> {
  const platform = BUILDS[`${process.platform}-${process.arch}`];
  if (platform === undefined)
    throw new TryFailure(
      `there is no build for ${process.platform}-${process.arch}`,
    );
  const exe = ON_WINDOWS ? ".exe" : "";
  const sources = {
    tui: join(dir, `eta-${platform}${exe}`),
    host: join(dir, `eta-host-${platform}${exe}`),
  };
  for (const path of Object.values(sources)) {
    if (!existsSync(path)) throw new TryFailure(`${path} does not exist`);
  }

  const temp = mkdtempSync(join(tmpdir(), "eta-try-install-"));
  try {
    const release = join(temp, "release");
    const home = join(temp, "home");
    mkdirSync(release);
    mkdirSync(home);
    const copies = {
      tui: join(release, `eta-${platform}${exe}`),
      host: join(release, `eta-host-${platform}${exe}`),
    };
    copyFileSync(sources.tui, copies.tui);
    copyFileSync(sources.host, copies.host);
    // A build downloaded as a workflow artifact has lost its execute bit.
    if (!ON_WINDOWS) chmodSync(copies.host, 0o755);
    writeFileSync(
      join(release, "SHA256SUMS"),
      `${sha256(copies.tui)}  eta-${platform}${exe}\n${sha256(copies.host)}  eta-host-${platform}${exe}\n`,
    );

    const installed = await run(installCommand(release), installEnv(home));
    if (installed.code !== 0)
      throw new TryFailure(
        `the install script exited with ${installed.code}: ${installed.output}`,
      );

    const bin = join(home, ".eta", "bin");
    const targets = {
      tui: join(bin, `eta${exe}`),
      host: join(bin, `eta-host${exe}`),
    };
    const problems: string[] = [];
    for (const which of ["tui", "host"] as const) {
      const target = targets[which];
      if (!existsSync(target)) {
        problems.push(`${target} was not installed`);
        continue;
      }
      if (!readFileSync(target).equals(readFileSync(sources[which])))
        problems.push(`${target} is not the same bytes as ${sources[which]}`);
      if (!ON_WINDOWS && (statSync(target).mode & ANY_EXECUTE) === 0)
        problems.push(`${target} is not executable`);
    }
    const expected = await versionOf(copies.host);
    let version = expected.output;
    if (existsSync(targets.host)) {
      const actual = await versionOf(targets.host);
      if (actual.code !== 0 || actual.output !== expected.output) {
        problems.push(
          `the installed eta-host --version says "${actual.output}" (exit ${actual.code}), and the build says "${expected.output}" (exit ${expected.code})`,
        );
      }
      version = actual.output;
    }
    if (problems.length > 0) throw new TryFailure(problems.join("\n"));
    return `try-install: the install script installed eta and eta-host for ${platform} (${version})`;
  } finally {
    removeTemporary(temp);
  }
}

/**
 * Removes the temporary directory. On Windows a program that has just run, or just been written,
 * can stay locked for a few seconds (a virus scanner reading it, say), so it is retried for a while,
 * and a directory still there after that is only a warning: the checks above have all been made.
 */
function removeTemporary(temp: string): void {
  try {
    rmSync(temp, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`::warning::could not remove ${temp}: ${message}\n`);
  }
}

async function main(): Promise<number> {
  const dir = process.argv[2];
  try {
    if (dir === undefined)
      throw new TryFailure(
        "usage: bun scripts/install/try-install.ts <directory>",
      );
    process.stdout.write(`${await tryInstall(dir)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const line of message.split("\n"))
      process.stdout.write(`::error::${line}\n`);
    return 1;
  }
}

process.exitCode = await main();
