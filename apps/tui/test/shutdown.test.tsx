/** How eta ends: quitting, crashing, the signals, and a render error inside Ink. */
import { EventEmitter } from "node:events";
import { render, Text } from "ink";
import { describe, expect, it, vi } from "vitest";
import { createShutdown, watchRenderErrors } from "../src/ui/shutdown";
import { realDelay } from "./ui-support/render";

function harness(options: { stopMs?: number; deadlineMs?: number } = {}) {
  const events: string[] = [];
  // How many events had happened each time the terminal was released.
  const released: number[] = [];
  const shutdown = createShutdown({
    releaseTerminal: () => released.push(events.length),
    stop: async () => {
      events.push("stop:start");
      await realDelay(options.stopMs ?? 0);
      events.push("stop:end");
    },
    killNow: () => events.push("kill"),
    unmount: () => events.push("unmount"),
    waitForUnmount: async () => {
      events.push("unmounted");
    },
    writeError: (text) => events.push(`stderr:${text.split("\n")[0]}`),
    exit: (code) => events.push(`exit:${code}`),
    deadlineMs: options.deadlineMs ?? 1_000,
  });
  return { events, released, shutdown };
}

describe("quit", () => {
  it("stops the controller, then leaves the screen, then exits 0, once", async () => {
    const { events, shutdown } = harness();
    await Promise.all([shutdown.quit(), shutdown.quit()]);
    expect(events).toEqual([
      "stop:start",
      "stop:end",
      "unmount",
      "unmounted",
      "exit:0",
    ]);
  });
});

describe("crash", () => {
  it("stops the temporary host gracefully first, then kills what is left, leaves the screen, prints the error and exits 1", async () => {
    const { events, shutdown } = harness();
    await shutdown.crash(new Error("render broke"));
    expect(events).toEqual([
      "stop:start",
      "stop:end",
      "kill",
      "unmount",
      "stderr:Error: render broke",
      "exit:1",
    ]);
  });

  it("does not wait for a stop that outlasts the deadline", async () => {
    const { events, shutdown } = harness({ stopMs: 2_000, deadlineMs: 50 });
    const started = Date.now();
    await shutdown.crash(new Error("stuck"));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(events).toEqual([
      "stop:start",
      "kill",
      "unmount",
      "stderr:Error: stuck",
      "exit:1",
    ]);
  });

  it("prints something that is not an Error as text", async () => {
    const { events, shutdown } = harness();
    await shutdown.crash("plain words");
    expect(events).toContain("stderr:plain words");
  });

  it("takes over from a quit in progress and runs once", async () => {
    const { events, shutdown } = harness({ stopMs: 100 });
    const quitting = shutdown.quit();
    await shutdown.crash(new Error("during quit"));
    await shutdown.crash(new Error("again"));
    void quitting;
    expect(events.filter((e) => e.startsWith("exit:"))).toEqual(["exit:1"]);
    expect(events.filter((e) => e.startsWith("stderr:"))).toEqual([
      "stderr:Error: during quit",
    ]);
  });
});

describe("signals", () => {
  it("gives SIGINT back after a program that could not start", async () => {
    const { events, shutdown } = harness();
    await expect(
      shutdown.runChild(Promise.reject(new Error("ENOENT"))),
    ).rejects.toThrow("ENOENT");
    shutdown.onSignal("SIGINT");
    await realDelay(10);
    expect(events.at(-1)).toBe("exit:0");
  });
});

describe("watchRenderErrors", () => {
  class MemoryStream extends EventEmitter {
    columns = 80;
    rows = 24;
    // Ink settles its exit only after a write callback, as real streams call it.
    write = (_data: string, done?: () => void) => {
      done?.();
      return true;
    };
  }
  class MemoryStdin extends EventEmitter {
    isTTY = true;
    setEncoding() {}
    setRawMode() {}
    resume() {}
    pause() {}
    ref() {}
    unref() {}
    read = () => null;
  }

  function Broken(): never {
    throw new Error("a view threw while rendering");
  }

  it("hands the error to the crash path when Ink ends because a component threw", async () => {
    const onError = vi.fn();
    const instance = render(<Broken />, {
      stdout: new MemoryStream() as unknown as NodeJS.WriteStream,
      stderr: new MemoryStream() as unknown as NodeJS.WriteStream,
      stdin: new MemoryStdin() as unknown as NodeJS.ReadStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    watchRenderErrors(() => instance.waitUntilExit(), onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(String(onError.mock.calls[0]?.[0])).toContain(
      "a view threw while rendering",
    );
  });

  it("does nothing when Ink ends normally", async () => {
    const onError = vi.fn();
    const instance = render(<Text>fine</Text>, {
      stdout: new MemoryStream() as unknown as NodeJS.WriteStream,
      stderr: new MemoryStream() as unknown as NodeJS.WriteStream,
      stdin: new MemoryStdin() as unknown as NodeJS.ReadStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    watchRenderErrors(() => instance.waitUntilExit(), onError);
    instance.unmount();
    await realDelay(50);
    expect(onError).not.toHaveBeenCalled();
  });
});
