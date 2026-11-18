import type { AgentMessage, ViewMessageRow } from "../src/index";
import { describe, expect, it } from "vitest";
import {
  groupBlocks,
  logBlocks,
  runBlocks,
  savedSteps,
  savedTools,
  splitReply,
} from "../src/index";

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

  // The reply goes to work before the view has the message that started it, so for a moment the
  // newest user message in the transcript is the last run's.
  it("shows nothing of the last run before this run's message arrives", () => {
    const last = [
      user("first"),
      assistant(2, [{ type: "text", text: "last answer" }]),
    ];
    const runFrom = last.at(-1)!.seq;
    expect(runBlocks(last, undefined, runFrom)).toEqual([]);
    // Without the place from the row, this is the bug: the last answer reads as this run's.
    expect(runBlocks(last, undefined)).toMatchObject([{ text: "last answer" }]);

    // The stream can overtake the transcript, and only it is this run's.
    const growing = streaming(3, [{ type: "text", text: "this one" }]);
    expect(runBlocks(last, growing, runFrom)).toMatchObject([
      { text: "this one" },
    ]);

    const asked = [...last, user("second")];
    expect(runBlocks(asked, undefined, runFrom)).toEqual([]);
    expect(
      runBlocks(
        [...asked, assistant(3, [{ type: "text", text: "this one" }])],
        undefined,
        runFrom,
      ),
    ).toMatchObject([{ text: "this one" }]);
  });

  it("keeps the steps before a steer and marks where it arrived", () => {
    const before = user("first");
    const blocks = runBlocks(
      [
        before,
        user("second"),
        assistant(2, [{ type: "text", text: "going" }]),
        user("no, the other one"),
        assistant(3, [{ type: "text", text: "turning" }]),
      ],
      undefined,
      before.seq,
    );
    expect(blocks).toMatchObject([
      { text: "going" },
      { type: "steer" },
      { text: "turning" },
    ]);
  });

  it("starts over at a steer when the row names no place", () => {
    const blocks = runBlocks(
      [
        user("second"),
        assistant(2, [{ type: "text", text: "going" }]),
        user("no, the other one"),
        assistant(3, [{ type: "text", text: "turning" }]),
      ],
      undefined,
    );
    expect(blocks).toMatchObject([{ text: "turning" }]);
  });

  it("keeps a run longer than the view's window, whose start has scrolled out of it", () => {
    const blocks = runBlocks(
      [
        assistant(5, [{ type: "text", text: "still" }]),
        assistant(6, [{ type: "text", text: "going" }]),
      ],
      undefined,
      0,
    );
    expect(blocks).toMatchObject([{ text: "still" }, { text: "going" }]);
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

  // The page draws a block as one element for as long as its id holds: one that changes when the
  // message lands draws its words again from scratch.
  it("keeps a message's block ids from its first streamed frame to its row", () => {
    const rows = [user("go")];
    const ids = (blocks: { id: string }[]) => blocks.map((b) => b.id);
    const growing = streaming(3, [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "我先看看" },
    ]);
    const committed = [
      ...rows,
      assistant(3, [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "我先看看" },
      ]),
    ];
    expect(ids(runBlocks(committed, growing))).toEqual(
      ids(runBlocks(rows, growing)),
    );
    expect(ids(logBlocks(committed, growing))).toEqual(
      ids(logBlocks(rows, growing)),
    );
    // The next message is drawn fresh, not over the one before it.
    const next = runBlocks(
      committed,
      streaming(5, [
        { type: "thinking", thinking: "then" },
        { type: "text", text: "看完了" },
      ]),
    );
    expect(new Set(ids(next)).size).toBe(4);
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

const call = (id: string, name: string, args: object) =>
  assistant(2, [{ type: "toolCall", id, name, arguments: args }]);
const result = (id: string, content: object[], extra: object = {}) =>
  row({
    role: "toolResult",
    toolCallId: id,
    toolName: "x",
    content,
    isError: false,
    timestamp: 3,
    ...extra,
  });

describe("a finished reply's process", () => {
  const activity = [
    { id: "t1", name: "bash", input: { command: "ls" }, status: "completed" },
  ];

  it("is its thoughts, words and calls in order; the text at the end is the answer, not a step", () => {
    const steps = savedSteps({
      thinking: "then answer",
      data: {
        activity,
        process: [
          { type: "thinking", text: "look first" },
          { type: "text", text: "Listing the files." },
          { type: "tool", id: "t1" },
          { type: "thinking", text: "then answer" },
          { type: "text", text: "the answer" },
          { type: "text", text: "and a second paragraph" },
        ],
      },
    });
    expect(
      steps.map((block) =>
        block.type === "tool"
          ? `tool ${block.id}`
          : `${block.type} ${"text" in block ? block.text : ""}`,
      ),
    ).toEqual([
      "thinking look first",
      "text Listing the files.",
      "tool t1",
      "thinking then answer",
    ]);
  });

  it("says where the run took words the user put into it", () => {
    const steps = savedSteps({
      thinking: "",
      data: {
        activity,
        process: [
          { type: "tool", id: "t1" },
          { type: "steer" },
          { type: "thinking", text: "they want more" },
          { type: "text", text: "the answer" },
        ],
      },
    });
    expect(steps.map((block) => block.type)).toEqual([
      "tool",
      "steer",
      "thinking",
    ]);
  });

  it("of a row written before the order was kept is its last thought, then its calls", () => {
    const steps = savedSteps({ thinking: "a thought", data: { activity } });
    expect(
      steps.map((block) =>
        block.type === "tool"
          ? `tool ${block.id}`
          : `${block.type} ${"text" in block ? block.text : ""}`,
      ),
    ).toEqual(["thinking a thought", "tool t1"]);
    expect(savedSteps({ thinking: "", data: {} })).toEqual([]);
  });

  it("reads a 0.3.0 reply's row, which kept calls as `activity` and nothing else", () => {
    // The shape a v0.3.0 board holds (checked against a real one: 311 such rows, none of them
    // blank): `data` is `{activity}` alone, an entry is `{id, name, input, status, output}` and
    // some carry `details`. The order of the steps was not kept, so the calls stand in their own
    // order and the words the agent thought are the one thought the row did keep.
    const activity = [
      {
        id: "old-1",
        name: "Bash",
        input: { command: "ls" },
        status: "completed",
        output: "a.txt",
      },
      {
        id: "old-2",
        name: "update_task",
        input: { taskId: "t1" },
        status: "failed",
        details: { code: "denied" },
      },
    ];
    const withoutThought = savedSteps({ thinking: "", data: { activity } });
    expect(
      withoutThought.map((block) =>
        block.type === "tool"
          ? `tool ${block.id} ${block.status}`
          : `${block.type} ${"text" in block ? block.text : ""}`,
      ),
    ).toEqual(["tool old-1 completed", "tool old-2 failed"]);
    const withThought = savedSteps({
      thinking: "the last thought",
      data: { activity },
    });
    expect(withThought[0]).toEqual({
      type: "thinking",
      id: "thinking",
      text: "the last thought",
    });
    expect(withThought).toHaveLength(3);
  });

  it("splits a reply at work the same way: trailing text is the answer, words before a call are steps", () => {
    const tool = {
      type: "tool" as const,
      id: "t1",
      name: "bash",
      input: {},
      status: "completed" as const,
    };
    const said = { type: "text" as const, id: "a", text: "on my way" };
    const answer = { type: "text" as const, id: "b", text: "done" };
    expect(splitReply([said, tool, answer])).toEqual({
      steps: [said, tool],
      answer: [answer],
    });
    expect(splitReply([said])).toEqual({ steps: [], answer: [said] });
  });
});

describe("where a finished reply's answer starts", () => {
  const tool = {
    type: "tool" as const,
    id: "t1",
    name: "bash",
    input: {},
    status: "completed" as const,
  };
  const thought = { type: "thinking" as const, id: "h", text: "hmm" };
  const text = (id: string) => ({ type: "text" as const, id, text: id });

  it("has no answer when the reply ends on a call or a thought: everything is process", () => {
    expect(splitReply([text("a"), tool])).toEqual({
      steps: [text("a"), tool],
      answer: [],
    });
    expect(splitReply([tool, thought])).toEqual({
      steps: [tool, thought],
      answer: [],
    });
    expect(splitReply([])).toEqual({ steps: [], answer: [] });
  });

  it("takes every paragraph after the last call or thought as the answer, and none before it", () => {
    expect(
      splitReply([text("a"), thought, text("b"), tool, text("c"), text("d")]),
    ).toEqual({
      steps: [text("a"), thought, text("b"), tool],
      answer: [text("c"), text("d")],
    });
  });

  it("of a finished reply that only called tools is its calls, in its process's order", () => {
    const steps = savedSteps({
      thinking: "",
      data: {
        activity: [
          { id: "t1", name: "bash", input: {}, status: "completed" },
          { id: "t2", name: "read", input: {}, status: "failed" },
        ],
        process: [
          { type: "tool", id: "t2" },
          { type: "tool", id: "t1" },
        ],
      },
    });
    expect(steps.map((block) => block.id)).toEqual(["t2", "t1"]);
  });

  it("leaves out a step naming a call its activity does not hold, and keeps the rest in order", () => {
    const steps = savedSteps({
      thinking: "",
      data: {
        activity: [{ id: "t1", name: "bash", input: {}, status: "completed" }],
        process: [
          { type: "text", text: "first" },
          { type: "tool", id: "gone" },
          { type: "tool", id: "t1" },
          { type: "text", text: "the answer" },
        ],
      },
    });
    expect(
      steps.map((block) =>
        block.type === "tool" ? block.id : "text" in block ? block.text : "",
      ),
    ).toEqual(["first", "t1"]);
  });

  it("of a finished reply that only wrote text has no process", () => {
    expect(
      savedSteps({
        thinking: "",
        data: {
          process: [
            { type: "text", text: "one" },
            { type: "text", text: "two" },
          ],
        },
      }),
    ).toEqual([]);
  });
});

describe("a run's log", () => {
  it("keeps the pictures a tool result carried, with where to fetch them", () => {
    const shot = result("r1", [
      { type: "text", text: "read it" },
      { type: "image", mimeType: "image/png", data: "iVBOR" },
      { type: "image", mimeType: "image/jpeg", data: "", bytes: 2048 },
    ]);
    const [block] = logBlocks(
      [user("brief"), call("r1", "Read", { file_path: "a.png" }), shot],
      undefined,
    );
    expect(block).toMatchObject({
      type: "tool",
      output: "read it",
      images: [
        {
          mimeType: "image/png",
          data: "iVBOR",
          entryId: shot.entryId,
          index: 1,
        },
        {
          mimeType: "image/jpeg",
          data: "",
          bytes: 2048,
          entryId: shot.entryId,
          index: 2,
        },
      ],
    });
  });

  it("shows a steer with its pictures, but not the briefing", () => {
    const steer = row({
      role: "user",
      content: [{ type: "image", mimeType: "image/png", data: "x" }],
      timestamp: 4,
    });
    const blocks = logBlocks([user("brief"), steer], undefined);
    expect(blocks).toMatchObject([
      {
        type: "user",
        text: "",
        images: [{ index: 0, entryId: steer.entryId }],
      },
    ]);
  });

  it("says where a turn failed or was stopped, and where history was summarized", () => {
    const blocks = logBlocks(
      [
        user("brief"),
        row({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "429 rate limited",
          timestamp: 2,
        }),
        row({
          role: "compactionSummary",
          summary: "did a and b",
          tokensBefore: 9,
          timestamp: 3,
        }),
        row({
          role: "assistant",
          content: [],
          stopReason: "aborted",
          timestamp: 4,
        }),
      ],
      undefined,
    );
    expect(blocks).toMatchObject([
      { type: "error", aborted: false, text: "429 rate limited" },
      { type: "summary", kind: "compaction", text: "did a and b" },
      { type: "error", aborted: true, text: "" },
    ]);
  });

  it("leaves failures and summaries out of a reply in a conversation", () => {
    const blocks = runBlocks(
      [
        user("go"),
        row({
          role: "assistant",
          content: [],
          stopReason: "error",
          timestamp: 2,
        }),
      ],
      undefined,
    );
    expect(blocks).toEqual([]);
  });
});

describe("folding a log", () => {
  const done = (id: string, name: string, input: object = { path: id }) => ({
    type: "tool" as const,
    id,
    name,
    input,
    status: "completed" as const,
  });

  it("folds three calls to one tool in a row into a group", () => {
    const items = groupBlocks([
      done("a", "Read"),
      done("b", "Read"),
      done("c", "Read"),
      done("d", "Write"),
    ]);
    expect(items.map((item) => item.type)).toEqual(["group", "tool"]);
    expect(items[0]).toMatchObject({
      name: "Read",
      tools: [{ id: "a" }, { id: "b" }, { id: "c" }],
    });
  });

  it("leaves two in a row, commands and calls still at work as they are", () => {
    const items = groupBlocks([
      done("a", "Read"),
      done("b", "Read"),
      { type: "text", id: "t", text: "hm" },
      done("c", "Bash", { command: "ls" }),
      done("d", "Bash", { command: "ls" }),
      done("e", "Bash", { command: "ls" }),
      { ...done("f", "Read"), status: "running" },
      done("g", "Read"),
      done("h", "Read"),
    ]);
    expect(items.map((item) => item.id)).toEqual([
      "a",
      "b",
      "t",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
    ]);
  });
});
