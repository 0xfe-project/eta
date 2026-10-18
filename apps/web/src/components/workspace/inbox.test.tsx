import { afterEach, describe, expect, it } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setWire } from "@/lib/wire";
import { interactionView, surfaceHost } from "@/test-inbox";
import { agentView, conversationView } from "@/test-product";
import { Inbox } from "./inbox";
import { useWorkspaceStore } from "./workspace-store";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Pending questions, one per agent, each in its own group. */
async function render(waits: { id: string; agent: string }[]) {
  const host = surfaceHost({
    agents: [
      agentView({ id: "a1", name: "研究员" }),
      agentView({ id: "a2", name: "运维" }),
    ],
    conversations: waits.map(({ agent }) =>
      conversationView({ id: `g-${agent}`, name: "群聊" }),
    ),
    interactions: waits.map(({ id, agent }) =>
      interactionView({
        id,
        agentId: agent,
        conversationId: `g-${agent}`,
        prompt: `tasks 请求确认\n${id}`,
      }),
    ),
  });
  host.handle("inbox.answer", () => ({ answered: true }));
  // The tasks and routines that wait for the user too: none.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  queryClient.setQueryData(["tasks"], { tasks: [], assignees: [] });
  queryClient.setQueryData(["routines"], []);
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <NuqsAdapter>
          <Inbox />
        </NuqsAdapter>
      ),
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
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  return { container, host };
}

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  )!;

describe("Inbox", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    setWire(undefined);
  });

  it("lists every agent's pending questions", async () => {
    const { container } = await render([
      { id: "i1", agent: "a1" },
      { id: "i2", agent: "a2" },
    ]);
    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("研究员");
    expect(items[1].textContent).toContain("运维");
  });

  it("answers a question on the inbox", async () => {
    const { container, host } = await render([{ id: "i1", agent: "a1" }]);
    await act(async () => button(container, "拒绝").click());
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(host.calls).toEqual([
      {
        target: "inbox",
        action: "answer",
        args: {
          id: "i1",
          response: { kind: "selection", selections: ["拒绝"] },
        },
      },
    ]);
  });

  it("declines a question with 放弃", async () => {
    const { container, host } = await render([{ id: "i1", agent: "a1" }]);
    await act(async () => button(container, "放弃").click());
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(host.calls[0]?.args).toEqual({
      id: "i1",
      response: { kind: "none" },
    });
  });

  it("opens the agent's conversation", async () => {
    const { container } = await render([{ id: "i2", agent: "a2" }]);
    await act(async () => button(container, "运维 · 群聊").click());
    const state = useWorkspaceStore.getState();
    expect(window.location.pathname).toBe("/");
    expect(state.mobilePanel).toBe("chat");
  });
});
