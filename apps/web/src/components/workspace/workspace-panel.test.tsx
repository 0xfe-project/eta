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

const group = (id: string, kind: "direct" | "group", agents: string[]) => ({
  id,
  kind,
  name: id,
  archived: false,
  updated_at: "2026-10-14T00:00:00Z",
  last_seq: 0,
  read_seq: 0,
  goal: "",
  decided: "",
  participants: agents.map((agent_id) => ({
    agent_id,
    name: agent_id,
    member: true,
  })),
});

async function mount(path = "/?group=team&view=memory") {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  client.setQueryData(["chat"], {
    agents: [
      { id: "a", name: "研究员 A" },
      { id: "b", name: "研究员 B" },
    ],
    groups: [
      group("dm", "direct", ["a"]),
      group("solo", "group", ["a"]),
      group("team", "group", ["a", "b"]),
    ],
    messages: [],
    interactions: [],
  });
  client.setQueryData(["tasks"], { tasks: [], assignees: [] });
  client.setQueryData(["artifacts"], { artifacts: [] });
  client.setQueryData(["routines"], []);

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
          const [, setLinked] = useWorkspaceView();
          const view = "context";
          return (
            <WorkspacePanel
              view={view}
              onViewChange={(value) => void setLinked(value)}
            />
          );
        },
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

const tabs = (container: HTMLElement) =>
  [...container.querySelectorAll('[aria-label="工作区标签"] [role="tab"]')].map(
    (tab) => [tab.textContent, tab.getAttribute("aria-selected")],
  );

it("gives every conversation the same five tabs", async () => {
  // Tasks, routines and pending used to be four sidebar destinations that each asked "but which
  // group?". They belong to the conversation you are in, so they are here — on every one of them,
  // group or direct — and 概览 stays the single global page.
  const { container } = await mount("/?group=team");
  expect(tabs(container).map(([label]) => label)).toEqual([
    "上下文",
    "任务",
    "定时",
    "待处理",
    "产物",
  ]);
});

it("opens 上下文 when a link asks for the tab a group used to call 成员", async () => {
  // Old links: `?view=members` is `context` now, and anything unknown opens the first tab.
  for (const view of ["members", "group"]) {
    const { container } = await mount(`/?group=team&view=${view}`);
    expect(tabs(container)[0]).toEqual(["上下文", "true"]);
  }
});
