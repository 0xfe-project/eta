/** Installing the local host as the user's service: `eta-host install-service`, then its `/up`. */
import type { Subprocess } from "bun";
import type { HostProgram } from "./types";
import { collect, sleep } from "./output";
import { probeUp } from "./probe";

/** How often the service's `/up` is asked while waiting for it. */
const UP_POLL_MS = 500;

export type InstallStep = "running" | "waiting-up";

/** `output` is what `install-service` printed, stdout and stderr in the order they came. */
export type InstallResult =
  | { ok: true; output: string }
  | { ok: false; step: InstallStep; output: string };

export interface InstallOptions {
  program: HostProgram;
  env: NodeJS.ProcessEnv;
  /** The service's HTTP base, where `/up` is asked. */
  localUrl: string;
  /** How long `install-service` may run. */
  runMs: number;
  /** How long the service may take to answer `/up` after it is installed. */
  upMs: number;
  probeTimeoutMs: number;
  /** Told when the command has succeeded and the wait for `/up` begins. */
  onStep?: (step: "waiting-up") => void;
  /** Aborting kills the command and ends the wait, as a failure of the step it was in. */
  signal?: AbortSignal;
}

/**
 * Run `[command, ...args, "install-service"]`, then ask `<localUrl>/up` every 500 ms. Fails in
 * the `running` step when the command exits non-zero or outlasts `runMs` (it is killed then),
 * and in the `waiting-up` step when `/up` does not answer within `upMs`. Never throws.
 */
export async function installService(
  options: InstallOptions,
): Promise<InstallResult> {
  let output = "";
  const append = (text: string) => {
    output += text;
  };
  let child: Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(
      [options.program.command, ...options.program.args, "install-service"],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: options.env },
    );
  } catch (error) {
    return {
      ok: false,
      step: "running",
      output: error instanceof Error ? error.message : String(error),
    };
  }
  const drained = Promise.all([
    collect(child.stdout, append),
    collect(child.stderr, append),
  ]);
  const kill = () => child.kill("SIGKILL");
  options.signal?.addEventListener("abort", kill, { once: true });
  const timer = setTimeout(kill, options.runMs);
  const code = await child.exited;
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", kill);
  await Promise.race([drained, sleep(UP_POLL_MS)]);
  const aborted = () => options.signal?.aborted === true;
  if (code !== 0 || child.signalCode !== null || aborted())
    return { ok: false, step: "running", output };

  options.onStep?.("waiting-up");
  const deadline = Date.now() + options.upMs;
  while (!aborted()) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const probeMs = Math.min(options.probeTimeoutMs, left);
    if (await probeUp(options.localUrl, probeMs)) return { ok: true, output };
    const pause = Math.min(UP_POLL_MS, deadline - Date.now());
    if (pause > 0) await sleep(pause);
  }
  return { ok: false, step: "waiting-up", output };
}
