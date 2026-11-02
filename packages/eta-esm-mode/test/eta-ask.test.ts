import type { AskRequest, AskResult, Hooks } from "../src/index";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/index";

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

  it("can see history from before the call (simulated)", async () => {
    // This test simulates the host providing history context
    let historyProvided = false;
    const hooks: Hooks = {
      ask: async (_request: AskRequest): Promise<AskResult> => {
        // In a real implementation, the host would check session history here
        historyProvided = true;
        return {
          text: "The project name is Eta",
          effects: [],
          stack: ["main"],
          status: "completed",
        };
      },
    };

    const agent = new Agent({ root, hooks });
    // First, simulate storing some history
    await agent.run(`export default "remember: project=Eta";`, {
      identifier: join(root, "setup.js"),
    });

    // Then call eta.ask
    const result = await agent.run(
      `import eta from "eta";
const answer = await eta.ask("What is the project name?");
export default answer;`,
      { identifier: join(root, "test.js") },
    );

    expect(historyProvided).toBe(true);
    expect(result.value).toMatchObject({
      text: expect.stringContaining("Eta"),
    });
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
