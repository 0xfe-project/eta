import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient } from "@tanstack/react-query";
import { Markdown } from "@/components/markdown";
import { setWire } from "@/lib/wire";
import {
  agentView,
  conversationView,
  memberView,
  messageView,
  productHost,
} from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { GroupNotice } from "./group-notice";
import { PendingStrip } from "./pending-strip";

rstest.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
  useRouterState: (options?: { select?: (state: unknown) => unknown }) =>
    options?.select
      ? options.select({ location: { pathname: "/" } })
      : { location: { pathname: "/" } },
  useRouter: () => ({ navigate: () => undefined }),
  useNavigate: () => () => undefined,
  useLocation: (options?: { select?: (location: unknown) => unknown }) =>
    options?.select ? options.select({ pathname: "/" }) : { pathname: "/" },
}));

// The notice reads the open group through nuqs; this file is about React's key warnings.
rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: [], current: undefined }),
  useOpenGroup: () => () => undefined,
}));

async function render(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  productHost({
    agents: [agentView({ id: "a1", name: "乐子人" })],
    conversations: [],
  });
  return (await mount(node, client)).container;
}

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

/** Every failure React reports goes through here; the one we chase says "unique key". */
async function warningsFrom(node: React.ReactNode): Promise<string[]> {
  const found: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const text = args.map(String).join(" | ");
    if (text.includes('unique "key"')) found.push(text.slice(0, 160));
  };
  try {
    await render(node);
  } finally {
    console.error = original;
  }
  return found;
}

describe("列表的 key", () => {
  it("系统消息一行一个，没有 key 就会在这里被抓到", async () => {
    const message = messageView({
      conversationId: "g1",
      kind: "system",
      author: "system",
      text: "x",
    });
    expect(await warningsFrom(<GroupNotice message={message} />)).toEqual([]);
  });

  it("待处理条里多条也都有 key", async () => {
    const question = (id: string) => ({
      id,
      conversationId: "g1",
      agentId: "a1",
      prompt: "p",
      options: ["允许"],
      multi: false,
    });
    expect(
      await warningsFrom(
        <PendingStrip
          questions={[question("i1"), question("i2")]}
          agents={[{ id: "a1", name: "A" }]}
          onChoose={() => {}}
        />,
      ),
    ).toEqual([]);
  });
});

describe("chat 页里成排出现的东西", () => {
  it("一页里的多条消息、每条里的多个块", async () => {
    const { ChatPanel } = await import("./chat-panel");
    const message = (author: "user" | "agent", seq: number) =>
      messageView({
        id: `m${seq}`,
        conversationId: "g1",
        seq,
        author,
        agentId: author === "agent" ? "a1" : null,
        text: author === "agent" ? "好" : "看这个",
        thinking: author === "agent" ? "先看看" : "",
      });
    expect(
      await warningsFrom(
        <ChatPanel
          groupId="g1"
          groupName="装配"
          held={[]}
          group={conversationView({
            id: "g1",
            name: "装配",
            participants: [memberView("a1")],
          })}
          agents={[agentView({ id: "a1", name: "乐子人" })]}
          messages={[
            message("user", 1),
            message("agent", 2),
            message("user", 3),
          ]}
          loading={false}
          hasOlder={false}
          loadingOlder={false}
          onLoadOlder={() => {}}
          questions={[]}
          draft={[]}
          onDraftChange={() => {}}
          onSend={() => {}}
          onCompact={() => {}}
          onStop={() => {}}
          onStopAll={() => {}}
          onChoose={() => {}}
          onAbort={() => {}}
          onGoal={async () => undefined}
          outgoing={[]}
          onRetry={() => {}}
          onEdit={() => {}}
          onDiscard={() => {}}
          onResend={() => {}}
        />,
      ),
    ).toEqual([]);
  });
});

describe("页面上常驻的浮层", () => {
  it("设置对话框打开时不抱怨 key", async () => {
    const { SettingsDialog } = await import("./settings-dialog");
    const { useWorkspaceStore } = await import("./workspace-store");
    useWorkspaceStore.getState().setSettings({ open: true, section: "agents" });
    expect(await warningsFrom(<SettingsDialog />)).toEqual([]);
    useWorkspaceStore
      .getState()
      .setSettings({ open: false, section: "agents" });
  });

  it("智能体编辑器打开时不抱怨 key", async () => {
    const { AgentEditor } = await import("./agent-editor");
    const { useWorkspaceStore } = await import("./workspace-store");
    useWorkspaceStore.getState().setAgentEditor({ open: true, agentId: null });
    expect(await warningsFrom(<AgentEditor />)).toEqual([]);
    useWorkspaceStore.getState().setAgentEditor({ open: false, agentId: null });
  });

  it("手机底部栏三项各有 key", async () => {
    // The bottom bar links through the router; this file is about React's key warnings, so the
    // router is replaced the way the other component tests replace it.
    const { BottomNav } = await import("./app-shell");
    expect(await warningsFrom(<BottomNav />)).toEqual([]);
  });
});

describe("markdown 的结构元素（表格、列表、代码块、流式半截语法）", () => {
  it("流式写入时的表格（半截的语法）", async () => {
    const found: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      const text = args.map(String).join(" | ");
      if (text.includes('unique "key"')) found.push(text.slice(0, 240));
      else original(...args);
    };
    // What streaming actually looks like: growing text, re-rendered per chunk.
    const full = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";
    const { show } = await mount(
      <Markdown streaming>{full.slice(0, 1)}</Markdown>,
    );
    for (let end = 8; end <= full.length; end += 7)
      await show(<Markdown streaming>{full.slice(0, end)}</Markdown>);
    await flush(30);
    console.error = original;
    expect(found).toEqual([]);
  });

  it("表格", async () => {
    const found = await warningsFrom(
      "| 共享渠道 | 实际状态 |\n| --- | --- |\n| a | b |\n| c | d |\n",
    );
    expect(found).toEqual([]);
  });

  it("多行列表和嵌套", async () => {
    expect(await warningsFrom("- a\n- b\n  - c\n  - d\n- e\n")).toEqual([]);
  });

  it("有序列表 + 代码块 + 引用", async () => {
    expect(
      await warningsFrom("1. a\n2. b\n\n```ts\nconst x = 1;\n```\n\n> 引用\n"),
    ).toEqual([]);
  });
});
