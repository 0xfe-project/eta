// The conversations of 03: their timelines, the sessions behind them, and the ops a chat calls,
// answered as apps/eta/src/conversations answers them. `wire` is 03, `artifacts` 03d, `dm-xiaoman`
// 03h, `board` a run with a failed test (03i). The rest are variants of `wire`, by scenario:
// chat-queue (03a), chat-errors (03f), chat-empty, chat-loading, chat-archived, chat-no-members,
// chat-no-model, chat-elsewhere (03g).

import type {
  AgentMessage,
  AgentView,
  AttachmentView,
  ConversationSummary,
  HistoryResult,
  InteractionView,
  MessageView,
  SendResult,
  TaskCardData,
  ToolActivity,
  ViewMessageRow,
} from "@eta/client-contracts";
import type { FakeHost } from "../fake-host";
import { AGENTS, CONVERSATIONS, minutesAgo } from "./base";

let seqs = 0;
let clock = minutesAgo(30);
const next = () => {
  clock += 1000;
  return clock;
};

function row(
  conversationId: string,
  seq: number,
  fields: Partial<MessageView>,
): MessageView {
  const at = next();
  seqs += 1;
  return {
    id: `${conversationId}-${seq}`,
    conversationId,
    seq,
    kind: "message",
    author: "user",
    agentId: null,
    text: "",
    thinking: "",
    status: "done",
    revision: seqs,
    mentions: [],
    rootMessageId: null,
    replyToId: null,
    data: {},
    createdAt: at,
    updatedAt: at,
    ...fields,
  };
}

const user = (
  conversationId: string,
  seq: number,
  text: string,
  data: object = {},
) =>
  row(conversationId, seq, {
    text,
    data: { woke: ["x"], joined: [], ...data },
  });

const reply = (
  conversationId: string,
  seq: number,
  agentId: string,
  fields: Partial<MessageView> = {},
) => row(conversationId, seq, { author: "agent", agentId, ...fields });

// ---------------------------------------------------------------- sessions

type Part = Record<string, unknown>;

const assistant = (content: Part[]): AgentMessage =>
  ({
    role: "assistant",
    content,
    timestamp: next(),
    stopReason: "toolUse",
  }) as unknown as AgentMessage;

const result = (
  toolCallId: string,
  text: string,
  details?: object,
  isError = false,
  images = 0,
): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId,
    toolName: "tool",
    // A picture the view left out: `data` is empty and `sessions.image` has it.
    content: [
      { type: "text", text },
      ...Array.from({ length: images }, () => ({
        type: "image",
        mimeType: "image/png",
        data: "",
        bytes: 68,
      })),
    ],
    isError,
    details,
    timestamp: next(),
  }) as unknown as AgentMessage;

interface Call {
  id: string;
  name: string;
  input: object;
  output: string;
  details?: object;
  error?: boolean;
  images?: number;
}

/** One session's transcript: the calls of a run, each message a row. */
function transcript(from: number, messages: AgentMessage[]): ViewMessageRow[] {
  return messages.map((message, index) => ({
    entryId: `entry-${from + index + 1}`,
    seq: from + index + 1,
    at: next(),
    message,
  }));
}

const calls = (list: Call[]): AgentMessage[] =>
  list.flatMap((call) => [
    assistant([
      { type: "toolCall", id: call.id, name: call.name, arguments: call.input },
    ]),
    result(
      call.id,
      call.output,
      call.details,
      call.error === true,
      call.images,
    ),
  ]);

/** A patch whose first lines are 03i's, and as long as +64 −12 says. */
function wirePatch(): string {
  return [
    "@@ reconnect() @@",
    "  const socket = open(url);",
    "- socket.send(hello());",
    "+ const last = store.lastSeq(id);",
    "+ socket.send(hello({ since: last }));",
    '  socket.on("frame", onFrame);',
    ...Array.from(
      { length: 62 },
      (_, index) => `+ replay.push(frames[${index}]);`,
    ),
    ...Array.from({ length: 11 }, (_, index) => `- drop(frames[${index}]);`),
  ].join("\n");
}

const replayPatch = () =>
  [
    "@@ -0,0 +1,98 @@",
    ...Array.from({ length: 98 }, (_, index) => `+ // replay ${index}`),
  ].join("\n");

