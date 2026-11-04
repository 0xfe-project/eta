/**
 * A call to one of the host's tools, as each runtime reports it, fed straight to the translator.
 * The spellings here are what the real runtimes said when a served tool was called through them
 * (Claude Code 2.1, Codex 0.162, OpenCode 1.18); Pi's is the one oar documents.
 *
 * What these pin: the transcript holds the host's name for the tool and the `details` the tool
 * left, on the journaled messages and on `tool:end` alike; overlapping calls of one tool keep
 * their own details whichever order they end in; a user's own MCP tools keep the runtime's name.
 */
import type { Event, EventBody, RawEvent } from "@botiverse/oar";
import type { AgentMessage } from "@eta/core";
import type { RuntimeId } from "../src/catalog";
import type { TranslatorTarget } from "../src/translate";
import { describe, expect, it } from "vitest";
import { HostCalls } from "../src/host-calls";
import { Translator } from "../src/translate";

type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;
type Assistant = Extract<AgentMessage, { role: "assistant" }>;

const SERVED = new Set(["publish_artifact", "reply"]);

function setup(runtime: RuntimeId) {
  const pushed: AgentMessage[] = [];
  const ended: { toolName: string; result: { details?: unknown } }[] = [];
  const target: TranslatorTarget = {
    runId: "run-1",
    emit: ((
      name: string,
      payload: { toolName: string; result: { details?: unknown } },
    ) => {
      if (name === "tool:end") ended.push(payload);
    }) as TranslatorTarget["emit"],
    push: (message) => pushed.push(message),
    noteTurn: () => true,
  };
  const calls = new HostCalls(runtime, SERVED);
  const translator = new Translator(
    target,
    { provider: runtime, model: "m" },
    undefined,
    calls,
  );
  let seq = 0;
  const see = (body: EventBody, agentPath: readonly string[] = []): void =>
    translator.see({
      ...body,
      sessionId: "native-1",
      agentPath,
      seq: seq++,
      receivedAt: Date.now(),
    } as Event);
  /** Codex's frame for a call starting, and the event oar reads out of it. */
  const codexCall = (
    callId: string,
    server: string,
    tool: string,
    input: string,
  ): void => {
    calls.see({
      kind: "frame",
      sessionId: "native-1",
      agentPath: [],
      seq: seq++,
      receivedAt: Date.now(),
      body: {
        type: "item/started",
        native: {
          item: {
            type: "mcpToolCall",
            id: callId,
            server,
            tool,
            arguments: JSON.parse(input) as unknown,
          },
        },
        events: [],
      },
    } as RawEvent);
    see({
      kind: "tool_call_started",
      callId,
      tool: "mcpToolCall",
      input,
    });
  };
  const end = (callId: string, text: string, failed = false): void =>
    see({
      kind: "tool_call_ended",
      callId,
      content: [{ type: "text", text }],
      result: failed ? "failed" : "ok",
    });
  /** The result written for a call. */
  const resultOf = (callId: string): ToolResult => {
    const message = pushed.find(
      (entry): entry is ToolResult =>
        entry.role === "toolResult" && entry.toolCallId === callId,
    );
    expect(message).toBeDefined();
    return message!;
  };
  const callNames = (): string[] =>
    pushed
      .filter((entry): entry is Assistant => entry.role === "assistant")
      .flatMap((message) =>
        message.content.flatMap((block) =>
          block.type === "toolCall" ? [block.name] : [],
        ),
      );
  return { see, calls, translator, codexCall, end, resultOf, callNames, ended };
}

const published = (version: number) => ({
  artifactId: `art-${version}`,
  title: `Page ${version}`,
  version,
  files: 1,
});

/** What a served tool said, as its handler keeps it. */
const answer = (
  calls: HostCalls,
  name: string,
  input: unknown,
  text: string,
  details?: unknown,
): void => calls.answered(name, input, [{ type: "text", text }], details);

