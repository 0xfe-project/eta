import type { ConversationSummary } from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setWire } from "@/lib/wire";
import {
  agentView,
  conversationView,
  memberView,
  productHost,
  projectView,
} from "@/test-product";
import { Sidebar } from "./app-shell";

const state = rstest.hoisted(() => ({
  agents: [] as { id: string; name: string; status: string }[],
  groups: [] as ConversationSummary[],
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
// The sidebar links through the router; this test is about the list, so the link is a plain one.
rstest.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
  useRouterState: () => ({ location: { pathname: "/" } }),
  // The folder header's "+" navigates to /new with a cwd.
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
  setWire(undefined);
});

const agent = (id: string, name: string) => ({ id, name, status: "idle" });

async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("左栏的搜索框", () => {
  it("filters the tree by conversation name or project", async () => {
    state.agents = [];
    state.groups = [
      conversationView({
        id: "g1",
        name: "装配",
        projectId: "p-eta",
        lastMessageAt: 2,
      }),
      conversationView({
        id: "g2",
        name: "装修",
        projectId: "p-house",
        lastMessageAt: 1,
      }),
    ];
    const container = await render(<Sidebar />);
    expect(container.textContent).toContain("装修");

    // A project's path is as good a way to find a conversation as its own name.
    await typeInto(container.querySelector("input")!, "desktop");
    expect(container.textContent).toContain("装配");
    expect(container.textContent).not.toContain("装修");
  });
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
});
