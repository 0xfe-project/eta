import { afterEach, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setWire } from "@/lib/wire";
import { agentView, conversationView, productHost } from "@/test-product";
import { MemoryView } from "./memory-view";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
const memories = Array.from({ length: 45 }, (_, i) => ({
  id: String(i),
  text: `记忆 ${i}`,
  source: i < 22 ? "user" : "agent",
}));
afterEach(async () => {
  await act(async () => root.render(null));
  client.clear();
  rstest.restoreAllMocks();
  setWire(undefined);
});
let host: ReturnType<typeof productHost>;
async function render() {
  host = productHost({
    agents: [agentView({ id: "a", name: "助手" })],
    conversations: [],
  });
  client.setQueryData(["memory", "a", ""], memories);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryView agentId="a" />
      </QueryClientProvider>,
    ),
  );
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("updates source names from the group snapshot without rewriting memories", async () => {
  await render();
  const updateGroup = (name: string) =>
    host.set("conversations", { list: [conversationView({ id: "g", name })] });
  await act(async () => {
    client.setQueryData(
      ["memory", "a", ""],
      [{ id: "m", text: "独立数据库", source_group_id: "g" }],
    );
    updateGroup("原来的群名");
    await pause(20);
  });
  expect(container.querySelector('a[href="/?group=g"]')?.textContent).toBe(
    "原来的群名",
  );
  await act(async () => {
    updateGroup("改名后的群");
    await pause(20);
  });
  expect(container.querySelector('a[href="/?group=g"]')?.textContent).toBe(
    "改名后的群",
  );
  expect(container.textContent).not.toContain("原来的群名");
});

async function choose(label: string) {
  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-label="记忆种类"]',
  )!;
  await act(async () =>
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ),
  );
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((el) => el.textContent === label)!;
  await act(async () => {
    option.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await pause(30);
  });
}
it("filters through the API, resets pagination, and restores the full cached list", async () => {
  const fetch = rstest
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      expect(String(input)).toBe(
        "/api/bundles/memory/v1/agents/a/memories?source=user",
      );
      return new Response(
        JSON.stringify({
          memories: memories.filter((m) => m.source === "user"),
        }),
      );
    });
  await render();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="下一页"]')!
      .click(),
  );
  expect(container.textContent).toContain("2 / 3");
  await choose("手动添加");
  await act(async () => {
    const deadline = Date.now() + 5000;
    while (client.isFetching() && Date.now() < deadline) await pause(10);
    await pause(20);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("1 / 2");
  expect(container.querySelectorAll("li")).toHaveLength(20);
  expect(container.textContent).not.toContain("智能体记下");
  await choose("全部种类");
  expect(container.textContent).toContain("1 / 3");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("combines debounced search with source and hides stale results while loading", async () => {
  let resolve!: (response: Response) => void;
  const fetch = rstest.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  await choose("手动添加");
  expect(container.querySelector('[aria-label="记忆列表"]')).toBeNull();
  await act(async () => {
    resolve(new Response(JSON.stringify({ memories: [] })));
    await pause(30);
  });
  expect(container.textContent).toContain("没有相关的记忆");
  const search = container.querySelector<HTMLInputElement>(
    '[aria-label="搜索记忆"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(search, "部署");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    await pause(350);
  });
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/bundles/memory/v1/agents/a/memories?q=%E9%83%A8%E7%BD%B2&source=user",
    { signal: expect.any(AbortSignal) },
  );
  await act(async () => {
    resolve(new Response(JSON.stringify({ memories: [] })));
    await pause(30);
  });
  expect(container.textContent).toContain("没有相关的记忆");
});
