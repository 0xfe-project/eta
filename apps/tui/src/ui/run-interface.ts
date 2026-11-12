import type { ProcessLaunch } from "./editor";
import type { ShutdownSignal } from "./shutdown";
import { spawn } from "node:child_process";
import { createShutdown, watchRenderErrors } from "./shutdown";

/** The parts of Node's `process` the interface hooks into. */
export interface InterfaceProcess {
  on: (
    event: "exit" | ShutdownSignal | "uncaughtException" | "unhandledRejection",
    listener: (cause: unknown) => void,
  ) => unknown;
  exit: (code: number) => void;
  stderr: { write: (text: string) => unknown };
}

/** The drawn interface, as Ink's `render` returns it. */
export interface InterfaceInk {
  /** Leaves the alternate screen. */
  unmount: () => void;
  /** Settles when Ink has ended; rejects when it ended because a component threw. */
  waitUntilExit: () => Promise<unknown>;
}

/** What the drawn interface is given to end eta and to hand the terminal to a program. */
export interface InterfaceHooks {
  quit: () => Promise<void>;
  /** Runs a program on the terminal; resolves with its exit code, rejects when it cannot start. */
  runProcess: (launch: ProcessLaunch) => Promise<number | null>;
}

/** A program running on the terminal. */
export interface TerminalProgram {
  /** Its exit code, null when a signal ended it; rejects when it could not start. */
  exited: Promise<number | null>;
  /** Ends it; nothing once it has ended. */
  kill: () => void;
}

/** Starts a program on this terminal, with eta's stdin, stdout and stderr. */
export function runOnTerminal(launch: ProcessLaunch): TerminalProgram {
  const child = spawn(launch.command, launch.args, {
    stdio: "inherit",
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  });
  const exited = new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code));
  });
  return {
    exited,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

/**
 * Draws the interface with `draw` and makes every way `proc` can end go through eta's shutdown:
 * the quit it hands the interface and SIGINT, SIGTERM and SIGHUP quit; an uncaught exception, an
 * unhandled rejection or a component that throws crashes; the `exit` event kills the temporary
 * host as a last resort. Programs started through `runProcess` (with `startProgram`) keep SIGINT
 * for themselves while they run and are killed when eta ends.
 */
export function runInterface(options: {
  process: InterfaceProcess;
  controller: { stop: () => Promise<void>; killTemporaryNow: () => void };
  /** How long a crash waits for the temporary host to stop before it kills it. */
  deadlineMs: number;
  startProgram: (launch: ProcessLaunch) => TerminalProgram;
  draw: (hooks: InterfaceHooks) => InterfaceInk;
}): void {
  const { process: proc, controller } = options;
  proc.on("exit", () => controller.killTemporaryNow());

  // Set right below by `draw`; nothing ends eta before that.
  let ink: InterfaceInk | undefined;
  const shutdown = createShutdown({
    stop: () => controller.stop(),
    killNow: () => controller.killTemporaryNow(),
    unmount: () => ink?.unmount(),
    waitForUnmount: async () => ink?.waitUntilExit().catch(() => {}),
    writeError: (text) => proc.stderr.write(text),
    exit: (code) => proc.exit(code),
    deadlineMs: options.deadlineMs,
  });

  const drawn = options.draw({
    quit: shutdown.quit,
    runProcess: (launch) => {
      const program = options.startProgram(launch);
      return shutdown.runChild(program.exited, program.kill);
    },
  });
  ink = drawn;

  const crash = (error: unknown) => void shutdown.crash(error);
  watchRenderErrors(() => drawn.waitUntilExit(), crash);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    proc.on(signal, () => shutdown.onSignal(signal));
  proc.on("uncaughtException", crash);
  proc.on("unhandledRejection", crash);
}
