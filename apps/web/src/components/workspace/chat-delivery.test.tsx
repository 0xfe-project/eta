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
import { EMPTY_DRAFT, plainDraft } from "@/lib/composer";
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
  body: {
    id: string;
    parts: { type: string; text?: string; attachment_id?: string }[];
  };
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}
let posts: Post[] = [];
let client: QueryClient | undefined;
let reading = 0;

/** The chat as Workspace wires it, for one agent. */
function Chat({ agentStatus = "idle" }: { agentStatus?: "idle" | "starting" }) {
  const chat = useQuery(chatQueryOptions());
  const history = useAgentMessages(chat.data ? AGENT : undefined);
  const draft = useOutbox((s) => s.drafts[AGENT] ?? EMPTY_DRAFT);
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
      onDraftChange={(next) => useOutbox.getState().setDraft(AGENT, next)}
      onFiles={() => []}
      onSend={(parts, mode) => {
        outbox.send(AGENT, parts, mode);
        useOutbox.getState().setDraft(AGENT, []);
      }}
      outgoing={all.filter((o) => !arrived.has(o.id))}
      onRetry={outbox.retry}
      onEdit={outbox.edit}
      onDiscard={outbox.discard}
      onResend={(parts) => outbox.send(AGENT, parts, "queue")}
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
      reading++;
      try {
        const body = await request.json();
        return new Promise<Response>((resolve, reject) =>
          posts.push({ body, resolve, reject }),
        );
      } finally {
        reading--;
      }
    });
  const container = document.createElement("div");
  document.body.append(container);
  const queryClient = new QueryClient();
  client = queryClient;
  await act(async () => {
    createRoot(container).render(
      <QueryClientProvider client={queryClient}>
        <Chat agentStatus={agentStatus} />
      </QueryClientProvider>,
    );
  });
  await settle();
  return container;
}

