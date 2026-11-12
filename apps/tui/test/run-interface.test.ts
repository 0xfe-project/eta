/**
 * How the interface is hooked into its process: every way the process can end goes through the
 * shutdown, and a program on the terminal is known to it. A double stands in for `process`.
 */
import type { ProcessLaunch } from "../src/ui/editor";
import type { InterfaceHooks, TerminalProgram } from "../src/ui/run-interface";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { runInterface, runOnTerminal } from "../src/ui/run-interface";
import { realDelay } from "./ui-support/render";

class FakeProcess extends EventEmitter {
  readonly exits: number[] = [];
  readonly errors: string[] = [];
  exit = (code: number): void => {
    this.exits.push(code);
  };

  stderr = {
    write: (text: string): boolean => {
      this.errors.push(text);
      return true;
    },
  };
}

/** A program on the terminal that ends when the test says so. */
function heldProgram(events: string[]) {
  let finish: (code: number) => void = () => {};
  const program: TerminalProgram = {
    exited: new Promise<number>((resolve) => {
      finish = resolve;
    }),
    kill: () => events.push("program:kill"),
  };
  return { program, finish: (code: number) => finish(code) };
}

function setup(options: { program?: TerminalProgram } = {}) {
  const events: string[] = [];
  const proc = new FakeProcess();
  let renderError: (error: unknown) => void = () => {};
  let unmounted: () => void = () => {};
  const inkExit = new Promise<void>((resolve, reject) => {
    unmounted = resolve;
    renderError = reject;
  });
  let hooks: InterfaceHooks | undefined;
  const launches: ProcessLaunch[] = [];
  runInterface({
    process: proc,
    controller: {
      stop: async () => {
        events.push("stop");
      },
      killTemporaryNow: () => events.push("killTemporaryNow"),
    },
    deadlineMs: 1_000,
    startProgram: (launch) => {
      launches.push(launch);
      if (!options.program) throw new Error("no program in this test");
      return options.program;
    },
    draw: (given) => {
      hooks = given;
      return {
        unmount: () => {
          events.push("unmount");
          unmounted();
        },
        waitUntilExit: () => inkExit,
      };
    },
  });
  if (!hooks) throw new Error("runInterface did not draw");
  return { events, proc, hooks, launches, renderError };
}

const EDITOR: ProcessLaunch = { command: "vi", args: ["/test/eta/tui.json"] };

describe("runInterface", () => {
  it("kills the temporary host on the process's exit event", () => {
    const { events, proc } = setup();
    proc.emit("exit", 0);
    expect(events).toEqual(["killTemporaryNow"]);
  });

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "quits on %s: stops the controller, leaves the screen, exits 0",
    async (signal) => {
      const { events, proc } = setup();
      proc.emit(signal, signal);
      await realDelay(20);
      expect(events).toEqual(["stop", "unmount"]);
      expect(proc.exits).toEqual([0]);
    },
  );

  it("quits through the quit it hands the interface", async () => {
    const { events, proc, hooks } = setup();
    await hooks.quit();
    expect(events).toEqual(["stop", "unmount"]);
    expect(proc.exits).toEqual([0]);
  });

  it.each(["uncaughtException", "unhandledRejection"] as const)(
    "crashes on %s: prints the error and exits 1",
    async (event) => {
      const { events, proc } = setup();
      proc.emit(event, new Error(`${event} here`));
      await realDelay(20);
      expect(events).toEqual(["stop", "killTemporaryNow", "unmount"]);
      expect(proc.errors.join("")).toContain(`${event} here`);
      expect(proc.exits).toEqual([1]);
    },
  );

  it("crashes when Ink ends because a component threw", async () => {
    const { events, proc, renderError } = setup();
    renderError(new Error("a view threw"));
    await realDelay(20);
    expect(events).toContain("killTemporaryNow");
    expect(proc.errors.join("")).toContain("a view threw");
    expect(proc.exits).toEqual([1]);
  });

  it("starts programs on the terminal with startProgram and leaves SIGINT to them while they run", async () => {
    const events: string[] = [];
    const held = heldProgram(events);
    const { proc, hooks, launches } = setup({ program: held.program });
    const ran = hooks.runProcess(EDITOR);
    expect(launches).toEqual([EDITOR]);

    proc.emit("SIGINT", "SIGINT");
    await realDelay(20);
    expect(proc.exits).toEqual([]);
    expect(events).toEqual([]);

    held.finish(0);
    expect(await ran).toBe(0);
    proc.emit("SIGINT", "SIGINT");
    await realDelay(20);
    expect(proc.exits).toEqual([0]);
  });

  it("kills the program on the terminal when a SIGTERM quits eta", async () => {
    const events: string[] = [];
    const held = heldProgram(events);
    const { proc, hooks } = setup({ program: held.program });
    void hooks.runProcess(EDITOR);
    proc.emit("SIGTERM", "SIGTERM");
    await realDelay(20);
    expect(events).toEqual(["program:kill"]);
    expect(proc.exits).toEqual([0]);
  });

  it("kills the program on the terminal when eta crashes", async () => {
    const events: string[] = [];
    const held = heldProgram(events);
    const { proc, hooks } = setup({ program: held.program });
    void hooks.runProcess(EDITOR);
    proc.emit("uncaughtException", new Error("boom"));
    await realDelay(20);
    expect(events).toEqual(["program:kill"]);
    expect(proc.exits).toEqual([1]);
  });
});

describe("runOnTerminal", () => {
  const started: TerminalProgram[] = [];
  afterEach(() => {
    for (const program of started.splice(0)) program.kill();
  });
  function start(launch: ProcessLaunch): TerminalProgram {
    const program = runOnTerminal(launch);
    started.push(program);
    return program;
  }

  it("resolves with the program's exit code", async () => {
    const program = start({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
    });
    expect(await program.exited).toBe(3);
  });

  it("rejects when the program cannot start", async () => {
    const program = start({
      command: "eta-tui-no-such-program",
      args: [],
    });
    await expect(program.exited).rejects.toThrow();
  });

  it("ends the program with kill", async () => {
    const program = start({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000)"],
    });
    await realDelay(200);
    const begun = Date.now();
    program.kill();
    const code = await program.exited;
    expect(code).not.toBe(0);
    expect(Date.now() - begun).toBeLessThan(5_000);
  });
});
