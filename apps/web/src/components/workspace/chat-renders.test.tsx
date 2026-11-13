import type {
  ConversationSummary,
  InteractionView,
  MessageView,
} from "@eta/client-contracts";
import { readFileSync } from "node:fs";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import { act } from "react";
import { plainDraft } from "@/lib/composer";
import { setWire } from "@/lib/wire";
import { useOutbox } from "@/queries/outbox";
import { Chat } from "@/test-chat";
import { interactionView, surfaceHost } from "@/test-inbox";
import {
  agentView,
  conversationSections,
  conversationView,
  memberView,
  messageView,
} from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";

// Each text block a row renders goes through Markdown: counting its calls
// counts the rows that rendered.
const renders = rstest.hoisted(() => [] as string[]);
rstest.mock("@/components/markdown", () => ({
  Markdown: ({ children }: { children: string }) => {
    renders.push(children);
    return <p>{children}</p>;
  },
}));

// The ref cards link into the app (a router and a search adapter); here they only say what they
// point at, and which version of it. Their own rendering is activity-ref.test.tsx.
rstest.mock("./activity-ref", () => ({
  ActivityRefCard: ({
    value,
    variant,
  }: {
    value: { kind: string; title: string; number?: number };
    variant?: string;
  }) => (
    <span data-testid="ref" data-variant={variant}>
      {value.kind}:{value.title}
      {/* An artifact's number is its version: publishing twice has to read as that. */}
      {value.number === undefined ? "" : ` #${value.number}`}
    </span>
  ),
}));

const AGENT = "a1";
const TURNS = 50;
// The rows the page has seen outlive a render, so each test has a conversation of its own.
let CONV = "";
let conversations = 0;
let n = 0;
// A group folds a reply's process into a box; a direct conversation does not. Both draw the cards
// the turn leaves beside its answer the same way.
let kind: "group" | "direct" = "group";
const fresh = () => {
  n = 0;
  kind = "group";
  conversations += 1;
  CONV = `chat-renders-${conversations}`;
};
const row = (fields: Partial<MessageView>): MessageView => {
  n += 1;
  return messageView({
    id: `${CONV}-${n}`,
    conversationId: CONV,
    seq: n,
    ...fields,
  });
};

let summary: ConversationSummary;
let history: MessageView[];
let host: ReturnType<typeof surfaceHost>;
/** The inbox of the host `start` makes. */
let pending: InteractionView[] = [];

const texts = (c: HTMLElement) =>
  [...c.querySelectorAll('[role="log"] p')].map((p) => p.textContent);

function start(
  members = [memberView(AGENT, { sessionId: "s1" })],
  prepare?: (host: ReturnType<typeof surfaceHost>) => void,
) {
  summary = conversationView({
    id: CONV,
    kind,
    name: "研究员",
    participants: members,
    lastSeq: n,
  });
  host = surfaceHost({
    interactions: pending,
    agents: [
      agentView({ id: AGENT, name: "研究员" }),
      agentView({ id: "a2", name: "装配检查" }),
    ],
    conversations: [summary],
    messages: { [CONV]: history },
  });
  prepare?.(host);
  return mount(<Chat conversationId={CONV} />);
}

/** Replace the conversation's rows, the way the host pushes a window. */
const push = async (rows: MessageView[], members = summary.participants) =>
  act(async () =>
    host.set(
      `conversations.${CONV}`,
      conversationSections({ ...summary, participants: members }, rows),
    ),
  );
const rendered = async (action: () => Promise<void>) => {
  renders.length = 0;
  await action();
  return [...renders];
};

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  useOutbox.setState({ drafts: {}, outgoing: [] });
  pending = [];
});

