import type {
  PluginDisposer,
  PluginLifecycle,
  SessionPluginContext,
  SessionsListener,
  StateProjector,
} from "@eta/plugin-sdk";
import type { GitStatus } from "../src/git";
import { WireService } from "@eta/server";
import { Context } from "cordis";
import { expect, it, vi } from "vitest";
import { gitStatus } from "../src/git";
import { gitPlugin } from "../src/index";

vi.mock("../src/git", () => ({ gitStatus: vi.fn(), gitDiff: vi.fn() }));

it("the SDK cleanup drains an in-flight read without publishing into the next instance", async () => {
  let releaseRead!: (status: GitStatus) => void;
  const reading = new Promise<GitStatus>((resolve) => {
    releaseRead = resolve;
  });
  const status: GitStatus = {
    notGit: false,
    branch: "old-branch",
    groups: { staged: [], changes: [], untracked: [], conflicted: [] },
  };
  vi.mocked(gitStatus).mockReturnValue(reading);
  const projectors: StateProjector[] = [];
  let drained: Promise<void> | undefined;
  const ctx = new Context();
  // A real host lifecycle must satisfy the public contract without a cast.
  const lifecycle: PluginLifecycle = ctx;
  const wire = new WireService(ctx);
  const listeners = new Set<SessionsListener>();
  let cleanup: PluginDisposer = () => undefined;
  let pushes = 0;
  const host: SessionPluginContext = {
    wire: {
      handle: wire.handle,
      stateOf(target, projector) {
        projectors.push(projector);
        return wire.stateOf(target, projector);
      },
      event: wire.event,
      push: () => {
        pushes++;
      },
      pushNow: () => {
        pushes++;
      },
    },
    sessions: {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    effect(execute) {
      cleanup = execute();
    },
  };
  try {
    expect(lifecycle.effect).toBeTypeOf("function");
    gitPlugin.apply(host);
    for (const listener of listeners)
      listener.opened({
        id: "old",
        cwd: "/controlled-checkout",
        running: false,
      });
    expect(gitStatus).toHaveBeenCalledWith("/controlled-checkout");
    let disposed = false;
    drained = Promise.resolve(cleanup()).then(() => {
      disposed = true;
    });
    // Give cleanup a full event-loop turn; only releaseRead can finish the read.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(false);
    expect(listeners.size).toBe(0);
    expect(wire.descriptors()).toEqual([]);
    gitPlugin.apply(host);
    releaseRead(status);
    await drained;
    expect(disposed).toBe(true);
    expect(projectors[0]?.project().sections.sessions).toEqual([]);
    expect(pushes).toBe(0);
    expect(listeners.size).toBe(1);
    expect(wire.descriptors()).toHaveLength(3);
    expect(wire.snapshot("git")?.sections.sessions).toEqual([]);
  } finally {
    releaseRead(status);
    await drained;
    await cleanup();
    await ctx.fiber.dispose();
    vi.mocked(gitStatus).mockReset();
  }
});
