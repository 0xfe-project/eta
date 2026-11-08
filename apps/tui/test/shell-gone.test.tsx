/**
 * The shell going away as eta quits: the controller stops and drops its wire, and the interface
 * draws on without the shell's context. React's development build, which the compiled `eta` also
 * carries, records each re-rendered component's changed props by reading every enumerable property
 * of the old and new values; reading must not throw once the wire is gone.
 */
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShellContext } from "../src/ui/shell-context";
import { createSession } from "../src/ui/shell/session";
import { renderApp, TEST_PATHS, TEST_URL } from "./ui-support/app";
import { testConfig } from "./ui-support/config";
import { FakeController } from "./ui-support/fake-controller";
import { fakeWire } from "./ui-support/fake-wire";
import { flush, plain, realDelay } from "./ui-support/render";

// React records renders only where `console.timeStamp` exists. Bun has it; the test runner's
// console does not, so it is given one before React loads.
vi.hoisted(() => {
  globalThis.console.timeStamp ??= () => {};
});

const open: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.unmount();
});

function contextOn(controller: FakeController) {
  const session = createSession({ tabs: [], activeTab: undefined });
  session.followShell(controller.getState().wire);
  const shell = session.store.getState().shell;
  if (shell === undefined) throw new Error("no shell in this test");
  return createShellContext({
    controller,
    paths: TEST_PATHS,
    commands: [],
    pinnedTabs: [],
    session,
    shell,
    getConfig: () => testConfig(),
    getLocale: () => "en",
    editFile: async () => ({ exitCode: 0 }),
    runInteractive: async () => ({ exitCode: 0 }),
    ensureConfigFile: async () => undefined,
    reloadConfig: async () => [],
    reportFailure: () => {},
    quit: async () => {},
  });
}

describe("the shell's context once the wire is gone", () => {
  it("still throws when a feature reads the wire", () => {
    const controller = new FakeController(
      { name: "connected", url: TEST_URL, temporary: false },
      { wire: fakeWire() },
    );
    const ctx = contextOn(controller);
    expect(ctx.wire).toBe(controller.getState().wire);
    controller.patch({ phase: { name: "stopped" }, wire: undefined });
    expect(() => ctx.wire).toThrow("There is no connection to a host yet");
  });
});

describe("the interface as the controller stops", () => {
  it("draws on without an uncaught error when the wire is dropped", async () => {
    const uncaught: unknown[] = [];
    const record = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", record);
    try {
      const r = await renderApp();
      open.push(r);
      r.controller.patch({ phase: { name: "stopped" }, wire: undefined });
      await flush();
      await realDelay(20);
      expect(uncaught).toEqual([]);
      expect(plain(r)).not.toContain("There is no connection to a host yet");
    } finally {
      process.off("uncaughtException", record);
    }
  });
});
