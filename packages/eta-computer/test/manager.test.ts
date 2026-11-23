import type {
  ComputerMicroAction,
  ComputerUserInput,
  ViewportSize,
} from "@eta/client-contracts";
import type { RealmDriver } from "../src/manager";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { VirtualClipboard } from "../src/clipboard";
import { ManagedRealm, RealmManager } from "../src/manager";
import { TrajectoryRecorder } from "../src/trajectory";

interface MockDriverHarness {
  driver: RealmDriver;
  executedActions: ComputerMicroAction[];
  executedUserInputs: ComputerUserInput[];
  watchedTransitions: boolean[];
  setOnStep: (
    hook: (
      stepIndex: number,
      action: ComputerMicroAction,
      ctx: { signal: AbortSignal; clipboard: VirtualClipboard },
    ) => Promise<{
      summary?: string;
      interruptedByModalOrNavigation?: boolean;
    } | void>,
  ) => void;
}

function createMockDriver(
  viewport: ViewportSize = { width: 1280, height: 720 },
): MockDriverHarness {
  const executedActions: ComputerMicroAction[] = [];
  const executedUserInputs: ComputerUserInput[] = [];
  const watchedTransitions: boolean[] = [];

  let onStep:
    | ((
        stepIndex: number,
        action: ComputerMicroAction,
        ctx: { signal: AbortSignal; clipboard: VirtualClipboard },
      ) => Promise<{
        summary?: string;
        interruptedByModalOrNavigation?: boolean;
      } | void>)
    | undefined;

  const driver: RealmDriver = {
    kind: "browser",
    tier: "cdp",
    title: () => "Test Realm",
    target: () => "https://example.test",
    viewport: () => viewport,
    observe: async () => ({
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      viewport,
    }),
    step: async (action, ctx) => {
      const idx = executedActions.length;
      executedActions.push(action);
      if (onStep) {
        return await onStep(idx, action, ctx);
      }
    },
    userInput: async (input) => {
      executedUserInputs.push(input);
    },
    setWatched: (watched) => {
      watchedTransitions.push(watched);
    },
    close: async () => {},
  };

  return {
    driver,
    executedActions,
    executedUserInputs,
    watchedTransitions,
    setOnStep: (hook) => {
      onStep = hook;
    },
  };
}