// What the page is waiting for: its queries, and sends whose request the
// stand-in server is still reading. A fixed pause alone is not enough when
// the machine is busy (the whole repository's checks run in parallel).
async function settle(ms = 10) {
  const pause = (wait: number) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, wait));
    });
  const idle = () => reading === 0 && !client?.isFetching();
  await pause(ms);
  // Idle twice in a row, React flushed in between: a query that starts only
  // once another one's data has rendered (the history after the chat) counts.
  const deadline = Date.now() + 5000;
  for (let quiet = 0; quiet < 2 && Date.now() < deadline; ) {
    await pause(5);
    quiet = idle() ? quiet + 1 : 0;
  }
}
const editor = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[contenteditable]")!;
// What the composer holds, as the user sees it.
const composed = (c: HTMLElement) => editor(c).textContent;
// Typing goes through the draft: the composer shows what the draft holds.
async function type(_c: HTMLElement, value: string) {
  await act(async () =>
    useOutbox.getState().setDraft(AGENT, plainDraft(value)),
  );
}
async function enter(c: HTMLElement) {
  await act(async () => {
    editor(c).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await settle();
}
const log = (c: HTMLElement) => c.querySelector('[role="log"]')!.textContent!;
const button = (c: HTMLElement, text: string) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent === text);
function accepted(post: Post) {
  const user = message("user", {
    id: post.body.id,
    text: post.body.parts.map((p) => p.text ?? "").join(""),
  });
  const reply = message("assistant", { reply_to_id: user.id });
  return Response.json({ message: user, reply }, { status: 202 });
}
const count = (text: string, part: string) => text.split(part).length - 1;

describe("sending a message", () => {
  beforeEach(() => {
    useOutbox.setState({ drafts: {}, uploads: {}, outgoing: [] });
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
    expect(composed(c)).toBe("");
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
    expect(composed(c)).toBe("正在写第二条");
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
    expect(composed(c)).toBe("你好");
    expect(log(c)).not.toContain("你好");
  });
});

describe("sending blocks", () => {
  const csv = {
    id: "a1",
    name: "data.csv",
    content_type: "text/csv",
    size: 8,
  };
  const long = "第一行\n".repeat(20);
  const draft = [
    { type: "text" as const, text: "看" },
    {
      type: "file" as const,
      id: "f",
      name: "data.csv",
      contentType: "text/csv",
      size: 8,
    },
    { type: "paste" as const, id: "p", text: long },
  ];
  beforeEach(() => {
    useOutbox.setState({ drafts: {}, uploads: {}, outgoing: [] });
  });
  afterEach(async () => {
    useOutbox.setState({ outgoing: [] });
    for (const post of posts)
      post.resolve(Response.json({ error: {} }, { status: 400 }));
    await settle();
    document.body.innerHTML = "";
    posts = [];
    rstest.restoreAllMocks();
  });

  it("waits for uploads, then sends text, files and pastes in order", async () => {
    const c = await render();
    await act(async () => {
      useOutbox.getState().setUpload("f", { agentId: AGENT });
      useOutbox.getState().setDraft(AGENT, draft);
    });
    expect(composed(c)).toContain("粘贴文本 · 80 字符");
    expect(composed(c)).toContain("上传中");
    await enter(c);
    expect(posts).toHaveLength(0);
    expect(c.textContent).toContain("附件上传中，完成后才能发送。");

    await act(async () =>
      useOutbox.getState().setUpload("f", { agentId: AGENT, attachment: csv }),
    );
    await enter(c);
    expect(posts).toHaveLength(1);
    expect(posts[0].body.parts).toEqual([
      { type: "text", text: "看" },
      { type: "attachment", attachment_id: "a1" },
      { type: "text", text: long },
    ]);
    expect(composed(c)).toBe("");
    // On its way, as written: the paste folded, the file by name.
    expect(log(c)).toContain("[data.csv · 8 B]");
    expect(log(c)).toContain("粘贴文本 · 80 字符");
    expect(log(c)).not.toContain("第一行");
  });

  it("keeps a draft whose upload failed, and says why", async () => {
    const c = await render();
    await act(async () => {
      useOutbox.getState().setUpload("f", {
        agentId: AGENT,
        error: "网络连接失败，上传未完成。",
      });
      useOutbox.getState().setDraft(AGENT, draft);
    });
    await enter(c);
    expect(posts).toHaveLength(0);
    expect(c.textContent).toContain("网络连接失败，上传未完成。");
    expect(c.textContent).toContain("有附件上传失败：重试或移除后再发送。");
    expect(useOutbox.getState().drafts[AGENT]).toEqual(draft);
  });
});

describe("drafts saved before blocks", () => {
  it("load as text, and messages on their way as their text", async () => {
    const id = crypto.randomUUID();
    localStorage.setItem(
      "axp.chat.v1",
      JSON.stringify({
        drafts: { [AGENT]: "写了一半" },
        outgoing: [
          { id, agentId: AGENT, text: "发送中", mode: "queue", failure: "x" },
        ],
      }),
    );
    await act(() => useOutbox.persist.rehydrate());
    const { drafts, outgoing, uploads } = useOutbox.getState();
    expect(drafts[AGENT]).toEqual([{ type: "text", text: "写了一半" }]);
    expect(outgoing[0].parts).toEqual([{ type: "text", text: "发送中" }]);
    expect(uploads).toEqual({});
    localStorage.clear();
  });

  it("fail uploads a reload cut off", async () => {
    localStorage.setItem(
      "axp.chat.v1",
      JSON.stringify({
        drafts: {
          [AGENT]: [
            {
              type: "file",
              id: "f",
              name: "a.png",
              contentType: "image/png",
              size: 1,
            },
          ],
        },
        uploads: { f: { agentId: AGENT }, gone: { agentId: AGENT } },
        outgoing: [],
      }),
    );
    await act(() => useOutbox.persist.rehydrate());
    expect(useOutbox.getState().uploads).toEqual({
      f: { agentId: AGENT, error: "上传中断，请移除后重新粘贴。" },
    });
    localStorage.clear();
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
      code: "AGENT_BUILD_FAILED",
      message: "智能体环境构建失败，此消息未执行。",
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
