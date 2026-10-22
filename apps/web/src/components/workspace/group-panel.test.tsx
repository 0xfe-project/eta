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

const linksOf = (container: HTMLElement, section: string) =>
  [...container.querySelectorAll(`section[aria-label="${section}"] a`)].map(
    (link) => link.getAttribute("href"),
  );

const countOf = (container: HTMLElement, section: string) =>
  container.querySelector(`section[aria-label="${section}"] h3`)!.textContent;

afterEach(() => {
  document.body.innerHTML = "";
  setWire(undefined);
});

it("puts what waits for the user above everything else", async () => {
  // The goal and the members used to be the first screen, and the two tasks
  // waiting for the user and the failed routine run were below the fold.
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
  expect(sections(container)).toEqual([
    "等你",
    "任务",
    "产物",
    "定时",
    "成员",
    "目标",
  ]);
  // What waits, saying why in the 待处理 tab's own words; the confirmation is
  // not drawn again, only the way to the tab that holds it.
  expect(rowsOf(container, "等你")).toEqual([
    "#1 任务1待验收",
    "日报1 次失败",
    "确认请求1去待处理",
  ]);
  expect(linksOf(container, "等你")).toEqual([
    "/?group=g1&view=tasks&task=t1",
    "/routines?routine=r1",
    "/?group=g1&view=inbox",
  ]);
  // The count is the badge's number, from the same hook: the other group's
  // blocked task counts toward it too, while the rows listed stay this group's.
  expect(countOf(container, "等你")).toBe("等你4");
  expect(container.querySelector("[data-badge]")!.textContent).toBe("4");
  // The background is still here, at the bottom.
  expect(container.textContent).toContain("本周上线");
});

it("does not spend a heading on an empty「等你」", async () => {
  const host = surfaceHost({
    conversations: [group],
    tasks: [task(1, { status: "in_progress" }), task(2)],
    routines: [
      routineSections(
        routineInfo({ id: "r1", name: "日报", conversationId: "g1" }),
      ),
    ],
  });
  host.target(
    "conversations.g1",
    conversationSections(group, [], { goal: "本周上线" }),
  );
  const container = await mount();
  expect(sections(container)).toEqual(["任务", "产物", "定时", "成员", "目标"]);
  expect(container.textContent).not.toContain("等你");
});

it("leads 任务 with what waits, then the last move made, and shows five", async () => {
  // The blocked one is the user's to unblock, so it leads its own section even
  // though it was not the last thing touched.
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
  expect(listed).toEqual(["任务4", "任务2", "任务1", "任务3", "任务5"]);
});