const THINKING =
  "Start by looking at how the hello frame carries state now, then check whether the host side has a query that fetches rows by seq.".repeat(
    38,
  );

const TEST_OUTPUT = [
  "wire.test.ts       31 pass",
  "replay.test.ts     12 pass",
  "reconnect.test.ts   8 pass",
  "",
  " 51 pass  0 fail  [4.21s]",
].join("\n");

function wireRun(from: number): ViewMessageRow[] {
  const steps: Call[] = [
    { id: "t1", name: "read", input: { path: "package.json" }, output: "{}" },
    {
      id: "t2",
      name: "read",
      input: { path: "docs/architecture/overview.md" },
      output: "…",
    },
    {
      id: "t3",
      name: "read",
      input: { path: "src/lib/store.ts" },
      output: "…",
    },
    {
      id: "t4",
      name: "grep",
      input: { pattern: "last_seq" },
      output: Array.from(
        { length: 18 },
        (_, index) => `src/file${index}.ts: last_seq`,
      ).join("\n"),
    },
    {
      id: "t5",
      name: "read",
      input: { path: "src/server/conversations.ts" },
      output: "…",
    },
    {
      id: "t6",
      name: "read",
      input: { path: "src/lib/wire.test.ts" },
      output: "…",
    },
    { id: "t7", name: "read", input: { path: "src/lib/wire.ts" }, output: "…" },
    {
      id: "t8",
      name: "read",
      input: { path: "docs/architecture/wire-protocol.md" },
      output: "…",
    },
    {
      id: "t9",
      name: "edit",
      input: { path: "src/lib/wire.ts" },
      output: "ok",
      details: { patch: wirePatch() },
    },
    {
      id: "t10",
      name: "edit",
      input: { path: "src/server/replay.ts" },
      output: "ok",
      details: { patch: replayPatch() },
    },
    {
      id: "t11",
      name: "bash",
      input: { command: "rm -rf ~/.eta/cache" },
      output: "blocked by approvals: user rejected this call",
      error: true,
    },
    {
      id: "t12",
      name: "bash",
      input: { command: "bun test wire" },
      output: TEST_OUTPUT,
      details: { exitCode: 0 },
    },
    {
      id: "t13",
      name: "write",
      input: {
        path: "migrations/0042_seq.sql",
        content: Array.from({ length: 20 }, (_, index) => `-- ${index}`).join(
          "\n",
        ),
      },
      output: "ok",
    },
  ];
  return transcript(from, [
    assistant([
      {
        type: "text",
        text: "The backfill is ready: the client includes the last received seq, and the host replays from that row onward. All tests pass.",
      },
      { type: "thinking", thinking: THINKING.slice(0, 1240) },
    ]),
    ...calls(steps),
    assistant([
      {
        type: "text",
        text: "The migration will lock the message table for about 40 seconds; you'll need to decide.",
      },
    ]),
  ]);
}

function boardRun(from: number): ViewMessageRow[] {
  return transcript(from, [
    assistant([
      {
        type: "thinking",
        thinking:
          "Board column widths should remember the last drag; check storage first.",
      },
    ]),
    ...calls([
      {
        id: "b1",
        name: "bash",
        input: { command: "bun test wire" },
        output: [
          "wire.test.ts       31 pass",
          "replay.test.ts     11 pass  1 fail",
          "  expected seq 41, received 42",
        ].join("\n"),
        details: {
          exitCode: 1,
          truncation: { truncated: true },
          fullOutputPath: "/tmp/eta/out-41.log",
        },
        error: true,
        images: 1,
      },
    ]),
  ]);
}

function dmRun(from: number): ViewMessageRow[] {
  return transcript(from, [
    assistant([
      {
        type: "thinking",
        thinking:
          "This week's tasks should be grouped by status, with blocked ones in a separate column. "
            .repeat(17)
            .slice(0, 320),
      },
    ]),
    ...calls([
      {
        id: "d1",
        name: "read_tasks",
        input: { query: "tasks · 18 items" },
        output: "…",
      },
      {
        id: "d2",
        name: "write",
        input: { path: "weekly/2026-w45.md", content: "# 2026 W45" },
        output: "ok",
      },
    ]),
  ]);
}

const REPORT =
  "The weekly report is ready: 12 tasks completed this week, 2 blocked. Now putting together next week's plan,";

