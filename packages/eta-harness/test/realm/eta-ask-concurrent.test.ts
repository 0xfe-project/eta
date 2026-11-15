import type { AskRequest, AskResult, Hooks } from "../../src/realm/index";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/realm/index";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "eta-ask-concurrent-test-"));
});

afterEach(() => {
  root = "";
});

describe("eta.ask 并发执行", () => {
  it("promise.all 并发 3 个 eta.ask 真正并发执行", async () => {
    const callLog: Array<{ seq: number; time: number; prompt: string }> = [];
    let seq = 0;

    let running = 0;
    let peak = 0;
    const hooks: Hooks = {
      ask: async (request: AskRequest): Promise<AskResult> => {
        const mySeq = seq++;
        const startTime = Date.now();
        callLog.push({ seq: mySeq, time: startTime, prompt: request.prompt });
        running += 1;
        peak = Math.max(peak, running);

        // Simulate async work (50ms)
        await new Promise((resolve) => setTimeout(resolve, 50));
        running -= 1;

        return {
          text: `Answer ${mySeq}: ${request.prompt}`,
          effects: [],
          stack: request.parentStack ?? ["main"],
          status: "completed",
        };
      },
    };

    const agent = new Agent({ root, hooks });

    const result = await agent.run(
      `import eta from "eta";
const results = await Promise.all([
  eta.ask("A"),
  eta.ask("B"),
  eta.ask("C")
]);
export default results;`,
      { identifier: join(root, "test.js") },
    );

    // All 3 should start concurrently: each was still running when the last began.
    expect(callLog.length).toBe(3);
    expect(peak).toBe(3);
    expect(result.value).toHaveLength(3);
  });

  it("并发超过 5 个时排队等待", async () => {
    const runningCount: number[] = [];
    let currentRunning = 0;

    const hooks: Hooks = {
      ask: async (request: AskRequest): Promise<AskResult> => {
        currentRunning++;
        runningCount.push(currentRunning);

        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 20));

        currentRunning--;

        return {
          text: `Answer: ${request.prompt}`,
          effects: [],
          stack: request.parentStack ?? ["main"],
          status: "completed",
        };
      },
    };

    const agent = new Agent({ root, hooks });

    await agent.run(
      `import eta from "eta";
const results = await Promise.all([
  eta.ask("1"),
  eta.ask("2"),
  eta.ask("3"),
  eta.ask("4"),
  eta.ask("5"),
  eta.ask("6"),
  eta.ask("7"),
  eta.ask("8"),
  eta.ask("9"),
  eta.ask("10")
]);
export default results.length;`,
      { identifier: join(root, "test.js") },
    );

    // Five at a time: the cap is reached, and never passed.
    const maxRunning = Math.max(...runningCount);
    expect(maxRunning).toBe(5);
  });

  it("某个 turn 调 ask_user 不阻塞其他并发 turn", async () => {
    const completionOrder: string[] = [];

    const hooks: Hooks = {
      ask: async (request: AskRequest): Promise<AskResult> => {
        if (request.prompt === "slow_turn") {
          // This simulates a turn that calls ask_user (pauses)
          await new Promise((resolve) => setTimeout(resolve, 200));
          completionOrder.push("slow_turn");
        } else {
          // Other turns complete quickly
          await new Promise((resolve) => setTimeout(resolve, 30));
          completionOrder.push(request.prompt);
        }

        return {
          text: `Answer: ${request.prompt}`,
          effects: [],
          stack: request.parentStack ?? ["main"],
          status: "completed",
        };
      },
    };

    const agent = new Agent({ root, hooks });

    await agent.run(
      `import eta from "eta";
const results = await Promise.all([
  eta.ask("fast_1"),
  eta.ask("slow_turn"),  // slow (simulates ask_user pause)
  eta.ask("fast_2")
]);
export default results;`,
      { identifier: join(root, "test.js") },
    );

    // The fast ones should complete before the slow one
    expect(completionOrder[0]).toBe("fast_1");
    expect(completionOrder[1]).toBe("fast_2");
    expect(completionOrder[2]).toBe("slow_turn");
  });

  it("大量并发请求（100个）正确处理", async () => {
    let completed = 0;

    const hooks: Hooks = {
      ask: async (request: AskRequest): Promise<AskResult> => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        completed++;

        return {
          text: `Answer: ${request.prompt}`,
          effects: [],
          stack: request.parentStack ?? ["main"],
          status: "completed",
        };
      },
    };

    const agent = new Agent({ root, hooks });

    // Generate code that calls eta.ask 100 times
    const calls = Array.from({ length: 100 }, (_, i) => `eta.ask("${i}")`).join(
      ",\n  ",
    );

    const result = await agent.run(
      `import eta from "eta";
const results = await Promise.all([
  ${calls}
]);
export default results.length;`,
      { identifier: join(root, "test.js") },
    );

    expect(result.value).toBe(100);
    expect(completed).toBe(100);
  });
});
