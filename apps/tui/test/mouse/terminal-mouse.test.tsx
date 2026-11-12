/**
 * `createTerminalMouse`, what `main` draws the interface with: the filtered stdin Ink reads, the
 * reporting written to the terminal, and the tree around the interface. Drawn with the real Ink
 * on a terminal double, in the alternate screen, so the order of what reaches the terminal shows.
 */
import { EventEmitter } from "node:events";
import { render, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useWheel } from "../../src/extensions/react";
import { MOUSE_REPORTING_OFF } from "../../src/ui/mouse/reporting";
import { createTerminalMouse } from "../../src/ui/mouse/terminal";
import { runInterface } from "../../src/ui/run-interface";
import { flush, realDelay } from "../ui-support/render";

const ESC = "\u001B";
const LEAVE_ALTERNATE_SCREEN = `${ESC}[?1049l`;

/** A terminal's stdout: everything written, in order. */
class TerminalStdout extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  readonly written: string[] = [];
  write(text: string, callback?: () => void): boolean {
    this.written.push(String(text));
    if (typeof callback === "function") callback();
    return true;
  }

  text(): string {
    return this.written.join("");
  }
}

/** A terminal's stdin: each write is one read. */
class TerminalStdin extends EventEmitter {
  isTTY = true;
  private readonly pending: string[] = [];
  write(data: string): void {
    this.pending.push(data);
    this.emit("readable");
  }

  read = (): string | null => this.pending.shift() ?? null;
  setRawMode(): void {}
  setEncoding(): void {}
  ref(): void {}
  unref(): void {}
}

class FakeProcess extends EventEmitter {
  readonly exits: number[] = [];
  exit = (code: number): void => {
    this.exits.push(code);
  };

  stderr = { write: (): boolean => true };
}

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

/** Draws `tree` the way `main` does, through `runInterface`, with the reporting on. */
function draw(
  tree: (hooks: { quit: () => Promise<void> }) => React.ReactNode,
  options: { stop?: () => Promise<void> } = {},
) {
  const stdout = new TerminalStdout();
  const terminal = new TerminalStdin();
  const proc = new FakeProcess();
  const mouse = createTerminalMouse({
    stdin: terminal,
    write: (text) => stdout.write(text),
  });
  let hooks: { quit: () => Promise<void> } | undefined;
  runInterface({
    process: proc,
    controller: {
      stop: options.stop ?? (async () => {}),
      killTemporaryNow: () => {},
    },
    deadlineMs: 5_000,
    mouse: mouse.reporting,
    startProgram: () => {
      throw new Error("no program in this test");
    },
    draw: (given) => {
      hooks = given;
      const instance = render(mouse.provide(tree(given)), {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: mouse.stdin,
        alternateScreen: true,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      unmounts.push(() => instance.unmount());
      return instance;
    },
  });
  mouse.reporting.setEnabled(true);
  if (!hooks) throw new Error("runInterface did not draw");
  return { stdout, terminal, proc, quit: hooks.quit };
}

function Bomb() {
  const [boom, setBoom] = useState(false);
  useEffect(() => {
    const timer = setTimeout(setBoom, 30, true);
    return () => clearTimeout(timer);
  }, []);
  if (boom) throw new Error("a view threw");
  return <Text>hello</Text>;
}

const offBeforeLeaving = (stdout: TerminalStdout) => {
  const text = stdout.text();
  return {
    off: text.indexOf(MOUSE_REPORTING_OFF),
    leave: text.indexOf(LEAVE_ALTERNATE_SCREEN),
  };
};

describe("the reporting as the screen is left", () => {
  it("is turned off before the alternate screen is left when a component throws", async () => {
    const { stdout, proc } = draw(() => <Bomb />);
    await realDelay(300);
    const { off, leave } = offBeforeLeaving(stdout);
    expect(leave).toBeGreaterThan(-1);
    expect(off).toBeGreaterThan(-1);
    expect(off).toBeLessThan(leave);
    expect(proc.exits).toEqual([1]);
  });

  it("is turned off at once on a quit, before the host has stopped", async () => {
    let stopped: () => void = () => {};
    const { stdout, quit } = draw(() => <Text>hello</Text>, {
      stop: () =>
        new Promise<void>((resolve) => {
          stopped = resolve;
        }),
    });
    await flush();
    void quit();
    await flush();
    expect(stdout.text()).toContain(MOUSE_REPORTING_OFF);
    expect(stdout.text()).not.toContain(LEAVE_ALTERNATE_SCREEN);
    stopped();
    await realDelay(50);
    const { off, leave } = offBeforeLeaving(stdout);
    expect(off).toBeLessThan(leave);
  });
});

function Reader({ keys, steps }: { keys: string[]; steps: string[] }) {
  useInput((input) => keys.push(input));
  useWheel((direction, count) => steps.push(`${direction}:${count}`));
  return <Text>reading</Text>;
}

describe("the wiring", () => {
  it("gives the interface the wheel steps, and Ink the keys without the mouse reports", async () => {
    const keys: string[] = [];
    const steps: string[] = [];
    const { terminal } = draw(() => <Reader keys={keys} steps={steps} />);
    await flush();
    terminal.write(`a${ESC}[<64;3;4M${ESC}[<0;3;4Mb`);
    await flush();
    terminal.write(`${ESC}[<65;3;4M`);
    await flush();
    expect(keys.join("")).toBe("ab");
    expect(steps).toEqual(["up:1", "down:1"]);
  });

  it("gives Ink a stdin that is a terminal", () => {
    const mouse = createTerminalMouse({
      stdin: new TerminalStdin(),
      write: () => {},
    });
    expect(mouse.stdin.isTTY).toBe(true);
  });
});
