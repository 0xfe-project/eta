/**
 * The deterministic half of compaction (ported from eta-agent's
 * test/eta/compaction-eta.test.ts).
 *
 * No model is asked anything here: these are the rules that decide what gets
 * dropped, what gets truncated, and what gets labeled untrusted.
 */
import type { AgentMessage } from "@eta/core";
import { describe, expect, it } from "vitest";
import {
  digestContext,
  dropToolPairs,
  maxMinFairAllocations,
  TOOL_MESSAGE_DROP_THRESHOLD,
  toolResultShare,
  truncateFairly,
  UNTRUSTED_SUMMARY_NOTE,
  untrustedFallback,
} from "../src/index";

const user = (text: string, timestamp = 0): AgentMessage =>
  ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  }) as AgentMessage;

const call = (id: string, name = "bash"): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: { command: "ls" } }],
    stopReason: "toolUse",
    timestamp: 0,
  }) as unknown as AgentMessage;

const result = (id: string, text = "output"): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  }) as unknown as AgentMessage;

describe("tool noise", () => {
  it("counts the tool-result share, and drops nothing below the threshold", () => {
    // One tool result in five messages is 20%, under the 25% threshold.
    const messages = [
      user("a"),
      call("c1"),
      result("c1"),
      user("b"),
      user("c"),
    ];
    expect(toolResultShare(messages)).toBe(20);
    expect(toolResultShare(messages)).toBeLessThan(TOOL_MESSAGE_DROP_THRESHOLD);
    expect(dropToolPairs(messages)).toEqual(messages);
  });

  it("drops whole pairs once the share is past the threshold", () => {
    // Two tool results in four messages is 50%.
    const messages = [call("c1"), result("c1"), call("c2"), result("c2")];
    expect(toolResultShare(messages)).toBe(50);
    expect(dropToolPairs(messages)).toEqual([]);
  });

  it("never splits a pair across the cut", () => {
    // c2's result is missing from this prefix, so the assistant half stays: a
    // call whose result is not here keeps the model's intent readable.
    const messages = [call("c1"), result("c1"), call("c2")];
    expect(toolResultShare(messages)).toBe(33);
    const dropped = dropToolPairs(messages);
    expect(dropped).toHaveLength(1);
    expect((dropped[0] as { content: { id?: string }[] }).content[0]?.id).toBe(
      "c2",
    );
  });

  it("keeps assistant messages that made no tool calls", () => {
    const plain = {
      role: "assistant",
      content: [{ type: "text", text: "thinking out loud" }],
    } as unknown as AgentMessage;
    const messages = [plain, result("c1"), result("c2"), result("c3")];
    expect(dropToolPairs(messages)).toEqual([plain]);
  });
});

describe("max-min-fair", () => {
  it("reallocates slack to the messages that can use it", () => {
    // Budget 100 over sizes 10, 10, 1000: the small ones take what they need and
    // the leftover goes to the big one.
    expect(maxMinFairAllocations([10, 10, 1000], 100)).toEqual([10, 10, 80]);
  });

  it("is deterministic and splits evenly when nothing fits", () => {
    expect(maxMinFairAllocations([100, 100, 100], 90)).toEqual([30, 30, 30]);
    expect(maxMinFairAllocations([], 100)).toEqual([]);
  });

  it("never allocates more than a message's size", () => {
    const sizes = [5, 5, 5];
    expect(maxMinFairAllocations(sizes, 1000)).toEqual([5, 5, 5]);
  });
});

describe("fair truncation", () => {
  it("marks omitted and truncated messages", () => {
    const messages = [user("x".repeat(2_000)), user("y".repeat(2_000))];
    const text = truncateFairly(messages, 1_000)!;
    expect(text).toContain("truncated");
    // Both messages appear: the budget was split, not spent on the first one.
    expect(text.split("truncated").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("drops messages that cannot hold a useful amount", () => {
    const messages = [user("a"), user("x".repeat(5_000))];
    const text = truncateFairly(messages, 500)!;
    expect(text).toContain("a");
    expect(text).toMatch(/\[omitted message, \d+ chars\]|truncated/);
  });

  it("returns nothing when no message fits at all", () => {
    expect(truncateFairly([], 500)).toBeUndefined();
  });

  it("a digest never comes back empty, even when the budget cannot spread", () => {
    // Many large messages and a budget smaller than the fair share: spreading
    // it writes off every message ("omitted"), which would drop the history
    // exactly when it is needed. The newest messages are kept instead.
    const messages = Array.from({ length: 30 }, (_, index) =>
      user(`message ${index} ${"y".repeat(2_000)}`, index),
    );
    expect(truncateFairly(messages, 3_200)).toBeUndefined();
    const digest = digestContext(messages, 3_200)!;
    expect(digest.startsWith(UNTRUSTED_SUMMARY_NOTE)).toBe(true);
    // The tail survived, not the head: what the kept history continues from.
    expect(digest).toContain("message 29");
    expect(digest).not.toContain("message 0 ");
  });

  it("labels a mechanical digest as untrusted", () => {
    const text = untrustedFallback([user("something worth keeping")], 10_000)!;
    expect(text.startsWith(UNTRUSTED_SUMMARY_NOTE)).toBe(true);
    expect(text).toContain("something worth keeping");
    expect(untrustedFallback([], 10_000)).toBeUndefined();
  });
});
