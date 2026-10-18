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

const confirmation = (id: string, status: string) => ({
  id,
  agent_id: "a1",
  message_id: `m-${id}`,
  kind: "choice",
  prompt: `tasks 请求确认\n删除${id}？`,
  options: [
    { value: "allow", label: "允许" },
    { value: "deny", label: "拒绝" },
  ],
  status,
  revision: 1,
  answer: status === "resolved" ? "allow" : null,
  created_at: "2026-10-09T09:00:00Z",
  updated_at: "2026-10-09T09:00:00Z",
});

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
  });

  it("lists tasks and routines that need them, and nothing else", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity } },
    });
    client.setQueryData(["chat"], { agents: [], interactions: [] });
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
    client.setQueryData(["chat"], {
      groups: [],
      agents: [{ id: "a1", name: "研究员" }],
      interactions: [confirmation("i1", "pending")],
    });
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
      "删除i1？允许拒绝",
    );
  });

  it("lists answered confirmations under 全部 only, never the waiting ones twice", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity } },
    });
    const pending = confirmation("i1", "pending");
    const answered = confirmation("i2", "resolved");
    client.setQueryData(["chat"], { agents: [], interactions: [pending] });
    client.setQueryData(["chat", "interactions"], [pending, answered]);
    client.setQueryData(["tasks"], { assignees: [], tasks: [] });
    client.setQueryData(["routines"], []);
    const all = await mount(client, () => <Notifications />);
    expect(headings(all)).toContain("已处理的确认");
    const items = [...all.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toHaveLength(2);
    expect(items[1]).toContain("已选择「允许」");
    document.body.innerHTML = "";
    const waiting = await mount(
      client,
      () => <Notifications />,
      "/?filter=pending",
    );
    expect(headings(waiting)).not.toContain("已处理的确认");
    expect(waiting.querySelectorAll("li")).toHaveLength(1);
  });
});
