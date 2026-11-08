/**
 * A reply's steps folded under one line: which items of a reply are its steps, where the line
 * stands, what it carries, and what shows when it is unfolded. Pure: rows and sessions are built
 * here as the host sends them.
 */
import type {
  AgentMessage,
  MemberView,
  MessageView,
  ViewMessageRow,
} from "@eta/client-contracts";
import type { TranscriptItem } from "../../src/ext/conversation/contract";
import type {
  ItemsInput,
  SessionLive,
} from "../../src/ext/conversation/model/items";
import { describe, expect, it } from "vitest";
import { transcriptItems } from "../../src/ext/conversation/model/items";

const ADA = { id: "agent-ada-0001", name: "Ada" };
const BEN = { id: "agent-ben-0002", name: "Ben" };

let seq = 0;
function row(fields: Partial<MessageView>): MessageView {
  seq += 1;
  return {
    id: `m${seq}`,
    conversationId: "c1",
    seq,
    kind: "message",
    author: "user",
    agentId: null,
    text: "",
    thinking: "",
    status: "done",
    revision: 1,
    mentions: [],
    rootMessageId: null,
    replyToId: null,
    data: {},
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  };
}

const reply = (fields: Partial<MessageView>) =>
  row({ author: "agent", agentId: ADA.id, ...fields });

const member = (fields: Partial<MemberView> = {}): MemberView => ({
  agentId: ADA.id,
  sessionId: "s-ada",
  lastSeq: 0,
  status: "working",
  ...fields,
});

function live(fields: Partial<SessionLive> = {}): SessionLive {
  return {
    rows: [],
    coreStreaming: undefined,
    streamed: undefined,
    progress: new Map(),
    question: undefined,
    unreadable: false,
    ...fields,
  };
}

const userMsg = (text: string): AgentMessage =>
  ({ role: "user", content: text, timestamp: 1 }) as never;
const assistant = (
  timestamp: number,
  content: unknown[],
  extra: Record<string, unknown> = {},
): AgentMessage =>
  ({ role: "assistant", content, timestamp, ...extra }) as never;
const toolCall = (id: string, command: string) => ({
  type: "toolCall",
  id,
  name: "bash",
  arguments: { command },
});
const toolResult = (
  toolCallId: string,
  text: string,
  isError = false,
): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError,
    timestamp: 1,
  }) as never;

function srow(entrySeq: number, message: AgentMessage): ViewMessageRow {
  return { entryId: `e${entrySeq}`, seq: entrySeq, at: 0, message };
}

const CLOSED = () => false;
const OPEN = () => true;

function items(input: Partial<ItemsInput>): TranscriptItem[] {
  return transcriptItems({
    rows: [],
    members: [],
    agents: [ADA, BEN],
    kind: "direct",
    sessions: new Map(),
    locale: "en",
    ...input,
  });
}

/** The same input without folding: every item the reply has, in order. */
const unfoldedOf = (input: Partial<ItemsInput>) =>
  items({ ...input, stepsOpen: undefined });

const kindsAndKeys = (list: readonly TranscriptItem[]) =>
  list.map((item) => `${item.kind} ${item.key}`);

function stepsOf(list: readonly TranscriptItem[]) {
  return list.filter(
    (item): item is Extract<TranscriptItem, { kind: "steps" }> =>
      item.kind === "steps",
  );
}

const savedTool = (
  id: string,
  status: "completed" | "failed" = "completed",
) => ({
  id,
  name: "bash",
  input: { command: `run ${id}` },
  output: `out ${id}`,
  status,
});