const session = (
  id: string,
  rows: ViewMessageRow[],
  streaming?: AgentMessage,
) => ({
  core: {
    session: id,
    running: streaming !== undefined,
    ...(streaming ? { streaming } : {}),
  },
  transcript: { messages: rows },
});

// ---------------------------------------------------------------- timelines

const LONG_REPLY = [
  "I've looked at the frame format; three things need changing:",
  "",
  ...Array.from(
    { length: 14 },
    (_, index) => `${index + 1}. Point ${index + 1} needs to include seq`,
  ),
  "",
  "```diff",
  "- socket.send(hello());",
  "+ socket.send(hello({ since: last }));",
  "```",
].join("\n");

function older(id: string): MessageView[] {
  const rows: MessageView[] = [];
  for (let seq = 1; seq <= 8; seq += 2) {
    rows.push(
      user(
        id,
        seq,
        `Message ${seq}: first walk through the current reconnect logic`,
      ),
    );
    rows.push(
      reply(id, seq + 1, "agent-ache", {
        text: `Item ${seq + 1}: if it drops now, re-pull everything.`,
      }),
    );
  }
  return rows;
}

const savedActivity: ToolActivity[] = [
  {
    id: "s1",
    name: "read",
    input: { path: "src/lib/wire.ts" },
    status: "completed",
    output: "…",
  },
  {
    id: "s2",
    name: "grep",
    input: { pattern: "hello" },
    status: "completed",
    output: "a\nb\nc",
  },
];

function wireRows(): MessageView[] {
  return [
    ...older("wire"),
    reply("wire", 9, "agent-ache", {
      text: LONG_REPLY,
      thinking: "Read wire.ts first.",
      data: { activity: savedActivity },
    }),
    user(
      "wire",
      10,
      "After reconnecting, backfill first, then resume live frames. Bring the migration along too.",
    ),
    reply("wire", 11, "agent-ache", {
      status: "waiting_for_input",
      text: "The migration will lock the message table for about 40 seconds — that's your call.",
      data: { runFrom: 40 },
      createdAt: minutesAgo(6),
    }),
    reply("wire", 12, "agent-mori", { status: "queued" }),
  ];
}

function cardRows(): MessageView[] {
  const id = "artifacts";
  const turn = "artifacts-3";
  const card: TaskCardData = {
    taskId: "task-128",
    number: 128,
    title: "Backfill lost frames after reconnect",
    status: "in_review",
    runStatus: "completed",
    conversationId: id,
    comments: 3,
    summary: "",
    artifacts: [],
    turnMessageId: turn,
  } as TaskCardData;
  return [
    row(id, 1, {
      kind: "system",
      author: "system",
      text: "agent-mori is steward now",
      data: { event: "steward", from: "agent-ache", to: "agent-mori" },
    }),
    user(id, 2, "File a task for the rollback too."),
    reply(id, 3, "agent-ache", {
      text: "I filed the migration rollback as a task; I'll start once you confirm. The previous write-up is published too.",
      data: {
        activity: [
          {
            id: "pub",
            name: "publish_artifact",
            status: "completed",
            input: {},
            details: {
              artifactId: "artifact-plan",
              title: "Reconnect plan",
              version: 2,
            },
          },
        ] satisfies ToolActivity[],
      },
    }),
    row(id, 4, {
      kind: "task_draft",
      author: "agent",
      agentId: "agent-ache",
      data: {
        title: "Write the migration rollback script",
        description:
          "Write the matching rollback for 0042_seq and run it once on the test database. Done means: after the rollback the message table schema matches the pre-migration one.",
        workspace: "worktree",
        turnMessageId: turn,
      },
    }),
    row(id, 5, {
      kind: "task_card",
      author: "agent",
      agentId: "agent-ache",
      data: card as unknown as Record<string, unknown>,
    }),
    row(id, 6, {
      kind: "system",
      author: "system",
      text: "wake budget used",
      data: { event: "wake_budget", budget: 5 },
    }),
  ];
}

