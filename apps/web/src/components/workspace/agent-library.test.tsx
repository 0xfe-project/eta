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
    agents: state.agents.map((a) => agentView({ ...a, status: "idle" })),
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

describe("智能体库", () => {
  it("lists every agent, whether or not it already has a conversation", async () => {
    state.agents = [agent("a1", "乐子人"), agent("a2", "装配检查")];
    state.groups = [
      conversationView({
        id: "g1",
        name: "乐子人",
        kind: "direct",
        projectId: "p",
        participants: [memberView("a1")],
      }),
    ];
    const container = await render(<Sidebar />);
    const library = container.querySelector(
      '[aria-labelledby="sidebar-agents"]',
    )!;
    // Both, every time: an agent is a durable actor, not a conversation that gets used up.
    // 乐子人 already has a private chat in the tree — it stays here anyway, because this list
    // answers "who exists", not "who have I not talked to yet".
    expect(library.textContent).toContain("装配检查");
    expect(library.textContent).toContain("乐子人");
  });

  it("keeps offering an agent after its conversation is open", async () => {
    state.agents = [agent("a1", "乐子人")];
    state.groups = [
      conversationView({
        id: "g1",
        name: "乐子人",
        kind: "direct",
        projectId: "p",
        participants: [memberView("a1")],
      }),
    ];
    const container = await render(<Sidebar />);
    const library = container.querySelector(
      '[aria-labelledby="sidebar-agents"]',
    )!;
    const row = [...library.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("乐子人"),
    )!;
    await act(async () => row.click());
    // Pressing it again is the same conversation, not a second one and not a shorter list.
    expect(state.openAgent).toHaveBeenCalledWith("a1");
    expect(library.textContent).toContain("乐子人");
  });

  it("opens a chat when a library agent is pressed", async () => {
    state.agents = [agent("a2", "装配检查")];
    state.groups = [];
    const container = await render(<Sidebar />);
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("装配检查"),
    )!;
    await act(async () => button.click());
    expect(state.openAgent).toHaveBeenCalledWith("a2");
  });

  it("shows every agent with its status", async () => {
    state.agents = [
      agent("a1", "乐子人", "working"),
      agent("a2", "装配检查", "waiting_for_input"),
      agent("a3", "闲着", "idle"),
    ];
    state.groups = [];
    const container = await render(<Sidebar />);
    const rows = [
      ...container.querySelectorAll(
        '[aria-labelledby="sidebar-agents"] [data-sidebar="menu-button"]',
      ),
    ];
    expect(rows.map((row) => row.textContent)).toEqual([
      `乐子人${agentStatusLabels.working}`,
      `装配检查${agentStatusLabels.waiting_for_input}`,
      `闲着${agentStatusLabels.idle}`,
    ]);
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
