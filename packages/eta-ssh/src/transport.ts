/**
 * The SSH transport: one command on another machine, and the trust that allows it.
 *
 * Everything above this file is the harness's own vocabulary (an `ExecutionEnv`, a
 * `FileSystem`, a `Shell`); everything below is OpenSSH. Keeping the seam here is
 * what makes the environment testable without a server: the protocol that the
 * environment speaks is a sequence of `sh` scripts, and a transport that runs
 * them *somewhere* — over SSH, or through the local shell — is enough to exercise it.
 *
 * What this file is responsible for, in order of how badly it goes wrong:
 *
 * - **Trust.** A host key is confirmed by fingerprint, never by "type yes": the
 *   caller can pass the fingerprint it expects, and a mismatch is refused. The
 *   prompt is captured through OpenSSH's own askpass hook with authentication
 *   disabled, so a password prompt can never be answered by it.
 * - **A retry budget.** Exit 255 is OpenSSH's "the connection itself failed"
 *   (a dropped link, a dead multiplex master). That is worth retrying a couple of
 *   times with a pause; a command that exited non-zero on the far side is not.
 * - **Reconnection.** A shared control socket is reused between commands, and a
 *   master that died between two of them is detected and replaced instead of
 *   surfacing as a mysterious failure of the command.
 */

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/** How to reach a machine. */
export interface SshTarget {
  host: string;
  user?: string | undefined;
  port?: number | undefined;
  /** A private key, as `~` may appear in it (OpenSSH expands it, this does too). */
  identityFile?: string | undefined;
  /** Extra `-o` options, verbatim. */
  options?: Record<string, string> | undefined;
}

/** One chunk of a command's output, tagged with the stream it arrived on. */
export interface SshStreamEvent {
  stream: "stdout" | "stderr";
  chunk: string;
}

/** What one remote command needs. */
export interface SshRunOptions {
  /** Written to the command's stdin. */
  input?: string | Uint8Array | undefined;
  /** Kill the command after this many milliseconds. */
  timeoutMs?: number | undefined;
  /** Cancels the command. */
  signal?: AbortSignal | undefined;
  /**
   * Called with each chunk as it arrives, in the order the machine produced them.
   * This is what makes a command's *interleaved* output available without asking a
   * shell to merge the two streams — the pipes already know.
   */
  onChunk?: ((event: SshStreamEvent) => void) | undefined;
}

export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The command was killed by its own timeout (not by the far side). */
  timedOut?: boolean | undefined;
  /** The command was cancelled through its signal. */
  aborted?: boolean | undefined;
}

/** One command on the far side. The environment is written against this alone. */
export interface SshTransport {
  /** The remote home directory; every relative path starts here. */
  readonly home: string;
  run: (script: string, options?: SshRunOptions) => Promise<SshResult>;
  /** Whether the transport is going through an SSH hop at all. */
  readonly overSsh: boolean;
  close: () => Promise<void>;
}

/** Quote one argument for `sh`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** A host name OpenSSH will accept as an argument rather than as an option. */
export function validHost(value: string): boolean {
  return /^[a-z0-9][\w.:-]{0,252}$/i.test(value);
}

