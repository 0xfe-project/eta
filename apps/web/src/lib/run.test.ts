import type { AgentMessage, ViewMessageRow } from "@eta/client-contracts";
import { describe, expect, it } from "@rstest/core";
import { runBlocks, savedTools } from "./run";

let seq = 0;
const row = (message: object): ViewMessageRow => {
  seq += 1;
  return {
    entryId: `e${seq}`,
    seq,
    at: seq,
    message: message as AgentMessage,
  };
};
const user = (text: string) =>
  row({ role: "user", content: text, timestamp: 1 });
const assistant = (timestamp: number, content: object[]) =>
  row({ role: "assistant", content, timestamp });
const streaming = (timestamp: number, content: object[]) =>
  ({ role: "assistant", content, timestamp }) as AgentMessage;

describe("the run in flight", () => {
  it("is what the session said since the last thing the user said", () => {
    const blocks = runBlocks(
      [
        assistant(1, [{ type: "text", text: "earlier run" }]),
        user("go"),
        assistant(2, [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "looking" },
        ]),
      ],
      undefined,
    );
    expect(blocks.map((b) => [b.type, "text" in b ? b.text : ""])).toEqual([
      ["thinking", "hmm"],
      ["text", "looking"],
    ]);
  });

  it("follows a tool call from running to its result", () => {
    const call = assistant(2, [
      { type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } },
    ]);
    const running = runBlocks([user("go"), call], undefined);
    expect(running).toMatchObject([
      { type: "tool", name: "bash", status: "running" },
    ]);

    const done = runBlocks(
      [
        user("go"),
        call,
        row({
          role: "toolResult",
          toolCallId: "t1",
          toolName: "bash",
          content: [{ type: "text", text: "a\nb" }],
          isError: false,
          timestamp: 3,
        }),
      ],
      undefined,
    );
    expect(done).toMatchObject([
      { type: "tool", status: "completed", output: "a\nb" },
    ]);
    const failed = runBlocks(
      [
        user("go"),
        call,
        row({
          role: "toolResult",
          toolCallId: "t1",
          toolName: "bash",
          content: [{ type: "text", text: "boom" }],
          isError: true,
          timestamp: 3,
        }),
      ],
      undefined,
    );
    expect(failed).toMatchObject([{ type: "tool", status: "failed" }]);
  });

  it("keeps what a tool result carries beyond its text", () => {
    const blocks = runBlocks(
      [
        user("go"),
        assistant(2, [
          {
            type: "toolCall",
            id: "p1",
            name: "publish_artifact",
            arguments: {},
          },
        ]),
        row({
          role: "toolResult",
          toolCallId: "p1",
          toolName: "publish_artifact",
          content: [{ type: "text", text: "published" }],
          details: { artifactId: "a1", title: "报告", version: 2, files: 3 },
          isError: false,
          timestamp: 3,
        }),
      ],
      undefined,
    );
    expect(blocks).toMatchObject([
      {
        type: "tool",
        details: { artifactId: "a1", title: "报告", version: 2, files: 3 },
      },
    ]);
  });

  it("ends with the message being streamed, until the transcript has committed it", () => {
    const rows = [user("go"), assistant(2, [{ type: "text", text: "one" }])];
    const growing = streaming(3, [{ type: "text", text: "two so" }]);
    expect(
      runBlocks(rows, growing).map((b) => ("text" in b ? b.text : "")),
    ).toEqual(["one", "two so"]);
    // The commit and the end of the stream arrive apart: the same words must not show twice.
    const committed = [
      ...rows,
      assistant(3, [{ type: "text", text: "two so far" }]),
    ];
    expect(
      runBlocks(committed, growing).map((b) => ("text" in b ? b.text : "")),
    ).toEqual(["one", "two so far"]);
  });
});

describe("the tool calls a finished reply kept", () => {
  it("come back as the blocks the run drew", () => {
    expect(
      savedTools({
        activity: [
          {
            id: "c1",
            name: "publish_artifact",
            input: { title: "t" },
            output: "ok",
            status: "completed",
            details: { artifactId: "a" },
          },
          { id: "c2", name: "bash", status: "failed" },
        ],
      }),
    ).toEqual([
      {
        type: "tool",
        id: "c1",
        name: "publish_artifact",
        input: { title: "t" },
        output: "ok",
        details: { artifactId: "a" },
        status: "completed",
      },
      {
        type: "tool",
        id: "c2",
        name: "bash",
        input: undefined,
        output: undefined,
        details: undefined,
        status: "failed",
      },
    ]);
  });

  it("are none when the row kept none or kept rubbish", () => {
    expect(savedTools({})).toEqual([]);
    expect(savedTools({ activity: "x" })).toEqual([]);
    expect(savedTools({ activity: [null, { id: 1 }] })).toEqual([]);
  });
});