describe("a finished reply", () => {
  it("without tool calls is drawn as it is: no steps line", () => {
    const done = reply({ text: "just words", thinking: "a thought" });
    const input = { rows: [done], stepsOpen: CLOSED };
    expect(items(input)).toEqual(unfoldedOf(input));
    expect(stepsOf(items(input))).toEqual([]);
  });

  it("with one tool call folds its thinking and the call under one line, the text after it showing", () => {
    const done = reply({
      text: "the answer",
      thinking: "let me think",
      data: { activity: [savedTool("t1")] },
    });
    const all = unfoldedOf({ rows: [done] });
    const out = items({ rows: [done], stepsOpen: CLOSED });
    expect(out).toEqual([
      {
        kind: "steps",
        key: `${done.id}:steps`,
        steps: [all[0], all[1]],
        replying: false,
      },
      all[2],
    ]);
    expect(all.map((item) => item.kind)).toEqual(["thinking", "tool", "text"]);
  });

  it("keeps every tool call among its steps, the failed ones too", () => {
    const done = reply({
      text: "done",
      data: {
        activity: [savedTool("t1"), savedTool("t2", "failed"), savedTool("t3")],
      },
    });
    const [steps] = stepsOf(items({ rows: [done], stepsOpen: CLOSED }));
    expect(steps!.steps.map((step) => step.key)).toEqual([
      `${done.id}:t1`,
      `${done.id}:t2`,
      `${done.id}:t3`,
    ]);
    expect(
      steps!.steps.map((step) =>
        step.kind === "tool" ? step.tool.status : "",
      ),
    ).toEqual(["completed", "failed", "completed"]);
  });

  it("that was stopped shows its text and then the stop, after the steps line", () => {
    const stopped = reply({
      status: "stopped",
      text: "partial",
      data: { activity: [savedTool("t1")] },
    });
    expect(kindsAndKeys(items({ rows: [stopped], stepsOpen: CLOSED }))).toEqual(
      [
        `steps ${stopped.id}:steps`,
        `text ${stopped.id}:text`,
        `outcome ${stopped.id}:outcome`,
      ],
    );
  });

  it("that failed shows how after the steps line", () => {
    const failed = reply({
      status: "failed",
      text: "boom",
      data: { code: "run_failed", activity: [savedTool("t1", "failed")] },
    });
    expect(kindsAndKeys(items({ rows: [failed], stepsOpen: CLOSED }))).toEqual([
      `steps ${failed.id}:steps`,
      `outcome ${failed.id}:outcome`,
    ]);
  });

  it("unfolded keeps the steps line on top and every item under it as it was", () => {
    const done = reply({
      text: "the answer",
      thinking: "let me think",
      data: { activity: [savedTool("t1"), savedTool("t2")] },
    });
    const all = unfoldedOf({ rows: [done] });
    const out = items({ rows: [done], stepsOpen: OPEN });
    expect(out[0]).toMatchObject({ kind: "steps", key: `${done.id}:steps` });
    expect(out.slice(1)).toEqual(all);
  });
});

describe("a group conversation", () => {
  it("folds each author's reply on its own, under the author's name", () => {
    const question = row({ text: "both of you" });
    const a = reply({ text: "from Ada", data: { activity: [savedTool("a")] } });
    const b = reply({
      agentId: BEN.id,
      text: "from Ben",
      data: { activity: [savedTool("b")] },
    });
    const out = items({
      rows: [question, a, b],
      kind: "group",
      stepsOpen: CLOSED,
    });
    expect(kindsAndKeys(out)).toEqual([
      `user ${question.id}`,
      `author ${a.id}:author`,
      `steps ${a.id}:steps`,
      `text ${a.id}:text`,
      `author ${b.id}:author`,
      `steps ${b.id}:steps`,
      `text ${b.id}:text`,
    ]);
    const [stepsA, stepsB] = stepsOf(out);
    expect(stepsA!.steps.map((step) => step.key)).toEqual([`${a.id}:a`]);
    expect(stepsB!.steps.map((step) => step.key)).toEqual([`${b.id}:b`]);
  });
});

