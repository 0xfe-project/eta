import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ModelChip, ThinkingChip } from "./composer-pickers";

const requests = rstest.hoisted(() => ({ patches: [] as unknown[] }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];
async function render(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(["session-model", "s1"], {
    model: "local:m1",
    thinking_level: "off",
  });
  client.setQueryData(
    ["llm", "models"],
    [
      { id: "local:m1", display_name: "Model One", available: true },
      { id: "local:m2", display_name: "Model Two", available: true },
    ],
  );
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
  requests.patches.length = 0;
  rstest.restoreAllMocks();
});

describe("单聊的两个 chip", () => {
  it("说的是这个会话真正在跑的模型，不是设置里的默认", async () => {
    const container = await render(<ModelChip sessionId="s1" />);
    expect(container.textContent).toContain("local:m1");
  });

  it("思考档显示当前值", async () => {
    const container = await render(<ThinkingChip sessionId="s1" />);
    expect(container.textContent).toContain("think:off");
  });

  it("没有会话时不画", async () => {
    const model = await render(<ModelChip sessionId={undefined} />);
    expect(model.textContent).toBe("");
    const thinking = await render(<ThinkingChip sessionId={undefined} />);
    expect(thinking.textContent).toBe("");
  });
});