/** The `ssh` arguments for a target: batch mode, no interactive prompts, own socket. */
export function sshArgs(
  target: SshTarget,
  control?: { path: string; persist: boolean },
): string[] {
  const args = [
    "-T",
    // Never fall back to a prompt: a missing key or a changed host key must be an
    // error the caller can report, not a hang nobody can see.
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=12",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  const options = { ...target.options };
  for (const [name, value] of Object.entries(options))
    args.push("-o", `${name}=${value}`);
  if (control === undefined) {
    args.push("-o", "ControlMaster=no", "-o", "ControlPath=none");
  } else {
    // A shared socket is what makes the second command cheap; it is also what has
    // to survive the first one dying.
    args.push("-o", "ControlMaster=auto", "-o", `ControlPath=${control.path}`);
    if (control.persist) args.push("-o", "ControlPersist=60");
  }
  if (target.port !== undefined) args.push("-p", String(target.port));
  if (target.user !== undefined) args.push("-l", target.user);
  if (target.identityFile !== undefined) {
    const file = target.identityFile.startsWith("~/")
      ? join(homedir(), target.identityFile.slice(2))
      : target.identityFile;
    args.push("-i", file);
  }
  return args;
}

export interface SshCommandTransportOptions {
  target: SshTarget;
  /**
   * The fingerprint the caller already trusted, when it has one. A different one
   * from what the host presents is refused — a changed host key is the one thing
   * this must never wave through.
   */
  expectedFingerprint?: string | undefined;
  /** How many times a *transport* failure (exit 255) is retried. Default 2. */
  retryBudget?: number | undefined;
  /** Pause between retries, in milliseconds. Default 250. */
  retryDelayMs?: number | undefined;
  /** Reuse one OpenSSH control socket across commands. Default true. */
  reuseConnection?: boolean | undefined;
  /** Diagnostics: a retry, a reconnection, a fingerprint being accepted. */
  warn?: ((message: string) => void) | undefined;
  /** The spawn function, injectable so the retry and reconnect paths can be tested. */
  spawnFn?: SpawnLike | undefined;
}

/** `spawn`, shaped as narrowly as this file needs it. */
export type SpawnLike = (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
) => {
  stdout: {
    on: (event: "data", listener: (chunk: Buffer) => void) => unknown;
  } | null;
  stderr: {
    on: (event: "data", listener: (chunk: Buffer) => void) => unknown;
  } | null;
  stdin: {
    write: (chunk: Uint8Array | string) => unknown;
    end: (chunk?: Uint8Array | string) => unknown;
  } | null;
  on: ((event: "close", listener: (code: number | null) => void) => unknown) &
    ((event: "error", listener: (error: Error) => void) => unknown);
  kill: (signal?: NodeJS.Signals) => unknown;
  pid?: number | undefined;
};

const DEFAULT_RETRY_BUDGET = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
/** OpenSSH's own "the connection failed rather than the command". */
const SSH_TRANSPORT_EXIT = 255;

export class SshCommandTransport implements SshTransport {
  readonly overSsh = true;
  readonly home: string;
  private readonly target: SshTarget;
  private readonly retryBudget: number;
  private readonly retryDelayMs: number;
  private readonly warn: (message: string) => void;
  private readonly spawnFn: SpawnLike;
  private readonly reuseConnection: boolean;
  private controlDirectory: string | undefined;
  private controlPath: string | undefined;
  private expectedFingerprint: string | undefined;

  private constructor(options: SshCommandTransportOptions, home: string) {
    this.target = options.target;
    this.retryBudget = options.retryBudget ?? DEFAULT_RETRY_BUDGET;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.warn = options.warn ?? (() => undefined);
    this.spawnFn = options.spawnFn ?? (spawn as unknown as SpawnLike);
    this.reuseConnection = options.reuseConnection ?? true;
    this.expectedFingerprint = options.expectedFingerprint;
    this.home = home;
  }

  /**
   * Reach the machine: confirm its host key, then ask it where home is.
   *
   * The order matters. Nothing is read from the host before its key is either
   * already in `known_hosts` or the fingerprint the caller expects — a first
   * connection with an `expectedFingerprint` is how trust is *established*, and a
   * connection without one can still succeed when OpenSSH already knows the host.
   */
  static async connect(
    options: SshCommandTransportOptions,
  ): Promise<SshCommandTransport> {
    if (!validHost(options.target.host))
      throw new Error(`invalid ssh host: ${options.target.host}`);
    const transport = new SshCommandTransport(options, "/");
    if (transport.reuseConnection) {
      transport.controlDirectory = await mkdtemp(join(tmpdir(), "eta-ssh-"));
      transport.controlPath = join(transport.controlDirectory, "control");
    }
    const fingerprint = await transport.readFingerprint();
    if (fingerprint !== undefined) {
      if (
        transport.expectedFingerprint !== undefined &&
        fingerprint !== transport.expectedFingerprint
      ) {
        await transport.close();
        throw new Error(
          `host key for ${transport.target.host} changed: expected ${transport.expectedFingerprint}, got ${fingerprint}`,
        );
      }
      transport.expectedFingerprint = fingerprint;
      transport.warn(
        `[eta-ssh] ${transport.target.host}: accepted host key ${fingerprint}`,
      );
    }
    const home = await transport.run('printf %s "$HOME"');
    if (home.code !== 0 || home.stdout.length === 0) {
      await transport.close();
      throw new Error(
        home.stderr.trim() ||
          `could not determine the home directory on ${transport.target.host}; run ssh ${transport.target.host} in a terminal to check the key and authentication`,
      );
    }
    // The far side is asked for the bare path (`printf %s`), so a trailing
    // newline here is something a wrapper added: trim it either way.
    return Object.assign(transport, { home: home.stdout.trim() });
  }

  /** The discovered fingerprint, once trust has been settled. */
  get fingerprint(): string | undefined {
    return this.expectedFingerprint;
  }

  async run(script: string, options: SshRunOptions = {}): Promise<SshResult> {
    let attempt = 0;
    for (;;) {
      const result = await this.once(script, options);
      if (result.code !== SSH_TRANSPORT_EXIT || attempt >= this.retryBudget) {
        if (result.code === SSH_TRANSPORT_EXIT) {
          this.warn(
            `[eta-ssh] ${this.target.host}: the connection is down (exit 255), out of retries`,
          );
        }
        return result;
      }
      attempt += 1;
      this.warn(
        `[eta-ssh] ${this.target.host}: connection failed (exit 255), retry ${attempt}/${this.retryBudget}`,
      );
      // A dead multiplex master is the usual cause: drop the socket so the next
      // attempt dials in again instead of reusing a corpse.
      await this.reconnect();
      await new Promise((resolve) =>
        setTimeout(resolve, this.retryDelayMs * attempt),
      );
    }
  }

  async close(): Promise<void> {
    const controlPath = this.controlPath;
    if (controlPath !== undefined) {
      // Ask OpenSSH to close its own master; failing that the socket goes with
      // the temp directory anyway.
      await new Promise<void>((resolve) => {
        try {
          const child = this.spawnFn(
            "ssh",
            [
              "-O",
              "exit",
              "-o",
              `ControlPath=${controlPath}`,
              this.target.host,
            ],
            {
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          child.on("close", () => resolve());
          child.on("error", () => resolve());
        } catch {
          resolve();
        }
      });
    }
    this.controlPath = undefined;
    const directory = this.controlDirectory;
    this.controlDirectory = undefined;
    if (directory !== undefined)
      await rm(directory, { recursive: true, force: true });
  }

  /** Drop the shared connection, so the next command dials in fresh. */
  private async reconnect(): Promise<void> {
    const controlPath = this.controlPath;
    if (controlPath === undefined) return;
    await new Promise<void>((resolve) => {
      const child = this.spawnFn(
        "ssh",
        ["-O", "exit", "-o", `ControlPath=${controlPath}`, this.target.host],
        {
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
    await rm(controlPath, { force: true });
  }

  /** One attempt, no retries: the script in `sh -c`, stdin as given. */
  private once(script: string, options: SshRunOptions): Promise<SshResult> {
    return new Promise<SshResult>((resolve) => {
      const control =
        this.controlPath === undefined
          ? undefined
          : { path: this.controlPath, persist: this.reuseConnection };
      const args = [
        ...sshArgs(this.target, control),
        "--",
        this.target.host,
        `sh -c ${shellQuote(script)}`,
      ];
      let settled = false;
      let child: ReturnType<SpawnLike> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: SshResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        // eslint-disable-next-line ts/no-use-before-define -- onAbort and its cleanup call each other
        options.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = (): void => {
        child?.kill("SIGTERM");
        settle({
          code: SSH_TRANSPORT_EXIT,
          stdout: "",
          stderr: "aborted",
          aborted: true,
        });
      };
      try {
        child = this.spawnFn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        settle({
          code: SSH_TRANSPORT_EXIT,
          stdout: "",
          stderr: (error as Error).message,
        });
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        options.onChunk?.({ stream: "stdout", chunk: chunk.toString("utf8") });
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        options.onChunk?.({ stream: "stderr", chunk: chunk.toString("utf8") });
      });
      if (options.input !== undefined) child.stdin?.end(options.input);
      else child.stdin?.end();
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          child?.kill("SIGTERM");
          settle({
            code: SSH_TRANSPORT_EXIT,
            stdout: "",
            stderr: "timeout",
            timedOut: true,
          });
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
        settle({ code: SSH_TRANSPORT_EXIT, stdout: "", stderr: error.message }),
      );
      child.on("close", (code: number | null) =>
        settle({
          code: code ?? SSH_TRANSPORT_EXIT,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
    });
  }

  /**
   * Learn the host's key without trusting anything yet.
   *
   * When OpenSSH already knows the host, this is a plain no-op: no prompt is
   * produced and nothing is accepted. When it does not, the prompt is captured
   * through an askpass helper that refuses everything except reading it back —
   * authentication is disabled for this one call, so the helper can never be used
   * to answer a password prompt.
   */
  private async readFingerprint(): Promise<string | undefined> {
    const directory = await mkdtemp(join(tmpdir(), "eta-ssh-key-"));
    try {
      const promptFile = join(directory, "prompt");
      const acceptedFile = join(directory, "accepted");
      const helper = join(directory, "askpass");
      const expectedFile = join(directory, "expected");
      await writeFile(expectedFile, this.expectedFingerprint ?? "", {
        mode: 0o600,
      });
      // The helper writes the prompt down, and answers "yes" only when it matches
      // what the caller already trusted.
      await writeFile(
        helper,
        `#!/bin/sh
case "$1" in
  "The authenticity of host "*"key fingerprint is"*"Are you sure you want to continue connecting"*) ;;
  *) exit 1 ;;
esac
printf '%s' "$1" > ${shellQuote(promptFile)}
${
  this.expectedFingerprint === undefined
    ? "exit 1"
    : `cmp -s ${shellQuote(promptFile)} ${shellQuote(expectedFile)} || exit 1
printf yes > ${shellQuote(acceptedFile)}
printf 'yes\\n'`
}
`,
        { mode: 0o700 },
      );
      const control =
        this.controlPath === undefined
          ? undefined
          : { path: `${this.controlPath}-key`, persist: false };
      const args = [
        ...sshArgs(this.target, control),
        "-o",
        "BatchMode=no",
        "-o",
        "StrictHostKeyChecking=ask",
        "-o",
        "PreferredAuthentications=none",
        "-o",
        "NumberOfPasswordPrompts=0",
        "-o",
        "VerifyHostKeyDNS=no",
        "-o",
        "UpdateHostKeys=no",
        "--",
        this.target.host,
        "true",
      ];
      await new Promise<void>((resolve) => {
        let child: ReturnType<SpawnLike>;
        try {
          child = this.spawnFn("ssh", args, {
            env: {
              ...process.env,
              LC_ALL: "C",
              SSH_ASKPASS: helper,
              SSH_ASKPASS_REQUIRE: "force",
              DISPLAY: "eta:0",
            },
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          resolve();
          return;
        }
        child.stdout?.on("data", () => undefined);
        child.stderr?.on("data", () => undefined);
        child.stdin?.end();
        child.on("close", () => resolve());
        child.on("error", () => resolve());
      });
      const captured = (
        await readFile(promptFile, "utf8").catch(() => "")
      ).trim();
      const fingerprint = hostKeyFingerprint(captured)?.fingerprint;
      if (fingerprint === undefined) return undefined;
      if (this.expectedFingerprint !== undefined) {
        const accepted = await readFile(acceptedFile, "utf8").catch(() => "");
        if (
          captured.trim() !== this.expectedFingerprint.trim() ||
          accepted.trim() !== "yes"
        ) {
          throw new Error(
            `host key confirmation for ${this.target.host} did not match the expected fingerprint`,
          );
        }
      }
      return fingerprint;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

/** The fingerprint out of OpenSSH's own first-connection prompt. */
export function hostKeyFingerprint(
  prompt: string,
): { algorithm: string; fingerprint: string } | undefined {
  if (!prompt.startsWith("The authenticity of host ")) return undefined;
  if (!prompt.includes("Are you sure you want to continue connecting"))
    return undefined;
  const match =
    /([A-Z0-9-]+) key fingerprint is:? (SHA256:[A-Za-z0-9+/]+)(?:\.|\s|$)/.exec(
      prompt,
    );
  return match === null
    ? undefined
    : { algorithm: match[1]!, fingerprint: match[2]! };
}
