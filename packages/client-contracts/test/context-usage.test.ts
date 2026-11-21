import type { AgentMessage, ViewMessageRow } from "../src/index";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_FALLBACK_WINDOW,
  contextRingDashes,
  contextUsage,
} from "../src/index";

// The numbers here are the web member ring's (apps/web member-ring.tsx): characters by role from
// the last compaction summary on, four characters to a token, against the model's window.

let seq = 0;
const row = (message: object, at = seq + 1): ViewMessageRow => {
  seq += 1;
  return { entryId: `e${seq}`, seq, at, message: message as AgentMessage };
};
const text = (n: number) => "x".repeat(n);
const user = (n: number) => row({ role: "user", content: text(n) });
const reply = (n: number, thinking = 0) =>
  row({
    role: "assistant",
    content: [
      ...(thinking ? [{ type: "thinking", thinking: text(thinking) }] : []),
      { type: "text", text: text(n) },
    ],
  });
const toolCall = (args: object) =>
  row({
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "esmrun", arguments: args }],
  });
const toolResult = (n: number) =>
  row({ role: "toolResult", content: [{ type: "text", text: text(n) }] });
const summary = (n: number, at: number) =>
  row({ role: "compactionSummary", summary: text(n), tokensBefore: 9 }, at);

const tokens = (usage: ReturnType<typeof contextUsage>) =>
  Object.fromEntries(usage.slices.map((slice) => [slice.source, slice.tokens]));

describe("a session's context usage", () => {
  it("splits the window by where the characters came from", () => {
    const script = { script: "console.log(1)" };
    const usage = contextUsage({
      messages: [
        user(400),
        toolCall(script),
        toolResult(8000),
        reply(2000, 400),
      ],
      tools: [{ name: "esmrun", description: text(94) }],
      prompt: { stableChars: 4000, adaptiveChars: 4800 },
      window: 10_000,
    });
    expect(tokens(usage)).toEqual({
      system: 1000,
      context: 200,
      user: 100,
      // the reply and its thinking, and the call's arguments as JSON
      assistant: Math.round((2400 + JSON.stringify(script).length) / 4),
      toolDefs: 25,
      tool: 2000,
    });
    expect(usage.used).toBe(1000 + 200 + 100 + 607 + 25 + 2000);
    expect(usage.percent).toBe(39);
    expect(usage.compactedAt).toBeUndefined();
  });

  it("counts only what follows the last compaction summary", () => {
    const before = [user(40_000), reply(400_000)];
    const after = [summary(2400, 777), user(100), reply(3300)];
    const usage = contextUsage({ messages: [...before, ...after], tools: [] });
    expect(tokens(usage)).toMatchObject({ user: 25, assistant: 1425 });
    expect(usage.used).toBe(1450);
    expect(usage.compactedAt).toBe(777);

    const whole = contextUsage({ messages: before, tools: [] });
    expect(whole.used).toBe(110_000);
    expect(whole.compactedAt).toBeUndefined();
  });

  it("starts from the latest of several compactions", () => {
    const usage = contextUsage({
      messages: [summary(4000, 1), reply(8000), summary(400, 2), reply(40)],
      tools: [],
    });
    expect(usage.used).toBe(110);
    expect(usage.compactedAt).toBe(2);
  });

  it("assumes a 128k window when the model's is unknown", () => {
    const usage = contextUsage({ messages: [reply(256_000)], tools: [] });
    expect(usage.window).toBe(CONTEXT_FALLBACK_WINDOW);
    expect(usage.percent).toBe(50);
  });

  it("draws a full ring past the window, and says how far past", () => {
    const usage = contextUsage({
      messages: [reply(60_000)],
      tools: [],
      window: 10_000,
    });
    expect(usage.cap).toBe(15_000);
    expect(usage.percent).toBe(150);
    const ring = contextRingDashes(usage, 100, 1);
    expect(ring).toEqual([
      { source: "assistant", tokens: 15_000, dash: 99, at: 0 },
    ]);
  });

  it("leaves out a slice thinner than the gap between slices", () => {
    const usage = contextUsage({
      messages: [user(40), reply(39_960)],
      tools: [],
      window: 10_000,
    });
    // user: 10 tokens = 0.1 of a 100-long ring, under the gap of 0.75
    const ring = contextRingDashes(usage, 100, 0.75);
    expect(ring.map((slice) => slice.source)).toEqual(["assistant"]);
    expect(ring[0]!.at).toBeCloseTo(0.1);
  });
});
