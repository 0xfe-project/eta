import { afterEach, expect, it, rstest } from "@rstest/core";
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
import { translate } from "@/lib/i18n";
import { setWire } from "@/lib/wire";
import { interactionView, surfaceHost } from "@/test-inbox";
import {
  artifactView,
  conversationSections,
  conversationView,
  routineInfo,
  routineSections,
  taskDetail,
} from "@/test-product";
import { GroupPanel } from "./group-panel";
import { useAttention } from "./use-attention";

// The members block is the group manager's own component, and its own tests
// cover it; here only the place its section holds matters.
rstest.mock("./groups", () => ({
  GroupMembers: () => (
    <section aria-label={translate("chat:groups.members.title")} />
  ),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const group = conversationView({ id: "g1", name: "装配" });
const other = conversationView({ id: "g2", name: "另一个群" });

const task = (
  number: number,
  fields: Partial<Parameters<typeof taskDetail>[0]> = {},
) => ({
  task: taskDetail({
    id: `t${number}`,
    number,
    title: `任务${number}`,
    conversationId: "g1",
    ...fields,
  }),
});

/** The panel, and the number the 待处理 tab's badge would show beside it. */
function Panel() {
  return (
    <>
      <GroupPanel group={group} />
      <em data-badge={true}>{useAttention().total}</em>
    </>
  );
}

async function mount(path = "/?group=g1") {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <NuqsAdapter>
          <Panel />
        </NuqsAdapter>
      ),
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
  return container;
}

const sections = (container: HTMLElement) =>
  [...container.querySelectorAll("section[aria-label]")].map((section) =>
    section.getAttribute("aria-label"),
  );

const rowsOf = (container: HTMLElement, section: string) =>
  [...container.querySelectorAll(`section[aria-label="${section}"] li`)].map(
    (row) => row.textContent ?? "",
  );

const countOf = (container: HTMLElement, section: string) =>
  container.querySelector(`section[aria-label="${section}"] h3`)!.textContent;

afterEach(() => {
  document.body.innerHTML = "";
  setWire(undefined);
});

it("leaves what waits to the 待处理 tab, even when something does", async () => {
  // A blocked task, one in review, a failed routine run and a confirmation, all
  // of this group's: none of them gets a section here, and the badge that sends
  // the user to them still counts them.
  const host = surfaceHost({
    conversations: [group, other],
    tasks: [
      task(1, { status: "in_review" }),
      task(2, { status: "todo" }),
      {
        task: taskDetail({
          id: "t9",
          number: 9,
          title: "别的群的事",
          conversationId: "g2",
          status: "blocked",
        }),
      },
    ],
    artifacts: [
      artifactView({ id: "v1", title: "看板", conversationId: "g1" }),
    ],
    routines: [
      routineSections(
        routineInfo({
          id: "r1",
          name: "日报",
          conversationId: "g1",
          unseenFailures: 1,
        }),
      ),
    ],
    interactions: [interactionView({ id: "i1", conversationId: "g1" })],
  });
  host.target(
    "conversations.g1",
    conversationSections(group, [], { goal: "本周上线" }),
  );
  const container = await mount();
  expect(sections(container)).toEqual(["任务", "产物", "成员", "目标"]);
  expect(container.textContent).not.toContain("等你");
  expect(container.textContent).not.toContain("去待处理");
  expect(container.querySelector("[data-badge]")!.textContent).toBe("3");
  // The background is still here, at the bottom.
  expect(container.textContent).toContain("本周上线");
});

it("orders 任务 by the last move made, and shows five", async () => {
  // A task waiting for the user does not jump the queue: that is the 待处理
  // tab's job.
  surfaceHost({
    conversations: [group],
    tasks: [
      task(1, { updatedAt: 600 }),
      task(2, { status: "in_review", updatedAt: 100 }),
      task(3, { updatedAt: 500 }),
      task(4, { status: "blocked", updatedAt: 400 }),
      task(5, { updatedAt: 300 }),
      task(6, { updatedAt: 200 }),
    ],
  });
  const container = await mount();
  const listed = rowsOf(container, "任务").map(
    (row) => row.match(/任务\d/)?.[0],
  );
  expect(listed).toEqual(["任务1", "任务3", "任务4", "任务5", "任务6"]);
});

it("draws its cards as flat rows: the list rules them, not a frame each", async () => {
  surfaceHost({
    conversations: [group],
    tasks: [task(1), task(2)],
    artifacts: [
      artifactView({ id: "v1", title: "看板", conversationId: "g1" }),
    ],
  });
  const container = await mount();
  const rows = ["任务", "产物"].flatMap((section) => [
    ...container.querySelectorAll(`section[aria-label="${section}"] li > *`),
  ]);
  expect(rows).toHaveLength(3);
  for (const card of rows)
    expect(card.classList.contains("border")).toBe(false);
});

it("leaves closed tasks out of 任务, and out of its count", async () => {
  surfaceHost({
    conversations: [group],
    tasks: [
      task(1, { status: "done", updatedAt: 900 }),
      task(2, { status: "in_progress", updatedAt: 800 }),
      task(3, { status: "cancelled", updatedAt: 700 }),
      task(4, { status: "backlog", updatedAt: 600 }),
      task(5, { updatedAt: 500 }),
      task(6, { status: "in_review", updatedAt: 400 }),
      task(7, { status: "blocked", updatedAt: 300 }),
      task(8, { updatedAt: 200 }),
    ],
  });
  const container = await mount();
  const listed = rowsOf(container, "任务").map(
    (row) => row.match(/任务\d/)?.[0],
  );
  // Six still open: the count says six, the list shows the first five.
  expect(listed).toEqual(["任务2", "任务4", "任务5", "任务6", "任务7"]);
  expect(countOf(container, "任务")).toBe("任务6");
});

it("does not say 还没有任务 when every task here is closed", async () => {
  surfaceHost({
    conversations: [group],
    tasks: [task(1, { status: "done" }), task(2, { status: "cancelled" })],
  });
  const container = await mount();
  expect(rowsOf(container, "任务")).toEqual([]);
  expect(countOf(container, "任务")).toBe("任务0");
  const section = container.querySelector('section[aria-label="任务"]')!;
  expect(section.textContent).toContain(translate("tasks:empty.noOpen"));
  expect(section.textContent).not.toContain(translate("tasks:empty.title"));
});
