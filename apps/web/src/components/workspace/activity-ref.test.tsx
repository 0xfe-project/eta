import type { ActivityOperation, ActivityRef } from "@/api/control-plane.gen";
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
// its Claude line; the line keeps the call's details.

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
    group_id: "g",
    seq: 1,
    kind: "message",
    data: {},
    role: "assistant",
    reply_to_id: null,
    status: "completed",
    revision: 1,
    blocks,
    failure: null,
    created_at: "2026-10-11T00:00:00Z",
  };
}

async function mount(blocks: Block[], { path = "/" } = {}) {
  const ui = () => (
    <ChatPanel
      agents={[]}
      groups={[]}
      activeReplies={[]}
      groupId="a"
      groupName="助手"
      messages={[reply(blocks)]}
      hasOlder={false}
      loadingOlder={false}
      onLoadOlder={() => {}}
      interactions={[]}
      draft={[]}
      onFiles={() => []}
      onDraftChange={() => {}}
      onSend={() => {}}
      outgoing={[]}
      onRetry={() => {}}
      onEdit={() => {}}
      onDiscard={() => {}}
      onResend={() => {}}
      onCompact={() => {}}
      onStopAll={() => {}}
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

  it(`opens the task beside the chat (Claude)`, async () => {
    const { container } = await mount(
      [activity({ status: "completed", ref: task })],
      {},
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

  it("opens an artifact's version in a sandboxed dialog", async () => {
    const id = "0b7e2b1c-58f8-4a3c-9d3c-1f0e2a9b6c11";
    const preview = (n: number) => `/preview/artifacts/v${n}.1.sig/files/`;
    const asked: string[] = [];
    g.fetch = async (input: RequestInfo | URL) => {
      asked.push(input instanceof Request ? input.url : String(input));
      return Response.json({
        id,
        title: "季度报告",
        versions: [2, 1].map((n) => ({
          number: n,
          files: 3,
          bytes: 10,
          size: 10,
          created_at: "2026-10-13T00:00:00Z",
          preview_url: preview(n),
        })),
      });
    };
    const { container } = await mount([
      activity({
        status: "completed",
        name: "artifacts.publish_artifact",
        ref: { kind: "artifact", id, number: 1, title: "季度报告" },
      }),
    ]);
    const card = container.querySelector<HTMLButtonElement>(
      '[role="log"] button[aria-label^="打开 Artifact"]',
    )!;
    expect(card.getAttribute("aria-label")).toBe(
      "打开 Artifact 季度报告 第 1 版",
    );
    await act(async () => {
      card.click();
      for (let i = 0; i < 50 && !document.querySelector("iframe"); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(asked.some((u) => u.endsWith(`/api/v1/artifacts/${id}`))).toBe(true);
    // The version the tool published, not the latest; scripts but no origin.
    const frame = document.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe(preview(1));
    expect(frame.getAttribute("sandbox")).toContain("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    const download = [...document.querySelectorAll("a")].find(
      (a) => a.textContent === "下载",
    );
    expect(download?.getAttribute("href")).toBe(
      `/api/v1/artifacts/${id}/versions/1/archive`,
    );
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

// An agenvo script's workspaces and worktrees, read from the native calls
// it made: one card each, telling done from accepted, refused and unknown.
const worktree: ActivityOperation = {
  action: "create_worktree",
  status: "completed",
  runtime: "paseo",
  computer: "办公室 Mac",
  id: "wks_1",
  name: "修复登录",
  project: "axp",
  path: "/home/u/.paseo/worktrees/axp/feat-x",
  branch: "feat/x",
  base: "main",
};
const execute = (fields: {
  status: string;
  operations?: ActivityOperation[];
}) =>
  activity({
    name: "agenvo.execute",
    input: '{"code":"return await call(…)"}',
    ...fields,
  } as Partial<Block> & { status: string });
const operationCards = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLButtonElement>('[role="log"] li > button')].map(
    (b) => b.getAttribute("aria-label"),
  );

describe("activity operation cards", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it(`shows what a script made, where (Claude)`, async () => {
    const { container } = await mount(
      [execute({ status: "completed", operations: [worktree] })],
      {},
    );
    expect(operationCards(container)).toEqual([
      "创建 worktree：修复登录，已创建（办公室 Mac · Paseo）",
    ]);
    const card = container.querySelector('[role="log"] li > button')!;
    expect(card.textContent).toBe(
      "创建 worktree 修复登录已创建办公室 Mac · Paseo · axp · feat/x ← main/home/u/.paseo/worktrees/axp/feat-x",
    );
    // It links nowhere, and the script's line still expands on its own.
    expect(container.querySelector('[role="log"] a')).toBeNull();
    expect(container.querySelector("details summary")?.textContent).toContain(
      "agenvo.execute",
    );
  });

  it("tells each call of a script apart, a failed one's too", async () => {
    const { container } = await mount([
      execute({
        status: "failed",
        operations: [
          worktree,
          {
            action: "add_project",
            status: "unknown",
            runtime: "paseo",
            computer: "办公室 Mac",
            path: "/home/u/new",
            error: "native_error: Paseo creation failed: timed out",
          },
          {
            action: "create_workspace",
            status: "accepted",
            runtime: "paseo",
            path: "/home/u/p",
          },
          {
            action: "create_worktree",
            status: "failed",
            runtime: "herdr",
            computer: "办公室 Mac",
            branch: "feat/x",
            error: "worktree_create_failed: fatal: already exists",
          },
          {
            action: "open_worktree",
            status: "completed",
            runtime: "herdr",
            name: "repo",
          },
        ],
      }),
    ]);
    expect(operationCards(container)).toEqual([
      "创建 worktree：修复登录，已创建（办公室 Mac · Paseo）",
      "添加项目：/home/u/new，结果未确认（办公室 Mac · Paseo）",
      "创建工作区：/home/u/p，已受理，未确认完成（Paseo）",
      "创建 worktree，失败（办公室 Mac · Herdr）",
      "打开 worktree：repo，已打开（Herdr）",
    ]);
    const failed = container.querySelectorAll('[role="log"] li > button')[3];
    expect(failed.textContent).toContain("worktree_create_failed");
    expect(failed.className).toContain("border-dashed");
  });

  it("unfolds a card to show every field whole", async () => {
    const { container } = await mount([
      execute({ status: "completed", operations: [worktree] }),
    ]);
    const card = container.querySelector<HTMLButtonElement>(
      '[role="log"] li > button',
    )!;
    expect(card.getAttribute("aria-expanded")).toBe("false");
    expect(card.textContent).not.toContain("wks_1");
    await act(async () => card.click());
    expect(card.getAttribute("aria-expanded")).toBe("true");
    expect(card.textContent).toContain("ID wks_1");
    expect(card.querySelector(".truncate")).toBeNull();
  });

  it("shows nothing for older history, other calls, or while running", async () => {
    const { container } = await mount([
      execute({ status: "completed" }),
      execute({ status: "running", operations: [worktree] }),
      execute({ status: "completed", operations: [] }),
    ]);
    expect(operationCards(container)).toEqual([]);
    expect(container.querySelectorAll("details")).toHaveLength(3);
  });
});
