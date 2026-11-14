/**
 * Transcript → provider messages (`prompts/summaries.ts`).
 *
 * The kernel refuses to invent prompt text when the context holds a summary, which
 * makes this function load-bearing: without it, a session that compacts can never run
 * again — the next request throws before it reaches a model. Both halves are checked
 * here (the wording, and that a plain conversation passes through untouched).
 */

import type { AgentMessage } from "@eta/core";
import { describe, expect, it } from "vitest";
import {
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  convertToLlm,
} from "../src/prompts/summaries";

const user = (text: string): AgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 1,
});

describe("convertToLlm", () => {
  it("passes a plain conversation through, in order", () => {
    const messages: AgentMessage[] = [
      user("hello"),
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        timestamp: 2,
      } as AgentMessage,
    ];
    expect(convertToLlm(messages)).toEqual(messages);
  });

  it("renders a compaction summary as the user message the model has always seen", () => {
    const converted = convertToLlm([
      {
        role: "compactionSummary",
        summary: "the gist",
        tokensBefore: 1234,
        timestamp: 3,
      },
    ]);
    expect(converted).toHaveLength(1);
    expect(converted[0]?.content).toEqual([
      {
        type: "text",
        text: `${COMPACTION_SUMMARY_PREFIX}the gist${COMPACTION_SUMMARY_SUFFIX}`,
      },
    ]);
    expect(converted[0]?.role).toBe("user");
  });

  it("renders a branch summary the same way, with its own words", () => {
    const converted = convertToLlm([
      {
        role: "branchSummary",
        summary: "the other path",
        fromId: "e1",
        timestamp: 4,
      },
    ]);
    expect(converted[0]?.content).toEqual([
      {
        type: "text",
        text: `${BRANCH_SUMMARY_PREFIX}the other path${BRANCH_SUMMARY_SUFFIX}`,
      },
    ]);
  });

  it("keeps the summary in place, with what came after it in order", () => {
    const converted = convertToLlm([
      {
        role: "compactionSummary",
        summary: "cut here",
        tokensBefore: 10,
        timestamp: 5,
      },
      user("after the cut"),
    ]);
    expect(converted).toHaveLength(2);
    expect(JSON.stringify(converted[0])).toContain("cut here");
    expect(JSON.stringify(converted[1])).toContain("after the cut");
  });
});
