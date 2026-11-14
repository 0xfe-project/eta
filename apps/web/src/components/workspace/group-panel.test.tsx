import { afterEach, expect, it, rstest } from "@rstest/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { act } from "react";
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
import { cleanup, flush, mount as render } from "@/test-render";
import { GroupPanel } from "./group-panel";
import { useAttention } from "./use-attention";

// The members block is the group manager's own component, and its own tests
// cover it; here only the place its section holds matters.
rstest.mock("./groups", () => ({
  GroupMembers: () => (
    <section aria-label={translate("chat:groups.members.title")} />
  ),
}));

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
  const { container } = await render(<RouterProvider router={router} />);
  await act(async () => router.load());
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

afterEach(async () => {
  // Every tree this file mounted, so one test's panel cannot answer another test's wire.
  await cleanup();
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

it("orders 任务 by the last move made, and leaves none out", async () => {
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
  expect(listed).toEqual([
    "任务1",
    "任务3",
    "任务4",
    "任务5",
    "任务6",
    "任务2",
  ]);
  expect(countOf(container, "任务")).toBe("任务6");
});

it("scrolls 任务 and 产物 in lists of one height, and hands the rest on to the panel", async () => {
  // Layout itself is measured in a real browser; what happy-dom can hold in place is the shape that
  // broke the panel. The pane rule `[class*="overflow-y-auto"]` sets `overscroll-behavior: none`,
  // and any element under it that keeps it stops the wheel and the finger right there, even with
  // nothing to scroll: so a list opts out, and `WorkspacePanel` is the only other scroller.
  surfaceHost({
    conversations: [group],
    tasks: [task(1), task(2)],
    artifacts: [
      artifactView({ id: "v1", title: "看板", conversationId: "g1" }),
    ],
  });
  const container = await mount();
  const lists = ["任务", "产物"].map(
    (section) =>
      container.querySelector(`section[aria-label="${section}"] ul`)!,
  );
  const scrollers = [
    ...container.querySelectorAll('[class*="overflow-y-auto"]'),
  ];
  expect(scrollers).toEqual(lists);
  expect(lists[0].className).toBe(lists[1].className);
  expect(lists[0].className).toContain("max-h-");
  expect(lists[0].classList.contains("overscroll-y-auto")).toBe(true);
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
  // Six still open: the count says six, and the list holds all six.
  expect(listed).toEqual([
    "任务2",
    "任务4",
    "任务5",
    "任务6",
    "任务7",
    "任务8",
  ]);
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

it("Captain 的会话里第一块是运营，不是任务", async () => {
  // Captain's conversation is a conversation, so this is its panel — but "which tasks is Captain
  // working on" is a question about the agents it assigns them to. What it holds for a person
  // instead is 运营: an approval it cannot give itself, an alert, what it handed out.
  const host = surfaceHost({
    conversations: [group, other],
    tasks: [task(1)],
  });
  host.target("captain", {
    identity: {
      agentId: "cap",
      name: "Captain",
      home: "/agents/cap",
      model: null,
      conversationId: "g1",
      createdAt: 1,
    },
    operations: [
      {
        id: "o1",
        kind: "task.create",
        actorAgentId: "cap",
        requiresApproval: true,
        status: "pending",
        payload: {},
        result: null,
        error: null,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "o2",
        kind: "task.close",
        actorAgentId: "cap",
        requiresApproval: true,
        status: "approved",
        payload: {},
        result: {},
        error: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    // A host from before Captain stopped raising alerts still sends them; none is drawn.
    notifications: [
      {
        id: "n1",
        kind: "stuck",
        body: "任务 9 卡住了",
        data: {},
        readAt: null,
        createdAt: 1,
      },
    ],
    assignments: [
      {
        id: "a1",
        conversationId: "g1",
        messageId: "m1",
        rootMessageId: null,
        captainAgentId: "cap",
        round: 2,
        status: "running",
        targets: [
          {
            id: "at1",
            agentId: "agenttwo",
            replyId: null,
            status: "running",
            taskCount: 3,
          },
        ],
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    memoryPauses: [],
    settings: {},
  });
  const container = await mount();
  await flush();
  expect(sections(container)).toEqual([
    "Captain 模型",
    "待审批操作",
    "最近派工",
    "产物",
    "成员",
  ]);
  // Only the undecided one is listed, and it can be decided here — this is the only place in the
  // window that can: the drawer that used to hold it is gone.
  expect(rowsOf(container, "待审批操作")).toHaveLength(1);
  expect(container.textContent).toContain("task.create");
  expect(container.textContent).toContain("批准");
  expect(container.textContent).toContain("拒绝");
  expect(container.textContent).not.toContain("任务 9 卡住了");
  expect(container.textContent).not.toContain("运营告警");
  expect(container.textContent).toContain("第 2 轮");
  // The tasks of that conversation are elsewhere (the 任务 page), not lost here by accident.
  expect(container.textContent).not.toContain("任务1");
  // Its model is chosen here: Captain is not edited like the other agents.
  expect(container.querySelector("#captain-model")).not.toBeNull();
});