function errorRows(): MessageView[] {
  const id = "wire";
  return [
    user(id, 1, "What does everyone think of this plan?", {
      woke: [],
      joined: [],
    }),
    user(id, 2, "Don't touch the migration, look at the logs first.", {
      woke: [],
      joined: ["agent-ache"],
    }),
    reply(id, 3, "agent-ache", {
      text: "There are two duplicate frames in the log, both after the reconnect",
      status: "stopped",
    }),
    user(id, 4, "Run it again.", {}),
    reply(id, 5, "agent-mori", {
      status: "failed",
      replyToId: "wire-4",
      text: "host restarted",
      data: { code: "restart" },
    }),
  ];
}

function queueRows(): MessageView[] {
  const id = "wire";
  return [
    user(
      id,
      1,
      "@everyone Don't merge this version yet, wait for the migration conclusion.",
    ),
    reply(id, 2, "agent-ache", { status: "working", data: { runFrom: 0 } }),
    reply(id, 3, "agent-mori", { status: "queued" }),
    reply(id, 4, "agent-mori", { status: "queued" }),
    reply(id, 5, "agent-xiaoman", { status: "queued" }),
  ];
}

function queueRun(): ViewMessageRow[] {
  const list: Call[] = Array.from({ length: 8 }, (_, index) => ({
    id: `q${index}`,
    name: "read",
    input: { path: `src/lib/file${index}.ts` },
    output: "…",
  }));
  return transcript(0, [
    assistant([{ type: "thinking", thinking: "Write the rollback first." }]),
    ...calls(list),
    assistant([
      {
        type: "text",
        text: "OK, I'll write the migration rollback first, and wait until you've reviewed it before",
      },
    ]),
  ]);
}

// ---------------------------------------------------------------- the ops

const PAGE = 50;

class Conversation {
  rows: MessageView[];
  held: MessageView[] = [];
  /** The newest window: what the host publishes. */
  window = 4;

  constructor(
    readonly host: FakeHost,
    readonly id: string,
    rows: MessageView[],
  ) {
    this.rows = rows;
  }

  summary(): ConversationSummary | undefined {
    return this.host
      .section<ConversationSummary[]>("conversations", "list")
      .find((conversation) => conversation.id === this.id);
  }

  sections() {
    const summary = this.summary();
    const shown = this.rows.slice(-this.window);
    return {
      info: {
        id: this.id,
        projectId: summary?.projectId ?? "eta",
        kind: summary?.kind ?? "group",
        name: summary?.name ?? "",
        goal: "",
        decided: "",
        archived: summary?.archived ?? false,
        stewardId: summary?.stewardId ?? null,
        stewardOverrideId: null,
        noSteward: false,
        readSeq: summary?.readSeq ?? 0,
        lastSeq: summary?.lastSeq ?? 0,
        createdAt: minutesAgo(9000),
        updatedAt: minutesAgo(3),
      },
      members: summary?.participants ?? [],
      timeline: {
        messages: shown,
        hasMore: this.rows.length > shown.length,
        held: this.held,
      },
    };
  }

  publish(): void {
    this.host.set(`conversations.${this.id}`, this.sections());
  }

  patchSummary(changes: Partial<ConversationSummary>): void {
    this.host.patch(
      "conversations",
      "list",
      this.host
        .section<ConversationSummary[]>("conversations", "list")
        .map((conversation) =>
          conversation.id === this.id
            ? { ...conversation, ...changes }
            : conversation,
        ),
    );
  }

  replace(id: string, changes: Partial<MessageView>): MessageView | undefined {
    const rowAt = this.rows.findIndex((item) => item.id === id);
    const before = this.rows[rowAt];
    if (before === undefined) return undefined;
    seqs += 1;
    const after = {
      ...before,
      ...changes,
      revision: seqs,
      updatedAt: Date.now(),
    };
    this.rows[rowAt] = after;
    return after;
  }

  nextSeq(): number {
    return (this.rows.at(-1)?.seq ?? 0) + 1;
  }

  active(agentId: string): MessageView | undefined {
    return this.rows.find(
      (item) =>
        item.agentId === agentId &&
        item.author === "agent" &&
        (item.status === "queued" ||
          item.status === "working" ||
          item.status === "waiting_for_input"),
    );
  }

  /** Who a message reaches: `routeUserMessage`. */
  targets(mentions: string[]): string[] {
    if (mentions.length > 0) return mentions;
    const summary = this.summary();
    if (summary?.kind === "direct")
      return summary.participants.map((member) => member.agentId);
    if (summary?.stewardId !== null && summary?.stewardId !== undefined)
      return [summary.stewardId];
    const members = summary?.participants ?? [];
    return members.length === 1 ? [members[0]?.agentId ?? ""] : [];
  }
}

