/**
 * What ending eta guarantees beyond the happy path: a crash exits 1 whatever step of it throws,
 * and a program that has the terminal does not outlive eta.
 */
import { describe, expect, it } from "vitest";
import { createShutdown } from "../src/ui/shutdown";

type Step = "releaseTerminal" | "stop" | "killNow" | "unmount" | "writeError";

function harness(throwing: Step[] = []) {
  const events: string[] = [];
  const fail = (step: Step) => {
    if (throwing.includes(step)) throw new Error(`${step} broke`);
  };
  const shutdown = createShutdown({
    releaseTerminal: () => {
      events.push("release");
      fail("releaseTerminal");
    },
    stop: () => {
      events.push("stop");
      fail("stop");
      return Promise.resolve();
    },
    killNow: () => {
      events.push("kill");
      fail("killNow");
    },
    unmount: () => {
      events.push("unmount");
      fail("unmount");
    },
    waitForUnmount: async () => {
      events.push("unmounted");
    },
    writeError: (text) => {
      events.push(`stderr:${text.split("\n")[0]}`);
      fail("writeError");
    },
    exit: (code) => events.push(`exit:${code}`),
    deadlineMs: 1_000,
  });
  return { events, shutdown };
}

describe("crash always ends the process", () => {
  it.each<Step>([
    "releaseTerminal",
    "stop",
    "killNow",
    "unmount",
    "writeError",
  ])("still tries every step and exits 1 when %s throws", async (step) => {
    const { events, shutdown } = harness([step]);
    await expect(shutdown.crash(new Error("boom"))).resolves.toBeUndefined();
    expect(events).toEqual([
      "release",
      "stop",
      "kill",
      "unmount",
      "stderr:Error: boom",
      "exit:1",
    ]);
  });

  it("still quits and exits 0 when releasing the terminal throws", async () => {
    const { events, shutdown } = harness(["releaseTerminal"]);
    await shutdown.quit();
    expect(events).toEqual([
      "release",
      "stop",
      "unmount",
      "unmounted",
      "exit:0",
    ]);
  });

  it("exits 1 once when every step throws", async () => {
    const { events, shutdown } = harness([
      "releaseTerminal",
      "stop",
      "killNow",
      "unmount",
      "writeError",
    ]);
    await expect(shutdown.crash(new Error("boom"))).resolves.toBeUndefined();
    await shutdown.crash(new Error("again"));
    expect(events.filter((e) => e.startsWith("exit:"))).toEqual(["exit:1"]);
    expect(events).toContain("unmount");
  });
});

describe("a program that has the terminal", () => {
  function program() {
    let finish: (code: number) => void = () => {};
    const done = new Promise<number>((resolve) => {
      finish = resolve;
    });
    return { done, finish };
  }

  it("is killed when eta quits while it runs, before the screen is left", async () => {
    const { events, shutdown } = harness();
    const editor = program();
    void shutdown.runChild(editor.done, () => events.push("child:kill"));
    await shutdown.quit();
    expect(events).toContain("child:kill");
    expect(events.indexOf("child:kill")).toBeLessThan(
      events.indexOf("unmount"),
    );
    expect(events.at(-1)).toBe("exit:0");
  });

  it("is left alone once it has ended", async () => {
    const { events, shutdown } = harness();
    const editor = program();
    const ran = shutdown.runChild(editor.done, () => events.push("child:kill"));
    editor.finish(0);
    await ran;
    await shutdown.quit();
    expect(events).not.toContain("child:kill");
  });

  it("does not stop the crash when killing it throws", async () => {
    const { events, shutdown } = harness();
    const editor = program();
    void shutdown.runChild(editor.done, () => {
      throw new Error("kill broke");
    });
    await expect(shutdown.crash(new Error("boom"))).resolves.toBeUndefined();
    expect(events.at(-1)).toBe("exit:1");
  });
});
