import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "./app-shell";

const state = rstest.hoisted(() => ({
  agents: [] as { id: string; name: string; status: string }[],
  groups: [] as unknown[],
  openAgent: rstest.fn(),
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
rstest.mock("./use-attention", () => ({
  useAttention: () => ({ total: 0 }),
}));
rstest.mock("@/queries/tasks", () => ({
  useTasks: () => ({ data: { tasks: [] } }),
}));
// The sidebar links through the router; this test is about the list, so the link is a plain one.
rstest.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
  useRouterState: () => ({ location: { pathname: "/" } }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];
async function render(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(["chat"], {
    groups: state.groups,
    agents: state.agents,
    active_replies: [],
    interactions: [],
    event_cursor: 0,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>{node}</QueryClientProvider>,
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
});

const agent = (id: string, name: string) => ({ id, name, status: "idle" });

describe("智能体库", () => {
  it("lists only the agents with no conversation to reach them by", async () => {
    state.agents = [agent("a1", "乐子人"), agent("a2", "装配检查")];
    state.groups = [
      {
        id: "g1",
        name: "乐子人",
        kind: "direct",
        cwd: "",
        archived: false,
        participants: [
          { agent_id: "a1", name: "乐子人", member: true, status: "idle" },
        ],
      },
    ];
    const container = await render(<Sidebar />);
    const library = container.querySelector(
      '[aria-labelledby="sidebar-agents"]',
    )!;
    expect(library.textContent).toContain("装配检查");
    // 乐子人 already has a row in the tree; a second one here would be the same agent twice.
    expect(library.textContent).not.toContain("乐子人");
  });

  it("says so when every agent is reachable", async () => {
    state.agents = [agent("a1", "乐子人")];
    state.groups = [
      {
        id: "g1",
        name: "乐子人",
        kind: "direct",
        cwd: "",
        archived: false,
        participants: [
          { agent_id: "a1", name: "乐子人", member: true, status: "idle" },
        ],
      },
    ];
    const container = await render(<Sidebar />);
    expect(container.textContent).toContain("每个智能体都已经有对话了");
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
});
