import type { Event, RuntimeEventBody } from "@botiverse/oar";
import type { RuntimeId } from "../src";
import { describe, expect, it } from "vitest";
import { HostCalls } from "../src/host-calls";
import { Translator } from "../src/translate";

function setup(provider: RuntimeId = "claude") {
  const observations: unknown[] = [];
  const translator = new Translator(
    {
      runId: "run-1",
      emit: (name, payload) => {
        if (name === "context:observed") observations.push(payload);
      },
      noteTurn: () => true,
      push: () => {},
    },
    { provider, model: "model-a" },
    undefined,
    new HostCalls(provider, new Set()),
  );
  let seq = 0;
  const frame = (
    type: string,
    native: unknown,
    events: readonly RuntimeEventBody[] = [],
    agentPath: readonly string[] = [],
  ) => {
    const envelope = {
      seq: seq++,
      sessionId: "native-1",
      receivedAt: Date.now(),
      agentPath,
    };
    if (native !== undefined)
      translator.seeRaw({
        ...envelope,
        kind: "frame",
        body: { type, native, events },
      });
    for (const event of events)
      translator.see({ ...envelope, ...event } as Event);
  };
  return { observations, frame };
}

const assistant = {
  type: "assistant",
  message: {
    model: "model-a",
    usage: {
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
    },
  },
};
const result = {
  type: "result",
  subtype: "success",
  num_turns: 1,
  usage: {
    input_tokens: 123,
    cache_read_input_tokens: 13696,
    cache_creation_input_tokens: 0,
  },
  modelUsage: { "model-a": { contextWindow: 1_000_000 } },
};
const completed = {
  kind: "turn_ended",
  outcome: { kind: "completed" },
} as const;
const placeholder = {
  kind: "usage",
  usage: {
    context: { tokens: 0, contextWindow: 1_000_000, percent: 0 },
    tokens: { input: 240_000, output: 50, cacheRead: 180_000, cacheWrite: 200 },
  },
} as const;
const missing = { used: null, window: null, reason: "missing" };

describe("claude context from a native result", () => {
  it("uses raw per-turn input and adds cache once even when OAR also reports a running total", () => {
    const { frame, observations } = setup();
    frame("assistant", assistant);
    frame("result/success", result, [placeholder, completed]);
    expect(observations).toEqual([
      expect.objectContaining({
        runId: "run-1",
        nativeSessionId: "native-1",
        used: 13819,
        window: 1_000_000,
      }),
    ]);
  });

  it("uses explicit native per-turn evidence when neither assistant usage nor a normalized baseline is available", () => {
    const { frame, observations } = setup();
    frame("assistant", { type: "assistant", message: { model: "model-a" } });
    frame("result/success", result, [completed]);
    expect(observations).toEqual([
      expect.objectContaining({ used: 13819, window: 1_000_000 }),
    ]);
  });

  it("keeps a positive assistant reading when the result has a different count", () => {
    const { frame, observations } = setup();
    frame("assistant", {
      ...assistant,
      message: {
        ...assistant.message,
        usage: { ...assistant.message.usage, input_tokens: 9000 },
      },
    });
    frame("result/success", result, [
      {
        kind: "usage",
        usage: {
          context: { tokens: 9000, contextWindow: 1_000_000, percent: 1 },
        },
      },
      completed,
    ]);
    expect(observations).toEqual([
      expect.objectContaining({ used: 9000, window: 1_000_000 }),
    ]);
  });

  it("cannot infer context from a cumulative report without context or raw result evidence", () => {
    const { frame, observations } = setup();
    frame("result/success", undefined, [
      { kind: "usage", usage: { tokens: placeholder.usage.tokens } },
      completed,
    ]);
    expect(observations).toEqual([expect.objectContaining(missing)]);
  });

  it.each([
    ["only a normalized running total", undefined],
    ["no raw usage", { ...result, usage: undefined }],
    [
      "no explicit cache count",
      {
        ...result,
        usage: { input_tokens: 123, cache_read_input_tokens: 13696 },
      },
    ],
    [
      "zero result placeholders",
      {
        ...result,
        usage: {
          input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ],
    [
      "no matching reported window",
      { ...result, modelUsage: { other: { contextWindow: 1_000_000 } } },
    ],
    ["no single-turn evidence", { ...result, num_turns: undefined }],
    ["multiple model calls", { ...result, num_turns: 2 }],
  ])("publishes missing with %s", (_cause, native) => {
    const { frame, observations } = setup();
    frame("assistant", assistant);
    frame("result/success", native, [placeholder, completed]);
    expect(observations).toEqual([expect.objectContaining(missing)]);
  });

  it("never uses an assistant frame from a subagent or the preceding turn", () => {
    const { frame, observations } = setup();
    frame("assistant", assistant);
    frame("result/success", result, [placeholder, completed]);
    frame("assistant", assistant, [], ["child"]);
    frame("result/success", result, [placeholder, completed]);
    expect(observations.at(-1)).toMatchObject(missing);
  });

  it("does not publish raw fallback results across a compaction boundary", () => {
    const { frame, observations } = setup();
    frame("assistant", assistant);
    frame("system/compact_boundary", { type: "system" }, [
      { kind: "compaction_ended", outcome: "completed" },
    ]);
    frame("result/success", result, [placeholder, completed]);
    expect(observations).toEqual([
      expect.objectContaining({ reason: "compacted" }),
      expect.objectContaining(missing),
    ]);
  });

  it.each(["pi", "codex"] as const)(
    "keeps an explicit reported zero from %s",
    (provider) => {
      const { frame, observations } = setup(provider);
      frame("usage", undefined, [placeholder, completed]);
      expect(observations).toEqual([
        expect.objectContaining({ used: 0, window: 1_000_000 }),
      ]);
    },
  );
});
