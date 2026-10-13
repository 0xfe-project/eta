import type { Draft } from "@/lib/composer";
import type { ChatMessage, Interaction } from "@/queries/chat";
import { writeFileSync } from "node:fs";
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
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { plainDraft } from "@/lib/composer";
import {
  chatQueryOptions,
  useAgentMessages,
  useLiveChat,
} from "@/queries/chat";
import { ChatPanel } from "./chat-panel";

// Each text block a row renders goes through Markdown: counting its calls
// counts the rows that rendered.
const renders = rstest.hoisted(() => [] as string[]);
rstest.mock("@/components/markdown", () => ({
  Markdown: ({ children }: { children: string }) => {
    renders.push(children);
    return <p>{children}</p>;
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as Record<string, unknown>;
g.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
};
g.IntersectionObserver ??= class {
  observe() {}
  disconnect() {}
};
/** The chat stream; `emit` delivers a product event to its listeners. */
class FakeSource {
  static CLOSED = 2;
  static current: FakeSource | undefined;
  listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  constructor() {
    FakeSource.current = this;
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener() {}
  close() {}
  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? [])
      listener(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}
g.EventSource = FakeSource;

const AGENT = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";
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
    status: role === "user" ? "completed" : "completed",
    revision: 1,
    blocks: text ? [{ id: `b${n}`, type: "text", text }] : [],
    failure: null,
    created_at: new Date(Date.UTC(2026, 9, 9, 0, 0, n)).toISOString(),
    ...rest,
  };
}

const TURNS = 50;
let history: ChatMessage[];
let streaming: ChatMessage;
let elsewhere: ChatMessage;
let draft: (text: string) => void;

function Chat() {
  useLiveChat();
  const chat = useQuery(chatQueryOptions());
  const timeline = useAgentMessages(chat.data ? AGENT : undefined);
  const [text, setText] = useState<Draft>([]);
  draft = (value) => setText(plainDraft(value));
  return (
    <ChatPanel
      agentId={AGENT}
      agentName="研究员"
      messages={timeline.messages}
      hasOlder={false}
      loadingOlder={false}
      onLoadOlder={() => {}}
      interactions={chat.data?.interactions ?? []}
      draft={text}
      onDraftChange={setText}
      onFiles={() => []}
      // Fresh handlers every render, as Workspace passes them.
      onSend={() => {}}
      outgoing={[]}
      onRetry={() => {}}
      onEdit={() => {}}
      onDiscard={() => {}}
      onResend={() => {}}
      onCompact={() => {}}
      onStop={() => {}}
      onAnswer={() => {}}
    />
  );
}

const texts = (c: HTMLElement) =>
  [...c.querySelectorAll('[role="log"] p')].map((p) => p.textContent);

let client: QueryClient;
async function render() {
  rstest
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url = (input as Request).url;
      if (url.endsWith("/api/v1/chat"))
        return Response.json({
          agents: [],
          active_replies: [streaming, elsewhere],
          interactions: [],
          event_cursor: "c",
        });
      // Newest first, as the control plane pages them.
      return Response.json({
        items: [...history].reverse(),
        next_cursor: null,
      });
    });
  const container = document.createElement("div");
  document.body.append(container);
  client = new QueryClient();
  await act(async () => {
    createRoot(container).render(
      <QueryClientProvider client={client}>
        <Chat />
      </QueryClientProvider>,
    );
  });
  // The snapshot, then history.
  for (let i = 0; i < 50 && texts(container).length <= 1; i++) await settle();
  return container;
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function emit(type: string, data: unknown) {
  await act(async () => FakeSource.current!.emit(type, data));
  // Query observers hear of it on the next tick.
  await settle();
}
/** The rows rendered by `action`. */
async function rendered(action: () => Promise<void>) {
  renders.length = 0;
  await action();
  return [...renders];
}

// Run with RENDER_COUNTS=<file> to write the counts out, e.g. to compare
// with the code before this change.
const counts: Record<string, number> = {};
afterEach(() => {
  if (process.env.RENDER_COUNTS)
    writeFileSync(process.env.RENDER_COUNTS, JSON.stringify(counts, null, 2));
});

describe("a streamed update", () => {
  beforeEach(() => {
    n = 0;
    history = [];
    for (let i = 0; i < TURNS; i++) {
      const user = message("user", { text: `问题 ${i}` });
      history.push(
        user,
        message("assistant", { reply_to_id: user.id, text: `回复 ${i}` }),
      );
    }
    const user = message("user", { text: "最后的问题" });
    history.push(user);
    streaming = message("assistant", {
      reply_to_id: user.id,
      status: "responding",
      text: "正在",
    });
    elsewhere = message("assistant", {
      agent_id: OTHER,
      status: "responding",
      text: "别处",
    });
  });
  afterEach(() => {
    document.body.innerHTML = "";
    rstest.restoreAllMocks();
  });

  it("renders only the message it changed", async () => {
    const c = await render();
    expect(texts(c)).toHaveLength(TURNS + 1);

    const once = await rendered(() =>
      emit("message.updated", {
        message: {
          ...streaming,
          revision: 2,
          blocks: [{ id: "s", type: "text", text: "正在写" }],
        },
      }),
    );
    counts.streamedUpdate = once.length;
    expect(once).toEqual(["正在写"]);
    expect(texts(c).at(-1)).toBe("正在写");

    // Revisions may skip: only a later one counts, an earlier one is stale.
    const later = await rendered(async () => {
      await emit("message.updated", {
        message: {
          ...streaming,
          revision: 7,
          blocks: [{ id: "s", type: "text", text: "正在写完" }],
        },
      });
      await emit("message.updated", {
        message: {
          ...streaming,
          revision: 5,
          blocks: [{ id: "s", type: "text", text: "旧的" }],
        },
      });
    });
    expect(later).toEqual(["正在写完"]);
    expect(texts(c).at(-1)).toBe("正在写完");

    const other = await rendered(() =>
      emit("message.updated", {
        message: { ...elsewhere, revision: 2 },
      }),
    );
    counts.otherAgentUpdate = other.length;
    expect(other).toEqual([]);

    const typing = await rendered(async () => {
      await act(async () => draft("你好"));
    });
    counts.typing = typing.length;
    expect(typing).toEqual([]);

    const interaction: Interaction = {
      id: "00000000-0000-0000-0002-000000000001",
      agent_id: AGENT,
      message_id: streaming.id,
      status: "pending",
      kind: "choice",
      prompt: "运行命令？",
      options: [{ label: "允许", value: "accept" }],
      answer: null,
      revision: 1,
      created_at: streaming.created_at,
      updated_at: streaming.created_at,
    };
    const asked = await rendered(() =>
      emit("interaction.updated", { interaction }),
    );
    counts.interaction = asked.length;
    expect(asked).toEqual(["正在写完"]);
    expect(c.textContent).toContain("运行命令？");
  });

  it("keeps order, and every message, once history covers the live ones", async () => {
    const c = await render();
    // A finished reply that history now holds drops out of the live cache,
    // and still shows, in place.
    const done = { ...streaming, status: "completed" as const, revision: 2 };
    await emit("message.updated", { message: done });
    history.push(done);
    await act(() =>
      client.invalidateQueries({ queryKey: ["chat", "messages", AGENT] }),
    );
    await settle();
    const snapshot = client.getQueryData<{ messages: ChatMessage[] }>([
      "chat",
    ])!;
    expect(snapshot.messages.map((m) => m.id)).toEqual([elsewhere.id]);
    expect(texts(c)).toHaveLength(TURNS + 1);
    expect(texts(c).at(-1)).toBe("正在");

    // A message that lands out of order still goes where it was sent.
    const early = message("assistant", {
      text: "补上的",
      created_at: history[1].created_at.replace(".000Z", ".500Z"),
    });
    await emit("message.updated", { message: early });
    expect(texts(c).slice(0, 2)).toEqual(["回复 0", "补上的"]);
  });

  it("never edits the cached snapshot in place", async () => {
    await render();
    const before = client.getQueryData<{ messages: ChatMessage[] }>(["chat"])!;
    const frozen = structuredClone(before.messages);
    Object.freeze(before.messages);
    for (const m of before.messages) Object.freeze(m);
    await emit("message.updated", {
      message: { ...streaming, revision: 2 },
    });
    await emit("message.updated", { message: message("user", { text: "新" }) });
    expect(before.messages).toEqual(frozen);
    const after = client.getQueryData<{ messages: ChatMessage[] }>(["chat"])!;
    expect(after.messages).not.toBe(before.messages);
    // Unchanged messages keep their objects.
    expect(after.messages).toContain(before.messages[1]);
  });
});
