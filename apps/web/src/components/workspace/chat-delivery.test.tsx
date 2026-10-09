import type { ChatMessage } from "@/queries/chat";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { chatQueryOptions, useAgentMessages } from "@/queries/chat";
import {
  useOutbox,
  useOutboxActions,
  useOutboxDelivery,
} from "@/queries/outbox";
import { ChatPanel } from "./chat-panel";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom has none of these.
const g = globalThis as Record<string, unknown>;
g.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
};
g.IntersectionObserver ??= class {
  observe() {}
  disconnect() {}
};
g.EventSource ??= class {
  static CLOSED = 2;
  addEventListener() {}
  removeEventListener() {}
  close() {}
};

const AGENT = "00000000-0000-0000-0000-000000000001";
let n = 0;
function message(
  role: ChatMessage["role"],
  fields: Partial<ChatMessage> & { text?: string } = {},
): ChatMessage {
  const { text = "", ...rest } = fields;
  n++;
  return {
    id: `00000000-0000-0000-0001-${String(n).padStart(12, "0")}`,
    agent_id: AGENT,
    role,
    reply_to_id: null,
    status: role === "user" ? "completed" : "queued",
    revision: 1,
    blocks: text ? [{ id: `b${n}`, type: "text", text }] : [],
    failure: null,
    created_at: `2026-10-09T00:00:${String(n).padStart(2, "0")}Z`,
    ...rest,
  };
}

// happy-dom drops a Request's headers, so the Idempotency-Key (the same id)
// cannot be checked here; the body's id can.
interface Post {
  body: { id: string; text: string };
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}
let posts: Post[] = [];

/** The chat as Workspace wires it, for one agent. */
function Chat({ agentStatus = "idle" }: { agentStatus?: "idle" | "starting" }) {
  const chat = useQuery(chatQueryOptions());
  const history = useAgentMessages(chat.data ? AGENT : undefined);
  const draft = useOutbox((s) => s.drafts[AGENT] ?? "");
  const all = useOutbox((s) => s.outgoing);
  const arrived = useMemo(
    () => new Set(history.messages.map((m) => m.id)),
    [history.messages],
  );
  useOutboxDelivery(arrived);
  const outbox = useOutboxActions();
  return (
    <ChatPanel
      theme="codex"
      agentId={AGENT}
      agentName="研究员"
      agentStatus={agentStatus}
      messages={history.messages}
      hasOlder={false}
      loadingOlder={false}
      onLoadOlder={() => {}}
      interactions={[]}
      draft={draft}
      onDraftChange={(text) => useOutbox.getState().setDraft(AGENT, text)}
      onSend={(text, mode) => {
        outbox.send(AGENT, text, mode);
        useOutbox.getState().setDraft(AGENT, "");
      }}
      outgoing={all.filter((o) => !arrived.has(o.id))}
      onRetry={outbox.retry}
      onEdit={outbox.edit}
      onDiscard={outbox.discard}
      onResend={(text) => outbox.send(AGENT, text, "queue")}
      onCompact={() => {}}
      onStop={() => {}}
      onAnswer={() => {}}
    />
  );
}

async function render(
  history: ChatMessage[] = [],
  agentStatus?: "idle" | "starting",
) {
  rstest
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.method === "GET" && request.url.endsWith("/api/v1/chat"))
        return Response.json({
          agents: [],
          active_replies: [],
          interactions: [],
          event_cursor: "c",
        });
      if (request.method === "GET")
        return Response.json({ items: history, next_cursor: null });
      const body = await request.json();
      return new Promise<Response>((resolve, reject) =>
        posts.push({ body, resolve, reject }),
      );
    });
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <QueryClientProvider client={new QueryClient()}>
        <Chat agentStatus={agentStatus} />
      </QueryClientProvider>,
    );
  });
  await settle();
  return container;
}

