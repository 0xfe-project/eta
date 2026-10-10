import { afterEach, describe, expect, it, rstest } from "@rstest/core";
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
import { useWorkspaceStore } from "./workspace-store";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, name: string) => ({ id, name });
const interaction = (id: string, agentId: string, status = "pending") => ({
  id,
  agent_id: agentId,
  message_id: `m-${id}`,
  kind: "choice",
  prompt: `tasks 请求确认\n${id}`,
  options: [
    { value: "allow", label: "允许" },
    { value: "deny", label: "拒绝" },
  ],
  status,
  revision: 1,
  created_at: "2026-10-09T09:00:00Z",
  updated_at: "2026-10-09T09:00:00Z",
});

async function render(snapshot: object) {
  // The tasks and routines that wait for the user too: none.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  queryClient.setQueryData(["chat"], snapshot);
  queryClient.setQueryData(["tasks"], { tasks: [], assignees: [] });
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

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  )!;

describe("Inbox", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    rstest.restoreAllMocks();
  });

  it("lists every agent's pending confirmations", async () => {
    const container = await render({
      agents: [agent("a1", "研究员"), agent("a2", "运维")],
      interactions: [
        interaction("i1", "a1"),
        interaction("i2", "a2"),
        interaction("i3", "a2", "resolved"),
      ],
    });
    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("研究员");
    expect(items[1].textContent).toContain("运维");
  });

  it("answers a confirmation", async () => {
    const answered = {
      ...interaction("i1", "a1"),
      status: "submitted",
      revision: 2,
    };
    const fetch = rstest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(answered), { status: 202 }),
      );
    const container = await render({
      agents: [agent("a1", "研究员")],
      interactions: [interaction("i1", "a1")],
    });
    await act(async () => button(container, "拒绝").click());
    // Until the answer's response has settled, however long that takes.
    for (let i = 0; i < 100; i++) {
      if (container.textContent?.includes("没有等你处理的事")) break;
      await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    const [request] = fetch.mock.calls[0] as [Request];
    expect(request.url).toContain("/api/v1/chat/interactions/i1/answer");
    expect(request.headers.get("Idempotency-Key")).toBeTruthy();
    expect(await request.json()).toEqual({ value: "deny" });
    expect(container.textContent).toContain("没有等你处理的事");
  });

  it("opens the agent's conversation", async () => {
    const container = await render({
      agents: [agent("a1", "研究员"), agent("a2", "运维")],
      interactions: [interaction("i2", "a2")],
    });
    await act(async () => button(container, "运维").click());
    const state = useWorkspaceStore.getState();
    expect(state.workspace.selectedAgentId).toBe("a2");
    expect(state.mobilePanel).toBe("chat");
  });
});
