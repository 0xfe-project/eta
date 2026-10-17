import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { NewSessionPage } from "./new-session";

const state = rstest.hoisted(() => ({
  agents: [] as { id: string; name: string }[],
  navigate: rstest.fn(),
  direct: rstest.fn(),
}));

rstest.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
}));
rstest.mock("@/components/workspace/use-agents", () => ({
  useAgents: () => ({ agents: state.agents, loaded: true }),
}));
rstest.mock("@/queries/groups", () => ({
  useGroupActions: () => ({
    direct: { mutate: state.direct, isPending: false },
  }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];
async function render() {
  const client = new QueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <NewSessionPage />
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
  state.navigate.mockClear();
  state.direct.mockClear();
});

describe("/new", () => {
  it("选了人和目录就直接开一个对话，不用先建群", async () => {
    state.agents = [
      { id: "a1", name: "乐子人" },
      { id: "a2", name: "装配检查" },
    ];
    const container = await render();
    const second = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("装配检查"),
    )!;
    await act(async () => second.click());

    const input = container.querySelector("input")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(input, " /tmp/app ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const start = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("开始"),
    )!;
    await act(async () => start.click());
    expect(state.direct).toHaveBeenCalledWith(
      { agentId: "a2", cwd: "/tmp/app" },
      expect.anything(),
    );
  });

  it("没填目录时说「没有目录」，而不是发一个空串", async () => {
    state.agents = [{ id: "a1", name: "乐子人" }];
    const container = await render();
    const start = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("开始"),
    )!;
    await act(async () => start.click());
    expect(state.direct).toHaveBeenCalledWith(
      { agentId: "a1" },
      expect.anything(),
    );
  });
});
