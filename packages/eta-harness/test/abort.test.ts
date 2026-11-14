/**
 * Abort (REFACTOR.md §2.4, ported from eta-agent's execution/effect-gate.ts).
 *
 * Cancellation cannot un-run an effect, so it does the two things it can: stop
 * admitting new ones, and abort the signal the running ones observe — then wait
 * for them to drain. The run reports `aborted`, which is not a failure: the
 * work stopped where it was, and what it had already committed stands.
 */

import { Kernel, Runner } from "@eta/core";
import { SessionLog } from "@eta/core/session";
import { MemoryStorage } from "@eta/core/storage";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { journaledKernel } from "../src/testing";

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("aborting a run", () => {
  it("waits for a tool that already started before returning", async () => {
    const kernel = Kernel.create({
      config: { model: { provider: "p", modelId: "m" } },
    });
    const fake = fakeModels([
      assistantMessage({
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "c1", name: "slow", arguments: {} }],
      }),
    ]);
    let finished = false;
    const runner = new Runner(kernel, { models: fake });
    kernel.tools.register({
      name: "slow",
      execute: async () => {
        await sleep(30);
        finished = true;
        return "done";
      },
    });
    kernel.inject(userMsg("go"));
    const run = runner.run();
    await sleep(5);
    runner.abort();
    const result = await run;
    // The effect could not be un-run, so the abort waited for it.
    expect(finished).toBe(true);
    expect(result.status).toBe("aborted");
    void kernel.dispose();
  });

  it("refuses to start a tool call that had not been admitted yet", async () => {
    const kernel = Kernel.create({
      config: {
        model: { provider: "p", modelId: "m" },
        toolExecution: "sequential",
      },
    });
    const fake = fakeModels([
      assistantMessage({
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "c1", name: "slow", arguments: {} },
          { type: "toolCall", id: "c2", name: "second", arguments: {} },
        ],
      }),
    ]);
    const ran: string[] = [];
    const runner = new Runner(kernel, { models: fake });
    kernel.tools.register({
      name: "slow",
      execute: async () => {
        ran.push("slow");
        await sleep(30);
        return "slow done";
      },
    });
    kernel.tools.register({
      name: "second",
      execute: () => {
        ran.push("second");
        return "second done";
      },
    });
    kernel.inject(userMsg("go"));
    const run = runner.run();
    await sleep(5);
    runner.abort();
    await run;

    // In sequential mode the second call never started; the first one finished.
    expect(ran).toEqual(["slow"]);
    void kernel.dispose();
  });

  it("keeps what the run had already committed", async () => {
    const log = SessionLog.create(new MemoryStorage());
    const { kernel, journaling } = journaledKernel(log, {
      config: { model: { provider: "p", modelId: "m" } },
    });
    const fake = fakeModels([
      assistantMessage({
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "c1", name: "slow", arguments: {} }],
      }),
    ]);
    const runner = new Runner(kernel, { models: fake, journal: journaling });
    kernel.tools.register({
      name: "slow",
      execute: async () => {
        await sleep(30);
        return "slow done";
      },
    });
    kernel.inject(userMsg("go"));
    const run = runner.run();
    await sleep(5);
    runner.abort();
    const result = await run;
    expect(result.status).toBe("aborted");

    // The user message, the assistant's call, and the tool result are all
    // committed — an abort is a stop, not a rollback.
    const reloaded = await SessionLog.load(log.storage);
    expect(reloaded.transcript().length).toBe(3);
    void kernel.dispose();
  });
});
