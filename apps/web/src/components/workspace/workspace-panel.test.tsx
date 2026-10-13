import { afterEach, expect, it } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryPage } from "@/pages/memory";
import { validateMemorySearch } from "./memory-nav";
import { WorkspacePanel } from "./workspace-panel";
import { useWorkspaceView, validateWorkspaceSearch } from "./workspace-search";
import { useWorkspaceStore } from "./workspace-store";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];
afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
  useWorkspaceStore.getState().setWorkspace((workspace) => ({
    ...workspace,
    selectedAgentId: undefined,
  }));
});

async function mount(path = "/?view=memory") {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  client.setQueryData(["chat"], {
    agents: [
      { id: "a", name: "研究员 A" },
      { id: "b", name: "研究员 B" },
    ],
    interactions: [],
  });
  client.setQueryData(["tasks"], { tasks: [], assignees: [] });
  client.setQueryData(["routines"], []);
  client.setQueryData(["llm", "connections"], []);
  for (const id of ["a", "b"])
    client.setQueryData(
      ["memory", id, ""],
      [{ id: `memory-${id}`, text: `${id} 的专属记忆`, source: "user" }],
    );

  const route = createRootRoute({
    component: () => (
      <NuqsAdapter>
        <Outlet />
      </NuqsAdapter>
    ),
  });
  const router = createRouter({
    routeTree: route.addChildren([
      createRoute({
        getParentRoute: () => route,
        path: "/",
        validateSearch: validateWorkspaceSearch,
        component: function Home() {
          const [view, setView] = useWorkspaceView();
          return (
            <WorkspacePanel
              view={view}
              onViewChange={(value) => void setView(value)}
            />
          );
        },
      }),
      createRoute({
        getParentRoute: () => route,
        path: "workspace/memory",
        validateSearch: validateMemorySearch,
        component: MemoryPage,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
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
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await router.load();
  });
  return { container, router };
}

const selectAgent = (id: string) =>
  useWorkspaceStore.getState().setWorkspace((workspace) => ({
    ...workspace,
    selectedAgentId: id,
  }));

const tabs = (container: HTMLElement) =>
  [...container.querySelectorAll('[aria-label="工作区标签"] [role="tab"]')].map(
    (tab) => [tab.textContent, tab.getAttribute("aria-selected")],
  );

it("leaves memory out of the side panel and defaults an unknown tab to group info", async () => {
  const { container } = await mount();
  expect(tabs(container)).toEqual([
    ["群", "true"],
    ["概览", "false"],
    ["任务", "false"],
    ["定时", "false"],
    ["待处理", "false"],
  ]);
  expect(container.textContent).not.toContain("的专属记忆");
  expect(
    container
      .querySelector('a[aria-label="在全窗口中打开"]')
      ?.getAttribute("href"),
  ).toBe("/workspace");
});

it("keeps the full-window memory page at the agent in its URL", async () => {
  // A direct load must use the URL even if this browser's chat selected B.
  selectAgent("b");
  const { container } = await mount("/workspace/memory?agent=a");
  expect(
    container.querySelector('[aria-label="智能体"]')?.textContent,
  ).toContain("研究员 A");
  expect(container.textContent).toContain("a 的专属记忆");
  expect(container.textContent).not.toContain("b 的专属记忆");
});
