import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Markdown } from "@/components/markdown";
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
rstest.mock("@/queries/groups", () => ({
  useGroupActions: () => ({ member: { mutate: () => {}, isPending: false } }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];
async function render(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(["chat"], { groups: [], agents: [], interactions: [] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>{node}</QueryClientProvider>,
    ),
  );
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  return container;
}

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
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
    const message = {
      id: "m1",
      kind: "system",
      data: {},
      blocks: [],
      created_at: "2026-10-17T00:00:00Z",
    };
    expect(
      await warningsFrom(<GroupNotice message={message as never} />),
    ).toEqual([]);
  });

  it("待处理条里多条也都有 key", async () => {
    const interaction = (id: string) => ({
      id,
      agent_id: "a1",
      group_id: "g1",
      message_id: "m1",
      kind: "choice" as const,
      prompt: "p",
      options: [{ value: "allow", label: "允许" }],
      status: "pending",
      revision: 1,
      created_at: "2026-10-17T00:00:00Z",
      updated_at: "2026-10-17T00:00:00Z",
    });
    expect(
      await warningsFrom(
        <PendingStrip
          interactions={[interaction("i1"), interaction("i2")]}
          agents={[{ id: "a1", name: "A" }]}
          onAnswer={() => {}}
        />,
      ),
    ).toEqual([]);
  });
});

describe("chat 页里成排出现的东西", () => {
  it("一页里的多条消息、每条里的多个块、以及附件块", async () => {
    const { ChatPanel } = await import("./chat-panel");
    const message = (id: string, role: "user" | "assistant", seq: number) => ({
      id,
      group_id: "g1",
      seq,
      kind: "message",
      data: {},
      agent_id: role === "user" ? null : "a1",
      role,
      reply_to_id: null,
      status: "done",
      revision: 1,
      blocks:
        role === "user"
          ? [
              { id: `${id}-t`, type: "text", text: "看这个" },
              {
                id: `${id}-a`,
                type: "attachment",
                attachment: {
                  id: "f1",
                  name: "a.txt",
                  content_type: "text/plain",
                  size: 3,
                },
              },
            ]
          : [
              { id: `${id}-th`, type: "thinking", text: "先看看", chars: 3 },
              { id: `${id}-t`, type: "text", text: "好" },
              {
                id: `${id}-k`,
                type: "activity",
                name: "bash",
                status: "completed",
                input: { command: "ls" },
                output: "a.txt",
              },
            ],
      failure: null,
      created_at: "2026-10-17T00:00:00Z",
    });
    expect(
      await warningsFrom(
        <ChatPanel
          groupId="g1"
          groupName="装配"
          group={
            {
              id: "g1",
              name: "装配",
              kind: "group",
              participants: [
                {
                  agent_id: "a1",
                  name: "乐子人",
                  member: true,
                  status: "idle",
                },
              ],
            } as never
          }
          agents={[{ id: "a1", name: "乐子人" } as never]}
          groups={[]}
          activeReplies={[]}
          messages={
            [
              message("m1", "user", 1),
              message("m2", "assistant", 2),
              message("m3", "user", 3),
            ] as never
          }
          loading={false}
          hasOlder={false}
          loadingOlder={false}
          onLoadOlder={() => {}}
          interactions={[]}
          draft={[]}
          onDraftChange={() => {}}
          onFiles={() => []}
          onSend={() => {}}
          onCompact={() => {}}
          onStop={() => {}}
          onStopAll={() => {}}
          onAnswer={() => {}}
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
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    // What streaming actually looks like: growing text, re-rendered per chunk.
    const full = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";
    for (let end = 1; end <= full.length; end += 7) {
      await act(async () =>
        root.render(<Markdown streaming>{full.slice(0, end)}</Markdown>),
      );
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    console.error = original;
    cleanup.push(() => {
      root.unmount();
      container.remove();
    });
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
