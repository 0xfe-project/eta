import type { SessionTheme } from "./chat-panel";
import type { ActivityRef } from "@/api/control-plane.gen";
import type { Block, ChatMessage } from "@/queries/chat";
import { afterEach, describe, expect, it } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatPanel } from "./chat-panel";

// A tool call that made or touched one thing links to it from a card under
// its line, in every theme; the line keeps the call's details.

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

const task: ActivityRef = {
  kind: "task",
  id: "t1",
  number: 16,
  title: "整理 Q4 发布说明",
  status: "todo",
};
function activity(fields: Partial<Block> & { status: string }): Block {
  return {
    id: `a-${Math.random()}`,
    type: "activity",
    label: "调用工具",
    name: "tasks.create_task",
    input: '{"title":"整理 Q4 发布说明"}',
    ...fields,
  } as Block;
}
function reply(blocks: Block[]): ChatMessage {
  return {
    id: "00000000-0000-0000-0001-000000000001",
    agent_id: "a",
    role: "assistant",
    reply_to_id: null,
    status: "completed",
    revision: 1,
    blocks,
    failure: null,
    created_at: "2026-10-11T00:00:00Z",
  };
}

async function mount(
  blocks: Block[],
  { path = "/", theme = "claude" as SessionTheme } = {},
) {
  const ui = () => (
    <ChatPanel
      theme={theme}
      agentId="a"
      agentName="助手"
      messages={[reply(blocks)]}
      hasOlder={false}
      loadingOlder={false}
      onLoadOlder={() => {}}
      interactions={[]}
      draft=""
      onDraftChange={() => {}}
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
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <NuqsAdapter>{ui()}</NuqsAdapter>,
    }),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await router.load();
  });
  return { container, router };
}

const cards = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLAnchorElement>('[role="log"] a')].map((a) => ({
    href: a.getAttribute("href"),
    label: a.getAttribute("aria-label"),
    text: a.textContent,
  }));

describe("activity ref cards", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  for (const theme of ["claude", "codex", "grok"] as const) {
    it(`opens the task beside the chat (${theme})`, async () => {
      const { container } = await mount(
        [activity({ status: "completed", ref: task })],
        { theme },
      );
      expect(cards(container)).toEqual([
        {
          href: "/?view=tasks&task=t1",
          label: "打开任务 #16 整理 Q4 发布说明",
          text: "#16 整理 Q4 发布说明待办",
        },
      ]);
      // The call's line is still there to expand, apart from the card.
      expect(container.querySelector("details summary")?.textContent).toContain(
        "tasks.create_task",
      );
    });
  }

  it("opens it on its page in the full-window workspace", async () => {
    const { container, router } = await mount(
      [activity({ status: "completed", ref: task })],
      { path: "/workspace/inbox" },
    );
    expect(cards(container)[0].href).toBe("/workspace/tasks?task=t1");
    await act(async () => {
      container.querySelector<HTMLAnchorElement>('[role="log"] a')!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(router.state.location.pathname).toBe("/workspace/tasks");
    expect(router.state.location.search).toEqual({ task: "t1" });
  });

  it("links routines and pull requests", async () => {
    const { container } = await mount([
      activity({
        status: "completed",
        name: "routines.create_routine",
        ref: { kind: "routine", id: "r1", title: "日报" },
      }),
      activity({
        status: "completed",
        name: "github.open_pull_request",
        ref: {
          kind: "pull_request",
          number: 7,
          title: "Add cards",
          url: "https://github.com/akarachen/axp/pull/7",
        },
      }),
    ]);
    expect(cards(container)).toEqual([
      {
        href: "/?view=routines&routine=r1",
        label: "打开定时 日报",
        text: "日报",
      },
      {
        href: "https://github.com/akarachen/axp/pull/7",
        label: "打开 PR #7 Add cards",
        text: "#7 Add cards · akarachen/axp",
      },
    ]);
  });

  it("offers to file an issue draft on GitHub, as no issue yet", async () => {
    const url =
      "https://github.com/akarachen/axp/issues/new?body=%E5%9D%8F%E4%BA%86&title=%E5%8D%A1%E7%89%87%E9%94%99%E4%BD%8D";
    const { container } = await mount([
      activity({
        status: "completed",
        name: "github.draft_issue",
        ref: { kind: "issue_draft", title: "卡片错位", url },
      }),
    ]);
    expect(cards(container)).toEqual([
      {
        href: url,
        label: "去 GitHub 创建 issue：卡片错位（akarachen/axp）",
        text: "卡片错位 · akarachen/axp去 GitHub 创建",
      },
    ]);
    const link = container.querySelector('[role="log"] a')!;
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.parentElement!.className).toContain("border-dashed");
    // The link carried the body: nothing to copy.
    expect(container.querySelector('[role="log"] button')).toBeNull();
  });

  it("lets a draft too long for its link copy its body", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    const { container } = await mount([
      activity({
        status: "completed",
        name: "github.draft_issue",
        ref: {
          kind: "issue_draft",
          title: "长",
          body: "很长的正文",
          url: "https://github.com/akarachen/axp/issues/new?title=%E9%95%BF",
        },
      }),
    ]);
    const copy = container.querySelector<HTMLButtonElement>(
      '[role="log"] button[aria-label^="正文太长"]',
    )!;
    expect(copy.textContent).toBe("复制正文");
    await act(async () => {
      copy.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(copied).toEqual(["很长的正文"]);
  });

  it("links nothing without a ref, or before the call completes", async () => {
    const { container } = await mount([
      activity({ status: "completed" }), // list results, history, unknown tools
      activity({ status: "running", ref: task }),
      activity({ status: "failed", ref: task }),
    ]);
    expect(cards(container)).toEqual([]);
    expect(container.querySelectorAll("details")).toHaveLength(3);
  });
});
