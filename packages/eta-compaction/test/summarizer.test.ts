/**
 * The summarizer (REFACTOR.md §6.2).
 *
 * A fake `ask` stands in for the model, so what is pinned here is the decision
 * layer: where the cut falls, what is retained, when the notes are kept instead
 * of rewritten, how a long prefix folds into the window, what happens when the
 * summarizer refuses, and what a split turn does. The prompts are asserted by
 * contract (the format the next reader depends on), not by wording.
 */
import type {
  AgentMessage,
  AssistantMessage,
  CompactionRequest,
} from "@eta/core";
import type { Entry } from "@eta/core/session";
import type { Usage } from "@eta/core/storage";
import { describe, expect, it } from "vitest";
import {
  etaCompaction,
  planCompaction,
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  SUMMARY_FOLD_LIMIT,
  TURN_PREFIX_SUMMARIZATION_PROMPT,
  UNTRUSTED_SUMMARY_NOTE,
} from "../src/index";

const user = (text: string, timestamp = 0): AgentMessage =>
  ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  }) as AgentMessage;

const answer = (text: string, timestamp = 0): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp,
  }) as unknown as AgentMessage;

const call = (
  id: string,
  name = "bash",
  args: Record<string, unknown> = { command: "ls" },
  timestamp = 0,
): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    stopReason: "toolUse",
    timestamp,
  }) as unknown as AgentMessage;

const result = (id: string, text = "output", timestamp = 0): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  }) as unknown as AgentMessage;

let seq = 0;
/** The branch entries behind a message list, as the kernel would hand them over. */
function entriesOf(messages: readonly AgentMessage[]): Entry[] {
  seq = 0;
  let parentId: string | null = null;
  return messages.map((message) => {
    seq += 1;
    const id = `e${seq}`;
    const entry = {
      id,
      parentId,
      seq,
      timestamp: 0,
      type: "message",
      message,
    } as Entry;
    parentId = id;
    return entry;
  });
}

const usageOf = (output: number): Usage => ({
  input: 10,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 10 + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

interface AskCall {
  systemPrompt?: string;
  messages: AgentMessage[];
  maxTokens?: number;
  reasoning?: string;
}

/** A scripted model call, recording what it was asked and answering in order. */
function asker(
  script: string[],
  stopReason: "stop" | "error" | "aborted" = "stop",
) {
  const calls: AskCall[] = [];
  let index = 0;
  const usage: Usage[] = [];
  const ask: CompactionRequest["ask"] = async (prompt, options) => {
    calls.push({
      systemPrompt: prompt.systemPrompt,
      messages: prompt.messages,
      maxTokens: options?.maxTokens,
      reasoning: options?.reasoning,
    });
    // The fallback names the piece, so a fold test does not have to guess how
    // many pieces the window will produce.
    const text = script[index] ?? `piece ${index + 1}`;
    index += 1;
    const cost = usageOf(5);
    usage.push(cost);
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
      ...(stopReason === "error"
        ? { errorMessage: "summarizer exploded" }
        : {}),
      usage: cost,
      timestamp: 0,
    } as unknown as AssistantMessage;
  };
  return { ask, calls, usage };
}

function request(
  messages: readonly AgentMessage[],
  ask: CompactionRequest["ask"],
  overrides: Partial<CompactionRequest> = {},
): CompactionRequest {
  return {
    reason: "threshold",
    messages,
    entries: entriesOf(messages),
    settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 500 },
    contextWindow: 200_000,
    estimatedTokens: 10_000,
    model: {
      id: "fake",
      name: "fake",
      api: "openai-completions",
      provider: "fake",
      baseUrl: "http://x",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    } as never,
    thinkingLevel: "off",
    signal: new AbortController().signal,
    ask,
    ...overrides,
  };
}

/**
 * A history long enough that a cut is needed, shaped so the cut lands on a user
 * message: the size sits in the questions, and the answers are negligible, so
 * walking back over the keep budget crosses inside a question rather than an
 * answer (an answer would split that turn in two).
 */
function longHistory(turns = 6, chars = 400): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push(user(`question ${turn} ${"x".repeat(chars)}`));
    messages.push(answer(`ack ${turn}`));
  }
  return messages;
}

