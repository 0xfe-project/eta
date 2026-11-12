/**
 * Which host already serves this computer's `~/.eta`, asked of `eta-host running`
 * (`apps/eta/src/running.ts`) before the TUI starts one: two hosts must not run over the same
 * data directory. The host checks its own record (a live pid, an answering `/up`) and the
 * computer's service, and prints one line of JSON, `{ address, tokenFile, from }` or `null`.
 *
 * A build from before that subcommand takes `running` for an argument of the run, which its
 * strict flag parsing refuses: it exits non-zero without starting, and the answer is `unknown`.
 */
import type { Subprocess } from "bun";
import type { HostProgram } from "./types";
import { readFile } from "node:fs/promises";
import { normalizeAddress } from "./address";
import { collect, sleep } from "./output";

/** How long to wait for the rest of the output once the command has ended or been killed. */
const DRAIN_AFTER_EXIT_MS = 500;

/** A host `eta-host running` names. */
export interface RunningHost {
  /** Its HTTP base, normalised. */
  url: string;
  /** The file its token is in, when it asks for one. */
  tokenFile: string | null;
}

export type RunningAnswer =
  | { result: "found"; host: RunningHost }
  | { result: "none" }
  /**
   * The command did not say: it could not be started, exited non-zero (a build without the
   * subcommand), outlasted the timeout, or printed something other than the expected JSON.
   * `detail` is for a test or a log, not for the user.
   */
  | { result: "unknown"; detail: string };

/**
 * Read the answer from what the command printed: the last non-empty line, as JSON. `null` is
 * none; an object whose `address` is a host address is a host; anything else is unknown.
 */
export function parseRunning(stdout: string): RunningAnswer {
  const line =
    stdout
      .split(/\r?\n/)
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .at(-1) ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { result: "unknown", detail: `not JSON: ${line}` };
  }
  if (parsed === null) return { result: "none" };
  if (typeof parsed !== "object" || Array.isArray(parsed))
    return { result: "unknown", detail: `not an object: ${line}` };
  const { address, tokenFile } = parsed as {
    address?: unknown;
    tokenFile?: unknown;
  };
  const url =
    typeof address === "string" ? normalizeAddress(address) : undefined;
  if (url === undefined)
    return { result: "unknown", detail: `no host address: ${line}` };
  return {
    result: "found",
    host: {
      url,
      tokenFile:
        typeof tokenFile === "string" && tokenFile !== "" ? tokenFile : null,
    },
  };
}

/**
 * Run `[command, ...args, "running"]` and read its answer. The command is killed after
 * `timeoutMs`, and the whole call ends within about half a second after that even when a process
 * it left behind holds its output open. Never throws.
 */
export async function askRunning(options: {
  program: HostProgram;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Aborting kills the command, and the answer is unknown. */
  signal?: AbortSignal;
}): Promise<RunningAnswer> {
  let child: Subprocess<"ignore", "pipe", "ignore">;
  try {
    child = Bun.spawn(
      [options.program.command, ...options.program.args, "running"],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: options.env },
    );
  } catch (error) {
    return {
      result: "unknown",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  let stdout = "";
  const drained = collect(child.stdout, (text) => {
    stdout += text;
  });
  let cut: string | undefined;
  const kill = (why: string) => {
    cut ??= why;
    child.kill("SIGKILL");
  };
  const onAbort = () => kill("aborted");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted === true) onAbort();
  const timer = setTimeout(
    kill,
    options.timeoutMs,
    `no answer within ${options.timeoutMs} ms`,
  );
  const code = await child.exited;
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", onAbort);
  await Promise.race([drained, sleep(DRAIN_AFTER_EXIT_MS)]);
  if (cut !== undefined) return { result: "unknown", detail: cut };
  if (code !== 0)
    return { result: "unknown", detail: `exited with ${String(code)}` };
  return parseRunning(stdout);
}

/** The token in `path`, trimmed; undefined when the file cannot be read or holds nothing. */
export async function readTokenFile(path: string): Promise<string | undefined> {
  try {
    const token = (await readFile(path, "utf8")).trim();
    return token === "" ? undefined : token;
  } catch {
    return undefined;
  }
}
