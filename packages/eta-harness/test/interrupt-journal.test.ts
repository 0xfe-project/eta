/**
 * An interrupted generation in the journal (eta #292).
 *
 * The attempt that was stopped is not history: its text never reaches the journal, a reload,
 * or the model. What does is the fact that it was stopped (one `interrupt` entry, who and why)
 * and the reminder the interrupt injected, as an ordinary message.
 */

import type { InterruptEntry } from "@eta/core/session";
import { Runner } from "@eta/core";
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

const say = (text: string) =>
  assistantMessage({ content: [{ type: "text", text }] });

describe("an interrupted generation is journaled as a fact, not as text", () => {
  it("records one interrupt entry and the reminder, never the discarded text", async () => {
    const storage = new MemoryStorage();
    const log = SessionLog.create(storage);
    const { kernel, journaling } = journaledKernel(log, {
      config: { model: { provider: "p", modelId: "m" } },
    });
    const models = fakeModels(
      [say("I will use the SECRET word"), say("a clean answer")],
      { chunkSize: 4 },
    );
    let seen = "";
    const runner = new Runner(kernel, {
      models,
      journal: journaling,
      guardGeneration: ({ event }) => {
        if (event.type === "text_delta") seen += event.delta;
        if (!seen.includes("SECRET")) return undefined;
        seen = "";
        return {
          reason: "said the secret word",
          source: "no-secret",
          inject: [userMsg("do not say the secret word")],
        };
      },
    });
    kernel.inject(userMsg("go"));
    const result = await runner.run();
    expect(result.status).toBe("completed");

    const stored = await storage.scanEntries({});
    expect(JSON.stringify(stored)).not.toContain("SECRET word");
    const interrupts = stored.filter(
      (entry): entry is InterruptEntry => entry.type === "interrupt",
    );
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]!.payload).toMatchObject({
      reason: "said the secret word",
      source: "no-secret",
    });
    expect(interrupts[0]!.payload.discardedChars).toBeGreaterThan(0);

    // A reload replays the same conversation: the reminder is in it, the discarded attempt is not.
    const reloaded = await SessionLog.load(storage);
    const replayed = reloaded.transcript();
    expect(replayed.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
    expect(JSON.stringify(replayed)).toContain("do not say the secret word");
    expect(JSON.stringify(replayed)).not.toContain("SECRET word");
    void kernel.dispose();
  });
});