describe("the name of a host tool's call", () => {
  it.each<[RuntimeId, string]>([
    ["claude", "mcp__eta__publish_artifact"],
    ["pi", "mcp__eta__publish_artifact"],
    ["opencode", "eta_publish_artifact"],
  ])("is the host's on %s, which says %s", (runtime, tool) => {
    const { see, end, resultOf, callNames, ended } = setup(runtime);
    see({ kind: "tool_call_started", callId: "c1", tool, input: "{}" });
    end("c1", "ok");
    expect(callNames()).toEqual(["publish_artifact"]);
    expect(resultOf("c1").toolName).toBe("publish_artifact");
    expect(ended[0]!.toolName).toBe("publish_artifact");
  });

  it("is the host's on codex, whose events only say mcpToolCall", () => {
    const { codexCall, end, resultOf, callNames } = setup("codex");
    codexCall("exec-1", "eta", "publish_artifact", "{}");
    end("exec-1", "ok");
    expect(callNames()).toEqual(["publish_artifact"]);
    expect(resultOf("exec-1").toolName).toBe("publish_artifact");
  });

  it("stays the runtime's for a tool this server does not serve", () => {
    const { see, end, callNames } = setup("claude");
    for (const tool of [
      "mcp__docs__publish_artifact",
      "mcp__eta_tools__reply",
      "mcp__eta__not_served",
      "publish_artifact_mcp__eta__",
      "Read",
    ]) {
      see({ kind: "tool_call_started", callId: tool, tool });
      end(tool, "ok");
    }
    expect(callNames()).toEqual([
      "mcp__docs__publish_artifact",
      "mcp__eta_tools__reply",
      "mcp__eta__not_served",
      "publish_artifact_mcp__eta__",
      "Read",
    ]);
  });

  it("stays the runtime's for opencode's tools that only start alike", () => {
    const { see, end, callNames } = setup("opencode");
    for (const tool of ["eta_tools_reply", "docs_reply", "bash"]) {
      see({ kind: "tool_call_started", callId: tool, tool });
      end(tool, "ok");
    }
    expect(callNames()).toEqual(["eta_tools_reply", "docs_reply", "bash"]);
  });

  it("stays the runtime's for a tool of another server on codex", () => {
    const { codexCall, end, callNames } = setup("codex");
    codexCall("exec-1", "docs", "reply", "{}");
    codexCall("exec-2", "eta", "not_served", "{}");
    end("exec-1", "ok");
    end("exec-2", "ok");
    expect(callNames()).toEqual(["mcpToolCall", "mcpToolCall"]);
  });

  it("does not read one runtime's spelling on another", () => {
    const { see, end, callNames } = setup("codex");
    see({
      kind: "tool_call_started",
      callId: "c1",
      tool: "mcp__eta__publish_artifact",
    });
    end("c1", "ok");
    expect(callNames()).toEqual(["mcp__eta__publish_artifact"]);
  });

  it("is the host's on a subagent's step too", () => {
    const { see, end, resultOf } = setup("claude");
    see({ kind: "tool_call_started", callId: "agent", tool: "Task" });
    see(
      {
        kind: "tool_call_started",
        callId: "k1",
        tool: "mcp__eta__reply",
        input: "{}",
      },
      ["agent"],
    );
    see({ kind: "tool_call_ended", callId: "k1", result: "ok" }, ["agent"]);
    end("agent", "done");
    expect(resultOf("agent").details).toMatchObject({
      children: [{ kind: "tool", id: "k1", name: "reply" }],
    });
  });
});

