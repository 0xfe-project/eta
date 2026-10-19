import type { ConversationSummary } from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SidebarProvider } from "@/components/ui/sidebar";
import { setWire } from "@/lib/wire";
import {
  agentView,
  conversationView,
  memberView,
  productHost,
  projectView,
} from "@/test-product";
import { agentStatusLabels } from "./agent-status";
import { Sidebar } from "./app-shell";
import { GroupList } from "./groups";

const state = rstest.hoisted(() => ({
  agents: [] as { id: string; name: string; status: string }[],
  groups: [] as ConversationSummary[],
  openAgent: rstest.fn(),
  pathname: "/",
}));
rstest.mock("./use-agents", () => ({
  useAgents: () => ({
    agents: state.agents,
    loaded: true,
    error: undefined,
    openEditor: () => undefined,
    select: () => undefined,
    current: undefined,
    retry: () => undefined,
  }),
  useOpenAgent: () => state.openAgent,
}));
rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: state.groups, current: undefined }),
  useOpenGroup: () => () => undefined,
}));
// The sidebar links through the router; this test is about the list, so the link is a plain one.
rstest.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: {
    children?: React.ReactNode;
    to?: string;
  }) => (
    <a data-to={to} {...props}>
      {children}
    </a>
  ),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: state.pathname } }),
  useNavigate: () => () => undefined,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];
async function render(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  productHost({
    agents: state.agents.map((a, index) =>
      agentView({ ...a, createdAt: index + 1 } as Parameters<
        typeof agentView
      >[0]),
    ),
    projects: [
      projectView({
        id: "p-eta",
        name: "eta",
        path: "/Users/me/Desktop/eta",
      }),
      projectView({
        id: "p-house",
        name: "house",
        path: "/Users/me/work/house",
      }),
      projectView({
        id: "p",
        name: "p",
        path: "/p",
      }),
    ],
    conversations: state.groups,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SidebarProvider>{node}</SidebarProvider>
      </QueryClientProvider>,
    ),
  );
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  return container;
}

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
  state.openAgent.mockClear();
  state.pathname = "/";
  setWire(undefined);
});

const agent = (id: string, name: string, status = "idle") => ({
  id,
  name,
  status,
});

const rowNames = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-sidebar="menu-button"]')]
    .filter((row) => !row.hasAttribute("data-to"))
    .map((row) => row.getAttribute("title"));

describe("左栏的一张列表", () => {
  const now = Date.now();
  const lists = () => {
    state.agents = [
      agent("a1", "乐子人"),
      agent("a2", "装配检查", "working"),
      agent("a3", "闲着"),
    ];
    // `useGroups` hands the conversations over newest activity first.
    state.groups = [
      conversationView({
        id: "d1",
        name: "乐子人",
        kind: "direct",
        projectId: "p",
        participants: [memberView("a1")],
        lastMessageAt: now - 60_000,
      }),
      conversationView({
        id: "g1",
        name: "装配",
        projectId: "p",
        participants: [memberView("a1"), memberView("a2")],
        lastMessageAt: now - 3_600_000,
      }),
    ];
  };

  it("holds a group, an agent's direct chat once, and an agent without one", async () => {
    lists();
    const container = await render(<Sidebar />);
    // 乐子人 appears once, as its direct chat; the two without a chat come after, by creation.
    expect(rowNames(container)).toEqual([
      "乐子人",
      "装配",
      "与 装配检查 对话",
      "与 闲着 对话",
    ]);
    expect(
      container.querySelectorAll('[data-sidebar="group-label"]'),
    ).toHaveLength(1);
    expect(container.textContent).not.toContain("智能体");
    expect(
      container.querySelector('[aria-labelledby="sidebar-agents"]'),
    ).toBeNull();
  });

  it("shows an agent without a chat with its status", async () => {
    lists();
    const container = await render(<Sidebar />);
    const row = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("装配检查"),
    )!;
    expect(row.textContent).toBe(`装配检查${agentStatusLabels.working}`);
  });

  it("opens the direct chat of an agent without one when it is pressed", async () => {
    lists();
    const container = await render(<Sidebar />);
    const row = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("装配检查"),
    )!;
    await act(async () => row.click());
    expect(state.openAgent).toHaveBeenCalledWith("a2");
  });

  it("has no button to create an agent", async () => {
    lists();
    const container = await render(<Sidebar />);
    expect(container.querySelector('[title="新建智能体"]')).toBeNull();
  });

  it("is the same single list on the phone's home", async () => {
    lists();
    const container = await render(<GroupList />);
    const titles = [...container.querySelectorAll("li button")].map((b) =>
      b.getAttribute("title"),
    );
    expect(titles).toEqual([
      "乐子人",
      "装配",
      "与 装配检查 对话",
      "与 闲着 对话",
    ]);
    expect(container.querySelectorAll("h2")).toHaveLength(1);
    const row = [...container.querySelectorAll<HTMLElement>("li button")].find(
      (b) => b.textContent?.includes("闲着"),
    )!;
    await act(async () => row.click());
    expect(state.openAgent).toHaveBeenCalledWith("a3");
  });

  it("says so once when there is nothing to chat with", async () => {
    state.agents = [];
    state.groups = [];
    const container = await render(<Sidebar />);
    expect(container.textContent).toContain("还没有对话");
  });
});

describe("左栏的页眉", () => {
  it("carries the wordmark and the one settings button", async () => {
    state.agents = [];
    state.groups = [];
    const container = await render(<Sidebar />);
    const header = container.querySelector('[data-sidebar="header"]')!;
    expect(header.textContent).toContain("eta.");
    expect(header.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelectorAll('button[title="设置"]')).toHaveLength(1);
  });

  it("links the sections and marks the current one", async () => {
    state.pathname = "/workspace/routines";
    state.agents = [];
    state.groups = [];
    const container = await render(<Sidebar />);
    const links = [...container.querySelectorAll("a[data-to]")].filter((a) =>
      a.hasAttribute("data-active"),
    );
    // Only the two pages that remain; chat, pending and memory have no button.
    expect(links.map((a) => a.getAttribute("data-to"))).toEqual([
      "/workspace/tasks",
      "/workspace/routines",
    ]);
    expect(links.map((a) => a.textContent)).toEqual(["任务", "定时"]);
    expect(
      links
        .filter((a) => a.getAttribute("data-active") === "true")
        .map((a) => a.getAttribute("data-to")),
    ).toEqual(["/workspace/routines"]);
  });
});
