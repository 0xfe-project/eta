import type { BoardTaskDetail } from "@eta/client-contracts";
import type { InteractionView } from "@/queries/inbox";
import type { SurfaceSeed } from "@/test-inbox";
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
import { setWire } from "@/lib/wire";
import { interactionView, surfaceHost } from "@/test-inbox";
import {
  agentView,
  conversationView,
  routineInfo,
  routineSections,
  taskDetail,
} from "@/test-product";
import { PendingList } from "./attention";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await router.load();
  });
  return container;
}

const headings = (container: HTMLElement) =>
  [...container.querySelectorAll("h2, h3")].map((h) => h.textContent);

describe("what waits for the user", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    setWire(undefined);
  });

  it("lists tasks and routines that need them, and nothing else", async () => {
    surfaceHost({
      tasks: [
        task(1, { status: "in_progress" }),
        task(2, { status: "in_review" }),
        task(3, { status: "blocked" }),
        task(4),
        task(5, { status: "done" }),
      ],
      routines: [routine("a", 2, 0), routine("b", 0, 1), routine("c", 0, 0)],
    });
    const container = await mount(new QueryClient(), () => <PendingList />);
    const rows = [...container.querySelectorAll("li")].map(
      (li) => li.textContent,
    );
    expect(rows).toEqual([
      "#2 任务2待验收",
      "#3 任务3受阻",
      "定时a2 份新报告",
      "定时b1 次失败",
    ]);
  });

  it("groups confirmations, tasks and routines, and says which failed to load", async () => {
    // The host has no routines plugin, so the routines never load.
    waiting(
      "i1",
      {},
      { tasks: [task(1, { status: "in_review" })], absent: ["routines"] },
    );
    const container = await mount(new QueryClient(), () => <PendingList />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(headings(container)).toEqual(["确认请求1", "任务1"]);
    expect(container.textContent).toContain("无法加载定时");
    expect(container.querySelector("li")!.textContent).toContain(
      "删除i1？允许拒绝放弃",
    );
  });
});
