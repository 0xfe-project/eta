import type { ChatMessage } from "./chat";
import { afterEach, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, lazy, Suspense } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { useAgents } from "@/components/workspace/use-agents";
import {
  useAgentMessages,
  useChatSnapshot,
  usePendingInteractions,
} from "./chat";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const message = (id: string, agentId: string) => ({
  id,
  agent_id: agentId,
  role: "assistant",
  status: "queued",
  revision: 1,
  created_at: "2026-10-11T09:00:00Z",
  blocks: [],
});
const snapshot = {
  agents: [{ id: "a", name: "研究员 A" }],
  messages: [message("a-message", "a"), message("b-message", "b")],
  active_replies: [],
  event_cursor: "cursor",
  interactions: [
    { id: "pending", status: "pending", prompt: "请确认 A 的操作" },
    { id: "resolved", status: "resolved", prompt: "已经确认" },
  ],
};
const selectMessages = (value: { messages: ChatMessage[] }) =>
  value.messages.filter((item) => item.agent_id === "a");
let selectedMessages: ChatMessage[] | undefined;
let pendingInteractions: ReturnType<typeof usePendingInteractions>;

function SnapshotReaders() {
  const chat = useChatSnapshot();
  const { current, loaded } = useAgents();
  const history = useAgentMessages(current?.id);
  pendingInteractions = usePendingInteractions();
  selectedMessages = useChatSnapshot(selectMessages).data;
  return (
    <>
      <div role="status">
        {chat.isPending ? "加载对话" : (chat.error?.message ?? "对话已加载")}
      </div>
      <div>{loaded ? current?.name : "加载智能体"}</div>
      <output>{history.messages.map((item) => item.id).join(",")}</output>
      <output>
        {pendingInteractions.map((item) => item.prompt).join(",")}
      </output>
      <output>{selectedMessages?.map((item) => item.id).join(",")}</output>
    </>
  );
}

const clients: QueryClient[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await act(async () => cleanups.splice(0).forEach((dispose) => dispose()));
  clients.splice(0).forEach((client) => client.clear());
  rstest.restoreAllMocks();
});
function client() {
  const result = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  clients.push(result);
  return result;
}
function serverHTML() {
  const html = renderToString(
    <QueryClientProvider client={client()}>
      <Suspense>
        <SnapshotReaders />
      </Suspense>
    </QueryClientProvider>,
  );
  expect(html).toContain("加载对话");
  expect(html).toContain("加载智能体");
  expect(html).not.toContain("研究员 A");
  expect(html).not.toContain("a-message");
  expect(html).not.toContain("请确认 A 的操作");
  return html;
}
function warmClient() {
  const result = client();
  result.setQueryData(["chat"], snapshot);
  result.setQueryData(["chat", "messages", "a"], {
    pages: [{ items: [], next_cursor: null }],
    pageParams: [null],
  });
  return result;
}

it("hydrates a delayed boundary from server loading when the live snapshot is already cached", async () => {
  const fetch = rstest.spyOn(globalThis, "fetch");
  const container = document.createElement("div");
  container.innerHTML = serverHTML();
  document.body.append(container);
  const queryClient = warmClient();
  let release!: () => void;
  const DelayedReaders = lazy(
    () =>
      new Promise<{ default: typeof SnapshotReaders }>((resolve) => {
        release = () => resolve({ default: SnapshotReaders });
      }),
  );
  const recover = rstest.fn();
  await act(async () => {
    const root = hydrateRoot(
      container,
      <QueryClientProvider client={queryClient}>
        <Suspense>
          <DelayedReaders />
        </Suspense>
      </QueryClientProvider>,
      { onRecoverableError: recover },
    );
    cleanups.push(() => {
      root.unmount();
      container.remove();
    });
  });
  expect(container.textContent).toContain("加载智能体");
  await act(async () => release());
  expect(recover).not.toHaveBeenCalled();
  expect(container.textContent).toContain("研究员 A");
  expect(container.textContent).toContain("a-message");
  expect(container.textContent).not.toContain("b-message");
  expect(container.textContent).toContain("请确认 A 的操作");
  expect(container.textContent).not.toContain("已经确认");
  expect(fetch).not.toHaveBeenCalled();

  // An unrelated agent's event preserves both selector results by reference.
  const messagesBefore = selectedMessages;
  const pendingBefore = pendingInteractions;
  await act(async () => {
    queryClient.setQueryData(["chat"], {
      ...snapshot,
      messages: [...snapshot.messages, message("b-next", "b")],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(selectedMessages).toBe(messagesBefore);
  expect(pendingInteractions).toBe(pendingBefore);
});

it("keeps a cached client error out of the server's first hydration frame", async () => {
  const container = document.createElement("div");
  container.innerHTML = serverHTML();
  document.body.append(container);
  const queryClient = warmClient();
  queryClient
    .getQueryCache()
    .find({ queryKey: ["chat"], exact: true })!
    .setState({ status: "error", error: new Error("连接暂时中断") });
  // Keep the cached failure until the user explicitly retries it.
  const fetch = rstest
    .spyOn(globalThis, "fetch")
    .mockReturnValue(new Promise<Response>(() => {}));
  const recover = rstest.fn();
  await act(async () => {
    const root = hydrateRoot(
      container,
      <QueryClientProvider client={queryClient}>
        <Suspense>
          <SnapshotReaders />
        </Suspense>
      </QueryClientProvider>,
      { onRecoverableError: recover },
    );
    cleanups.push(() => {
      root.unmount();
      container.remove();
    });
  });
  expect(recover).not.toHaveBeenCalled();
  expect(container.textContent).toContain("研究员 A");
  expect(container.textContent).toContain("连接暂时中断");
  fetch.mockRestore();
});