describe("the details of a host tool's call", () => {
  it("land on the result, as the tool left them", () => {
    const { see, calls, end, resultOf, ended } = setup("claude");
    see({
      kind: "tool_call_started",
      callId: "c1",
      tool: "mcp__eta__publish_artifact",
    });
    see({ kind: "tool_call_input", callId: "c1", input: '{"title":"Page 1"}' });
    answer(
      calls,
      "publish_artifact",
      { title: "Page 1" },
      'Published "Page 1" version 1 (1 files).',
      published(1),
    );
    end("c1", 'Published "Page 1" version 1 (1 files).');
    expect(resultOf("c1")).toMatchObject({
      toolName: "publish_artifact",
      details: published(1),
      isError: false,
    });
    expect(ended[0]!.result.details).toEqual(published(1));
  });

  it("do not cross between two calls that overlap", () => {
    const { see, calls, end, resultOf } = setup("claude");
    for (const [callId, title] of [
      ["c1", "Page 1"],
      ["c2", "Page 2"],
    ] as const)
      see({
        kind: "tool_call_started",
        callId,
        tool: "mcp__eta__publish_artifact",
        input: JSON.stringify({ title }),
      });
    // The second call answers first, and the runtime reports the ends in yet another order.
    answer(
      calls,
      "publish_artifact",
      { title: "Page 2" },
      "second",
      published(2),
    );
    answer(
      calls,
      "publish_artifact",
      { title: "Page 1" },
      "first",
      published(1),
    );
    end("c2", "second");
    end("c1", "first");
    expect(resultOf("c1").details).toEqual(published(1));
    expect(resultOf("c2").details).toEqual(published(2));
  });

  it("do not cross when two overlapping calls were given the same arguments", () => {
    const { calls, codexCall, end, resultOf } = setup("codex");
    codexCall("c1", "eta", "publish_artifact", '{"title":"Same"}');
    codexCall("c2", "eta", "publish_artifact", '{"title":"Same"}');
    answer(
      calls,
      "publish_artifact",
      { title: "Same" },
      "version 2",
      published(2),
    );
    answer(
      calls,
      "publish_artifact",
      { title: "Same" },
      "version 1",
      published(1),
    );
    end("c1", "version 1");
    end("c2", "version 2");
    expect(resultOf("c1").details).toEqual(published(1));
    expect(resultOf("c2").details).toEqual(published(2));
  });

  it("hand each of two identical calls one answer", () => {
    const { see, calls, end, resultOf } = setup("claude");
    for (const callId of ["c1", "c2"])
      see({
        kind: "tool_call_started",
        callId,
        tool: "mcp__eta__publish_artifact",
        input: "{}",
      });
    answer(calls, "publish_artifact", {}, "same", published(1));
    answer(calls, "publish_artifact", {}, "same", published(2));
    end("c1", "same");
    end("c2", "same");
    expect(
      [resultOf("c1").details, resultOf("c2").details].sort(
        (a, b) =>
          (a as { version: number }).version -
          (b as { version: number }).version,
      ),
    ).toEqual([published(1), published(2)]);
  });

  it("are found however the runtime joined the answer's blocks or ordered its keys", () => {
    const { see, calls, end, resultOf } = setup("opencode");
    see({
      kind: "tool_call_started",
      callId: "c1",
      tool: "eta_publish_artifact",
      input: "{}",
    });
    see({
      kind: "tool_call_input",
      callId: "c1",
      input: '{"b":{"d":1,"c":2},"a":1}',
    });
    calls.answered(
      "publish_artifact",
      { a: 1, b: { c: 2, d: 1 } },
      [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
      published(1),
    );
    answer(calls, "publish_artifact", { a: 2 }, "something else", published(2));
    end("c1", "one\n\ntwo");
    expect(resultOf("c1").details).toEqual(published(1));
  });

  it("are found by the arguments when the runtime rewrote the answer", () => {
    const { see, calls, end, resultOf } = setup("claude");
    see({
      kind: "tool_call_started",
      callId: "c1",
      tool: "mcp__eta__publish_artifact",
      input: '{"title":"Page 1"}',
    });
    answer(
      calls,
      "publish_artifact",
      { title: "Page 1" },
      "the whole answer",
      published(1),
    );
    end("c1", "the whole…");
    expect(resultOf("c1").details).toEqual(published(1));
  });

  it("stay beside what the runtime itself reported", () => {
    const { see, calls, resultOf } = setup("claude");
    see({
      kind: "tool_call_started",
      callId: "c1",
      tool: "mcp__eta__publish_artifact",
      input: "{}",
    });
    answer(calls, "publish_artifact", {}, "done", published(1));
    see({
      kind: "tool_call_ended",
      callId: "c1",
      content: [{ type: "text", text: "done" }],
      result: "ok",
      exitCode: 0,
    });
    expect(resultOf("c1").details).toEqual({ ...published(1), exitCode: 0 });
  });

  it("are not given to a call of another tool, or to one the host did not run", () => {
    const { see, calls, end, resultOf } = setup("claude");
    answer(calls, "publish_artifact", {}, "same", published(1));
    see({
      kind: "tool_call_started",
      callId: "c1",
      tool: "mcp__eta__reply",
      input: "{}",
    });
    see({ kind: "tool_call_started", callId: "c2", tool: "Read", input: "{}" });
    end("c1", "same");
    end("c2", "same");
    expect("details" in resultOf("c1")).toBe(false);
    expect("details" in resultOf("c2")).toBe(false);
  });

  it("of a failed call go to that call, not a sibling", () => {
    const { see, calls, end, resultOf } = setup("claude");
    for (const callId of ["c1", "c2"])
      see({
        kind: "tool_call_started",
        callId,
        tool: "mcp__eta__publish_artifact",
        input: "{}",
      });
    answer(calls, "publish_artifact", {}, "no such directory");
    answer(calls, "publish_artifact", {}, "published", published(1));
    end("c1", "no such directory", true);
    end("c2", "published");
    expect("details" in resultOf("c1")).toBe(false);
    expect(resultOf("c1").isError).toBe(true);
    expect(resultOf("c2").details).toEqual(published(1));
  });

  it("of a subagent's call are spent on it, not left for the root's", () => {
    const { see, calls, end, resultOf } = setup("claude");
    see({ kind: "tool_call_started", callId: "agent", tool: "Task" });
    see(
      {
        kind: "tool_call_started",
        callId: "k1",
        tool: "mcp__eta__publish_artifact",
        input: "{}",
      },
      ["agent"],
    );
    answer(calls, "publish_artifact", {}, "same", published(1));
    see(
      {
        kind: "tool_call_ended",
        callId: "k1",
        content: [{ type: "text", text: "same" }],
        result: "ok",
      },
      ["agent"],
    );
    see({
      kind: "tool_call_started",
      callId: "c2",
      tool: "mcp__eta__publish_artifact",
      input: "{}",
    });
    answer(calls, "publish_artifact", {}, "same", published(2));
    end("c2", "same");
    end("agent", "done");
    expect(resultOf("c2").details).toEqual(published(2));
  });

  it("only go to objects: a tool that left something else leaves nothing", () => {
    const { see, calls, end, resultOf } = setup("claude");
    see({
      kind: "tool_call_started",
      callId: "c1",
      tool: "mcp__eta__reply",
      input: "{}",
    });
    answer(calls, "reply", {}, "sent", "a string");
    end("c1", "sent");
    expect("details" in resultOf("c1")).toBe(false);
  });
});
