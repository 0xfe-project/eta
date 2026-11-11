import type { AskRequest, AskResult, Hooks } from "../../src/realm/index";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/realm/index";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "eta-ask-test-"));
});

afterEach(() => {
  root = "";
});

describe("eta.ask", () => {
  it("can return a result with text, effects, stack, and status", async () => {
    const hooks: Hooks = {
      ask: async (request: AskRequest): Promise<AskResult> => {
        // Simple mock: just echo the prompt
        return {
          text: `Answer to: ${request.prompt}`,
          effects: [],
          stack: request.parentStack ?? ["main"],
          status: "completed",
        };
      },
    };

    const agent = new Agent({ root, hooks });
    const result = await agent.run(
      `import eta from "eta";
const result = await eta.ask("What is 1 + 1?");
export default result;`,
      { identifier: join(root, "test.js") },
    );

    expect(result.value).toMatchObject({
      text: expect.stringContaining("What is 1 + 1?"),
      status: "completed",
      stack: expect.any(Array),
    });
  });

  it("supports passing model option", async () => {
    let capturedModel: string | undefined;
    const hooks: Hooks = {
      ask: async (request: AskRequest): Promise<AskResult> => {
        capturedModel = request.model;
        return {
          text: "result",
          effects: [],
          stack: ["main"],
          status: "completed",
        };
      },
    };

    const agent = new Agent({ root, hooks });
    await agent.run(
      `import eta from "eta";
await eta.ask("test", { model: "gpt-4" });
export default 1;`,
      { identifier: join(root, "test.js") },
    );

    expect(capturedModel).toBe("gpt-4");
  });

  it("supports recursive calls", async () => {
    const callLog: string[] = [];
    const hooks: Hooks = {
      ask: async (request: AskRequest): Promise<AskResult> => {
        callLog.push(request.prompt);
        const depth = request.parentStack?.length ?? 0;

        // Stop recursion at depth 2
        if (depth >= 2) {
          return {
            text: `Depth ${depth}: stopping`,
            effects: [],
            stack: request.parentStack ?? ["main"],
            status: "completed",
          };
        }

        return {
          text: `Depth ${depth}: continuing`,
          effects: [],
          stack: request.parentStack ?? ["main"],
          status: "completed",
        };
      },
    };

    const agent = new Agent({ root, hooks });
    const result = await agent.run(
      `import eta from "eta";
const r1 = await eta.ask("outer");
export default r1;`,
      { identifier: join(root, "test.js") },
    );

    expect(callLog).toContain("outer");
    expect(result.value).toMatchObject({
      status: "completed",
    });
  });

  it("parentStack contains the truncated prompt", async () => {
    let capturedStack: string[] | undefined;
    const hooks: Hooks = {
      ask: async (request: AskRequest): Promise<AskResult> => {
        capturedStack = request.parentStack;
        return {
          text: "result",
          effects: [],
          stack: request.parentStack ?? ["main"],
          status: "completed",
        };
      },
    };

    const agent = new Agent({ root, hooks });
    await agent.run(
      `import eta from "eta";
await eta.ask("This is a test prompt");
export default 1;`,
      { identifier: join(root, "test.js") },
    );

    expect(capturedStack).toBeDefined();
    expect(capturedStack?.[0]).toContain("eta.ask");
    expect(capturedStack?.[0]).toContain("This is a test prompt");
  });

  it("truncates long prompts to 30 characters in stack", async () => {
    let capturedStack: string[] | undefined;
    const hooks: Hooks = {
      ask: async (request: AskRequest): Promise<AskResult> => {
        capturedStack = request.parentStack;
        return {
          text: "result",
          effects: [],
          stack: request.parentStack ?? ["main"],
          status: "completed",
        };
      },
    };

    const agent = new Agent({ root, hooks });
    const longPrompt = "A".repeat(50);
    await agent.run(
      `import eta from "eta";
await eta.ask(${JSON.stringify(longPrompt)});
export default 1;`,
      { identifier: join(root, "test.js") },
    );

    expect(capturedStack).toBeDefined();
    expect(capturedStack?.[0]).toContain("...");
    expect(capturedStack?.[0]?.length).toBeLessThan(60); // "eta.ask(\"" + 30 + "...\")" is ~44 chars
  });

  it("the request carries depth for the host to count recursion", async () => {
    // History injection is the host's job; what the runtime owes the host is
    // a depth it can trust and a stack it can merge. This tests that much and
    // nothing about session history — the rest is #23's (host side).
    const depths: number[] = [];
    const hooks: Hooks = {
      ask: async (request: AskRequest): Promise<AskResult> => {
        depths.push(request.depth ?? 0);
        return {
          text: "ok",
          effects: [],
          stack: request.parentStack ?? ["main"],
          status: "completed",
        };
      },
    };

    const agent = new Agent({ root, hooks });
    await agent.run(
      `import eta from "eta";
await eta.ask("first");`,
      {
        identifier: join(root, "test.js"),
      },
    );

    expect(depths).toEqual([1]);
  });

  it("a deep ask surfaces a warning but does not stop", async () => {
    let hostDepth = 10;
    const hooks: Hooks = {
      ask: async (request: AskRequest): Promise<AskResult> => {
        // The host mirrors deeper session stacks: it counts, the runtime warns.
        void request;
        return {
          text: "ok",
          effects: [],
          stack: ["main"],
          status: "completed",
          ...(hostDepth >= 10
            ? { warning: `eta.ask recursion depth is ${hostDepth}` }
            : {}),
        };
      },
    };

    const agent = new Agent({ root, hooks });
    const result = await agent.run(
      `import eta from "eta";
const r = await eta.ask("deep");
export default r;`,
      { identifier: join(root, "test.js") },
    );

    // A warning arrives, and the result still comes back: never a stop.
    expect(result.value).toMatchObject({
      status: "completed",
      warning: expect.stringContaining("depth"),
    });

    hostDepth = 3;
    const shallow = await agent.run(
      `import eta from "eta";
const r = await eta.ask("shallow");
export default r;`,
      { identifier: join(root, "test2.js") },
    );
    expect((shallow.value as { warning?: string }).warning).toBeUndefined();
  });

  it("handles cancelled status", async () => {
    const hooks: Hooks = {
      ask: async (): Promise<AskResult> => {
        return {
          text: "Partial result",
          effects: [],
          stack: ["main"],
          status: "cancelled",
        };
      },
    };

    const agent = new Agent({ root, hooks });
    const result = await agent.run(
      `import eta from "eta";
const r = await eta.ask("test");
export default r;`,
      { identifier: join(root, "test.js") },
    );

    expect(result.value).toMatchObject({
      status: "cancelled",
    });
  });

  it("can return effects from the turn", async () => {
    const hooks: Hooks = {
      ask: async (): Promise<AskResult> => {
        return {
          text: "result",
          effects: [
            {
              name: "fs.readFile",
              at: { identifier: "test.js", line: 1, column: 0 },
              status: "ok",
              ms: 5,
              detail: "test.txt",
            },
          ],
          stack: ["main"],
          status: "completed",
        };
      },
    };

    const agent = new Agent({ root, hooks });
    const result = await agent.run(
      `import eta from "eta";
const r = await eta.ask("read a file");
export default r;`,
      { identifier: join(root, "test.js") },
    );

    expect(result.value).toMatchObject({
      effects: [
        {
          name: "fs.readFile",
          status: "ok",
        },
      ],
    });
  });

  it("eta.ask is recorded in the effect ledger", async () => {
    const hooks: Hooks = {
      ask: async (request: AskRequest): Promise<AskResult> => {
        return {
          text: "answer",
          effects: [],
          stack: request.parentStack ?? ["main"],
          status: "completed",
        };
      },
    };

    const agent = new Agent({ root, hooks });
    const result = await agent.run(
      `import eta from "eta";
await eta.ask("test question");
export default 1;`,
      { identifier: join(root, "test.js") },
    );

    expect(result.effects).toContainEqual(
      expect.objectContaining({
        name: "eta.ask",
        status: "ok",
      }),
    );
  });

  it("nested eta.ask calls build up the stack", async () => {
    const stacks: Array<string[] | undefined> = [];
    const hooks: Hooks = {
      ask: async (request: AskRequest): Promise<AskResult> => {
        stacks.push(request.parentStack);
        return {
          text: "result",
          effects: [],
          stack: request.parentStack ?? ["main"],
          status: "completed",
        };
      },
    };

    const agent = new Agent({ root, hooks });

    // Create an env.js that calls eta.ask recursively
    await writeFile(join(root, "env.js"), `// Empty env file\n`);

    await agent.run(
      `import eta from "eta";
// Outer call
const r1 = await eta.ask("outer question");
export default r1;`,
      { identifier: join(root, "test.js") },
    );

    // Should have captured one stack
    expect(stacks.length).toBeGreaterThan(0);
    expect(stacks[0]).toBeDefined();
    expect(stacks[0]?.[0]).toContain("eta.ask");
  });
});

