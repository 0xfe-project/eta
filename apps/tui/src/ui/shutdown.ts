/** What ending eta needs from the program around it. */
export interface ShutdownDeps {
  /** Close the wire and stop the temporary host, waiting for it to end. */
  stop: () => Promise<void>;
  /** Kill every temporary host still running, at once. */
  killNow: () => void;
  /** Unmount Ink, which leaves the alternate screen. */
  unmount: () => void;
  /** Settles once Ink is unmounted. */
  waitForUnmount: () => Promise<unknown>;
  writeError: (text: string) => void;
  exit: (code: number) => void;
  /** How long a crash waits for the graceful stop before it kills. */
  deadlineMs: number;
}

const EXIT_OK = 0;
const EXIT_FAILURE = 1;

export type ShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

function describeError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? `${error.name}: ${error.message}`)
    : String(error);
}

/** Runs one step of an ending; a step that throws does not keep the next ones from running. */
function attempt(step: () => void): void {
  try {
    step();
  } catch {
    // The process is ending either way; the error being reported is the one that matters.
  }
}

/**
 * The ways eta ends. `quit` stops the controller, leaves the screen and exits 0. `crash` stops the
 * temporary host within `deadlineMs`, kills whatever is left, leaves the screen, prints the error
 * and exits 1, also when one of those steps throws; it takes over from a quit in progress. Each
 * runs once. While a program started with `runChild` has the terminal, SIGINT belongs to that
 * program and does not end eta, and both ways of ending kill that program first.
 */
export function createShutdown(deps: ShutdownDeps) {
  let quitting: Promise<void> | undefined;
  let crashing: Promise<void> | undefined;
  let children = 0;
  const running = new Set<{ kill: () => void }>();

  const killPrograms = () => {
    for (const program of [...running]) attempt(program.kill);
  };

  const quit = (): Promise<void> => {
    quitting ??= (async () => {
      killPrograms();
      await deps.stop();
      if (crashing) return;
      deps.unmount();
      await deps.waitForUnmount();
      if (crashing) return;
      deps.exit(EXIT_OK);
    })();
    return quitting;
  };

  const crash = (error: unknown): Promise<void> => {
    crashing ??= (async () => {
      killPrograms();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deps.deadlineMs);
      });
      const stopped = (async () => deps.stop())().catch(() => {});
      await Promise.race([stopped, deadline]);
      clearTimeout(timer);
      attempt(deps.killNow);
      attempt(deps.unmount);
      attempt(() => deps.writeError(`${describeError(error)}\n`));
      deps.exit(EXIT_FAILURE);
    })();
    return crashing;
  };

  return {
    quit,
    crash,
    onSignal: (signal: ShutdownSignal): void => {
      if (signal === "SIGINT" && children > 0) return;
      void quit();
    },
    /**
     * Marks the time `task` (a program on the terminal) runs, for `onSignal`; returns it unchanged.
     * `kill` ends the program when eta quits or crashes while it runs.
     */
    runChild: <T>(task: Promise<T>, kill?: () => void): Promise<T> => {
      children += 1;
      const program = kill === undefined ? undefined : { kill };
      if (program) running.add(program);
      return task.finally(() => {
        children -= 1;
        if (program) running.delete(program);
      });
    },
  };
}

/**
 * Calls `onError` when Ink ends because a component threw. Ink then unmounts on its own and keeps
 * the error to itself, so nothing else would notice.
 */
export function watchRenderErrors(
  waitUntilExit: () => Promise<unknown>,
  onError: (error: unknown) => void,
): void {
  waitUntilExit().catch(onError);
}
