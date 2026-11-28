import type { AskRequest, AskResult, Hooks } from "../../src/realm/index";
import { mkdtemp } from "node:fs/promises";
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
});

describe("eta.ask effect ledger", () => {
  it.skipIf(process.platform === "win32")("records the call site and a prompt summary", async () => {
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
