import type { ActivityRef } from "./activity-ref";
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
import { ActivityRefCard } from "./activity-ref";

// A thing a task, a routine, a pull request or an artifact points at links to it from a card; the
// right panel's task, routine and artifact blocks draw them.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const task: ActivityRef = {
  kind: "task",
  id: "t1",
  number: 16,
  title: "整理 Q4 发布说明",
  status: "todo",
};

async function mount(refs: ActivityRef[], { path = "/" } = {}) {
  const ui = () => (
    <div role="log">
      {refs.map((value, index) => (
        <ActivityRefCard key={index} value={value} />
      ))}
    </div>
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

  it("opens the task beside the chat", async () => {
    const { container } = await mount([task]);
    expect(cards(container)).toEqual([
      {
        href: "/?view=tasks&task=t1",
        label: "打开任务 #16 整理 Q4 发布说明",
        text: "#16 整理 Q4 发布说明待办",
      },
    ]);
  });

  it("keeps a real group, and drops the word null", async () => {
    const { container: named } = await mount([task], {
      path: "/?group=g1",
    });
    expect(cards(named)[0].href).toBe("/?group=g1&view=tasks&task=t1");
    // `?group=null` reached this link once, and then every card the panel drew carried the word
    // on: the conversation "null" does not exist, so the URL should simply name none.
    const { container: bogus } = await mount([task], { path: "/?group=null" });
    expect(cards(bogus)[0].href).toBe("/?view=tasks&task=t1");
  });

  it("opens it on its own page", async () => {
    const { container, router } = await mount([task], {
      path: "/tasks",
    });
    expect(cards(container)[0].href).toBe("/tasks?task=t1");
    await act(async () => {
      container.querySelector<HTMLAnchorElement>('[role="log"] a')!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(router.state.location.pathname).toBe("/tasks");
    expect(router.state.location.search).toEqual({ task: "t1" });
  });

  it("links routines and pull requests", async () => {
    const { container } = await mount([
      { kind: "routine", id: "r1", title: "日报" },
      {
        kind: "pull_request",
        number: 7,
        title: "Add cards",
        url: "https://github.com/akarachen/eta/pull/7",
      },
    ]);
    expect(cards(container)).toEqual([
      {
        href: "/routines?routine=r1",
        label: "打开定时 日报",
        text: "日报",
      },
      {
        href: "https://github.com/akarachen/eta/pull/7",
        label: "打开 PR #7 Add cards",
        text: "#7 Add cards · akarachen/eta",
      },
    ]);
  });

  it("offers to file an issue draft on GitHub, as no issue yet", async () => {
    const url =
      "https://github.com/akarachen/eta/issues/new?body=%E5%9D%8F%E4%BA%86&title=%E5%8D%A1%E7%89%87%E9%94%99%E4%BD%8D";
    const { container } = await mount([
      { kind: "issue_draft", title: "卡片错位", url },
    ]);
    expect(cards(container)).toEqual([
      {
        href: url,
        label: "去 GitHub 创建 issue：卡片错位（akarachen/eta）",
        text: "卡片错位 · akarachen/eta去 GitHub 创建",
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
      {
        kind: "issue_draft",
        title: "长",
        body: "很长的正文",
        url: "https://github.com/akarachen/eta/issues/new?title=%E9%95%BF",
      },
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
});
