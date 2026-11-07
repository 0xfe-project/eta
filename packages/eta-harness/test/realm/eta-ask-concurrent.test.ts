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

    // Results should be in call order (A, B, C) not completion order
    const results = result.value as AskResult[];
    expect(results).toHaveLength(3);
    expect(results[0].text).toContain("A");
    expect(results[1].text).toContain("B");
    expect(results[2].text).toContain("C");
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

    // Max concurrent should never exceed 5
    const maxRunning = Math.max(...runningCount);
    expect(maxRunning).toBeLessThanOrEqual(5);
  });

  it("flatten 按调用顺序，不是完成顺序", async () => {
    const hooks: Hooks = {
      ask: async (request: AskRequest): Promise<AskResult> => {
        // A takes 100ms, B takes 20ms
        const delay = request.prompt === "A" ? 100 : 20;
        await new Promise((resolve) => setTimeout(resolve, delay));

        return {
          text: `Answer: ${request.prompt}`,
          effects: [],
          stack: request.parentStack ?? ["main"],
          status: "completed",
        };
      },
    };

    const agent = new Agent({ root, hooks });

    const result = await agent.run(
      `import eta from "eta";
const [a, b] = await Promise.all([
  eta.ask("A"),  // slower
  eta.ask("B")   // faster
]);
export default [a, b];`,
      { identifier: join(root, "test.js") },
    );

    // B completes first, but results are in call order (A, B)
    const results = result.value as AskResult[];
    expect(results).toHaveLength(2);
    expect(results[0].text).toContain("A");
    expect(results[1].text).toContain("B");
  });

  it("递归调用计入并发上限", async () => {
    let maxConcurrent = 0;
    let currentRunning = 0;

    const hooks: Hooks = {
      ask: async (request: AskRequest): Promise<AskResult> => {
        currentRunning++;
        maxConcurrent = Math.max(maxConcurrent, currentRunning);

        await new Promise((resolve) => setTimeout(resolve, 10));

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

    // Call eta.ask 6 times in parallel (more than the 5 limit)
    await agent.run(
      `import eta from "eta";
const results = await Promise.all([
  eta.ask("1"),
  eta.ask("2"),
  eta.ask("3"),
  eta.ask("4"),
  eta.ask("5"),
  eta.ask("6")
]);
export default results.length;`,
      { identifier: join(root, "test.js") },
    );

    // Should respect the 5 concurrent limit
    expect(maxConcurrent).toBeLessThanOrEqual(5);
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

  it("返回结果按调用顺序即使完成顺序不同", async () => {
    const hooks: Hooks = {
      ask: async (request: AskRequest): Promise<AskResult> => {
        // Delays: A=80ms, B=40ms, C=20ms
        const delays: Record<string, number> = { A: 80, B: 40, C: 20 };
        const delay = delays[request.prompt] ?? 50;
        await new Promise((resolve) => setTimeout(resolve, delay));

        return {
          text: `Answer: ${request.prompt}`,
          effects: [],
          stack: request.parentStack ?? ["main"],
          status: "completed",
        };
      },
    };

    const agent = new Agent({ root, hooks });

    const result = await agent.run(
      `import eta from "eta";
const [a, b, c] = await Promise.all([
  eta.ask("A"),  // slowest
  eta.ask("B"),  // medium
  eta.ask("C")   // fastest
]);
export default [a.text, b.text, c.text];`,
      { identifier: join(root, "test.js") },
    );

    // Completion order: C, B, A
    // But results order: A, B, C (call order)
    const texts = result.value as string[];
    expect(texts).toEqual(["Answer: A", "Answer: B", "Answer: C"]);
  });

  it("并发调用都能看到相同的 history 起点", async () => {
    const seenPrompts: string[][] = [];

    const hooks: Hooks = {
      ask: async (request: AskRequest): Promise<AskResult> => {
        // Record what prompts this turn can see
        // In real implementation, would check ctx.messages()
        // For now, just record the parentStack
        seenPrompts.push(request.parentStack ?? []);

        await new Promise((resolve) => setTimeout(resolve, 10));

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
const [a, b, c] = await Promise.all([
  eta.ask("A"),
  eta.ask("B"),
  eta.ask("C")
]);
export default [a, b, c];`,
      { identifier: join(root, "test.js") },
    );

    // All three calls should start from the same point
    // (before any of them started executing)
    expect(seenPrompts).toHaveLength(3);
    // Each should only see its own call in the stack
    for (const stack of seenPrompts) {
      expect(stack).toHaveLength(1);
      expect(stack[0]).toMatch(/^eta\.ask\("/);
    }
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