export function installChat(host: FakeHost): void {
  const scenario = host.scenario;
  const conversations = new Map<string, Conversation>();
  const add = (id: string, rows: MessageView[]) => {
    const conversation = new Conversation(host, id, rows);
    conversations.set(id, conversation);
    return conversation;
  };
  const isVariant = scenario.startsWith("chat-");
  const wireTimeline = () => {
    if (scenario === "chat-queue") return queueRows();
    if (scenario === "chat-errors") return errorRows();
    if (scenario === "chat-empty") return [];
    return wireRows();
  };

  for (const summary of CONVERSATIONS) {
    if (summary.id === "wire") add("wire", wireTimeline());
    else if (summary.id === "artifacts") add("artifacts", cardRows());
    else if (summary.id === "dm-xiaoman")
      add("dm-xiaoman", [
        user(
          "dm-xiaoman",
          1,
          "Summarize this week's tasks into a weekly report.",
        ),
        reply("dm-xiaoman", 2, "agent-xiaoman", {
          status: "working",
          data: { runFrom: 0 },
        }),
      ]);
    else if (summary.id === "board")
      add("board", [
        user("board", 1, "Remember the last column-width drag on the board."),
        reply("board", 2, "agent-mori", {
          status: "working",
          data: { runFrom: 0 },
        }),
      ]);
    else add(summary.id, []);
  }

  const summaries = (changes: Record<string, Partial<ConversationSummary>>) =>
    host.patch(
      "conversations",
      "list",
      host
        .section<ConversationSummary[]>("conversations", "list")
        .map((summary) => ({ ...summary, ...changes[summary.id] })),
    );
  const member = (
    agentId: string,
    status: "working" | "queued" | "idle",
    sessionId?: string,
  ) => ({
    agentId,
    sessionId: sessionId ?? `session-${agentId}`,
    lastSeq: 10,
    status,
  });

  // Unread, so that opening it reads it.
  summaries({ "dm-xiaoman": { lastSeq: 2, readSeq: 1 } });
  if (scenario === "chat-archived") summaries({ wire: { archived: true } });
  if (scenario === "chat-no-members")
    summaries({ wire: { participants: [], stewardId: null } });
  if (scenario === "chat-queue")
    summaries({
      wire: {
        participants: [
          member("agent-ache", "working"),
          member("agent-mori", "queued"),
          member("agent-xiaoman", "queued"),
        ],
      },
      redesign: {
        participants: [
          member("agent-xiaoman", "working", "session-xiaoman-site"),
        ],
      },
    });
  if (scenario === "chat-elsewhere")
    summaries({
      redesign: {
        participants: [member("agent-ache", "working", "session-ache-site")],
      },
    });
  if (scenario === "chat-no-model") {
    host.patch(
      "agents",
      "list",
      AGENTS.map(
        (agent): AgentView =>
          agent.id === "agent-ache" ? { ...agent, model: null } : agent,
      ),
    );
    // After every fixture: `create` installs the providers later than this.
    queueMicrotask(() =>
      host.patch("providers", "config", { revision: "r0", providers: [] }),
    );
  }
  if (scenario === "chat-queue") {
    const wire = conversations.get("wire");
    if (wire !== undefined)
      wire.held = [
        row("wire", 6, {
          text: "The rollback needs tests too",
          data: { held: true },
        }),
      ];
  }

  for (const conversation of conversations.values()) conversation.publish();

  const runs: Record<string, ViewMessageRow[]> = {
    "session-agent-ache":
      scenario === "chat-queue" ? queueRun() : isVariant ? [] : wireRun(40),
    "session-agent-mori": boardRun(0),
    "session-agent-xiaoman": dmRun(0),
  };
  // After every fixture is in: the group's data shares these sessions, for their numbers.
  void Promise.resolve().then(() => {
    for (const [id, rows] of Object.entries(runs))
      host.set(`sessions.${id}`, {
        ...host.state.get(`sessions.${id}`),
        ...session(id, rows),
      });
    if (scenario === "chat-loading") host.set("conversations.wire", {});
    // The board's fixture turns a draft into its card; the host also moves the row's revision.
    const confirm = host.ops.get("tasks.confirmDraft");
    if (confirm === undefined) return;
    host.on("tasks.confirmDraft", async (args: { conversationId: string }) => {
      const answer = (await confirm(args)) as { message: MessageView };
      const conversation = conversationOf(args.conversationId);
      const message = conversation.replace(answer.message.id, {
        kind: answer.message.kind,
        data: answer.message.data,
      });
      conversation.publish();
      return { ...answer, message };
    });
  });

  // The question 03 stands on, unless the inbox's data already brings one for this conversation.
  if (scenario === "") {
    const inbox = host.section<InteractionView[]>("inbox", "list") ?? [];
    if (
      !inbox.some(
        (item) => item.conversationId === "wire" && item.status === "pending",
      )
    )
      host.patch("inbox", "list", [
        ...inbox,
        {
          id: "ask-wire",
          sessionId: "session-agent-ache",
          questionId: "t14",
          agentId: "agent-ache",
          conversationId: "wire",
          replyId: "wire-11",
          prompt:
            "Should the migration script run directly on the production database?",
          options: [
            "Back up first, then run",
            "Run it directly",
            "Don't run it yet",
          ],
          multi: false,
          status: "pending",
          answer: null,
          revision: 1,
          createdAt: minutesAgo(1),
          updatedAt: minutesAgo(1),
        } as unknown as InteractionView,
      ]);
  }

  let streamed = false;
  /** Writing, as a run does: the reply's words grow through `message:update`. */
  const stream = (target: string, words: string, done?: () => void) => {
    const at = Date.now();
    let length = 0;
    const tick = () => {
      length = Math.min(words.length, length + 4);
      const message = {
        role: "assistant",
        content: [{ type: "text", text: words.slice(0, length) }],
        timestamp: at,
      };
      host.event(target, "message:update", { message });
      if (length < words.length) setTimeout(tick, 120);
      else done?.();
    };
    setTimeout(tick, 120);
  };

  host.on("sessions.goal", () => ({ ok: true }));
  host.on("sessions.image", () => ({
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  }));
  host.on("sessions.compact", ({ session: id }: { session: string }) => ({
    session: id,
    compacted: true,
  }));
  host.on("sessions.history", ({ session: id }: { session: string }) => ({
    session: id,
    rows: [],
  }));
  host.on("projects.files", () => ({
    files: [
      "src/lib/wire.ts",
      "src/server/replay.ts",
      "docs/architecture/wire-protocol.md",
    ],
    truncated: false,
  }));

  const conversationOf = (id: string): Conversation => {
    const conversation = conversations.get(id);
    if (conversation === undefined) throw new Error(`no conversation ${id}`);
    return conversation;
  };

  host.on(
    "conversations.send",
    (args: {
      conversationId: string;
      text: string;
      mentions?: string[];
      mode?: "queue" | "steer";
      clientId?: string;
      attachments?: string[];
    }): SendResult | Promise<SendResult> => {
      if (
        scenario === "chat-errors" &&
        args.text.includes("Back up first, then run")
      )
        throw new Error("Network connection failed, message not delivered.");
      if (
        scenario === "chat-errors" &&
        args.text.includes("Send me a copy of the log")
      )
        return new Promise<SendResult>(() => undefined);
      const conversation = conversationOf(args.conversationId);
      const known = conversation.rows.find((item) => item.id === args.clientId);
      if (known !== undefined)
        return { message: known, replies: [], joined: [], nobody: false };
      const targets = conversation.targets(args.mentions ?? []);
      const planned = targets.map((agentId) => ({
        agentId,
        join:
          args.mode === "steer" && conversation.active(agentId) !== undefined,
      }));
      const held =
        planned.length > 0 &&
        planned.every(
          (target) =>
            !target.join && conversation.active(target.agentId) !== undefined,
        );
      const seq = conversation.nextSeq() + conversation.held.length;
      const files = (args.attachments ?? []).flatMap((id) => {
        const file = attachments.get(id);
        return file === undefined ? [] : [file];
      });
      const message = row(args.conversationId, seq, {
        id: args.clientId ?? `sent-${seq}`,
        text: args.text,
        mentions: args.mentions ?? [],
        rootMessageId: args.clientId ?? `sent-${seq}`,
        data: {
          ...(held ? { held: true } : {}),
          woke: planned
            .filter((target) => !target.join)
            .map((target) => target.agentId),
          joined: planned
            .filter((target) => target.join)
            .map((target) => target.agentId),
          ...(files.length === 0 ? {} : { attachments: files }),
        },
      });
      const replies = planned
        .filter((target) => !target.join)
        .map((target, index) =>
          reply(args.conversationId, seq + index + 1, target.agentId, {
            status: "queued",
            replyToId: message.id,
            rootMessageId: message.id,
          }),
        );
      if (held) conversation.held.push(message);
      else conversation.rows.push(message, ...replies);
      conversation.patchSummary({
        lastSeq: conversation.nextSeq() - 1,
        readSeq: conversation.nextSeq() - 1,
        preview: args.text,
      });
      conversation.publish();
      if (!held)
        for (const answer of replies) {
          const member = conversation
            .summary()
            ?.participants.find((item) => item.agentId === answer.agentId);
          const sessionId = member?.sessionId ?? `session-${answer.agentId}`;
          setTimeout(() => {
            conversation.replace(answer.id, {
              status: "working",
              data: { runFrom: 10_000 },
            });
            conversation.publish();
            const words = "Got it.";
            stream(`sessions.${sessionId}`, words, () => {
              conversation.replace(answer.id, { status: "done", text: words });
              conversation.publish();
            });
          }, 100);
        }
      return { message, replies, joined: [], nobody: planned.length === 0 };
    },
  );

  host.on(
    "conversations.stop",
    ({
      conversationId,
      messageId,
    }: {
      conversationId: string;
      messageId?: string;
    }) => {
      const conversation = conversationOf(conversationId);
      const stopped = conversation.rows
        .filter(
          (item) =>
            item.author === "agent" &&
            (item.status === "queued" ||
              item.status === "working" ||
              item.status === "waiting_for_input") &&
            (messageId === undefined || item.id === messageId),
        )
        .flatMap(
          (item) => conversation.replace(item.id, { status: "stopped" }) ?? [],
        );
      conversation.publish();
      return { stopped };
    },
  );

  host.on(
    "conversations.read",
    ({ conversationId, seq }: { conversationId: string; seq: number }) => {
      const conversation = conversationOf(conversationId);
      conversation.patchSummary({ readSeq: seq, unread: 0 });
      // 03h's reply goes on writing once someone is there to see it.
      if (conversationId === "dm-xiaoman" && !streamed) {
        streamed = true;
        stream("sessions.session-agent-xiaoman", REPORT);
      }
      return { conversation: conversation.summary() };
    },
  );

  host.on(
    "conversations.history",
    ({
      conversationId,
      beforeSeq,
      limit,
    }: {
      conversationId: string;
      beforeSeq?: number;
      limit?: number;
    }): HistoryResult => {
      const conversation = conversationOf(conversationId);
      const before = conversation.rows.filter(
        (item) => item.seq < (beforeSeq ?? Number.POSITIVE_INFINITY),
      );
      const page = before.slice(-(limit ?? PAGE));
      return {
        conversationId,
        messages: page,
        hasMore: page.length < before.length,
      };
    },
  );

  host.on(
    "conversations.recall",
    ({
      conversationId,
      messageId,
    }: {
      conversationId: string;
      messageId: string;
    }) => {
      const conversation = conversationOf(conversationId);
      const recalled = conversation.held.some((item) => item.id === messageId);
      conversation.held = conversation.held.filter(
        (item) => item.id !== messageId,
      );
      conversation.publish();
      return { conversationId, recalled };
    },
  );

  const attachments = new Map<string, AttachmentView>();
  host.on(
    "conversations.attach",
    (args: {
      uploadId: string;
      name: string;
      contentType?: string;
      last?: boolean;
      data: string;
    }) => {
      if (args.last !== true) return { attachment: null };
      const attachment: AttachmentView = {
        id: args.uploadId,
        name: args.name,
        contentType: args.contentType ?? "application/octet-stream",
        size: args.data.length,
      };
      attachments.set(attachment.id, attachment);
      return { attachment };
    },
  );
  host.on(
    "conversations.unattach",
    ({ attachmentId }: { attachmentId: string }) => ({
      removed: attachments.delete(attachmentId),
    }),
  );
}
