/**
 * External checkers: `command` checks, `decide` scripts and lifecycle `run` commands.
 *
 * `argv` is started directly, never through a shell. Relative program paths (and the working
 * directory) are the project root. The input is a versioned JSON document on stdin, the answer is
 * JSON on stdout; a timeout, a failed exit or invalid output is an error the caller turns into a
 * refusal (tool rules) or into nothing (lifecycle rules).
 */
import type { CommandSpec } from "./types";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import process from "node:process";

export class CheckerError extends Error {
  override readonly name = "CheckerError";
  readonly ruleId: string;
  constructor(ruleId: string, reason: string) {
    super(`checker for ${ruleId} failed: ${reason}`);
    this.ruleId = ruleId;
  }
}

/** Run `spec` from `root` with `input` on stdin; resolves with its stdout. */
export function runCommand(
  ruleId: string,
  spec: CommandSpec,
  input: string,
  root: string,
): Promise<string> {
  const [program, ...args] = spec.argv;
  if (program === undefined || program === "")
    return Promise.reject(new CheckerError(ruleId, "empty argv"));
  const resolved =
    !isAbsolute(program) && program.includes("/")
      ? join(root, program)
      : program;
  return new Promise((resolve, reject) => {
    const fail = (reason: string): void => {
      reject(new CheckerError(ruleId, reason));
    };
    // Its own process group, so a timeout takes the command's children with it.
    const child = spawn(resolved, args, {
      cwd: root,
      ...(spec.env === undefined
        ? {}
        : { env: { ...process.env, ...spec.env } }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    };
    timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(() => fail("timed out"));
    }, spec.timeout_ms);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      finish(() => fail(error.message));
    });
    // A command may exit without reading its input.
    child.stdin.on("error", () => undefined);
    child.on("close", (code) => {
      finish(() => {
        if (code !== 0) {
          fail(
            `exited ${String(code)}: ${Buffer.concat(err).toString("utf8").trim()}`,
          );
          return;
        }
        resolve(Buffer.concat(out).toString("utf8"));
      });
    });
    child.stdin.end(input);
  });
}

/** Run a checker or decide script and parse its stdout as JSON. */
export async function runJson(
  ruleId: string,
  spec: CommandSpec,
  input: unknown,
  root: string,
): Promise<unknown> {
  const stdout = await runCommand(ruleId, spec, JSON.stringify(input), root);
  try {
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new CheckerError(
      ruleId,
      `invalid JSON output: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
