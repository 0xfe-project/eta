import type { BoardTaskDetail } from "@eta/client-contracts";
import type { InteractionView } from "@/queries/inbox";
import type { SurfaceSeed } from "@/test-inbox";
import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { setWire } from "@/lib/wire";
import { interactionView, surfaceHost } from "@/test-inbox";
import {
  agentView,
  conversationView,
  routineInfo,
  routineSections,
  taskDetail,
} from "@/test-product";
import { cleanup, flush, mount as render } from "@/test-render";
import { PendingList } from "./attention";

const task = (number: number, fields: Partial<BoardTaskDetail> = {}) => ({
  task: taskDetail({
    id: `t${number}`,
    number,
    title: `任务${number}`,
    ...fields,
  }),
});
const routine = (id: string, reports: number, failures: number) =>
  routineSections(
    routineInfo({
      id,
      name: `定时${id}`,
      unseenReports: reports,
      unseenFailures: failures,
    }),
  );

/** A pending question in a group, and the host that holds it. */
function waiting(
  id: string,
  extra: Partial<InteractionView> = {},
  seed: SurfaceSeed = {},
) {
  return surfaceHost({
    ...seed,
    agents: [agentView({ id: "a1", name: "研究员" })],
    conversations: [conversationView({ id: "g1", name: "群聊" })],
    interactions: [
      interactionView({
        id,
        prompt: `tasks 请求确认\n删除${id}？`,
        ...extra,
      }),
    ],
  });
}

async function mount(
  client: QueryClient,
  ui: () => React.ReactNode,
  path = "/",
) {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <NuqsAdapter>{ui()}</NuqsAdapter>,
    }),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const { container } = await render(
    <RouterProvider router={router} />,
    client,
  );
  await act(async () => router.load());
  return container;
}

const headings = (container: HTMLElement) =>
  [...container.querySelectorAll("h2, h3")].map((h) => h.textContent);

describe("what waits for the user", () => {
  afterEach(async () => {
    await cleanup();
    setWire(undefined);
  });

  it("lists the tasks that need them, and nothing else", async () => {
    surfaceHost({
      tasks: [
        task(1, { status: "in_progress" }),
        task(2, { status: "in_review" }),
        task(3, { status: "blocked" }),
        task(4),
        task(5, { status: "done" }),
      ],
      // A routine waits with reports or failures the user has not seen; one with neither does not.
      routines: [routine("a", 2, 0), routine("b", 0, 1), routine("c", 0, 0)],
    });
    const container = await mount(new QueryClient(), () => <PendingList />);
    const rows = [...container.querySelectorAll("li")].map(
      (li) => li.textContent,
    );
    expect(rows.slice(0, 2)).toEqual(["#2 任务2待验收", "#3 任务3受阻"]);
    expect(rows).toHaveLength(4);
    expect(rows[2]).toContain("定时a");
    expect(rows[3]).toContain("定时b");
  });

  it("groups confirmations and tasks, and says which failed to load", async () => {
    // The host has no routines plugin: the reader is told the routines could not be loaded.
    waiting(
      "i1",
      {},
      { tasks: [task(1, { status: "in_review" })], absent: ["routines"] },
    );
    const container = await mount(new QueryClient(), () => <PendingList />);
    await flush(10);
    expect(headings(container)).toEqual(["确认请求1", "任务1"]);
    expect(container.textContent).toContain("无法加载定时");
    expect(container.querySelector("li")!.textContent).toContain(
      "删除i1？允许拒绝放弃",
    );
  });
});