describe("a reply that changes", () => {
  let streaming: MessageView;
  beforeEach(() => {
    fresh();
    history = [];
    for (let i = 0; i < TURNS; i++) {
      const user = row({ text: `问题 ${i}` });
      history.push(
        user,
        row({
          author: "agent",
          agentId: AGENT,
          replyToId: user.id,
          text: `回复 ${i}`,
        }),
      );
    }
    const user = row({ text: "最后的问题" });
    streaming = row({
      author: "agent",
      agentId: AGENT,
      replyToId: user.id,
      status: "working",
      text: "",
    });
    history.push(user, streaming);
  });

  it("renders only the message it changed", async () => {
    const { container } = await start();
    await flush();
    expect(texts(container).filter((t) => t?.startsWith("回复"))).toHaveLength(
      TURNS,
    );

    const finished = {
      ...streaming,
      status: "done" as const,
      text: "写完了",
      revision: 2,
    };
    const once = await rendered(() =>
      push([...history.slice(0, -1), finished]),
    );
    expect(once).toEqual(["写完了"]);

    // Typing renders no row.
    const typing = await rendered(async () => {
      await act(async () =>
        useOutbox.getState().setDraft(CONV, plainDraft("你好")),
      );
    });
    expect(typing).toEqual([]);
  });

  it("keeps rows the window has moved past, in order", async () => {
    const { container } = await start();
    await flush();
    await push(history.slice(-10));
    expect(texts(container).filter((t) => t?.startsWith("回复"))).toHaveLength(
      TURNS,
    );
    expect(container.textContent).toContain("问题 0");
  });
});

describe("what the timeline says besides words", () => {
  beforeEach(() => {
    fresh();
    history = [];
  });

  it("says a steward change in the reader's language, from the event and the names", async () => {
    history = [
      row({
        kind: "system",
        author: "system",
        text: "A is now the steward.",
        data: { event: "steward", from: "a2", to: AGENT },
      }),
    ];
    const { container } = await start();
    await flush();
    expect(container.textContent).toContain(
      "研究员 成为主理人，接替 装配检查。",
    );
  });

  it("says the wake budget in the reader's language", async () => {
    history = [
      row({
        kind: "system",
        author: "system",
        text: "This thread has used its 5 wake-ups",
        data: { event: "wake_budget", budget: 5 },
      }),
    ];
    const { container } = await start();
    await flush();
    expect(container.textContent).toContain("5 次唤醒");
  });

  it("does not draw what Captain is told about its group proposal, old or new", async () => {
    history = [
      row({ text: "Make a group for the launch" }),
      row({
        author: "system",
        text: 'Your proposed group "Launch" (operation 6f1c2a3b-0d4e-4f5a-8b6c-7d8e9f0a1b2c) was confirmed by the user and created.\nAssign work there with assign_in_group.',
        data: {
          captainGroupOutcome: {
            operationId: "6f1c2a3b-0d4e-4f5a-8b6c-7d8e9f0a1b2c",
            status: "applied",
          },
        },
      }),
      // Written before the mark existed: known by its opening line.
      row({
        author: "system",
        text: 'Your proposed group "Docs" (operation 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d) was rejected by the user. Nothing was created.',
      }),
      row({ author: "agent", agentId: AGENT, text: "Assigned." }),
    ];
    const { container } = await start();
    await flush();
    expect(container.textContent).toContain("Assigned.");
    expect(container.textContent).not.toContain("Your proposed group");
    expect(container.querySelectorAll("[data-mid]")).toHaveLength(2);
  });

  it("renders a Captain review as labeled observation cards", async () => {
    history = [
      row({
        author: "system",
        text: [
          "<captain-review>",
          "The platform Supervisor queued the following observations.",
          "1. [task_run_offline] Task #7 is waiting for an offline machine.",
          "{",
          '  "taskId": "t1",',
          '  "taskNumber": 7,',
          '  "runIds": ["r1"],',
          '  "runs": [{ "machineName": "build-box" }]',
          "}",
          "2. [inbox_pending] An Inbox question has waited.",
          '{ "interactionId": "i1", "agentId": "a1" }',
          "3. [assignment_settled] The work handed to Ada is done.",
          "</captain-review>",
        ].join("\n"),
      }),
    ];
    const { container } = await start();
    await flush();
    const review = container.querySelector(".captain-review");
    expect(review).not.toBeNull();
    expect(review?.textContent).toContain("机器离线");
    expect(review?.textContent).toContain("Inbox 待处理");
    expect(review?.textContent).toContain("build-box");
    expect(review?.textContent).toContain("任务 #7");
    expect(review?.textContent).not.toContain("The platform Supervisor queued");
    expect(container.querySelectorAll(".captain-review-details")).toHaveLength(
      3,
    );
    // Severity is a square beside each label: error for what failed, warning for what needs a
    // person, grey for work that settled. The card itself is not coloured.
    expect(
      [...review!.querySelectorAll("article [data-tone]")].map((mark) =>
        mark.getAttribute("data-tone"),
      ),
    ).toEqual(["error", "warning", "neutral"]);
    expect(review?.textContent).toContain("已落定");
    expect(review?.querySelector("header")?.className).not.toContain("state-");
  });

  it("folds an unparseable Captain review instead of exposing its prompt", async () => {
    history = [
      row({
        author: "system",
        text: [
          "<captain-review>",
          "The platform Supervisor queued the following observations.",
          "An invalid review item.",
          "</captain-review>",
        ].join("\n"),
      }),
    ];
    const { container } = await start();
    await flush();
    const empty = container.querySelector(".captain-review-empty")!;
    expect(empty.querySelector(":scope > p")?.textContent).toContain(
      "这条巡检没能解析出条目",
    );
    expect(empty.querySelector("details")?.open).toBe(false);
    expect(empty.querySelector("pre")?.textContent).toContain(
      "The platform Supervisor queued",
    );
  });

  it("explains a message that woke nobody, right under it", async () => {
    history = [row({ text: "有人吗", data: { woke: [], joined: [] } })];
    const { container } = await start([memberView(AGENT), memberView("a2")]);
    await flush();
    expect(container.textContent).toContain("没有叫醒任何人");
  });

  it("does not, when someone was woken", async () => {
    history = [row({ text: "你好", data: { woke: [AGENT], joined: [] } })];
    const { container } = await start();
    await flush();
    expect(container.textContent).not.toContain("没有叫醒任何人");
  });

  it("says who a steered message joined", async () => {
    history = [row({ text: "改一下", data: { woke: [], joined: [AGENT] } })];
    const { container } = await start();
    await flush();
    expect(container.textContent).toContain("已并入 研究员 正在进行的回复");
    expect(container.textContent).not.toContain("没有叫醒任何人");
  });

  it("gives a failed reply its reason, and sends the message again on request", async () => {
    const user = row({ text: "跑一下" });
    history = [
      user,
      row({
        author: "agent",
        agentId: AGENT,
        replyToId: user.id,
        status: "failed",
        text: "model overloaded",
        data: { code: "run_failed" },
      }),
    ];
    const { container } = await start();
    await flush();
    expect(container.textContent).toContain("运行失败。 model overloaded");
    host.handle("conversations.send", () => ({
      message: row({ text: "跑一下" }),
      replies: [],
      joined: [],
      nobody: false,
    }));
    const resend = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("重新发送"),
    );
    await click(resend);
    await flush();
    const sent = host.calls.find((call) => call.action === "send")!;
    expect(sent.args).toMatchObject({
      conversationId: CONV,
      text: "跑一下",
      mentions: [AGENT],
    });
  });

  it("says a restart once for replies that all failed that way", async () => {
    const user = row({ text: "一起问" });
    const restart = (text: string) =>
      row({
        author: "agent",
        agentId: AGENT,
        replyToId: user.id,
        status: "failed",
        text,
        data: { code: "restart" },
      });
    history = [user, restart("x"), restart("y")];
    const { container } = await start();
    await flush();
    expect(container.textContent).toContain("此消息未执行，原因同下");
    expect(container.textContent).toContain("宿主重启了");
  });
});

