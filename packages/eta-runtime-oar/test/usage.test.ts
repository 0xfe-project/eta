/**
 * oar reports a running total of tokens; eta charges each assistant message what the total grew by
 * since the one before it. What these pin: adding a run's messages up gives what the runtime
 * reported for that run, each token once, also across runs of one runtime session; cache traffic is
 * taken out of `input`; the model is the one the runtime reported in effect; and a message from
 * before the runtime reported anything says "not reported", not 0.
 */
import type { Event, EventBody, TokenTotals } from "@botiverse/oar";
import type { AgentMessage, AssistantMessage } from "@eta/core";
import type { TranslatorTarget } from "../src/translate";
import { reportedField, tokensReported } from "@eta/core";
import { describe, expect, it } from "vitest";
import { HostCalls } from "../src/host-calls";
import { Translator } from "../src/translate";

function run(charged: TokenTotals | undefined) {
  const pushed: AgentMessage[] = [];
  const target: TranslatorTarget = {
    runId: "run-1",
    emit: (() => undefined) as TranslatorTarget["emit"],
    push: (message) => pushed.push(message),
    noteTurn: () => true,
  };
  const translator = new Translator(
    target,
    { provider: "claude", model: "opus" },
    charged,
    new HostCalls("claude", new Set()),
  );
  let seq = 0;
  const see = (body: EventBody): void =>
    translator.see({
      ...body,
      sessionId: "native-1",
      agentPath: [],
      seq: seq++,
      receivedAt: Date.now(),
    } as Event);
  const total = (tokens: TokenTotals): void =>
    see({ kind: "usage", usage: { tokens } } as EventBody);
  /** A message of words, then a tool call that ends it. */
  const step = (words: string, callId: string): void => {
    see({ kind: "text_delta", text: words } as EventBody);
    see({ kind: "tool_call_started", callId, tool: "Read" } as EventBody);
    see({
      kind: "tool_call_ended",
      callId,
      content: [{ type: "text", text: "ok" }],
      result: "ok",
    } as EventBody);
  };
  const assistants = (): AssistantMessage[] =>
    pushed.filter(
      (message): message is AssistantMessage => message.role === "assistant",
    );
  return { translator, see, total, step, assistants };
}

/** What a run's messages add up to, as eta counts it. */
const sum = (messages: AssistantMessage[]) =>
  messages.reduce(
    (acc, { usage }) => ({
      input: acc.input + usage.input,
      output: acc.output + usage.output,
      cacheRead: acc.cacheRead + usage.cacheRead,
      cacheWrite: acc.cacheWrite + usage.cacheWrite,
      reasoning: acc.reasoning + (usage.reasoning ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  );

describe("oar's running totals, as each message's share", () => {
  it("only charges new cache traffic when an optional counter returns", () => {
    const turn = run(undefined);
    turn.total({ input: 1000, output: 0, cacheRead: 200 });
    turn.step("one", "c1");
    turn.total({ input: 1200, output: 0 });
    turn.step("two", "c2");
    turn.total({ input: 1500, output: 0, cacheRead: 300 });
    turn.step("three", "c3");
    expect(
      turn.assistants().map(({ usage }) => reportedField(usage, "cacheRead")),
    ).toEqual([200, null, 100]);
  });

  it("add up to what was reported, each token once, across messages and runs", () => {
    const first = run(undefined);
    // Nothing reported yet: the first message has no count, which is not a count of 0.
    first.step("looking", "c1");
    first.total({
      input: 1_000,
      cacheRead: 600,
      cacheWrite: 100,
      output: 50,
      reasoning: 20,
    });
    first.step("reading", "c2");
    first.see({ kind: "model", model: "claude-opus-5-5" } as EventBody);
    first.see({ kind: "text_delta", text: "done" } as EventBody);
    first.total({
      input: 2_500,
      cacheRead: 1_800,
      cacheWrite: 200,
      output: 90,
      reasoning: 30,
    });
    first.translator.finish("completed");

    const [unknown, ...counted] = first.assistants();
    expect(tokensReported(unknown!.usage)).toBe(false);
    expect(counted.every((message) => tokensReported(message.usage))).toBe(
      true,
    );
    // The run's messages together are the run's total, cache taken out of input.
    expect(sum(first.assistants())).toEqual({
      input: 2_500 - 1_800 - 200,
      output: 90,
      cacheRead: 1_800,
      cacheWrite: 200,
      reasoning: 30,
    });
    // The model the runtime said is in effect, not the one asked for.
    expect(counted.at(-1)!.model).toBe("claude-opus-5-5");

    // The next run of the same runtime session starts from what was charged: only the growth.
    const second = run(first.translator.charged);
    second.see({ kind: "text_delta", text: "again" } as EventBody);
    second.total({
      input: 3_000,
      cacheRead: 2_200,
      cacheWrite: 250,
      output: 120,
      reasoning: 30,
    });
    second.translator.finish("completed");
    expect(sum(second.assistants())).toEqual({
      input: 500 - 400 - 50,
      output: 30,
      cacheRead: 400,
      cacheWrite: 50,
      reasoning: 0,
    });
  });
});