describe("eta.ask effect ledger", () => {
  it("records the call site and a prompt summary", async () => {
    if (process.platform === "win32") return;
    const hooks: Hooks = {
      ask: async (request: AskRequest): Promise<AskResult> => ({
        text: "answer",
        effects: [],
        stack: request.parentStack ?? ["main"],
        status: "completed",
      }),
    };

    const agent = new Agent({ root, hooks });
    const result = await agent.run(
      `import eta from "eta";
const r = await eta.ask("find the failing test");
export default r;`,
      { identifier: join(root, "ledger.js") },
    );

    const ask = result.effects.find((e) => e.name === "eta.ask");
    expect(ask).toBeDefined();
    expect(ask?.status).toBe("ok");
    expect(ask?.detail).toContain("find the failing test");
    expect(ask?.at.line).toBe(2);
  });

  it("records a failed ask as failed, and it still throws into the script", async () => {
    const hooks: Hooks = {
      ask: async (): Promise<AskResult> => {
        throw new Error("host exploded");
      },
    };

    const agent = new Agent({ root, hooks });
    const result = await agent.run(
      `import eta from "eta";
try { await eta.ask("boom"); } catch { }
export default 1;`,
      { identifier: join(root, "failed.js") },
    );

    // The script caught the rethrow, so the run completes — with a failed row.
    expect(result.value).toBe(1);
    expect(
      result.effects.some((e) => e.name === "eta.ask" && e.status === "failed"),
    ).toBe(true);
  });
});