describe("a running reply", () => {
  const working = () => reply({ status: "working", data: { runFrom: 1 } });
  const running = (
    target: MessageView,
    rows: ViewMessageRow[],
    extra: Partial<SessionLive> = {},
  ): Partial<ItemsInput> => ({
    rows: [target],
    members: [member()],
    sessions: new Map([["s-ada", live({ rows, ...extra })]]),
  });

  it("with its tool call still running folds it, saying the reply is running", () => {
    const target = working();
    const input = running(target, [
      srow(1, userMsg("go")),
      srow(2, assistant(20, [toolCall("c1", "npm test")])),
    ]);
    const out = items({ ...input, stepsOpen: CLOSED });
    expect(out).toHaveLength(1);
    const [steps] = stepsOf(out);
    expect(steps).toMatchObject({ key: `${target.id}:steps`, replying: true });
    expect(steps!.steps).toHaveLength(1);
    expect(steps!.steps[0]).toMatchObject({
      kind: "tool",
      tool: { id: "c1", status: "running" },
    });
  });

  it("whose last tool call ended shows what it writes next after the steps line", () => {
    const target = working();
    const streamed = assistant(30, [{ type: "text", text: "writing on" }]);
    const input = running(
      target,
      [
        srow(1, userMsg("go")),
        srow(2, assistant(20, [toolCall("c1", "ls")])),
        srow(3, toolResult("c1", "a\nb")),
      ],
      { streamed },
    );
    const out = items({ ...input, stepsOpen: CLOSED });
    expect(out.map((item) => item.kind)).toEqual(["steps", "text"]);
    expect(out[0]).toMatchObject({ replying: true });
    expect(out[1]).toMatchObject({ text: "writing on", streaming: true });
  });

  it("folds the thinking and text between tool calls, up to the last call", () => {
    const target = working();
    const input = running(target, [
      srow(1, userMsg("go")),
      srow(
        2,
        assistant(20, [
          { type: "thinking", thinking: "first think" },
          toolCall("c1", "ls"),
        ]),
      ),
      srow(3, toolResult("c1", "a")),
      srow(
        4,
        assistant(30, [
          { type: "text", text: "now the next" },
          toolCall("c2", "cat a"),
        ]),
      ),
      srow(5, toolResult("c2", "b", true)),
      srow(6, assistant(40, [{ type: "text", text: "the end" }])),
    ]);
    const all = unfoldedOf(input);
    const out = items({ ...input, stepsOpen: CLOSED });
    expect(all.map((item) => item.kind)).toEqual([
      "thinking",
      "tool",
      "text",
      "tool",
      "text",
    ]);
    expect(out).toEqual([
      {
        kind: "steps",
        key: `${target.id}:steps`,
        steps: all.slice(0, 4),
        replying: true,
      },
      all[4],
    ]);
  });

  it("moves the text it was writing among the steps once a new tool call starts", () => {
    const target = working();
    const first = [
      srow(1, userMsg("go")),
      srow(2, assistant(20, [toolCall("c1", "ls")])),
      srow(3, toolResult("c1", "a")),
    ];
    const writing = items({
      ...running(target, first, {
        streamed: assistant(30, [{ type: "text", text: "half a thought" }]),
      }),
      stepsOpen: CLOSED,
    });
    expect(writing.map((item) => item.kind)).toEqual(["steps", "text"]);
    expect(writing[1]).toMatchObject({ text: "half a thought" });

    const next = items({
      ...running(target, [
        ...first,
        srow(
          4,
          assistant(30, [
            { type: "text", text: "half a thought" },
            toolCall("c2", "pwd"),
          ]),
        ),
      ]),
      stepsOpen: CLOSED,
    });
    expect(next.map((item) => item.kind)).toEqual(["steps"]);
    const [steps] = stepsOf(next);
    expect(steps!.steps.map((step) => step.kind)).toEqual([
      "tool",
      "text",
      "tool",
    ]);
    // The text keeps its key, now inside the steps.
    expect(steps!.steps[1]!.key).toBe(writing[1]!.key);
  });

  it("keeps the waiting line after the steps line", () => {
    const target = reply({ status: "waiting_for_input", data: { runFrom: 1 } });
    const input = {
      ...running(
        target,
        [
          srow(1, userMsg("go")),
          srow(2, assistant(20, [toolCall("c1", "ls")])),
        ],
        { question: "Which one?" },
      ),
      members: [member({ status: "waiting_for_input" })],
    };
    const out = items({ ...input, stepsOpen: CLOSED });
    expect(kindsAndKeys(out)).toEqual([
      `steps ${target.id}:steps`,
      `notice ${target.id}:waiting`,
    ]);
    expect(out[0]).toMatchObject({ replying: true });
  });

  it("in a group keeps the author on top of the steps line", () => {
    const target = working();
    const input = running(target, [
      srow(1, userMsg("go")),
      srow(2, assistant(20, [toolCall("c1", "ls")])),
    ]);
    const out = items({ ...input, kind: "group", stepsOpen: CLOSED });
    expect(kindsAndKeys(out)).toEqual([
      `author ${target.id}:author`,
      `steps ${target.id}:steps`,
    ]);
  });
});