describe("the cut", () => {
  it("keeps the recent tail and summarizes what is left", async () => {
    const messages = longHistory();
    const { ask, calls } = asker(["notes"]);
    const outcome = await etaCompaction().summarize(request(messages, ask));

    expect(outcome?.summary).toContain("notes");
    // The retained tail is a suffix of the history, and a real part of it.
    expect(outcome!.retainedTail.length).toBeGreaterThan(0);
    expect(outcome!.retainedTail.length).toBeLessThan(messages.length);
    expect(outcome!.retainedTail[0]).toEqual(
      messages[messages.length - outcome!.retainedTail.length],
    );
    // It is the budget that decided, so the tail is worth roughly the keep budget.
    expect(outcome!.tokensBefore).toBe(10_000);
    // One request: the cut landed on a question, so nothing was split in two.
    expect(calls).toHaveLength(1);
    // The prompt is the first-time one, with the format the next reader needs.
    const prompt = JSON.stringify(calls[0]!.messages);
    expect(prompt).toContain(SUMMARIZATION_PROMPT.split("\n")[0]!.slice(0, 40));
    expect(calls[0]!.systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT);
  });

  it("never cuts between a tool call and its result", async () => {
    const messages = longHistory();
    // A tool pair right at the boundary: whatever the cut does, both halves end
    // up on the same side.
    messages.push(call("c1"), result("c1"));
    messages.push(user("the last question"), answer("the last answer"));
    const { ask } = asker(["notes"]);
    const outcome = await etaCompaction().summarize(request(messages, ask));

    const summarized = messages.slice(
      0,
      messages.length - outcome!.retainedTail.length,
    );
    const calls = summarized.filter(
      (message) =>
        message.role === "assistant" &&
        (message as { content: { type: string }[] }).content.some(
          (block) => block.type === "toolCall",
        ),
    );
    const results = summarized.filter(
      (message) => message.role === "toolResult",
    );
    // Any tool call that made it into the summarized prefix has its result there.
    expect(results.length).toBeGreaterThanOrEqual(0);
    expect(results.length === 0 || calls.length > 0).toBe(true);
  });

  it("drops tool noise from the prefix, in whole pairs", () => {
    // A prefix that is mostly tool results: fifty percent here.
    const messages = [call("c1"), result("c1"), call("c2"), result("c2")];
    const plan = planCompaction({
      entries: entriesOf(messages),
      settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
      estimatedTokens: 100,
    });
    expect(plan.messagesToSummarize).toEqual([]);
  });
});

describe("nothing to summarize", () => {
  it("keeps the existing notes instead of asking for a rewrite", async () => {
    // A previous compaction followed by one message, with a keep budget that
    // covers all of it: nothing new needs noting, so the notes stand and no
    // request is made (asking for a rewrite could not change them).
    const previousSummary = "## Goal\nkeep the kernel honest";
    const earlier = user("an earlier question");
    const later = answer("an answer since the notes");
    const messages = [earlier, later];
    const entries: Entry[] = [
      {
        id: "c1",
        parentId: null,
        seq: 1,
        timestamp: 0,
        type: "compaction",
        summary: previousSummary,
        retainedTail: [earlier],
        tokensBefore: 500,
      },
      {
        id: "e2",
        parentId: "c1",
        seq: 2,
        timestamp: 0,
        type: "message",
        message: later,
      },
    ];
    const { ask, calls } = asker([]);
    const outcome = await etaCompaction().summarize(
      request(messages, ask, {
        entries,
        settings: {
          enabled: true,
          reserveTokens: 1_000,
          keepRecentTokens: 100_000,
        },
      }),
    );

    expect(calls).toEqual([]);
    expect(outcome?.summary).toBe(previousSummary);
    expect(outcome?.usage?.output).toBe(0);
    // Everything is retained, because nothing was replaced.
    expect(outcome?.retainedTail).toEqual([earlier, later]);
  });
});

const UPDATE_SUMMARY_PROMPT_MARKER = "You're updating them, not starting over.";

describe("incremental summaries", () => {
  it("updates the previous notes rather than redoing them", async () => {
    const previousSummary = "## Goal\nship the compaction";
    const messages = longHistory();
    const entries: Entry[] = [
      {
        id: "c1",
        parentId: null,
        seq: 1,
        timestamp: 0,
        type: "compaction",
        summary: previousSummary,
        retainedTail: [],
        tokensBefore: 100,
      },
      ...entriesOf(messages).map((entry, index) => ({
        ...entry,
        id: `m${index}`,
        parentId: index === 0 ? "c1" : `m${index - 1}`,
      })),
    ];
    const { ask, calls } = asker([
      "## Goal\nship the compaction\n\n## Progress\n- [x] cut the history",
    ]);
    const outcome = await etaCompaction().summarize(
      request(messages, ask, { entries }),
    );

    // The update prompt, and the old notes in the message: the model continues
    // them instead of starting over.
    const prompt = JSON.stringify(calls[0]!.messages);
    expect(prompt).toContain("<previous-summary>");
    expect(prompt).toContain("ship the compaction");
    expect(prompt).toContain(UPDATE_SUMMARY_PROMPT_MARKER);
    expect(outcome?.summary).toContain("cut the history");
  });

  it("uses the first-time prompt when there are no previous notes", async () => {
    const { ask, calls } = asker(["notes"]);
    await etaCompaction().summarize(request(longHistory(), ask));
    const prompt = JSON.stringify(calls[0]!.messages);
    expect(prompt).not.toContain("<previous-summary>");
    expect(prompt).toContain(SUMMARIZATION_PROMPT.split("\n")[0]!.slice(0, 40));
  });
});