describe("a reply that is writing", () => {
  beforeEach(() => {
    fresh();
    history = [];
  });

  it("shows the session's words and tool calls while it works, then the row's own text", async () => {
    const user = row({ text: "查一下" });
    const reply = row({
      author: "agent",
      agentId: AGENT,
      replyToId: user.id,
      status: "working",
    });
    history = [user, reply];
    const { container } = await start(undefined, (fake) => {
      fake.target("sessions.s1", {
        core: { session: "s1", running: true },
        transcript: { messages: [] },
      });
      fake.handle("sessions.resync", () => ({}));
    });
    await flush();
    await act(async () =>
      host.socket.receive({
        type: "event",
        target: "sessions.s1",
        name: "message:update",
        data: {
          message: {
            role: "assistant",
            timestamp: 9,
            content: [
              { type: "text", text: "我先看看" },
              {
                type: "toolCall",
                id: "t1",
                name: "bash",
                arguments: { command: "ls" },
              },
            ],
          },
        },
      }),
    );
    await flush(80);
    expect(container.textContent).toContain("我先看看");
    expect(container.textContent).toContain("bash");

    await push([
      user,
      { ...reply, status: "done", text: "看完了", revision: 2 },
    ]);
    expect(container.textContent).toContain("看完了");
    expect(container.textContent).not.toContain("我先看看");
  });

  it("draws the tool calls a finished reply kept, and the artifacts it published", async () => {
    const user = row({ text: "发布一个页面" });
    const reply = row({
      author: "agent",
      agentId: AGENT,
      replyToId: user.id,
      status: "done",
      text: "发布好了",
      data: {
        activity: [
          {
            id: "t1",
            name: "bash",
            input: { command: "ls -la" },
            output: "total 0",
            status: "completed",
          },
          {
            id: "t2",
            name: "publish_artifact",
            input: { title: "报告" },
            status: "completed",
            details: { artifactId: "art-1", title: "报告", version: 2 },
          },
          {
            id: "t3",
            name: "publish_artifact",
            input: { title: "看板" },
            status: "completed",
            details: { artifactId: "art-1", title: "看板", version: 4 },
          },
        ],
      },
    });
    history = [user, reply];
    const { container } = await start();
    await flush();
    expect(container.textContent).toContain("bash · ls -la");
    expect(container.textContent).toContain("total 0");
    expect(container.textContent).toContain("发布好了");

    // A group folds the process once the answer is written, so the cards of what the reply produced
    // cannot live in it: they are drawn beside the answer, in the turn's own card layer, in the
    // order they were published and each saying which version it opens.
    const fold = container.querySelector(".process-fold")!;
    const cards = [...container.querySelectorAll('[data-testid="ref"]')];
    expect(cards.map((c) => c.textContent)).toEqual([
      "artifact:报告 #2",
      "artifact:看板 #4",
    ]);
    for (const card of cards) {
      // In a chat a card stands among text, with no list to rule it: it draws its own line.
      expect(card.getAttribute("data-variant")).toBe("framed");
      const layer = card.closest(".turn-tasks") as HTMLElement | null;
      expect(layer).not.toBeNull();
      expect(card.closest(".process-fold")).toBeNull();
    }
    // The column sits flush with the answer: no hairline, and no indent that only held one.
    const styles = readFileSync(
      new URL("../../styles.css", import.meta.url),
      "utf8",
    );
    const rule = styles.match(/\.turn-tasks \{[^}]*\}/)?.[0] ?? "";
    expect(rule).not.toMatch(/border-left/);
    expect(rule).not.toMatch(/margin-left/);
    expect(rule).not.toMatch(/padding-left/);
    expect(styles).not.toContain('.turn-tasks[data-only-email-cards="true"]');
    // After the answer it belongs to, not before it.
    const answer = container.querySelector(
      ".message.assistant .message-content",
    )!;
    expect(
      answer.compareDocumentPosition(cards[0]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The calls themselves stay in the process, with their arguments and result; the card is not
    // repeated there.
    expect(fold.textContent).toContain("publish_artifact");
    expect(fold.querySelectorAll('[data-testid="ref"]')).toHaveLength(0);
  });

  it("draws a widget a finished reply kept, beside its answer", async () => {
    const user = row({ text: "构建情况" });
    const reply = row({
      author: "agent",
      agentId: AGENT,
      replyToId: user.id,
      status: "done",
      text: "如上",
      data: {
        activity: [
          {
            id: "w1",
            name: "show_widget",
            // A row cuts long arguments: the spec it draws is the one in `details`.
            input: { title: "构建", spec: '{"op":"add"…' },
            status: "completed",
            details: {
              title: "构建",
              spec: {
                root: "main",
                elements: {
                  main: {
                    type: "Grid",
                    props: {},
                    children: ["rate", "slow"],
                  },
                  rate: {
                    type: "Metric",
                    props: { label: "通过率", value: "98%", trend: "up" },
                    children: [],
                  },
                  slow: {
                    type: "BarChart",
                    props: {
                      data: [
                        { label: "web", value: 42 },
                        { label: "web", value: 12 },
                      ],
                      unit: "s",
                    },
                    children: [],
                  },
                },
              },
            },
          },
        ],
      },
    });
    history = [user, reply];
    const { container } = await start();
    await flush();
    const widget = container.querySelector(".turn-tasks figure")!;
    expect(widget.getAttribute("aria-label")).toBe("构建");
    expect(widget.textContent).toContain("通过率98%");
    expect(widget.textContent).toContain("web42s");
    expect(widget.textContent).toContain("web12s");
    expect(widget.closest(".process-fold")).toBeNull();
  });

  it("draws a widget while its call is still streaming", async () => {
    const user = row({ text: "构建情况" });
    const reply = row({
      author: "agent",
      agentId: AGENT,
      replyToId: user.id,
      status: "working",
    });
    history = [user, reply];
    const lines = [
      JSON.stringify({ op: "add", path: "/root", value: "main" }),
      JSON.stringify({
        op: "add",
        path: "/elements/main",
        value: { type: "Card", props: { title: "CI" }, children: ["rate"] },
      }),
      // Half a line: not drawn until it is whole.
      '{"op":"add","path":"/elements/rate","value":{"type":"Met',
    ].join("\n");
    const { container } = await start(undefined, (fake) => {
      fake.target("sessions.s1", {
        core: {
          session: "s1",
          running: true,
          streaming: {
            role: "assistant",
            timestamp: 2,
            content: [
              {
                type: "toolCall",
                id: "w1",
                name: "show_widget",
                arguments: { title: "构建", spec: lines },
              },
            ],
          },
        },
        transcript: {
          messages: [
            {
              entryId: "e1",
              seq: 1,
              at: 1,
              message: { role: "user", content: "构建情况", timestamp: 1 },
            },
          ],
        },
      });
      fake.handle("sessions.resync", () => ({}));
    });
    await flush(80);
    const widget = container.querySelector(".turn-tasks figure")!;
    expect(widget.getAttribute("aria-busy")).toBe("true");
    expect(widget.querySelector("h4")?.textContent).toBe("CI");
  });

  it("draws a publish's card beside the answer while the reply is still writing", async () => {
    const user = row({ text: "发布一个页面" });
    const reply = row({
      author: "agent",
      agentId: AGENT,
      replyToId: user.id,
      status: "working",
    });
    history = [user, reply];
    const published = {
      id: "t2",
      name: "publish_artifact",
      input: { title: "报告" },
      status: "completed",
      details: { artifactId: "art-1", title: "报告", version: 2 },
    };
    const { container } = await start(undefined, (fake) => {
      fake.target("sessions.s1", {
        core: { session: "s1", running: true },
        transcript: {
          messages: [
            {
              entryId: "e1",
              seq: 1,
              at: 1,
              message: { role: "user", content: "发布一个页面", timestamp: 1 },
            },
            {
              entryId: "e2",
              seq: 2,
              at: 2,
              message: {
                role: "assistant",
                timestamp: 2,
                content: [
                  {
                    type: "toolCall",
                    id: "t2",
                    name: "publish_artifact",
                    arguments: { title: "报告" },
                  },
                ],
              },
            },
            {
              entryId: "e3",
              seq: 3,
              at: 3,
              message: {
                role: "toolResult",
                toolCallId: "t2",
                toolName: "publish_artifact",
                content: [{ type: "text", text: "published" }],
                details: published.details,
                isError: false,
                timestamp: 3,
              },
            },
            {
              entryId: "e4",
              seq: 4,
              at: 4,
              message: {
                role: "assistant",
                timestamp: 4,
                content: [{ type: "text", text: "发布好了" }],
              },
            },
          ],
        },
      });
      fake.handle("sessions.resync", () => ({}));
    });
    await flush(80);
    // Its last text is written, so the box has folded while the row still reads as working.
    const fold = container.querySelector(".process-fold")!;
    expect(fold.textContent).toContain("publish_artifact");
    expect(fold.querySelectorAll('[data-testid="ref"]')).toHaveLength(0);
    const card = container.querySelector('[data-testid="ref"]')!;
    expect(card.textContent).toBe("artifact:报告 #2");
    expect(card.getAttribute("data-variant")).toBe("framed");
    expect(card.closest(".turn-tasks")).not.toBeNull();

    // The row settling, or the page reloading, does not move it or change its version: the same
    // cards, in the same layer, from the run's blocks or from the row that kept them.
    await push([
      user,
      {
        ...reply,
        status: "done",
        text: "发布好了",
        revision: 2,
        data: { activity: [published] },
      },
    ]);
    const settled = container.querySelector('[data-testid="ref"]')!;
    expect(settled.textContent).toBe("artifact:报告 #2");
    expect(settled.closest(".turn-tasks")).not.toBeNull();
    expect(
      container
        .querySelector(".process-fold")!
        .querySelectorAll('[data-testid="ref"]'),
    ).toHaveLength(0);
  });

  // What the translator writes for a call an agent on Claude Code or Codex made over MCP: the host's
  // name, the runtime's call id, and the details the tool left, in both places a card is read from.
  it("draws the card of a publish made on an external runtime, while writing and after", async () => {
    const user = row({ text: "发布一个页面" });
    const reply = row({
      author: "agent",
      agentId: AGENT,
      replyToId: user.id,
      status: "working",
    });
    history = [user, reply];
    const details = {
      artifactId: "art-1",
      title: "报告",
      version: 2,
      files: 1,
    };
    const { container } = await start(undefined, (fake) => {
      fake.target("sessions.s1", {
        core: { session: "s1", running: true },
        transcript: {
          messages: [
            {
              entryId: "e1",
              seq: 1,
              at: 1,
              message: { role: "user", content: "发布一个页面", timestamp: 1 },
            },
            {
              entryId: "e2",
              seq: 2,
              at: 2,
              message: {
                role: "assistant",
                api: "oar-claude",
                provider: "claude",
                stopReason: "toolUse",
                timestamp: 2,
                content: [
                  {
                    type: "toolCall",
                    id: "toolu_01",
                    name: "publish_artifact",
                    arguments: { path: "site", title: "报告" },
                  },
                ],
              },
            },
            {
              entryId: "e3",
              seq: 3,
              at: 3,
              message: {
                role: "toolResult",
                toolCallId: "toolu_01",
                toolName: "publish_artifact",
                content: [{ type: "text", text: 'Published "报告" version 2' }],
                details,
                isError: false,
                timestamp: 3,
              },
            },
          ],
        },
      });
      fake.handle("sessions.resync", () => ({}));
    });
    await flush(80);
    expect(container.querySelector('[data-testid="ref"]')?.textContent).toBe(
      "artifact:报告 #2",
    );

    await push([
      user,
      {
        ...reply,
        status: "done",
        text: "发布好了",
        revision: 2,
        data: {
          activity: [
            {
              id: "toolu_01",
              name: "publish_artifact",
              input: { path: "site", title: "报告" },
              status: "completed",
              output: 'Published "报告" version 2',
              details,
            },
          ],
        },
      },
    ]);
    const settled = container.querySelector('[data-testid="ref"]')!;
    expect(settled.textContent).toBe("artifact:报告 #2");
    expect(settled.closest(".turn-tasks")).not.toBeNull();
  });

  // A direct conversation has no process box to fold, and the card does not move because of one:
  // the same layer, beside the answer, in both.
  it("draws a publish's card in that same layer where there is no process box", async () => {
    kind = "direct";
    const user = row({ text: "发布一个页面" });
    history = [
      user,
      row({
        author: "agent",
        agentId: AGENT,
        replyToId: user.id,
        status: "done",
        text: "发布好了",
        data: {
          activity: [
            {
              id: "t2",
              name: "publish_artifact",
              input: { title: "报告" },
              status: "completed",
              details: { artifactId: "art-1", title: "报告", version: 2 },
            },
          ],
        },
      }),
    ];
    const { container } = await start();
    await flush();
    expect(container.querySelector(".process-fold")).toBeNull();
    const card = container.querySelector('[data-testid="ref"]')!;
    expect(card.textContent).toBe("artifact:报告 #2");
    expect(card.closest(".turn-tasks")).not.toBeNull();
    // Not under the tool line it came from, which stays where the process is drawn.
    expect(card.closest(".tool-step")).toBeNull();
    expect(container.textContent).toContain("publish_artifact");
  });

  it("shows the files a message came with under its words", async () => {
    const user = row({
      text: "看这个",
      data: {
        attachments: [
          {
            id: "f1",
            name: "报告.pdf",
            contentType: "application/pdf",
            size: 2048,
          },
          { id: "f2", name: "图.png", contentType: "image/png", size: 10 },
        ],
      },
    });
    history = [user];
    const { container } = await start();
    await flush();
    expect(container.textContent).toContain("看这个");
    expect(container.textContent).toContain("[报告.pdf · 2.0 KB]");
    expect(container.textContent).toContain("[图.png · 10 B]");
  });

  // A long paste folds into a chip in the composer; the sent message keeps it that way, with
  // the typing around it rendered as itself. The chip opens the whole text.
  const PASTE = "日志行\n".repeat(300); // 1200 characters, over LONG_PASTE.chars
  const chips = (c: ParentNode, chars: number) =>
    [...c.querySelectorAll("button")].filter(
      (b) => b.textContent === `[粘贴文本 · ${chars} 字符]`,
    );
  const chipCount = (c: ParentNode, chars: number) => chips(c, chars).length;
  const chipAt = (c: ParentNode, chars: number) => chips(c, chars)[0]!;

  it("folds a paste back into the composer's chip, the typing around it intact", async () => {
    const at = "先看：".length;
    const user = row({
      text: `先看：\n${PASTE}\n就这些`,
      data: { blocks: [[at + 1, at + 1 + PASTE.length]] },
    });
    history = [user];
    const { container } = await start();
    await flush();
    const log = container.querySelector('[role="log"]')!;
    expect(log.textContent).toContain("先看：");
    expect(log.textContent).toContain("就这些");
    expect(chipCount(log, [...PASTE].length)).toBe(1);
    // Folded means the paste's own lines are not sitting in the transcript.
    expect(log.textContent).not.toContain("日志行");

    // The chip opens the whole text, and the dialog closes again.
    await click(chipAt(log, [...PASTE].length));
    await flush();
    expect(document.body.textContent).toContain("日志行");
    await click(document.querySelector('[data-slot="dialog-close"]')!);
    await flush();
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
  });

  it("folds a block at the start and a block at the end of one message", async () => {
    const user = row({
      text: `${PASTE}中间的手打${PASTE}`,
      data: {
        blocks: [
          [0, PASTE.length],
          [
            PASTE.length + "中间的手打".length,
            PASTE.length + "中间的手打".length + PASTE.length,
          ],
        ],
      },
    });
    history = [user];
    const { container } = await start();
    await flush();
    const log = container.querySelector('[role="log"]')!;
    expect(chipCount(log, [...PASTE].length)).toBe(2);
    expect(log.textContent).toContain("中间的手打");
    expect(log.textContent).not.toContain("日志行");
  });

  it("reads a long typed message whole, with no fold in the way", async () => {
    const typed = `${"手写的很长一段\n".repeat(30)}`;
    const user = row({ text: typed });
    history = [user];
    const { container } = await start();
    await flush();
    const log = container.querySelector('[role="log"]')!;
    // Every line of it, including the last, and nothing standing between the reader and it.
    expect(log.textContent).toContain(typed.trimEnd());
    expect(log.textContent).not.toContain("展开全文");
    expect(log.querySelector(".line-clamp-12")).toBeNull();
    expect(chipCount(log, [...typed].length)).toBe(0);
  });

  it("asks its question in a card and answers on the inbox", async () => {
    const user = row({ text: "删掉吗" });
    const reply = row({
      author: "agent",
      agentId: AGENT,
      replyToId: user.id,
      status: "waiting_for_input",
    });
    history = [user, reply];
    pending = [
      interactionView({
        id: "i1",
        agentId: AGENT,
        conversationId: CONV,
        prompt: "删掉这个分支？",
        options: ["删", "留"],
      }),
    ];
    const { container } = await start(
      [memberView(AGENT, { sessionId: "s1", status: "waiting_for_input" })],
      (fake) => {
        fake.target("sessions.s1", {
          core: { session: "s1", running: true },
          transcript: { messages: [] },
        });
        fake.handle("inbox.answer", () => ({ answered: true }));
      },
    );
    await flush();
    const card = container.querySelector(".ask-block")!;
    expect(card.textContent).toContain("删掉这个分支？");
    await click(
      [...card.querySelectorAll("button")].find((b) => b.textContent === "删"),
    );
    await flush();
    expect(host.calls.find((call) => call.action === "answer")?.args).toEqual({
      id: "i1",
      response: { kind: "selection", selections: ["删"] },
    });
    await click(
      [...card.querySelectorAll("button")].find(
        (b) => b.textContent === "放弃",
      ),
    );
    await flush();
    expect(host.calls.at(-1)?.args).toEqual({
      id: "i1",
      response: { kind: "none" },
    });
  });
});
