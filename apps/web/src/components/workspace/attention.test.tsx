import { afterEach, describe, expect, it } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AttentionList } from "./attention";

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
  revising: false,
  unseen_reports: reports,
  unseen_failures: failures,
});

describe("what waits for the user", () => {
  afterEach(() => {
    document.body.innerHTML = "";
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
      routeTree: createRootRoute({ component: () => <AttentionList /> }),
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
});