describe("realmManager & ManagedRealm (T2)", () => {
  it("cancels mid-batch on takeover during step 2 so steps 3..5 never execute and epoch increments", async () => {
    const manager = new RealmManager();
    const harness = createMockDriver();
    const realm = manager.register(harness.driver, { id: "realm_lock_test" });

    const initialEpoch = realm.epoch;
    expect(initialEpoch).toBe(1);
    expect(realm.controller).toBe("agent");

    const abortedSignals: boolean[] = [];

    harness.setOnStep(async (stepIndex, _action, ctx) => {
      if (stepIndex === 1) {
        // Trigger human takeover while step 2 (0-based index 1) is running
        realm.takeover("User clicked Take Over during step 2");
        abortedSignals.push(ctx.signal.aborted);
      }
    });

    const fiveActions: ComputerMicroAction[] = [
      { kind: "move", x: 100, y: 100 },
      { kind: "click", x: 200, y: 200 },
      { kind: "type", text: "should not be typed" },
      { kind: "key", key: "Enter" },
      { kind: "click", x: 800, y: 800 },
    ];

    const result = await realm.act(fiveActions);

    // Only steps 1 & 2 were invoked; step 2 was aborted mid-flight so completedSteps is 1
    expect(harness.executedActions).toHaveLength(2);
    expect(result.completedSteps).toBe(1);
    expect(result.aborted).toBe(true);
    expect(abortedSignals).toEqual([true]);
    expect(realm.controller).toBe("user");
    expect(realm.epoch).toBe(initialEpoch + 1);

    // Late agent call while controller === "user" is rejected immediately
    await expect(
      realm.act([{ kind: "click", x: 500, y: 500 }]),
    ).rejects.toThrow(/controller is "user"/);

    // Release back to agent increments epoch again, and stale expectedEpoch is rejected
    realm.release();
    expect(realm.controller).toBe("agent");
    expect(realm.epoch).toBe(initialEpoch + 2);

    await expect(
      realm.act([{ kind: "click", x: 500, y: 500 }], {
        expectedEpoch: initialEpoch,
      }),
    ).rejects.toThrow(/Stale epoch/);

    // Reject batches larger than MAX_MICRO_ACTIONS (8)
    const nineActions: ComputerMicroAction[] = Array.from(
      { length: 9 },
      (_, i) => ({
        kind: "move",
        x: i * 10,
        y: i * 10,
      }),
    );
    await expect(realm.act(nineActions)).rejects.toThrow(RangeError);
  });

  it("stops batch early when a step reports interruptedByModalOrNavigation", async () => {
    const harness = createMockDriver();
    const realm = new ManagedRealm(harness.driver, { id: "realm_modal_test" });

    harness.setOnStep(async (stepIndex) => {
      if (stepIndex === 1) {
        return {
          summary: "Native file picker opened",
          interruptedByModalOrNavigation: true,
        };
      }
    });

    const result = await realm.act([
      { kind: "move", x: 250, y: 250 },
      { kind: "click", x: 250, y: 250 },
      { kind: "type", text: "after modal" },
    ]);

    expect(harness.executedActions).toHaveLength(2);
    expect(result.completedSteps).toBe(2);
    expect(result.interruptedByModalOrNavigation).toBe(true);
    expect(result.aborted).toBe(false);
  });

  it("enforces userInput only when controller === 'user' and emits normalized cursor events", async () => {
    const harness = createMockDriver({ width: 1000, height: 500 });
    const realm = new ManagedRealm(harness.driver, { id: "realm_user_input" });

    const cursorEvents: Array<{ x: number; y: number; kind: string }> = [];
    realm.onCursor((ev) => {
      cursorEvents.push({ x: ev.x, y: ev.y, kind: ev.kind });
    });

    // Rejected while agent has control
    await expect(
      realm.userInput({ kind: "click", x: 400, y: 600 }),
    ).rejects.toThrow(/controller is "agent"/);

    // Allowed after takeover
    realm.takeover();
    await realm.userInput({ kind: "click", x: 400, y: 600 });
    expect(harness.executedUserInputs).toHaveLength(1);
    expect(realm.cursor.x).toBe(400);
    expect(realm.cursor.y).toBe(600);
    expect(cursorEvents).toEqual([{ x: 400, y: 600, kind: "click" }]);
  });

  it("guarantees clipboard zero-contamination across realms and throws RangeError on oversize payloads", async () => {
    const manager = new RealmManager({
      clipboardOptions: { maxBytes: 1024 },
    });
    const realmA = manager.register(createMockDriver().driver, {
      id: "realm_a",
    });
    const realmB = manager.register(createMockDriver().driver, {
      id: "realm_b",
    });

    await Promise.all([
      Promise.resolve().then(() => {
        realmA.clipboard.write({
          text: "secret-from-realm-A",
          html: "<b>Realm A</b>",
          imagePng: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        });
      }),
      Promise.resolve().then(() => {
        realmB.clipboard.write({
          text: "isolated-in-realm-B",
          html: "<i>Realm B</i>",
        });
      }),
    ]);

    expect(realmA.clipboard.readText()).toBe("secret-from-realm-A");
    expect(realmA.clipboard.readHtml()).toBe("<b>Realm A</b>");
    expect(
      realmA.clipboard
        .readImagePng()
        ?.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    ).toBe(true);
    expect(realmA.clipboard.revision).toBe(1);

    expect(realmB.clipboard.readText()).toBe("isolated-in-realm-B");
    expect(realmB.clipboard.readHtml()).toBe("<i>Realm B</i>");
    expect(realmB.clipboard.readImagePng()).toBeUndefined();
    expect(realmB.clipboard.revision).toBe(1);

    // Clear on realm A does not affect realm B
    realmA.clipboard.clear();
    expect(realmA.clipboard.readText()).toBe("");
    expect(realmA.clipboard.revision).toBe(2);
    expect(realmB.clipboard.readText()).toBe("isolated-in-realm-B");

    // Oversize payload (> 1024 bytes) throws RangeError and preserves existing state
    const oversize = "x".repeat(2048);
    expect(() => realmB.clipboard.writeText(oversize)).toThrow(RangeError);
    expect(realmB.clipboard.readText()).toBe("isolated-in-realm-B");
    expect(realmB.clipboard.revision).toBe(1);

    // Default VirtualClipboard cap is 4 MiB
    const defaultClipboard = new VirtualClipboard();
    expect(defaultClipboard.maxBytes).toBe(4 * 1024 * 1024);
    expect(() =>
      defaultClipboard.writeImagePng(Buffer.alloc(4 * 1024 * 1024 + 1)),
    ).toThrow(RangeError);
  });

  it("drives warm-on-subscribe watcher transitions (0 -> 1 -> 2 -> 1 -> 0) and records trajectory events", async () => {
    const recorder = new TrajectoryRecorder({ maxEntries: 10 });
    const harness = createMockDriver();
    const realm = new ManagedRealm(harness.driver, {
      id: "realm_watch_test",
      recorder,
    });

    expect(harness.watchedTransitions).toEqual([]);
    expect(realm.watcherCount).toBe(0);

    // 0 -> 1 triggers setWatched(true)
    const unsub1 = realm.watch(() => {});
    expect(realm.watcherCount).toBe(1);
    expect(harness.watchedTransitions).toEqual([true]);

    // 1 -> 2 does not re-trigger setWatched
    const unsub2 = realm.watch(() => {});
    expect(realm.watcherCount).toBe(2);
    expect(harness.watchedTransitions).toEqual([true]);

    // 2 -> 1 does not trigger setWatched(false)
    unsub1();
    expect(realm.watcherCount).toBe(1);
    expect(harness.watchedTransitions).toEqual([true]);

    // Redundant unsubscribe is a no-op
    unsub1();
    expect(realm.watcherCount).toBe(1);

    // 1 -> 0 triggers setWatched(false)
    unsub2();
    expect(realm.watcherCount).toBe(0);
    expect(harness.watchedTransitions).toEqual([true, false]);

    // Re-subscribing and closing the realm triggers setWatched(false)
    realm.watch(() => {});
    expect(harness.watchedTransitions).toEqual([true, false, true]);
    await realm.close();
    expect(harness.watchedTransitions).toEqual([true, false, true, false]);

    expect(recorder.list("realm_watch_test").length).toBeGreaterThanOrEqual(1);
    expect(recorder.list("realm_watch_test")[0]?.kind).toBe("open");
  });
});
