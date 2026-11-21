/**
 * The same protocol, on this machine.
 *
 * The environment's contract is not ssh — it is a set of `sh` scripts with exit
 * codes that mean things. This transport runs those scripts through the local
 * shell, which is what makes the environment testable in CI and what makes a
 * "remote" install usable on a machine that is already where the work is.
 *
 * What it does *not* exercise is the SSH hop itself: trust, retries, the shared
 * connection. Those live in `SshCommandTransport` and are covered by its own tests
 * (and by the real-target check, when one is configured).
 */

import type { SshResult, SshRunOptions, SshTransport } from "./transport";
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import process from "node:process";

const PROGRAM_FILES_SHELL = "C:\\Program Files\\Git\\usr\\bin\\sh.exe";

export interface WindowsShellProbe {
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  /** Output of `git --exec-path`, when git runs; scoop shims report the real install here. */
  gitExecPath: () => string | undefined;
}

const parentDir = (path: string, levels = 1): string =>
  path
    .split(/[\\/]+/)
    .slice(0, -levels)
    .join("\\");

/**
 * Bun on Windows cannot execute the POSIX literal `/bin/sh`. Git for Windows ships the same
 * shell the scripts are written for. Order: `ETA_LOCAL_SHELL`, the Git that `git.exe` on PATH
 * belongs to (scoop shims included), then the default Program Files install.
 */
export function windowsShell(probe: WindowsShellProbe): string {
  const override = probe.env.ETA_LOCAL_SHELL;
  if (override) return override;
  const roots: string[] = [];
  const execPath = probe.gitExecPath();
  // <root>\mingw64\libexec\git-core
  if (execPath) roots.push(parentDir(execPath.trim(), 3));
  for (const dir of (probe.env.PATH ?? "").split(";")) {
    if (dir && probe.exists(`${dir}\\git.exe`)) roots.push(parentDir(dir));
  }
  const candidates = [
    ...roots.map((root) => `${root}\\usr\\bin\\sh.exe`),
    PROGRAM_FILES_SHELL,
  ];
  const found = candidates.find((path) => probe.exists(path));
  if (found) return found;
  throw new Error(
    "Cannot find Git's sh.exe. Install Git for Windows, or set ETA_LOCAL_SHELL to the full path of its usr\\bin\\sh.exe.",
  );
}

/** PATH for the child: the chosen shell's Unix tools first, so the scripts find `mktemp`, `git`, ... */
export function windowsChildEnv(
  shell: string,
  path: string | undefined,
): { PATH: string } {
  const usrBin = parentDir(shell);
  const bin = `${parentDir(usrBin, 2)}\\bin`;
  return { PATH: `${usrBin};${bin};${path ?? ""}` };
}

function gitExecPath(): string | undefined {
  try {
    return execFileSync("git", ["--exec-path"], {
      encoding: "utf8",
      timeout: 5000,
    });
  } catch {
    return undefined;
  }
}

/** This machine's probe for `windowsShell`. Nothing is probed until the shell is asked for, so importing never throws. */
export const localWindowsProbe: WindowsShellProbe = {
  env: process.env,
  exists: existsSync,
  gitExecPath,
};

const shellCommand = (): string =>
  process.platform === "win32" ? windowsShell(localWindowsProbe) : "/bin/sh";

const childEnv = (): { PATH?: string } =>
  process.platform === "win32"
    ? windowsChildEnv(shellCommand(), process.env.PATH)
    : {};

/** Git Bash accepts drive paths with forward slashes; scripts receive shell-quoted paths. */
function windowsScript(script: string): string {
  return process.platform === "win32"
    ? script.replace(
        /'([a-z]:[^']*)'/gi,
        (_match, value: string) => `'${value.replaceAll("\\", "/")}'`,
      )
    : script;
}

/** Git Bash prints drive paths as `/c/...`; the product and Node use `C:/...`. */
function windowsOutput(output: string): string {
  return process.platform === "win32"
    ? output.replace(/(^|\n)\/([a-z])\//gi, "$1$2:/")
    : output;
}

export interface LocalTransportOptions {
  /** The "remote" home; defaults to this machine's. */
  home?: string | undefined;
  /** Where `mktemp` templates land; defaults to this machine's temp directory. */
  tempDir?: string | undefined;
}

export class LocalTransport implements SshTransport {
  readonly overSsh = false;
  readonly home: string;
  private readonly tempDir: string;

  constructor(options: LocalTransportOptions = {}) {
    this.home = options.home ?? homedir();
    this.tempDir = options.tempDir ?? tmpdir();
  }

  async run(script: string, options: SshRunOptions = {}): Promise<SshResult> {
    return await new Promise<SshResult>((resolve) => {
      const child = spawn(shellCommand(), ["-c", windowsScript(script)], {
        env: { ...process.env, ...childEnv(), TMPDIR: this.tempDir },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const settle = (result: SshResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        // eslint-disable-next-line ts/no-use-before-define -- onAbort and its cleanup call each other
        options.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = (): void => {
        child.kill("SIGTERM");
        settle({ code: 143, stdout: "", stderr: "aborted", aborted: true });
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        options.onChunk?.({ stream: "stdout", chunk: chunk.toString("utf8") });
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        options.onChunk?.({ stream: "stderr", chunk: chunk.toString("utf8") });
      });
      // A script that exits without reading its input leaves the write with no
      // reader (EPIPE); the exit code is the answer, so the write is not.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input ?? "");
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          child.kill("SIGTERM");
          settle({ code: 124, stdout: "", stderr: "timeout", timedOut: true });
        }, options.timeoutMs);
      }
      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      child.on("error", (error: Error) =>
        settle({ code: 127, stdout: "", stderr: error.message }),
      );
      child.on("close", (code: number | null) =>
        settle({
          code: code ?? 127,
          stdout: windowsOutput(Buffer.concat(stdout).toString("utf8")),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
    });
  }

  async close(): Promise<void> {
    // Nothing to release: every command was its own process.
  }
}
