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

// A thing a task, a routine or an artifact points at links to it from a card; the right panel's
// task, routine and artifact blocks draw them.

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

async function mount(
  refs: ActivityRef[],
  { path = "/", variant }: { path?: string; variant?: "flat" | "framed" } = {},
) {
  const ui = () => (
    <div role="log">
      {refs.map((value, index) => (
        <ActivityRefCard
          key={index}
          value={value}
          {...(variant ? { variant } : {})}
        />
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

const hasBorder = (el: Element) => el.classList.contains("border");

/** The element that carries the frame, in each of the card's two shapes. */
const frames = (c: HTMLElement) => {
  const log = c.querySelector('[role="log"]')!;
  return [...log.children];
};

// The two shapes the card is drawn in: an artifact (a button inside a frame), and a task (a router
// link that is its own frame).
const shapes: ActivityRef[] = [
  { kind: "artifact", id: "a1", title: "看板", number: 2 },
  task,
];

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
    // A flat row: no outline and no resting fill of its own; the list rules between rows.
    const card = container.querySelector('[role="log"] a')!;
    expect(card.className).not.toMatch(/(^|\s)(border|bg-)/);
  });

  it("draws no line of its own by default, in any shape", async () => {
    const { container: unset } = await mount(shapes);
    const { container: flat } = await mount(shapes, { variant: "flat" });
    for (const container of [unset, flat]) {
      const drawn = frames(container);
      expect(drawn).toHaveLength(2);
      for (const frame of drawn) expect(hasBorder(frame)).toBe(false);
    }
    // `flat` is the default, spelled out: the same classes, not a look of its own.
    expect(frames(flat).map((frame) => frame.className)).toEqual(
      frames(unset).map((frame) => frame.className),
    );
  });

  it("draws a 1px line round a framed card, in every shape", async () => {
    const { container } = await mount(shapes, { variant: "framed" });
    const drawn = frames(container);
    expect(drawn).toHaveLength(2);
    for (const frame of drawn) {
      expect(hasBorder(frame)).toBe(true);
      expect(frame.classList.contains("border-border")).toBe(true);
      // The line, and nothing else: a card here is still square, and has no fill of its own.
      expect(frame.className).not.toMatch(/(^|\s)(bg-|shadow|rounded|max-w)/);
    }
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

  it("draws nothing for a routine", async () => {
    const { container } = await mount([
      { kind: "routine", id: "r1", title: "日报" },
    ]);
    // 定时 is off in this build: its card would be a dead link, so it draws nothing.
    expect(frames(container)).toEqual([]);
  });
});
