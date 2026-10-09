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
import { Overview } from "./overview";
import { useWorkspaceStore } from "./workspace-store";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, name: string, status = "idle") => ({
  id,
  name,
  description: "",
  model: "gpt",
  status,
  revision: 1,
});

const reply = (agentId: string, secondsAgo: number) => ({
  id: `r-${agentId}`,
  agent_id: agentId,
  role: "assistant",
  reply_to_id: null,
  status: "responding",
  revision: 1,
  blocks: [],
  failure: null,
  created_at: new Date(Date.now() - secondsAgo * 1000).toISOString(),
});

const connection = (id: string, state: string) => ({
  id,
  connector: "codex",
  label: id,
  state,
  created_at: "2026-01-01T00:00:00Z",
});

async function render({
  agents,
  messages = [],
  pending = 0,
  connections = [],
  memories = {},
}: {
  agents: ReturnType<typeof agent>[];
  messages?: ReturnType<typeof reply>[];
  pending?: number;
  connections?: ReturnType<typeof connection>[];
  memories?: Record<string, number>;
}) {
  // Seeded data stays fresh, so nothing is fetched.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  queryClient.setQueryData(["chat"], {
    agents,
    active_replies: messages,
    messages,
    interactions: Array.from({ length: pending }, (_, i) => ({
      id: `i${i}`,
      agent_id: agents[0].id,
      message_id: "m",
      kind: "choice",
      prompt: "",
      options: [],
      status: "pending",
      revision: 1,
    })),
    event_cursor: "0",
  });
  queryClient.setQueryData(["llm", "connections"], connections);
  queryClient.setQueryData(
    ["llm", "models"],
    [{ id: "gpt", connector: "codex", display_name: "GPT", available: true }],
  );
  for (const { id } of agents)
    queryClient.setQueryData(
      ["memory", id, ""],
      Array.from({ length: memories[id] ?? 0 }, (_, i) => ({
        id: `${id}-${i}`,
        text: "",
      })),
    );
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <Overview />,
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

const label = (container: HTMLElement, prefix: string) =>
  container
    .querySelector(`[aria-label^="${prefix}"]`)
    ?.getAttribute("aria-label");

describe("Overview", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useWorkspaceStore.setState((s) => ({
      workspace: { ...s.workspace, selectedAgentId: undefined },
    }));
  });

  it("reads load, accounts, pending interactions and memories off the fleet", async () => {
    const container = await render({
      agents: [
        agent("a1", "研究员", "working"),
        agent("a2", "运维", "waiting_for_input"),
        agent("a3", "画师", "unavailable"),
      ],
      pending: 2,
      connections: [
        connection("main", "active"),
        connection("spare", "rate_limited"),
      ],
      memories: { a1: 3, a2: 4 },
    });
    expect(label(container, "负载")).toBe("负载：3 个智能体中 2 个在运转");
    const text = container.textContent;
    expect(text).toContain("待确认02");
    expect(text).not.toContain("限流1");
    expect(text).not.toContain("不可用1");
    expect(text).toContain("1 / 2 可用");
    expect(text).toContain("0007");
  });

  it("times the current agent's reply", async () => {
    const container = await render({
      agents: [agent("a1", "研究员"), agent("a2", "运维", "working")],
      messages: [reply("a2", 75)],
    });
    expect(label(container, "本轮")).toBe("本轮已用 1:15");
  });

  it("opens an agent's conversation", async () => {
    const container = await render({
      agents: [agent("a1", "研究员"), agent("a2", "运维")],
    });
    const row = [...container.querySelectorAll("li button")].find((b) =>
      b.textContent?.includes("研究员"),
    ) as HTMLButtonElement;
    await act(async () => row.click());
    const state = useWorkspaceStore.getState();
    expect(state.workspace.selectedAgentId).toBe("a1");
    expect(state.mobilePanel).toBe("chat");
  });
});
