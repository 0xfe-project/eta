import type { InteractionView } from "@/queries/inbox";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
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
import { agentView, conversationView } from "@/test-product";
import { PendingList } from "./attention";
import { Notifications } from "./notifications";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const task = (number: number, fields: object) => ({
  id: `t${number}`,
  number,
  title: `任务${number}`,
  status: "todo",
  assignee: { kind: "remote" },
  comments: 0,
  run_status: null,
  updated_at: "2026-10-09T09:00:00Z",
  ...fields,
});
const routine = (id: string, reports: number, failures: number) => ({
  id,
  name: `定时${id}`,
  model: "m",
  schedule: { kind: "daily", time: "08:00" },
  timezone: "UTC",
  enabled: true,
  next_run_at: null,
  runs: [],
  assists: [],
  loops: [],
  revising: false,
  unseen_reports: reports,
  unseen_failures: failures,
});

/** A pending question in a group, and the host that holds it. */
function waiting(id: string, extra: Partial<InteractionView> = {}) {
  return surfaceHost({
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
    rstest.restoreAllMocks();
    setWire(undefined);
  });

  it("lists tasks and routines that need them, and nothing else", async () => {
    surfaceHost();
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity } },
    });
    client.setQueryData(["tasks"], {
      assignees: [],
      tasks: [
        task(1, { assignee: { kind: "user" } }),
        task(2, { status: "in_review" }),
        task(3, { status: "blocked" }),
        task(4, { run_status: "failed" }),
        task(5, { run_status: "awaiting_confirmation" }),
        task(6, { status: "done", assignee: { kind: "user" } }),
        task(7, { run_status: "running" }),
      ],
    });
    client.setQueryData(
      ["routines"],
      [routine("a", 2, 0), routine("b", 0, 1), routine("c", 0, 0)],
    );
    const router = createRouter({
      routeTree: createRootRoute({
        component: () => (
          <NuqsAdapter>
            <PendingList />
          </NuqsAdapter>
        ),
      }),
      history: createMemoryHistory(),
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
    const rows = [...container.querySelectorAll("li")].map(
      (li) => li.textContent,
    );
    expect(rows).toEqual([
      "#1 任务1指派给你",
      "#2 任务2待验收",
      "#3 任务3受阻",
      "#4 任务4远程运行失败",
      "#5 任务5等你确认交给远程智能体",
      "定时a2 份新报告",
      "定时b1 次失败",
    ]);
  });

  it("groups confirmations, tasks and routines, and says which failed to load", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    waiting("i1");
    client.setQueryData(["tasks"], {
      assignees: [],
      tasks: [task(1, { status: "in_review" })],
    });
    // The routines never load.
    rstest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json(
          { error: { code: "UNAVAILABLE", message: "定时服务不可用" } },
          { status: 503 },
        ),
      );
    const container = await mount(client, () => <PendingList />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(headings(container)).toEqual([
      "所有群在等你的",
      "确认请求1",
      "任务1",
    ]);
    expect(container.textContent).toContain("无法加载定时");
    expect(container.querySelector("li")!.textContent).toContain(
      "删除i1？允许拒绝放弃",
    );
  });

  describe("the page", () => {
    const history = () => {
      const now = Date.now();
      surfaceHost({
        agents: [agentView({ id: "a1", name: "研究员" })],
        conversations: [conversationView({ id: "g1", name: "群聊" })],
        interactions: [
          interactionView({ id: "i1", prompt: "tasks 请求确认\n删除i1？" }),
          interactionView({
            id: "i2",
            prompt: "tasks 请求确认\n删除i2？",
            status: "answered",
            answer: { kind: "selection", selections: ["允许"] },
            updatedAt: now,
          }),
          interactionView({
            id: "i3",
            prompt: "tasks 请求确认\n删除i3？",
            status: "canceled",
            answer: { kind: "none" },
            updatedAt: now,
          }),
          interactionView({
            id: "i4",
            prompt: "tasks 请求确认\n删除i4？",
            status: "expired",
            updatedAt: now - 2 * 86_400_000,
          }),
        ],
      });
      const client = new QueryClient({
        defaultOptions: { queries: { staleTime: Infinity } },
      });
      client.setQueryData(["tasks"], { assignees: [], tasks: [] });
      client.setQueryData(["routines"], []);
      return client;
    };

    it("lists what waits, then what was answered before, by day", async () => {
      const page = await mount(history(), () => <Notifications />);
      expect(headings(page)).toContain("已处理的确认");
      const sections = [...page.querySelectorAll("section[aria-label]")];
      const rows = sections.map((section) => [
        section.getAttribute("aria-label"),
        [...section.querySelectorAll("li")].map((li) => li.textContent),
      ]);
      expect(rows[0]?.[0]).toBe("确认请求");
      expect(page.textContent).toContain("已选择「允许」");
      expect(page.textContent).toContain("已拒绝，没有答复");
      expect(page.textContent).toContain("已过期，没有答复");
      expect(
        page.querySelectorAll("section[aria-label='今天'] li"),
      ).toHaveLength(2);
    });

    it("shows only what waits under 待处理", async () => {
      const page = await mount(
        history(),
        () => <Notifications />,
        "/?filter=pending",
      );
      expect(headings(page)).not.toContain("已处理的确认");
      expect(page.querySelectorAll("li")).toHaveLength(1);
      expect(page.textContent).toContain("删除i1？");
    });
  });
});
