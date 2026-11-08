/**
 * The transcript's items, from a conversation's rows and the live run of each member's session.
 * Pure: every input is built here as the host sends it.
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

function srow(
  entrySeq: number,
  message: AgentMessage,
  entryId = `e${entrySeq}`,
): ViewMessageRow {
  return { entryId, seq: entrySeq, at: 0, message };
}

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

describe("a user row", () => {
  it("is a user item keyed by the row, with its valid pastes and its files", () => {
    const user = row({
      text: "look: PASTED and more",
      data: {
        blocks: [[6, 12]],
        attachments: [
          { id: "f1", name: "a.txt", contentType: "text/plain", size: 3 },
          { name: "no id" },
          null,
        ],
      },
    });
    expect(items({ rows: [user] })).toEqual([
      {
        kind: "user",
        key: user.id,
        text: "look: PASTED and more",
        pastes: [[6, 12]],
        attachments: [
          { id: "f1", name: "a.txt", contentType: "text/plain", size: 3 },
        ],
        images: [],
      },
    ]);
  });

  it.each([
    [
      "overlapping",
      [
        [0, 4],
        [3, 6],
      ],
    ],
    ["out of the text", [[0, 99]]],
    ["empty range", [[2, 2]]],
    ["not integers", [[0.5, 3]]],
    ["not pairs", [[1, 2, 3]]],
    [
      "descending",
      [
        [4, 6],
        [0, 2],
      ],
    ],
  ])("reads %s blocks as no pastes", (_name, blocks) => {
    const user = row({ text: "0123456789", data: { blocks } });
    expect(items({ rows: [user] })[0]).toMatchObject({ pastes: [] });
  });

  it("that joined a running reply is followed by a muted line naming whose", () => {
    const user = row({
      text: "shorter",
      data: { joined: [ADA.id, "agent-gone-99"] },
    });
    const zh = items({ rows: [user], locale: "zh" });
    expect(zh).toHaveLength(2);
    expect(zh[1]).toEqual({
      kind: "notice",
      key: `${user.id}:joined`,
      tone: "muted",
      text: "插进了 Ada、agent- 的回复",
    });
    expect(items({ rows: [user] })[1]).toMatchObject({
      text: "Joined Ada, agent-'s reply",
    });
  });

  it("with an empty joined list has no line under it", () => {
    const user = row({ text: "hi", data: { joined: [] } });
    expect(items({ rows: [user] })).toHaveLength(1);
  });
});

describe("a finished reply", () => {
  it("is its thinking, its saved tools, then its text; no author in a direct conversation", () => {
    const done = reply({
      text: "the answer",
      thinking: "let me think",
      data: {
        activity: [
          {
            id: "t1",
            name: "bash",
            input: { command: "ls" },
            output: "a\nb",
            status: "completed",
          },
          { id: "t2", name: "read", input: {}, status: "failed" },
        ],
      },
    });
    expect(items({ rows: [done] })).toEqual([
      {
        kind: "thinking",
        key: `${done.id}:thinking`,
        text: "let me think",
        streaming: false,
      },
      {
        kind: "tool",
        key: `${done.id}:t1`,
        tool: {
          type: "tool",
          id: "t1",
          name: "bash",
          input: { command: "ls" },
          output: "a\nb",
          details: undefined,
          status: "completed",
        },
        progress: undefined,
      },
      {
        kind: "tool",
        key: `${done.id}:t2`,
        tool: {
          type: "tool",
          id: "t2",
          name: "read",
          input: {},
          output: undefined,
          details: undefined,
          status: "failed",
        },
        progress: undefined,
      },
      {
        kind: "text",
        key: `${done.id}:text`,
        text: "the answer",
        streaming: false,
      },
    ]);
  });

  it("in a group starts with its author's name; an unknown agent is its id's first six characters", () => {
    const a = reply({ text: "one" });
    const b = reply({ text: "two", agentId: "zz9876543210" });
    const out = items({ rows: [a, b], kind: "group" });
    expect(out.map((item) => item.kind)).toEqual([
      "author",
      "text",
      "author",
      "text",
    ]);
    expect(out[0]).toEqual({
      kind: "author",
      key: `${a.id}:author`,
      name: "Ada",
    });
    expect(out[2]).toMatchObject({ name: "zz9876" });
  });

  it("with no text and no thinking draws nothing of its own", () => {
    expect(items({ rows: [reply({ text: "" })] })).toEqual([]);
  });

  it("that failed says how, with the host's code and words, and not its text as an answer", () => {
    const failed = reply({
      status: "failed",
      text: "provider said no",
      data: { code: "run_failed" },
    });
    expect(items({ rows: [failed] })).toEqual([
      {
        kind: "outcome",
        key: `${failed.id}:outcome`,
        outcome: "failed",
        code: "run_failed",
        text: "provider said no",
      },
    ]);
  });

  it("that was stopped keeps what it said and then says it stopped", () => {
    const stopped = reply({ status: "stopped", text: "half an ans" });
    expect(items({ rows: [stopped] })).toEqual([
      {
        kind: "text",
        key: `${stopped.id}:text`,
        text: "half an ans",
        streaming: false,
      },
      {
        kind: "outcome",
        key: `${stopped.id}:outcome`,
        outcome: "stopped",
        code: undefined,
        text: "",
      },
    ]);
  });

  it("is drawn from its row even when its member's session is live", () => {
    const done = reply({ text: "landed" });
    const out = items({
      rows: [done],
      members: [member({ status: "idle" })],
      sessions: new Map([
        [
          "s-ada",
          live({
            rows: [
              srow(1, assistant(5, [{ type: "text", text: "session words" }])),
            ],
          }),
        ],
      ]),
    });
    expect(out).toEqual([
      {
        kind: "text",
        key: `${done.id}:text`,
        text: "landed",
        streaming: false,
      },
    ]);
  });
});

describe("a running reply with its session in hand", () => {
  it("is the run since runFrom and since the last user message, with the stream after it", () => {
    const working = reply({ status: "working", data: { runFrom: 3 } });
    const rows = [
      srow(1, userMsg("old question")),
      srow(2, assistant(10, [{ type: "text", text: "old answer" }])),
      srow(3, userMsg("new question")),
      srow(
        4,
        assistant(20, [
          { type: "thinking", thinking: "hmm" },
          {
            type: "toolCall",
            id: "c1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ]),
      ),
      srow(5, toolResult("c1", "out")),
    ];
    const streamed = assistant(30, [{ type: "text", text: "writing" }]);
    const out = items({
      rows: [working],
      members: [member()],
      sessions: new Map([
        [
          "s-ada",
          live({ rows, streamed, progress: new Map([["c1", "partial"]]) }),
        ],
      ]),
    });
    expect(out).toEqual([
      {
        kind: "thinking",
        key: `${working.id}:at20:0`,
        text: "hmm",
        streaming: false,
      },
      {
        kind: "tool",
        key: `${working.id}:c1`,
        tool: {
          type: "tool",
          id: "c1",
          name: "bash",
          input: { command: "ls" },
          output: "out",
          details: undefined,
          status: "completed",
        },
        progress: "partial",
      },
      {
        kind: "text",
        key: `${working.id}:at30:0`,
        text: "writing",
        streaming: true,
      },
    ]);
  });

  it("keeps a streamed text's key when it lands as a session row", () => {
    const working = reply({ status: "working", data: { runFrom: 1 } });
    const ask = srow(1, userMsg("q"));
    const streaming = assistant(40, [{ type: "text", text: "part" }]);
    const before = items({
      rows: [working],
      members: [member()],
      sessions: new Map([
        ["s-ada", live({ rows: [ask], streamed: streaming })],
      ]),
    });
    const after = items({
      rows: [working],
      members: [member()],
      sessions: new Map([
        [
          "s-ada",
          live({
            rows: [
              ask,
              srow(2, assistant(40, [{ type: "text", text: "part and more" }])),
            ],
          }),
        ],
      ]),
    });
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0]!.key).toBe(before[0]!.key);
    expect(after[0]).toMatchObject({ text: "part and more", streaming: false });
  });

  it("marks only the last text or thinking block as streaming, and none without a stream", () => {
    const working = reply({ status: "working", data: { runFrom: 1 } });
    const rows = [
      srow(1, userMsg("q")),
      srow(2, assistant(10, [{ type: "text", text: "first" }])),
    ];
    const streamed = assistant(20, [{ type: "thinking", thinking: "then" }]);
    const withStream = items({
      rows: [working],
      members: [member()],
      sessions: new Map([["s-ada", live({ rows, streamed })]]),
    });
    expect(
      withStream.map((item) => (item as { streaming?: boolean }).streaming),
    ).toEqual([false, true]);
    const without = items({
      rows: [working],
      members: [member()],
      sessions: new Map([["s-ada", live({ rows })]]),
    });
    expect(without).toEqual([
      {
        kind: "text",
        key: `${working.id}:at10:0`,
        text: "first",
        streaming: false,
      },
    ]);
  });

  it("does not mark a block streaming when the stream is no newer than what landed", () => {
    const working = reply({ status: "working", data: { runFrom: 1 } });
    const rows = [
      srow(1, userMsg("q")),
      srow(2, assistant(10, [{ type: "text", text: "landed" }])),
    ];
    const out = items({
      rows: [working],
      members: [member()],
      sessions: new Map([
        [
          "s-ada",
          live({
            rows,
            streamed: assistant(10, [{ type: "text", text: "landed" }]),
          }),
        ],
      ]),
    });
    expect(out).toEqual([
      {
        kind: "text",
        key: `${working.id}:at10:0`,
        text: "landed",
        streaming: false,
      },
    ]);
  });

  it("uses the view's own stream once the view has caught up with the run", () => {
    const working = reply({ status: "working", data: { runFrom: 1 } });
    const out = items({
      rows: [working],
      members: [member()],
      sessions: new Map([
        [
          "s-ada",
          live({
            rows: [srow(2, userMsg("q"))],
            coreStreaming: assistant(50, [{ type: "text", text: "core says" }]),
          }),
        ],
      ]),
    });
    expect(out).toEqual([
      {
        kind: "text",
        key: `${working.id}:at50:0`,
        text: "core says",
        streaming: true,
      },
    ]);
  });

  it("ignores the view's own stream while the view has not caught up with the run", () => {
    const working = reply({ status: "working", data: { runFrom: 5 } });
    const coreStreaming = assistant(50, [
      { type: "text", text: "the last run's" },
    ]);
    const rows = [srow(4, userMsg("q"))];
    expect(
      items({
        rows: [working],
        members: [member()],
        sessions: new Map([["s-ada", live({ rows, coreStreaming })]]),
      }),
    ).toEqual([]);
    // The events are this run's, behind or not.
    const streamed = assistant(60, [{ type: "text", text: "this run's" }]);
    expect(
      items({
        rows: [working],
        members: [member()],
        sessions: new Map([["s-ada", live({ rows, coreStreaming, streamed })]]),
      }),
    ).toEqual([
      {
        kind: "text",
        key: `${working.id}:at60:0`,
        text: "this run's",
        streaming: true,
      },
    ]);
  });

  it("carries the run's errors and summaries", () => {
    const working = reply({ status: "stopping", data: { runFrom: 1 } });
    const rows = [
      srow(1, userMsg("q")),
      srow(
        2,
        assistant(10, [{ type: "text", text: "try" }], {
          stopReason: "error",
          errorMessage: "rate limited",
        }),
      ),
      srow(
        3,
        {
          role: "compactionSummary",
          summary: "folded",
          tokensBefore: 1,
          timestamp: 1,
        } as never,
        "sum1",
      ),
    ];
    expect(
      items({
        rows: [working],
        members: [member({ status: "stopping" })],
        sessions: new Map([["s-ada", live({ rows })]]),
      }),
    ).toEqual([
      {
        kind: "text",
        key: `${working.id}:at10:0`,
        text: "try",
        streaming: false,
      },
      {
        kind: "outcome",
        key: `${working.id}:at10:error`,
        outcome: "run-error",
        code: undefined,
        text: "rate limited",
      },
      {
        kind: "summary",
        key: `${working.id}:sum1`,
        summary: "compaction",
        text: "folded",
      },
    ]);
  });

  it("in a group still starts with the author", () => {
    const working = reply({ status: "working" });
    const out = items({
      rows: [working],
      kind: "group",
      members: [member()],
      sessions: new Map([
        [
          "s-ada",
          live({
            rows: [srow(1, userMsg("q"))],
            streamed: assistant(9, [{ type: "text", text: "w" }]),
          }),
        ],
      ]),
    });
    expect(out.map((item) => item.kind)).toEqual(["author", "text"]);
  });

  it("finds the session through the member of the reply's agent, not another member's", () => {
    const working = reply({ status: "working", agentId: BEN.id });
    const out = items({
      rows: [working],
      members: [member(), member({ agentId: BEN.id, sessionId: "s-ben" })],
      sessions: new Map([
        [
          "s-ada",
          live({ streamed: assistant(9, [{ type: "text", text: "ada" }]) }),
        ],
        [
          "s-ben",
          live({ streamed: assistant(9, [{ type: "text", text: "ben" }]) }),
        ],
      ]),
    });
    expect(out).toMatchObject([{ kind: "text", text: "ben" }]);
  });
});

describe("a reply that is not drawn from a live session", () => {
  it("says it is replying when its session has not arrived", () => {
    const working = reply({ status: "working" });
    const expected = {
      kind: "notice",
      key: `${working.id}:replying`,
      tone: "muted",
    };
    expect(items({ rows: [working], members: [member()] })).toEqual([
      { ...expected, text: "Replying…" },
    ]);
    expect(
      items({ rows: [working], members: [member()], locale: "zh" }),
    ).toEqual([{ ...expected, text: "正在回复…" }]);
  });

  it("says the reply's session cannot be read, in either language", () => {
    const working = reply({ status: "working" });
    const input = {
      rows: [working],
      members: [member()],
      sessions: new Map([
        ["s-ada", live({ rows: undefined, unreadable: true })],
      ]),
    };
    expect(items(input)).toEqual([
      {
        kind: "notice",
        key: `${working.id}:replying`,
        tone: "muted",
        text: "Replying, but its session cannot be read",
      },
    ]);
    expect(items({ ...input, locale: "zh" })).toMatchObject([
      { text: "正在回复，但读不到它的会话" },
    ]);
  });

  it("says it is queued", () => {
    const queued = reply({ status: "queued" });
    expect(items({ rows: [queued], locale: "zh" })).toEqual([
      {
        kind: "notice",
        key: `${queued.id}:queued`,
        tone: "muted",
        text: "排队中",
      },
    ]);
  });

  it("waiting for the user says what it asks, from its session", () => {
    const waiting = reply({ status: "waiting_for_input" });
    const out = items({
      rows: [waiting],
      members: [member({ status: "waiting_for_input" })],
      sessions: new Map([["s-ada", live({ question: "Which branch?" })]]),
      locale: "zh",
    });
    expect(out.at(-1)).toEqual({
      kind: "notice",
      key: `${waiting.id}:waiting`,
      tone: "warning",
      text: "等你回答：Which branch?",
    });
  });

  it("waiting for the user without a question in hand says only that it waits", () => {
    const waiting = reply({ status: "waiting_for_input" });
    const out = items({
      rows: [waiting],
      members: [member({ status: "waiting_for_input" })],
    });
    expect(out.at(-1)).toEqual({
      kind: "notice",
      key: `${waiting.id}:waiting`,
      tone: "warning",
      text: "Waiting for your answer",
    });
  });
});

describe("a system row", () => {
  const system = (data: Record<string, unknown>, text = "host words") =>
    row({ kind: "system", author: "system", text, data });

  it.each([
    [
      { event: "steward", from: ADA.id, to: BEN.id },
      "Ben 成为主理人，接替 Ada。",
    ],
    [{ event: "steward", from: null, to: BEN.id }, "Ben 成为主理人。"],
    [{ event: "steward", from: ADA.id, to: null }, "Ada 不再是主理人。"],
    [
      { event: "wake_budget", budget: 8 },
      "这条消息已经用完 8 次唤醒；之后的 @ 只记入对话，等你再发言才会唤醒。",
    ],
    [{ event: "routine_report", title: "Daily digest" }, "Daily digest"],
    [{ event: "routine_report", title: "" }, "host words"],
    [{ event: "something_new" }, "host words"],
    [{}, "host words"],
  ])("%j reads as a muted line", (data, text) => {
    const found = system(data);
    expect(items({ rows: [found], locale: "zh" })).toEqual([
      { kind: "notice", key: found.id, tone: "muted", text },
    ]);
  });

  it("names a steward it does not know by the id's first six characters", () => {
    const found = system({ event: "steward", from: null, to: "abcdef123" });
    expect(items({ rows: [found] })[0]).toMatchObject({
      text: "abcdef is now the steward.",
    });
  });
});

describe("a task row", () => {
  it("draft and card are muted lines where they stand", () => {
    const draft = row({
      kind: "task_draft",
      author: "agent",
      agentId: ADA.id,
      data: { title: "Fix login", turnMessageId: "x" },
    });
    const card = row({
      kind: "task_card",
      author: "agent",
      agentId: ADA.id,
      data: { number: 12, title: "Ship it", taskId: "t" },
    });
    expect(items({ rows: [draft, card], locale: "zh" })).toEqual([
      {
        kind: "notice",
        key: draft.id,
        tone: "muted",
        text: "任务草稿：Fix login",
      },
      {
        kind: "notice",
        key: card.id,
        tone: "muted",
        text: "任务 #12：Ship it",
      },
    ]);
    expect(items({ rows: [card] })[0]).toMatchObject({
      text: "Task #12: Ship it",
    });
  });
});

describe("keys", () => {
  it("are unique across a mixed timeline and the same when worked out again", () => {
    const user = row({ text: "go", data: { joined: [ADA.id] } });
    const done = reply({
      text: "ok",
      thinking: "t",
      data: { activity: [{ id: "x1", name: "bash", status: "completed" }] },
      status: "failed",
    });
    const working = reply({ status: "working", data: { runFrom: 1 } });
    const queued = reply({ status: "queued", agentId: BEN.id });
    const system = row({ kind: "system", author: "system", text: "s" });
    const input: Partial<ItemsInput> = {
      rows: [user, done, working, queued, system],
      kind: "group",
      members: [
        member(),
        member({ agentId: BEN.id, sessionId: null, status: "queued" }),
      ],
      sessions: new Map([
        [
          "s-ada",
          live({
            rows: [
              srow(1, userMsg("q")),
              srow(
                2,
                assistant(10, [
                  { type: "text", text: "a" },
                  { type: "text", text: "b" },
                ]),
              ),
            ],
            streamed: assistant(11, [{ type: "text", text: "c" }]),
          }),
        ],
      ]),
    };
    const first = items(input);
    const keys = first.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(items(input).map((item) => item.key)).toEqual(keys);
  });

  it("of two agents' live blocks with the same stamp differ", () => {
    const a = reply({ status: "working" });
    const b = reply({ status: "working", agentId: BEN.id });
    const same = assistant(77, [{ type: "text", text: "x" }]);
    const out = items({
      rows: [a, b],
      members: [member(), member({ agentId: BEN.id, sessionId: "s-ben" })],
      sessions: new Map([
        ["s-ada", live({ streamed: same })],
        ["s-ben", live({ streamed: same })],
      ]),
    });
    expect(out).toHaveLength(2);
    expect(out[0]!.key).not.toBe(out[1]!.key);
  });
});
