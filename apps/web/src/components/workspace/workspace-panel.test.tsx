import { afterEach, expect, it, rstest } from "@rstest/core";
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

it("gives a group chat 成员 and Artifacts, falling back to 成员", async () => {
  // memory was never a tab; group, overview, tasks, routines and inbox were
  // a group chat's before.
  for (const view of ["memory", "group", "overview", "tasks", "routines"]) {
    const { container } = await mount(`/?group=team&view=${view}`);
    expect(tabs(container)).toEqual([
      ["成员", "true"],
      ["Artifacts", "false"],
    ]);
  }
  const { container } = await mount("/?group=team&view=artifacts");
  expect(tabs(container)[1]).toEqual(["Artifacts", "true"]);
  expect(container.textContent).toContain("还没有 Artifacts");
});

it("leaves memory out of a direct chat's side panel", async () => {
  const { container } = await mount("/?group=dm&view=memory");
  expect(tabs(container)).toEqual([
    ["概览", "true"],
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

it("opens a direct chat's overview for a group chat's tab", async () => {
  for (const view of ["group", "members", "artifacts"]) {
    const { container } = await mount(`/?group=dm&view=${view}`);
    expect(tabs(container)[0]).toEqual(["概览", "true"]);
  }
  for (const id of ["solo", "team"]) {
    const { container } = await mount(`/?group=${id}`);
    expect(tabs(container)[0]).toEqual(["成员", "true"]);
  }
});

it("says a page this host cannot serve is not served, instead of loading forever", async () => {
  // 记忆 is P3.4 (capabilities.ts): the memory bundle's service is not on this host. A direct URL
  // still renders something true — the sentence — rather than a page that spins behind a hidden
  // navigation entry. When the capability comes on, this test becomes the one that asserts the
  // agent in the URL again.
  const { container } = await mount("/workspace/memory?agent=a");
  expect(container.textContent).toContain("记忆");
  expect(container.textContent).not.toContain("的专属记忆");
});
