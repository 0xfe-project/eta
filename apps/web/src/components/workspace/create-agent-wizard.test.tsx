import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AgentEditor } from "./agent-editor";
import { useWorkspaceStore } from "./workspace-store";

const api = rstest.hoisted(() => ({
  create: rstest.fn(),
  select: rstest.fn(),
}));
rstest.mock("@/queries/chat", () => {
  return {
    useBundles: () => ({
      data: [
        { name: "memory", description: "记忆", builtin: true },
        { name: "mine", description: "", builtin: false },
      ],
    }),
    useCreateAgent: () => useMutation({ mutationFn: api.create }),
    useDeleteAgent: () => ({ mutate: () => {} }),
    useUpdateAgent: () => ({ mutate: () => {}, isPending: false }),
  };
});
rstest.mock("@/queries/llm", () => ({
  useModels: () => ({
    data: [{ id: "m1", display_name: "M1", connector: "c", available: true }],
  }),
  useConnectors: () => ({ data: [{ id: "c", display_name: "C" }] }),
}));
rstest.mock("./use-agents", () => ({
  useAgents: () => ({ agents: [], select: api.select }),
}));
rstest.mock("./agent-identity", () => ({ AgentAvatar: () => <span /> }));
rstest.mock("sonner", () => ({
  toast: { success: () => {}, error: () => {} },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 20)));

const open = async () => {
  await act(async () =>
    useWorkspaceStore.getState().setAgentEditor({ open: true, agentId: null }),
  );
  await settle();
};
const dialog = () => document.querySelector('[role="dialog"]');
const step = () =>
  document.querySelector('[aria-current="step"]')?.textContent ?? "";
const button = (name: string) =>
  [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].find((b) => b.textContent === name)!;
const field = (id: string) =>
  document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
const type = async (id: string, value: string) => {
  const element = field(id);
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element),
    "value",
  )!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const click = async (name: string, detail = 1) => {
  await act(async () => {
    button(name).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail }),
    );
  });
  await settle();
};
const alerts = () =>
  [...document.querySelectorAll('[role="dialog"] [role="alert"]')].map(
    (alert) => alert.textContent,
  );

beforeEach(async () => {
  api.create.mockReset();
  api.select.mockReset();
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <AgentEditor />
      </QueryClientProvider>,
    ),
  );
});
afterEach(async () => {
  await act(async () =>
    useWorkspaceStore.getState().setAgentEditor({ open: false, agentId: null }),
  );
  await act(async () => root.render(null));
});

describe("creating an agent step by step", () => {
  it("checks each step, keeps input going back, creates only at the end", async () => {
    api.create.mockResolvedValue({ id: "new", name: "审查" });
    await open();
    expect(step()).toContain("名称与模型");
    expect(document.activeElement).toBe(field("agent-name"));

    await click("下一步");
    expect(step()).toContain("名称与模型");
    expect(alerts()).toContain("请输入名称。");

    await type("agent-name", "  审查  ");
    await click("下一步");
    expect(step()).toContain("指令");
    expect(document.activeElement).toBe(field("agent-description"));
    await type("agent-description", "只看会出错的地方");

    await click("上一步");
    expect(field("agent-name").value).toBe("  审查  ");
    await click("下一步");
    expect(field("agent-description").value).toBe("只看会出错的地方");
    await click("下一步");
    expect(step()).toContain("环境包");
    expect(api.create).not.toHaveBeenCalled();

    await click("创建");
    // The last used or first usable model, every built-in bundle.
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.create.mock.calls[0][0]).toEqual({
      name: "审查",
      description: "只看会出错的地方",
      model: "m1",
    });
    expect(api.select).toHaveBeenCalledWith("new");
    expect(dialog()).toBeNull();
  });

  it("keeps everything after a failure and creates once on retry", async () => {
    let finish!: (agent: unknown) => void;
    api.create
      .mockRejectedValueOnce(new Error("控制面暂时不可用。"))
      .mockImplementationOnce(
        () => new Promise((resolve) => (finish = resolve)),
      );
    await open();
    await type("agent-name", "审查");
    await click("下一步");
    await click("下一步");
    await click("创建");
    expect(alerts()).toContain("创建失败：控制面暂时不可用。");
    expect(dialog()).not.toBeNull();

    await click("上一步");
    await click("上一步");
    expect(field("agent-name").value).toBe("审查");
    await click("下一步");
    await click("下一步");
    await click("重试创建");
    expect(button("正在创建…").disabled).toBe(true);
    // Enter again while it is on its way.
    await act(async () =>
      document
        .querySelector('[role="dialog"] form')!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    await settle();
    expect(api.create).toHaveBeenCalledTimes(2);
    await act(async () => finish({ id: "new", name: "审查" }));
    await settle();
    expect(dialog()).toBeNull();
  });

  it("ignores the second click of a double click on 下一步", async () => {
    await open();
    await type("agent-name", "审查");
    await click("下一步");
    await click("下一步");
    // It lands on 创建, which took 下一步's place.
    await click("创建", 2);
    expect(api.create).not.toHaveBeenCalled();
  });

  it("starts over when cancelled and opened again", async () => {
    await open();
    await type("agent-name", "半成品");
    await click("下一步");
    await click("取消");
    expect(dialog()).toBeNull();

    await open();
    expect(step()).toContain("名称与模型");
    expect(field("agent-name").value).toBe("");
  });
});
