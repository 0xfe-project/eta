import type {
  ConversationSummary,
  InteractionView,
  MessageView,
} from "@eta/client-contracts";
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
// point at. Their own rendering is activity-ref.test.tsx.
rstest.mock("./activity-ref", () => ({
  ActivityRefCard: ({ value }: { value: { kind: string; title: string } }) => (
    <span data-testid="ref">
      {value.kind}:{value.title}
    </span>
  ),
}));

const AGENT = "a1";
const TURNS = 50;
// The rows the page has seen outlive a render, so each test has a conversation of its own.
let CONV = "";
let conversations = 0;
let n = 0;
const fresh = () => {
  n = 0;
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

  it("draws the tool calls a finished reply kept, and the artifact one of them published", async () => {
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
        ],
      },
    });
    history = [user, reply];
    const { container } = await start();
    await flush();
    expect(container.textContent).toContain("bash · ls -la");
    expect(container.textContent).toContain("total 0");
    expect(container.textContent).toContain("publish_artifact");
    expect(container.querySelector('[data-testid="ref"]')?.textContent).toBe(
      "artifact:报告",
    );
    expect(container.textContent).toContain("发布好了");
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
