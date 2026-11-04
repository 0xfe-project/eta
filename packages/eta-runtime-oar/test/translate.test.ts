/**
 * What a root call's tool result carries beside its content, fed straight to the translator: the
 * scripted runtime has no subagents, exit codes or unrecognized parts, and these are the facts
 * the run log draws from `details`.
 *
 * What these pin: an exit code, a subagent's steps, the runtime task and unrecognized result
 * parts land on the call's result (the journaled message and `tool:end` alike), and a plain call
 * still has no `details`.
 */
import type { Event, EventBody } from "@botiverse/oar";
import type { AgentMessage } from "@eta/core";
import type { OarToolResultDetails, TranslatorTarget } from "../src/translate";
import { describe, expect, it } from "vitest";
import { HostCalls } from "../src/host-calls";
import { Translator } from "../src/translate";

type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;

function setup() {
  const pushed: AgentMessage[] = [];
  const ended: { toolCallId: string; result: unknown }[] = [];
  const target: TranslatorTarget = {
    runId: "run-1",
    emit: ((name: string, payload: { toolCallId: string; result: unknown }) => {
      if (name === "tool:end")
        ended.push({ toolCallId: payload.toolCallId, result: payload.result });
    }) as TranslatorTarget["emit"],
    push: (message) => pushed.push(message),
    noteTurn: () => true,
  };
  const translator = new Translator(
    target,
    { provider: "claude", model: "sonnet" },
    undefined,
    new HostCalls("claude", new Set()),
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
  /** The result written for a call, checked to be the same on the message and on `tool:end`. */
  const resultOf = (callId: string): ToolResult => {
    const message = pushed.find(
      (entry): entry is ToolResult =>
        entry.role === "toolResult" && entry.toolCallId === callId,
    );
    expect(message).toBeDefined();
    const end = ended.find((entry) => entry.toolCallId === callId);
    expect((end?.result as { details?: unknown }).details).toEqual(
      message!.details,
    );
    return message!;
  };
  const detailsOf = (callId: string): OarToolResultDetails =>
    resultOf(callId).details as OarToolResultDetails;
  return { see, translator, resultOf, detailsOf };
}

describe("a root call's result details", () => {
  it("leaves a plain call without details", () => {
    const { see, resultOf } = setup();
    see({ kind: "tool_call_started", callId: "c1", tool: "Read" });
    see({
      kind: "tool_call_ended",
      callId: "c1",
      content: [{ type: "text", text: "contents" }],
      result: "ok",
    });
    const result = resultOf("c1");
    expect(result.content).toEqual([{ type: "text", text: "contents" }]);
    expect(result.isError).toBe(false);
    expect("details" in result).toBe(false);
  });

  it("carries the exit code the runtime reported", () => {
    const { see, resultOf, detailsOf } = setup();
    see({ kind: "tool_call_started", callId: "c1", tool: "Bash" });
    see({
      kind: "tool_call_ended",
      callId: "c1",
      content: [{ type: "text", text: "no such file" }],
      result: "failed",
      exitCode: 2,
    });
    see({ kind: "tool_call_started", callId: "c2", tool: "Bash" });
    see({ kind: "tool_call_ended", callId: "c2", exitCode: null });
    expect(resultOf("c1").isError).toBe(true);
    expect(detailsOf("c1")).toEqual({ exitCode: 2 });
    expect(detailsOf("c2")).toEqual({ exitCode: null });
  });

  it("keeps a subagent's tool calls and text as the call's children", () => {
    const { see, detailsOf } = setup();
    see({ kind: "tool_call_started", callId: "agent", tool: "Task" });
    see({ kind: "text_delta", text: "Let me " }, ["agent"]);
    see({ kind: "text_delta", text: "look." }, ["agent"]);
    see({ kind: "tool_call_started", callId: "k1", tool: "Bash" }, ["agent"]);
    see({ kind: "tool_call_input_delta", callId: "k1", delta: '{"comm' }, [
      "agent",
    ]);
    see({ kind: "tool_call_input_delta", callId: "k1", delta: 'and":"ls"}' }, [
      "agent",
    ]);
    see(
      {
        kind: "tool_call_ended",
        callId: "k1",
        content: [
          { type: "text", text: "a.txt" },
          { type: "image", mediaType: "image/png", data: "AAAA" },
          { type: "text", text: "b.txt" },
        ],
        result: "ok",
        exitCode: 0,
      },
      ["agent"],
    );
    // A deeper subagent's call lands on the same root; one that never ends stays running.
    see(
      {
        kind: "tool_call_started",
        callId: "k2",
        tool: "Grep",
        input: "first",
      },
      ["agent", "inner"],
    );
    see({ kind: "tool_call_input", callId: "k2", input: '{"q":"x"}' }, [
      "agent",
      "inner",
    ]);
    see({ kind: "tool_call_started", callId: "k3", tool: "Edit" }, ["agent"]);
    see({ kind: "tool_call_ended", callId: "k3", result: "failed" }, ["agent"]);
    see({ kind: "text_delta", text: "Done." }, ["agent"]);
    see({
      kind: "tool_call_ended",
      callId: "agent",
      content: [{ type: "text", text: "summary" }],
      result: "ok",
    });
    expect(detailsOf("agent")).toEqual({
      children: [
        { kind: "text", text: "Let me look." },
        {
          kind: "tool",
          id: "k1",
          name: "Bash",
          input: '{"command":"ls"}',
          status: "completed",
          output: "a.txt\nb.txt",
          exitCode: 0,
        },
        {
          kind: "tool",
          id: "k2",
          name: "Grep",
          input: '{"q":"x"}',
          status: "running",
        },
        { kind: "tool", id: "k3", name: "Edit", status: "failed" },
        { kind: "text", text: "Done." },
      ],
    });
  });

  it("cuts a child's long output and caps the steps", () => {
    const { see, detailsOf } = setup();
    see({ kind: "tool_call_started", callId: "agent", tool: "Task" });
    see({ kind: "tool_call_started", callId: "k0", tool: "Read" }, ["agent"]);
    see(
      {
        kind: "tool_call_ended",
        callId: "k0",
        content: [{ type: "text", text: "x".repeat(5000) }],
        result: "ok",
      },
      ["agent"],
    );
    for (let i = 1; i < 250; i++)
      see({ kind: "tool_call_started", callId: `k${i}`, tool: "Read" }, [
        "agent",
      ]);
    see({ kind: "tool_call_ended", callId: "agent", result: "ok" });
    const children = detailsOf("agent").children!;
    expect(children).toHaveLength(200);
    expect(children[0]).toMatchObject({
      status: "completed",
      outputTruncated: true,
    });
    expect(
      (children[0] as Extract<(typeof children)[0], { kind: "tool" }>).output,
    ).toHaveLength(4000);
    expect(children.at(-1)).toMatchObject({ id: "k199" });
  });

  it("carries the runtime task the call started, as it stood when the result came", () => {
    const { see, detailsOf } = setup();
    see({ kind: "tool_call_started", callId: "agent", tool: "Task" });
    see({
      kind: "task_started",
      taskId: "t1",
      taskType: "agent",
      nativeType: "local_agent",
      description: "Explore the repo",
      toolCallId: "agent",
    });
    // Ambient work and a task under another call are not this call's.
    see({
      kind: "task_started",
      taskId: "t2",
      taskType: "shell",
      toolCallId: "agent",
      ambient: true,
    });
    see({ kind: "task_updated", taskId: "t1", status: "running" });
    see({
      kind: "task_ended",
      taskId: "t1",
      status: "completed",
      summary: "Found it",
      outputFile: "/tmp/out.txt",
    });
    see({ kind: "tool_call_ended", callId: "agent", result: "ok" });
    // Too late: the result is written.
    see({ kind: "task_updated", taskId: "t1", description: "later" });
    expect(detailsOf("agent")).toEqual({
      runtimeTask: {
        type: "agent",
        nativeType: "local_agent",
        description: "Explore the repo",
        status: "completed",
        summary: "Found it",
        outputFile: "/tmp/out.txt",
      },
    });
  });

  it("keeps parts oar does not recognize in details, and their JSON in the content", () => {
    const { see, resultOf, detailsOf } = setup();
    const value = { type: "resource_link", uri: "file:///a" };
    see({ kind: "tool_call_started", callId: "c1", tool: "mcp__docs" });
    see({
      kind: "tool_call_ended",
      callId: "c1",
      content: [
        { type: "text", text: "see" },
        { type: "other", value },
      ],
      result: "ok",
    });
    expect(detailsOf("c1")).toEqual({ other: [value] });
    expect(resultOf("c1").content).toEqual([
      { type: "text", text: "see" },
      { type: "text", text: JSON.stringify({ type: "other", value }) },
    ]);
  });
});