async function settle(ms = 10) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
const textarea = (c: HTMLElement) => c.querySelector("textarea")!;
async function type(c: HTMLElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(textarea(c), value);
    textarea(c).dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function enter(c: HTMLElement) {
  await act(async () => {
    textarea(c).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  await settle();
}
const log = (c: HTMLElement) => c.querySelector('[role="log"]')!.textContent!;
const button = (c: HTMLElement, text: string) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent === text);
function accepted(post: Post) {
  const user = message("user", { id: post.body.id, text: post.body.text });
  const reply = message("assistant", { reply_to_id: user.id });
  return Response.json(
    { message: user, reply, steered: false },
    { status: 202 },
  );
}
const count = (text: string, part: string) => text.split(part).length - 1;

describe("sending a message", () => {
  beforeEach(() => {
    useOutbox.setState({ drafts: {}, outgoing: [] });
  });
  afterEach(async () => {
    // Ends the deliveries still waiting, so none outlives its test.
    rstest.useRealTimers();
    useOutbox.setState({ outgoing: [] });
    for (const post of posts)
      post.resolve(Response.json({ error: {} }, { status: 400 }));
    await settle();
    document.body.innerHTML = "";
    posts = [];
    rstest.useRealTimers();
    rstest.restoreAllMocks();
  });

  it("shows it at once and sends it once, however often Enter is pressed", async () => {
    const c = await render();
    await type(c, "你好");
    await enter(c);
    await enter(c);
    await enter(c);
    expect(posts).toHaveLength(1);
    expect(textarea(c).value).toBe("");
    expect(log(c)).toContain("你好");
    expect(log(c)).toContain("发送中");
    await act(async () => posts[0].resolve(accepted(posts[0])));
    await settle();
    expect(count(log(c), "你好")).toBe(1);
    expect(log(c)).not.toContain("发送中");
  });

  it("leaves the next draft alone when the last message arrives", async () => {
    const c = await render();
    await type(c, "第一条");
    await enter(c);
    await type(c, "正在写第二条");
    await act(async () => posts[0].resolve(accepted(posts[0])));
    await settle();
    expect(textarea(c).value).toBe("正在写第二条");
  });

  it("tries again as the same message, then offers a retry", async () => {
    const c = await render();
    await type(c, "你好");
    await enter(c);
    // The waits between tries pass at once.
    rstest.useFakeTimers({ toFake: ["setTimeout"] });
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        posts[i].reject(new TypeError("Failed to fetch"));
        await rstest.advanceTimersByTimeAsync(10_000);
      });
    }
    expect(posts).toHaveLength(4);
    expect(new Set(posts.map((p) => p.body.id)).size).toBe(1);
    expect(log(c)).toContain("网络连接失败，消息未送达。");
    await act(async () => button(c, "重试")!.click());
    await act(async () => rstest.advanceTimersByTimeAsync(10));
    expect(posts).toHaveLength(5);
    expect(posts[4].body.id).toBe(posts[0].body.id);
    await act(async () => {
      posts[4].resolve(accepted(posts[4]));
      await rstest.advanceTimersByTimeAsync(10);
    });
    expect(count(log(c), "你好")).toBe(1);
  });

  it("does not retry what the server refused, and can edit it", async () => {
    const c = await render();
    await type(c, "你好");
    await enter(c);
    await act(async () =>
      posts[0].resolve(
        Response.json(
          {
            error: {
              code: "QUEUE_FULL",
              message: "该智能体待处理的消息过多。",
            },
          },
          { status: 429 },
        ),
      ),
    );
    await settle();
    expect(posts).toHaveLength(1);
    expect(log(c)).toContain("该智能体待处理的消息过多。");
    await act(async () => button(c, "编辑")!.click());
    expect(textarea(c).value).toBe("你好");
    expect(log(c)).not.toContain("你好");
  });
});

describe("waiting replies", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    rstest.restoreAllMocks();
  });

  it("moves only the first and numbers the rest", async () => {
    const a = message("user", { text: "A" });
    const ra = message("assistant", { reply_to_id: a.id });
    const b = message("user", { text: "B" });
    const rb = message("assistant", { reply_to_id: b.id });
    const c = await render([a, ra, b, rb], "starting");
    const moving = [...c.querySelectorAll('[role="status"]')].map(
      (s) => s.textContent,
    );
    expect(moving).toHaveLength(1);
    expect(moving[0]).toContain("正在启动智能体");
    expect(log(c)).toContain("等待中 · 前面还有 1 条");
  });

  it("says an environment failure once and offers to send again", async () => {
    const failure = {
      code: "START_TIMEOUT",
      message: "智能体环境准备超时，此消息未执行。",
    };
    const a = message("user", { text: "A" });
    const ra = message("assistant", {
      reply_to_id: a.id,
      status: "failed",
      failure,
    });
    const b = message("user", { text: "B" });
    const rb = message("assistant", {
      reply_to_id: b.id,
      status: "failed",
      failure,
    });
    const c = await render([a, ra, b, rb]);
    expect(count(log(c), failure.message)).toBe(1);
    expect(log(c)).toContain("此消息未执行，原因同下。");
    expect(
      [...c.querySelectorAll("button")].filter(
        (x) => x.textContent === "重新发送",
      ),
    ).toHaveLength(2);
  });
});