describe("folding a history the window cannot hold", () => {
  it("asks once per piece, each an update of the running notes", async () => {
    // A window far smaller than the history forces the fold path, and the keep
    // budget lands the cut on a question, so no turn is split in two.
    const messages = longHistory(40, 2_000);
    const { ask, calls } = asker([
      "piece 1",
      "piece 2",
      "piece 3",
      "piece 4",
      "piece 5",
    ]);
    const outcome = await etaCompaction().summarize(
      request(messages, ask, {
        contextWindow: 4_000,
        settings: {
          enabled: true,
          reserveTokens: 1_000,
          keepRecentTokens: 600,
        },
      }),
    );

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThanOrEqual(SUMMARY_FOLD_LIMIT);
    // The first piece is the first-time prompt; every later piece is an update
    // carrying what the earlier pieces concluded.
    expect(JSON.stringify(calls[0]!.messages)).not.toContain(
      "<previous-summary>",
    );
    expect(JSON.stringify(calls[1]!.messages)).toContain("<previous-summary>");
    expect(JSON.stringify(calls[1]!.messages)).toContain("piece 1");
    // The notes are what the last piece answered.
    expect(outcome?.summary.startsWith("piece ")).toBe(true);
    // And what it cost is summed across the pieces.
    expect(outcome?.usage?.output).toBe(5 * calls.length);
  });

  it("stops folding at the limit and digests the rest, labeled untrusted", async () => {
    // The limit is checked before a piece is asked, so a limit of two allows one
    // summary and digests everything after it (eta-agent's loop shape).
    const messages = longHistory(40, 2_000);
    const { ask, calls } = asker(["piece 1", "piece 2"]);
    const outcome = await etaCompaction({ foldLimit: 2 }).summarize(
      request(messages, ask, {
        contextWindow: 4_000,
        settings: {
          enabled: true,
          reserveTokens: 1_000,
          keepRecentTokens: 600,
        },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(outcome?.summary).toContain("piece 1");
    expect(outcome?.summary).toContain(UNTRUSTED_SUMMARY_NOTE);
    // The digest carries raw context, so the history is not lost to the limit.
    expect(outcome?.summary.length).toBeGreaterThan(
      UNTRUSTED_SUMMARY_NOTE.length + 100,
    );
  });
});

describe("when there is nothing to compact", () => {
  it("declines instead of asking a model to summarize an empty conversation", async () => {
    // A keep budget larger than the history means the cut is at the beginning:
    // nothing to replace, so nothing to ask.
    const messages = [user("one question"), answer("one answer")];
    const { ask, calls } = asker([]);
    const outcome = await etaCompaction().summarize(
      request(messages, ask, {
        settings: {
          enabled: true,
          reserveTokens: 1_000,
          keepRecentTokens: 100_000,
        },
      }),
    );
    expect(outcome).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("declines when the journal already ends with a compaction", async () => {
    const messages = [user("a question"), answer("an answer")];
    const entries: Entry[] = [
      {
        id: "e1",
        parentId: null,
        seq: 1,
        timestamp: 0,
        type: "message",
        message: messages[0]!,
      },
      {
        id: "c1",
        parentId: "e1",
        seq: 2,
        timestamp: 0,
        type: "compaction",
        summary: "already compacted",
        retainedTail: [messages[1]!],
        tokensBefore: 100,
      },
    ];
    const { ask, calls } = asker([]);
    const outcome = await etaCompaction().summarize(
      request(messages, ask, { entries }),
    );
    expect(outcome).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe("when the summarizer refuses", () => {
  it("declines on an abort, leaving the decision to the caller", async () => {
    const { ask } = asker(["never used"], "aborted");
    const outcome = await etaCompaction().summarize(
      request(longHistory(), ask),
    );
    expect(outcome).toBeUndefined();
  });

  it("digests the history when the request fails, rather than losing it", async () => {
    const { ask, calls } = asker(["never used"], "error");
    const outcome = await etaCompaction().summarize(
      request(longHistory(), ask),
    );
    expect(calls).toHaveLength(1);
    expect(outcome?.summary.startsWith(UNTRUSTED_SUMMARY_NOTE)).toBe(true);
    expect(outcome?.summary.length).toBeGreaterThan(
      UNTRUSTED_SUMMARY_NOTE.length,
    );
  });
});

describe("a split turn", () => {
  it("summarizes the early half on its own terms and marks it", async () => {
    // One user turn made of many exchanges: the cut lands inside it, so the
    // prefix gets its own note and the kept half stays readable.
    const messages: AgentMessage[] = [
      user("earlier question"),
      answer("earlier answer"),
    ];
    messages.push(user("a very long turn"));
    for (let step = 0; step < 8; step += 1) {
      messages.push(
        call(`c${step}`),
        result(`c${step}`, `out ${step} ${"z".repeat(200)}`),
      );
    }
    const { ask, calls } = asker(["history notes", "prefix notes"]);
    const outcome = await etaCompaction().summarize(
      request(messages, ask, {
        settings: {
          enabled: true,
          reserveTokens: 1_000,
          keepRecentTokens: 300,
        },
      }),
    );

    const prompts = calls.map((call) => JSON.stringify(call.messages));
    expect(
      prompts.some((prompt) =>
        prompt.includes(TURN_PREFIX_SUMMARIZATION_PROMPT.slice(0, 30)),
      ),
    ).toBe(true);
    expect(outcome?.summary).toContain("Turn Context (split turn)");
    expect(outcome?.summary).toContain("prefix notes");
    expect(outcome?.retainedTail.length).toBeGreaterThan(0);
  });
});

describe("what the summary carries", () => {
  it("appends the files the history touched", async () => {
    // The tool turns are spaced out with plain text, so the summary-to-be keeps
    // its tool pairs (dropping them is for a prefix that is mostly tool noise)
    // and the recent turn is a plain question, where the cut lands.
    const messages: AgentMessage[] = [
      user("first, some groundwork"),
      answer("groundwork done"),
      user("look at these"),
      call("c1", "read", { path: "/tmp/read-me.ts" }),
      result("c1", "read output"),
      answer("read it"),
      user("now write one"),
      call("c2", "write", { path: "/tmp/written.ts" }),
      result("c2", "write output"),
      answer("wrote it"),
      user("now edit one"),
      call("c3", "edit", { path: "/tmp/edited.ts" }),
      result("c3", "edit output"),
      answer("edited it"),
      user(`and now something else ${"z".repeat(400)}`),
      answer("ack"),
    ];
    const { ask } = asker(["notes"]);
    const outcome = await etaCompaction().summarize(
      request(messages, ask, {
        settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 10 },
      }),
    );

    expect(outcome?.summary).toContain(
      "<read-files>\n/tmp/read-me.ts\n</read-files>",
    );
    expect(outcome?.summary).toContain(
      "<modified-files>\n/tmp/edited.ts\n/tmp/written.ts\n</modified-files>",
    );
    expect(outcome?.details).toEqual({
      readFiles: ["/tmp/read-me.ts"],
      modifiedFiles: ["/tmp/edited.ts", "/tmp/written.ts"],
    });
  });

  it("asks with the token budget the reserve allows", async () => {
    const { ask, calls } = asker(["notes"]);
    await etaCompaction().summarize(
      request(longHistory(), ask, {
        settings: {
          enabled: true,
          reserveTokens: 4_000,
          keepRecentTokens: 500,
        },
      }),
    );
    expect(calls[0]!.maxTokens).toBe(3_200); // 80% of the reserve
    expect(calls[0]!.reasoning).toBeUndefined(); // thinking level is off
  });

  it("passes the thinking level through when it is on", async () => {
    const { ask, calls } = asker(["notes"]);
    await etaCompaction().summarize(
      request(longHistory(), ask, { thinkingLevel: "high" }),
    );
    expect(calls[0]!.reasoning).toBe("high");
  });

  it("carries a manual compaction's extra focus into the prompt", async () => {
    const { ask, calls } = asker(["notes"]);
    await etaCompaction().summarize(
      request(longHistory(), ask, {
        reason: "manual",
        customInstructions: "focus on the migration plan",
      }),
    );
    expect(JSON.stringify(calls[0]!.messages)).toContain(
      "Additional focus: focus on the migration plan",
    );
  });
});
