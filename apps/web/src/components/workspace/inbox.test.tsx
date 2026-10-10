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
import { Inbox } from "./inbox";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function render(tasks: object[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  queryClient.setQueryData(["tasks"], { tasks, assignees: [] });
  queryClient.setQueryData(["routines"], []);
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <Inbox />,
    }),
    history: createMemoryHistory(),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await router.load();
  });
  return container;
}

describe("Inbox", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("says when nothing waits for the user", async () => {
    const container = await render([]);
    expect(container.textContent).toContain("没有等你处理的事");
  });

  it("lists the tasks waiting for the user", async () => {
    const container = await render([
      {
        id: "t1",
        number: 1,
        title: "验收",
        status: "in_review",
        assignee: { kind: "remote" },
        comments: 0,
        run_status: null,
        updated_at: "2026-10-09T09:00:00Z",
      },
    ]);
    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain("待验收");
  });
});
