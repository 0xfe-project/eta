import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import { TaskBoard } from "./task-board";
import { Tasks } from "./tasks";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanup: (() => void)[] = [];
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const task = {
  id: "t1",
  number: 75,
  title: "交付任务",
  status: "in_review",
  assignee: { kind: "user" },
  comments: 0,
  run_status: null,
  updated_at: "2026-10-11T06:00:00Z",
  description: "",
  created_by: { kind: "user" },
  created_at: "2026-10-11T06:00:00Z",
  runs: [],
  assists: [],
  loops: [],
  activity: [
    {
      id: "a1",
      kind: "deliverable",
      actor: { kind: "user" },
      created_at: "2026-10-11T06:00:00Z",
      data: { url: "https://github.com/acme/web/pull/7", title: "交付 PR" },
    },
  ],
};

describe("completion returns to the owning task list", () => {
  afterEach(async () => {
    await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
    rstest.restoreAllMocks();
  });
  for (const layout of ["chat", "workspace"] as const) {
    it(`${layout}: a direct detail visit clears only task, refreshes the list and keeps its toast after unmount`, async () => {
      let done = false;
      const updates = rstest.fn();
      rstest
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const request = input instanceof Request ? input : null;
          const url = request?.url ?? String(input);
          const method = request?.method ?? init?.method ?? "GET";
          if (method === "PATCH") done = true;
          const current = { ...task, status: done ? "done" : "in_review" };
          const body = url.includes("/api/forge/")
            ? {
                url: "https://github.com/acme/web/pull/7",
                title: "交付 PR",
                state: "merged",
                additions: 1,
                deletions: 0,
                head_sha: "abc",
              }
            : url.endsWith("/tasks")
              ? { tasks: [current], assignees: [] }
              : current;
          return new Response(JSON.stringify(body), { status: 200 });
        });
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      cleanup.push(() => {
        root.unmount();
        client.clear();
        container.remove();
      });
      await act(async () => {
        root.render(
          <NuqsTestingAdapter
            hasMemory
            searchParams="?task=t1&view=tasks&keep=parent"
            onUrlUpdate={updates}
          >
            <QueryClientProvider client={client}>
              {layout === "chat" ? <Tasks /> : <TaskBoard />}
              <Toaster />
            </QueryClientProvider>
          </NuqsTestingAdapter>,
        );
        await settle();
      });
      await act(settle);
      for (
        let attempt = 0;
        attempt < 10 && !container.textContent?.includes("标记任务完成");
        attempt++
      )
        await act(settle);
      const complete = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "标记任务完成",
      )!;
      expect(complete).toBeDefined();
      await act(async () => {
        complete.click();
        await settle();
      });
      await act(settle);
      expect(updates).toHaveBeenCalledTimes(1);
      const event = updates.mock.calls[0][0];
      expect(event.searchParams.get("task")).toBeNull();
      expect(event.searchParams.get("view")).toBe("tasks");
      expect(event.searchParams.get("keep")).toBe("parent");
      expect(event.options.history).toBe("replace");
      expect(
        [...container.querySelectorAll("button")].some(
          (button) => button.textContent === "标记任务完成",
        ),
      ).toBe(false);
      expect(
        container.querySelector('[data-sonner-toast][data-type="success"]')
          ?.textContent,
      ).toContain("任务已完成");
      expect(
        client.getQueryData<{ tasks: (typeof task)[] }>(["tasks"])?.tasks[0]
          .status,
      ).toBe("done");
    });
  }
});
